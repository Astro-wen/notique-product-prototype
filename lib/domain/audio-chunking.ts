import type {
  DiarizedTranscriptSegment,
  ValidatedDiarizedTranscript,
} from "@/lib/domain/audio-transcription";

export const AUDIO_CHUNK_TARGET_MS = 3 * 60_000;
export const AUDIO_CHUNK_OVERLAP_MS = 15_000;
export const AUDIO_CHUNK_MIN_DURATION_MS = 5 * 60_000;
export const AUDIO_CHUNK_MIN_SOURCE_BYTES = 18 * 1024 * 1024;
export const AUDIO_CHUNK_MAX_PARALLEL = 6;
export const MAX_STABLE_SPEAKER_COUNT = 4;
export const UNRESOLVED_SPEAKER_LABEL = "Speaker unknown";

/**
 * Keep short recordings conservative while letting a long recording fill one
 * bounded six-lane provider batch. This does not add chunks or model work; it
 * only avoids leaving already-prepared chunks idle behind a four-lane wave.
 */
export function audioChunkParallelism(chunkCountValue: number): number {
  const chunkCount = Math.max(1, Math.floor(finiteNonNegative(chunkCountValue, "chunkCount")));
  if (chunkCount >= 6) return AUDIO_CHUNK_MAX_PARALLEL;
  return Math.min(3, chunkCount);
}

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

function isStableSpeakerLabel(value: string): boolean {
  const match = value.match(/^Speaker (\d+)$/);
  if (!match) return false;
  const speakerNumber = Number(match[1]);
  return speakerNumber >= 1 && speakerNumber <= MAX_STABLE_SPEAKER_COUNT;
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
  let nextGlobalSpeaker = 1;
  let previousChunkSpeakers: string[] = [];
  let previousLocalSpeakerMap = new Map<string, string>();
  for (const chunk of chunks) {
    const offsetSeconds = chunk.startMs / 1_000;
    const absoluteSegments = chunk.transcript.segments.map((source) => ({
      speaker: source.speaker,
      text: source.text,
      startSeconds: offsetSeconds + source.startSeconds,
      endSeconds: offsetSeconds + source.endSeconds,
      chunkIndex: chunk.index,
    }));
    const localSpeakers = [...new Set(absoluteSegments.map((segment) => segment.speaker))];
    const speakerMap = new Map<string, string>();
    const usedGlobalSpeakers = new Set<string>();
    const votes: Array<{ local: string; global: string; score: number }> = [];

    if (chunk.index > 0) {
      for (const segment of absoluteSegments) {
        for (const candidate of merged) {
          if (
            candidate.chunkIndex !== chunk.index - 1
            || !isStableSpeakerLabel(candidate.speaker)
            || !duplicateAcrossBoundary(candidate, segment)
          ) continue;
          votes.push({
            local: segment.speaker,
            global: candidate.speaker,
            score: textSimilarity(candidate.text, segment.text),
          });
        }
      }
      votes.sort((left, right) => right.score - left.score || left.local.localeCompare(right.local));
      for (const vote of votes) {
        if (speakerMap.has(vote.local) || usedGlobalSpeakers.has(vote.global)) continue;
        speakerMap.set(vote.local, vote.global);
        usedGlobalSpeakers.add(vote.global);
      }

      // In the common two-person case one overlap anchor determines the other
      // speaker by elimination. Do this only when the adjacent chunks contain
      // the same number of speakers and exactly one identity remains.
      const unmappedLocal = localSpeakers.filter((speaker) => !speakerMap.has(speaker));
      const unusedPrevious = previousChunkSpeakers.filter((speaker) => !usedGlobalSpeakers.has(speaker));
      if (
        speakerMap.size > 0
        && localSpeakers.length === previousChunkSpeakers.length
        && unmappedLocal.length === 1
        && unusedPrevious.length === 1
      ) {
        speakerMap.set(unmappedLocal[0]!, unusedPrevious[0]!);
        usedGlobalSpeakers.add(unusedPrevious[0]!);
      }

      // OpenAI assigns chunk-local labels independently. When the overlap is
      // silent or contains no repeated phrase, retain the immediately prior
      // local-label mapping instead of minting another global identity. A
      // proven overlap vote above always wins when labels changed at a chunk
      // boundary.
      for (const localSpeaker of localSpeakers) {
        if (speakerMap.has(localSpeaker)) continue;
        const previousGlobal = previousLocalSpeakerMap.get(localSpeaker);
        if (
          previousGlobal
          && isStableSpeakerLabel(previousGlobal)
          && !usedGlobalSpeakers.has(previousGlobal)
        ) {
          speakerMap.set(localSpeaker, previousGlobal);
          usedGlobalSpeakers.add(previousGlobal);
        }
      }
    }

    // A higher local speaker count is the only deterministic evidence, in
    // the absence of an overlap anchor, that a new participant may have
    // appeared. Never create more than four canonical identities: the
    // provider supports at most four known-speaker references, and inventing
    // Speaker 5...13 is more misleading than marking the identity unresolved.
    let newSpeakerSlots = chunk.index === 0
      ? MAX_STABLE_SPEAKER_COUNT
      : Math.max(0, localSpeakers.length - previousChunkSpeakers.length);
    for (const localSpeaker of localSpeakers) {
      if (speakerMap.has(localSpeaker)) continue;
      if (newSpeakerSlots > 0 && nextGlobalSpeaker <= MAX_STABLE_SPEAKER_COUNT) {
        speakerMap.set(localSpeaker, `Speaker ${nextGlobalSpeaker}`);
        nextGlobalSpeaker += 1;
        newSpeakerSlots -= 1;
      } else {
        speakerMap.set(localSpeaker, UNRESOLVED_SPEAKER_LABEL);
      }
    }

    const alignedSegments = absoluteSegments.map((segment) => ({
      ...segment,
      speaker: speakerMap.get(segment.speaker)!,
    }));
    previousLocalSpeakerMap = new Map(speakerMap);
    previousChunkSpeakers = [...new Set(
      alignedSegments
        .map((segment) => segment.speaker)
        .filter(isStableSpeakerLabel),
    )];

    for (const segment of alignedSegments) {
      const normalizedSegment = {
        speaker: segment.speaker,
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        chunkIndex: chunk.index,
      };
      const duplicateIndex = merged.findIndex((candidate) =>
        candidate.chunkIndex === chunk.index - 1 && duplicateAcrossBoundary(candidate, normalizedSegment));
      if (duplicateIndex < 0) {
        merged.push(normalizedSegment);
        continue;
      }
      const existing = merged[duplicateIndex]!;
      if (normalizedWords(normalizedSegment.text).length > normalizedWords(existing.text).length) {
        merged[duplicateIndex] = {
          ...normalizedSegment,
          startSeconds: Math.min(existing.startSeconds, normalizedSegment.startSeconds),
          endSeconds: Math.max(existing.endSeconds, normalizedSegment.endSeconds),
        };
      } else {
        existing.startSeconds = Math.min(existing.startSeconds, normalizedSegment.startSeconds);
        existing.endSeconds = Math.max(existing.endSeconds, normalizedSegment.endSeconds);
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
