import type { DiarizedTranscriptSegment } from "@/lib/domain/audio-transcription";

export const SPEAKER_IDENTITY_VERSION = "voice-references.v1";
export type SpeakerReference = {
  name: string;
  canonicalSpeaker: string;
  startSeconds: number;
  endSeconds: number;
  dataUrl: string;
};

export function normalizeSpeakerKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase()
    .replace(/^speaker[\s_:-]*/, "").replace(/[^\p{L}\p{N}]+/gu, "") || "unknown";
}

export function unresolvedSpeakerKey(value: string): boolean {
  return ["unknown", "unresolved", "pending", "待确认", "未知", "不明"].includes(value);
}

export function speakerReferenceMap(value: unknown): Record<string, string> {
  let source: unknown = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return {}; }
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(Object.entries(source).filter(([name, speaker]) =>
    /^nq_voice_[1-4]$/.test(name) && speaker === `Speaker ${name.at(-1)}`));
}

/** Extract the browser-prepared PCM WAV without a decoder or extra model call. */
export function prepareSpeakerReferences(
  audio: ArrayBuffer,
  segments: DiarizedTranscriptSegment[],
): SpeakerReference[] {
  const view = new DataView(audio);
  const tag = (offset: number) => offset + 4 <= view.byteLength
    ? String.fromCharCode(...new Uint8Array(audio, offset, 4)) : "";
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return [];
  let formatOffset = -1;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > view.byteLength) return [];
    if (tag(offset) === "fmt " && size >= 16) formatOffset = offset + 8;
    if (tag(offset) === "data") { dataOffset = offset + 8; dataLength = size; }
    offset += 8 + size + (size % 2);
  }
  if (formatOffset < 0 || dataOffset < 0) return [];
  const format = view.getUint16(formatOffset, true);
  const channels = view.getUint16(formatOffset + 2, true);
  const sampleRate = view.getUint32(formatOffset + 4, true);
  const bits = view.getUint16(formatOffset + 14, true);
  const blockAlign = view.getUint16(formatOffset + 12, true);
  if (format !== 1 || channels !== 1 || bits !== 16 || sampleRate < 8000
    || sampleRate > 48000 || blockAlign !== 2 || dataLength % blockAlign) return [];
  const duration = dataLength / (sampleRate * blockAlign);
  const speakers = [...new Set(segments.map(s => normalizeSpeakerKey(s.speaker)))]
    .filter(key => !unresolvedSpeakerKey(key)).slice(0, 4);
  const refs: SpeakerReference[] = [];
  for (const [index, speaker] of speakers.entries()) {
    const turns = segments.filter(s => normalizeSpeakerKey(s.speaker) === speaker
      && Number.isFinite(s.startSeconds) && Number.isFinite(s.endSeconds)
      && s.startSeconds >= 0 && s.endSeconds <= duration + 0.02 && s.text.trim());
    if (turns.reduce((sum, s) => sum + Math.max(0, s.endSeconds - s.startSeconds), 0) < 6) continue;
    const candidates = turns.map(s => ({
      start: s.startSeconds + 0.15,
      end: Math.min(s.endSeconds - 0.15, s.startSeconds + 8.15, duration),
    })).filter(clip => clip.end - clip.start >= 2
      && !segments.some(s => normalizeSpeakerKey(s.speaker) !== speaker
        && s.startSeconds < clip.end && s.endSeconds > clip.start))
      .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const clip = candidates[0];
    if (!clip) continue;
    const startFrame = Math.ceil(clip.start * sampleRate);
    const endFrame = Math.floor(clip.end * sampleRate);
    if (endFrame - startFrame < 2 * sampleRate) continue;
    const pcm = new Uint8Array(audio, dataOffset + startFrame * blockAlign, (endFrame - startFrame) * blockAlign);
    const wav = new Uint8Array(44 + pcm.byteLength);
    const header = new DataView(wav.buffer);
    const writeTag = (offset: number, value: string) => wav.set(new TextEncoder().encode(value), offset);
    writeTag(0, "RIFF"); header.setUint32(4, 36 + pcm.byteLength, true);
    writeTag(8, "WAVE"); writeTag(12, "fmt "); header.setUint32(16, 16, true);
    header.setUint16(20, 1, true); header.setUint16(22, 1, true);
    header.setUint32(24, sampleRate, true); header.setUint32(28, sampleRate * blockAlign, true);
    header.setUint16(32, blockAlign, true); header.setUint16(34, bits, true);
    writeTag(36, "data"); header.setUint32(40, pcm.byteLength, true); wav.set(pcm, 44);
    let binary = "";
    for (let offset = 0; offset < wav.length; offset += 8192) {
      binary += String.fromCharCode(...wav.subarray(offset, offset + 8192));
    }
    refs.push({ name: `nq_voice_${index + 1}`, canonicalSpeaker: `Speaker ${index + 1}`,
      startSeconds: startFrame / sampleRate, endSeconds: endFrame / sampleRate,
      dataUrl: `data:audio/wav;base64,${btoa(binary)}` });
  }
  return refs;
}
