import type {
  DiarizedTranscriptSegment,
  ValidatedDiarizedTranscript,
} from "@/lib/domain/audio-transcription";

export const AUDIO_CHUNK_TARGET_MS = 3 * 60_000;
export const AUDIO_CHUNK_OVERLAP_MS = 5_000;
export const AUDIO_CHUNK_MIN_DURATION_MS = 5 * 60_000;
export const AUDIO_CHUNK_MIN_SOURCE_BYTES = 18 * 1024 * 1024;
export const AUDIO_CHUNK_MAX_PARALLEL = 3;

export type AudioChunkPlanItem = {
  index: number;
  startMs: number;
  endMs: number;
};

export type ChunkTranscriptInput = AudioChunkPlanItem & {
  assetVersionId: string;
  transcript: ValidatedDiarizedTranscript;
};

function finiteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number.`);
  }
  return Math.round(value);
}

export function shouldChunkAudio(input: {
  durationMs: number;
  sizeBytes: number;
}): boolean {
  const durationMs = finiteNonNegative(input.durationMs, "durationMs");
  const sizeBytes = finiteNonNegative(input.sizeBytes, "sizeBytes");
  return durationMs > AUDIO_CHUNK_MIN_DURATION_MS || sizeBytes > AUDIO_CHUNK_MIN_SOURCE_BYTES;
}

export function planAudioChunks(
  durationMsValue: number,
  targetMsValue = AUDIO_CHUNK_TARGET_MS,
  overlapMsValue = AUDIO_CHUNK_OVERLAP_MS,
): AudioChunkPlanItem[] {
  const durationMs = finiteNonNegative(durationMsValue, "durationMs");
  const targetMs = finiteNonNegative(targetMsValue, "targetMs");
  const overlapMs = finiteNonNegative(overlapMsValue, "overlapMs");
  if (durationMs === 0) throw new Error("durationMs must be greater than zero.");
  if (targetMs < 30_000) throw new Error("targetMs must be at least 30 seconds.");
  if (overlapMs >= targetMs / 2) {
    throw new Error("overlapMs must be less than half the target duration.");
  }

  const result: AudioChunkPlanItem[] = [];
  const stepMs = targetMs - overlapMs;
  let index = 0;
  for (let startMs = 0; startMs < durationMs; startMs += stepMs) {
    const endMs = Math.min(durationMs, startMs + targetMs);
    result.push({ index, startMs, endMs });
    index += 1;
    if (endMs === durationMs) break;
  }
  return result;
}

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function textSimilarity(left: string, right: string): number {
  const leftWords = normalizedWords(left);
  const rightWords = normalizedWords(right);
  if (!leftWords.length || !rightWords.length) return 0;
  const leftSet = new Set(leftWords);
  const rightSet = new Set(rightWords);
  let intersection = 0;
  for (const word of leftSet) if (rightSet.has(word)) intersection += 1;
  const union = new Set([...leftSet, ...rightSet]).size;
  const jaccard = union ? intersection / union : 0;
  const leftText = leftWords.join(" ");
  const rightText = rightWords.join(" ");
  const containment = leftText.includes(rightText) || rightText.includes(leftText)
    ? Math.min(leftText.length, rightText.length) / Math.max(leftText.length, rightText.length)
    : 0;
  return Math.max(jaccard, containment);
}

function rangesOverlap(
  left: DiarizedTranscriptSegment,
  right: DiarizedTranscriptSegment,
): boolean {
  return Math.min(left.endSeconds, right.endSeconds) >= Math.max(left.startSeconds, right.startSeconds) - 0.75;
}

function duplicateAcrossBoundary(
  left: DiarizedTranscriptSegment,
  right: DiarizedTranscriptSegment,
): boolean {
  return rangesOverlap(left, right) && textSimilarity(left.text, right.text) >= 0.78;
}

/**
 * Merge independently-transcribed chunks back onto the original recording's
 * absolute timeline. The original audio remains the Evidence source; chunk
 * files are only temporary provider inputs.
 */
export function mergeChunkTranscripts(chunksValue: ChunkTranscriptInput[]): ValidatedDiarizedTranscript {
  if (!chunksValue.length) throw new Error("At least one chunk transcript is required.");
  const chunks = [...chunksValue].sort((left, right) => left.index - right.index);
  chunks.forEach((chunk, position) => {
    if (chunk.index !== position) throw new Error("Chunk indices must be contiguous from zero.");
    if (chunk.endMs <= chunk.startMs) throw new Error(`Chunk ${chunk.index} has an invalid time range.`);
    if (position > 0 && chunk.startMs >= chunks[position - 1]!.endMs) {
      throw new Error("Adjacent chunks must overlap so boundary speech can be reconciled.");
    }
  });

  const merged: Array<DiarizedTranscriptSegment & { chunkIndex: number }> = [];
  for (const chunk of chunks) {
    const offsetSeconds = chunk.startMs / 1_000;
    for (const source of chunk.transcript.segments) {
      const segment = {
        speaker: source.speaker,
        text: source.text,
        startSeconds: offsetSeconds + source.startSeconds,
        endSeconds: offsetSeconds + source.endSeconds,
        chunkIndex: chunk.index,
      };
      const duplicateIndex = merged.findIndex((candidate) =>
        candidate.chunkIndex === chunk.index - 1 && duplicateAcrossBoundary(candidate, segment));
      if (duplicateIndex < 0) {
        merged.push(segment);
        continue;
      }
      const existing = merged[duplicateIndex]!;
      if (normalizedWords(segment.text).length > normalizedWords(existing.text).length) {
        merged[duplicateIndex] = {
          ...segment,
          startSeconds: Math.min(existing.startSeconds, segment.startSeconds),
          endSeconds: Math.max(existing.endSeconds, segment.endSeconds),
        };
      } else {
        existing.startSeconds = Math.min(existing.startSeconds, segment.startSeconds);
        existing.endSeconds = Math.max(existing.endSeconds, segment.endSeconds);
      }
    }
  }

  const segments = merged
    .sort((left, right) => left.startSeconds - right.startSeconds || left.chunkIndex - right.chunkIndex)
    .map((segment) => ({
      speaker: segment.speaker,
      text: segment.text,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
    }));
  if (!segments.length) throw new Error("Chunk transcripts did not contain spoken text.");
  return {
    durationSeconds: Math.max(
      chunks.at(-1)!.endMs / 1_000,
      ...segments.map((segment) => segment.endSeconds),
    ),
    text: segments.map((segment) => segment.text).join(" "),
    segments,
  };
}
