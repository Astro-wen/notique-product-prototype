export const AUDIO_TRANSCRIPTION_MODEL_DEFAULT = "gpt-4o-transcribe-diarize";
export const AUDIO_TRANSCRIPTION_SCHEMA_VERSION = "diarized-transcript.v1";
export const AUDIO_TRANSCRIPTION_PARSER_VERSION = "openai-diarized-json.v1";
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const AUDIO_FILE_ACCEPT = ".mp3,.mp4,.mpeg,.mpga,.m4a,.wav,.webm";

export const AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "video/mp4",
] as const;

const EXTENSION_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  mp4: "audio/mp4",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
};

export type DiarizedTranscriptSegment = {
  speaker: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type ValidatedDiarizedTranscript = {
  durationSeconds: number | null;
  text: string;
  segments: DiarizedTranscriptSegment[];
};

function normalizedMime(value: string): string {
  return value.trim().toLowerCase().split(";", 1)[0] ?? "";
}

export function audioMimeFor(filename: string, declaredMime: string): string | null {
  const declared = normalizedMime(declaredMime);
  const extension = filename.toLowerCase().split(".").at(-1) ?? "";
  const fromExtension = EXTENSION_MIME[extension];
  if (!fromExtension) return null;
  if (!declared || declared === "application/octet-stream") return fromExtension;
  return (AUDIO_MIME_TYPES as readonly string[]).includes(declared)
    ? declared
    : null;
}

export function validAudioMagic(mime: string, bytes: Uint8Array): boolean {
  const value = normalizedMime(mime);
  if (value === "audio/wav" || value === "audio/x-wav") {
    return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
  }
  if (value === "audio/webm") {
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  if (value === "audio/mpeg" || value === "audio/mp3") {
    return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  }
  if (value === "audio/mp4" || value === "audio/x-m4a" || value === "video/mp4") {
    return ascii(bytes, 4, 8) === "ftyp";
  }
  return false;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

function nonEmptyText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be non-empty text no longer than ${max} characters.`);
  }
  return value.trim();
}

export function validateDiarizedTranscriptOutput(
  input: unknown,
): ValidatedDiarizedTranscript {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Transcription response must be an object.");
  }
  const source = input as Record<string, unknown>;
  if (!Array.isArray(source.segments) || source.segments.length < 1 || source.segments.length > 10_000) {
    throw new Error("Transcription response must contain 1 to 10,000 speaker segments.");
  }
  let previousStart = -1;
  let totalCharacters = 0;
  const segments = source.segments.map((item, index): DiarizedTranscriptSegment => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`segments[${index}] must be an object.`);
    }
    const row = item as Record<string, unknown>;
    const speaker = nonEmptyText(row.speaker, `segments[${index}].speaker`, 100);
    const text = nonEmptyText(row.text, `segments[${index}].text`, 20_000);
    const startSeconds = finiteNumber(row.start, `segments[${index}].start`);
    const endSeconds = finiteNumber(row.end, `segments[${index}].end`);
    if (startSeconds < 0 || endSeconds < startSeconds) {
      throw new Error(`segments[${index}] has an invalid time range.`);
    }
    if (startSeconds < previousStart) {
      throw new Error("Transcription segments must be ordered by start time.");
    }
    previousStart = startSeconds;
    totalCharacters += text.length;
    if (totalCharacters > 5 * 1024 * 1024) {
      throw new Error("Transcription text exceeds the 5 MiB safety limit.");
    }
    return { speaker, text, startSeconds, endSeconds };
  });
  const responseDuration = source.duration === undefined
    ? null
    : finiteNumber(source.duration, "duration");
  const maxEnd = Math.max(...segments.map((segment) => segment.endSeconds));
  const durationSeconds = responseDuration === null
    ? maxEnd
    : Math.max(responseDuration, maxEnd);
  const fullText = typeof source.text === "string" && source.text.trim()
    ? source.text.trim()
    : segments.map((segment) => segment.text).join(" ");
  return { durationSeconds, text: fullText, segments };
}

export function diarizedTranscriptJson(value: ValidatedDiarizedTranscript): string {
  return JSON.stringify({
    schema_version: AUDIO_TRANSCRIPTION_SCHEMA_VERSION,
    duration: value.durationSeconds,
    text: value.text,
    segments: value.segments.map((segment) => ({
      speaker: segment.speaker,
      start: segment.startSeconds,
      end: segment.endSeconds,
      text: segment.text,
    })),
  });
}
