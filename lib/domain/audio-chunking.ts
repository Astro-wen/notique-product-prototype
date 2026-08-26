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
 * Every prepared chunk gets a provider lane immediately, up to the bounded
 * six-lane batch. This changes only concurrency, not chunk count or model work.
 */
export function audioChunkParallelism(chunkCountValue: number): number {
  const chunkCount = Math.max(1, Math.floor(finiteNonNegative(chunkCountValue, "chunkCount")));
  return Math.min(AUDIO_CHUNK_MAX_PARALLEL, chunkCount);
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

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function characterGrams(value: string): Set<string> {
  const text = normalizedText(value);
  if (!text) return new Set();
  const width = text.length >= 8 ? 3 : text.length >= 4 ? 2 : 1;
  const grams = new Set<string>();
  for (let index = 0; index <= text.length - width; index += 1) {
    grams.add(text.slice(index, index + width));
  }
  return grams;
}

function setSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
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
  const leftCompact = normalizedText(left);
  const rightCompact = normalizedText(right);
  const characterSimilarity = setSimilarity(characterGrams(left), characterGrams(right));
  const characterContainment = leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact)
    ? Math.min(leftCompact.length, rightCompact.length) / Math.max(leftCompact.length, rightCompact.length)
    : 0;
  return Math.max(jaccard, containment, characterSimilarity, characterContainment);
}

function rangesOverlap(
  left: DiarizedTranscriptSegment,
  right: DiarizedTranscriptSegment,
): boolean {
  return Math.min(left.endSeconds, right.endSeconds) >= Math.max(left.startSeconds, right.startSeconds) - 0.25;
}

const LOW_INFORMATION_UTTERANCES = new Set([
  "ah", "gotit", "hm", "hmm", "mhm", "nah", "no", "ok", "okay", "right", "sure", "uh", "uhh", "um", "yeah", "yep", "yes",
  "嗯", "啊", "哦", "对", "好", "好的", "行", "是", "是的", "可以", "没错",
]);

function lowInformationUtterance(value: string): boolean {
  const text = normalizedText(value);
  return text.length <= 3 || LOW_INFORMATION_UTTERANCES.has(text);
}

const PROTECTED_BOUNDARY_PATTERNS = [
  /[$€£¥￥]\s*[+-]?\d[\d,.]*(?:%|％)?/gu,
  /[+-]?\d[\d,.]*(?:%|％)?/gu,
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/giu,
  /[零〇一二三四五六七八九十百千万亿两]+/gu,
  /\b(?:usd|cad|aud|eur|gbp|rmb|dollars?|euros?|pounds?|percent|days?|weeks?|months?|years?|hours?|minutes?|bedrooms?|bathrooms?|acres?|hectares?|sq\.?\s*ft|square\s+feet)\b/giu,
  /(?:美元|加元|澳元|欧元|英镑|人民币|元|万元|百分之|天|周|星期|个月|月|年|小时|分钟|平米|平方米|平方英尺|英亩|公顷|房|室|卫)/gu,
  /\b(?:can't|cannot|couldn't|didn't|doesn't|don't|isn't|mustn't|never|no|not|shouldn't|wasn't|weren't|without|won't|wouldn't)\b/giu,
  /(?:不能|不会|不要|不是|没有|不想|不需要|没法|没|无|未)/gu,
];

function protectedBoundarySignature(value: string): string[] {
  const text = value.normalize("NFKC").toLocaleLowerCase().replace(/[’‘`´ʼ]/g, "'");
  return PROTECTED_BOUNDARY_PATTERNS
    .flatMap((pattern) => [...text.matchAll(pattern)].map((match) => ({
      index: match.index,
      value: match[0].replace(/[\s,]/g, ""),
    })))
    .sort((left, right) => left.index - right.index || left.value.localeCompare(right.value))
    .map((match) => match.value);
}

function sameProtectedBoundarySemantics(left: string, right: string): boolean {
  const leftTokens = protectedBoundarySignature(left);
  const rightTokens = protectedBoundarySignature(right);
  return leftTokens.length === rightTokens.length
    && leftTokens.every((token, index) => rightTokens[index] === token);
}

function midpointSeconds(segment: DiarizedTranscriptSegment): number {
  return (segment.startSeconds + segment.endSeconds) / 2;
}

function boundaryMatchScore(
  left: DiarizedTranscriptSegment,
  right: DiarizedTranscriptSegment,
): number {
  if (!rangesOverlap(left, right)) return 0;
  const similarity = textSimilarity(left.text, right.text);
  const midpointDistance = Math.abs(midpointSeconds(left) - midpointSeconds(right));
  const lowInformation = lowInformationUtterance(left.text) || lowInformationUtterance(right.text);
  if (lowInformation && (similarity < 0.99 || midpointDistance > 0.2)) return 0;
  if (!lowInformation && similarity < 0.4) return 0;
  const timeScore = Math.max(0, 1 - midpointDistance / 1.5);
  return similarity * 0.76 + timeScore * 0.24;
}

function normalizeLocalSpeakerKey(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/^speaker[\s_:-]*/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return normalized || "unknown";
}

const UNRESOLVED_LOCAL_SPEAKER_KEYS = new Set([
  "unknown", "unresolved", "pending", "待确认", "未知", "不明",
]);

function unresolvedLocalSpeakerKey(value: string): boolean {
  return UNRESOLVED_LOCAL_SPEAKER_KEYS.has(value);
}

function insideSharedBoundary(
  segment: DiarizedTranscriptSegment,
  sharedStartSeconds: number,
  sharedEndSeconds: number,
): boolean {
  return segment.endSeconds >= sharedStartSeconds - 0.25
    && segment.startSeconds <= sharedEndSeconds + 0.25;
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
  const speakerHistory = new Map<string, { global: string; lastSeenChunk: number }>();
  for (const chunk of chunks) {
    const offsetSeconds = chunk.startMs / 1_000;
    const absoluteSegments = chunk.transcript.segments.map((source) => ({
      speaker: source.speaker,
      localSpeakerKey: normalizeLocalSpeakerKey(source.speaker),
      text: source.text,
      startSeconds: offsetSeconds + source.startSeconds,
      endSeconds: offsetSeconds + source.endSeconds,
      chunkIndex: chunk.index,
    }));
    const localSpeakers = [...new Set(absoluteSegments.map((segment) => segment.localSpeakerKey))];
    const speakerMap = new Map<string, string>();
    for (const localSpeaker of localSpeakers) {
      if (unresolvedLocalSpeakerKey(localSpeaker)) {
        speakerMap.set(localSpeaker, UNRESOLVED_SPEAKER_LABEL);
      }
    }
    const usedGlobalSpeakers = new Set<string>();
    let boundaryAnchorCount = 0;
    const previousChunk = chunk.index > 0 ? chunks[chunk.index - 1]! : null;
    const sharedStartSeconds = chunk.startMs / 1_000;
    const sharedEndSeconds = previousChunk ? previousChunk.endMs / 1_000 : sharedStartSeconds;
    const voteGroups = new Map<string, {
      local: string;
      global: string;
      total: number;
      best: number;
      count: number;
    }>();

    if (chunk.index > 0) {
      for (const segment of absoluteSegments) {
        if (unresolvedLocalSpeakerKey(segment.localSpeakerKey)) continue;
        if (!insideSharedBoundary(segment, sharedStartSeconds, sharedEndSeconds)) continue;
        for (const candidate of merged) {
          if (
            candidate.chunkIndex !== chunk.index - 1
            || !isStableSpeakerLabel(candidate.speaker)
            || !insideSharedBoundary(candidate, sharedStartSeconds, sharedEndSeconds)
          ) continue;
          const score = boundaryMatchScore(candidate, segment);
          if (score < 0.62) continue;
          const key = `${segment.localSpeakerKey}\u0000${candidate.speaker}`;
          const existing = voteGroups.get(key);
          voteGroups.set(key, {
            local: segment.localSpeakerKey,
            global: candidate.speaker,
            total: (existing?.total ?? 0) + score,
            best: Math.max(existing?.best ?? 0, score),
            count: (existing?.count ?? 0) + 1,
          });
        }
      }
      const votes = [...voteGroups.values()].sort((left, right) => {
        const leftScore = left.total + Math.min(2, left.count - 1) * 0.12 + left.best * 0.2;
        const rightScore = right.total + Math.min(2, right.count - 1) * 0.12 + right.best * 0.2;
        return rightScore - leftScore || left.local.localeCompare(right.local) || left.global.localeCompare(right.global);
      });
      const voteStrength = (vote: typeof votes[number]) =>
        vote.total + Math.min(2, vote.count - 1) * 0.12 + vote.best * 0.2;
      for (const vote of votes) {
        if (speakerMap.has(vote.local) || usedGlobalSpeakers.has(vote.global)) continue;
        const strength = voteStrength(vote);
        const localRival = votes.find((candidate) =>
          candidate.local === vote.local && candidate.global !== vote.global);
        const globalRival = votes.find((candidate) =>
          candidate.global === vote.global && candidate.local !== vote.local);
        if (
          (localRival && strength - voteStrength(localRival) < 0.08)
          || (globalRival && strength - voteStrength(globalRival) < 0.08)
        ) continue;
        speakerMap.set(vote.local, vote.global);
        usedGlobalSpeakers.add(vote.global);
        boundaryAnchorCount += 1;
      }

      // Provider labels are local to one chunk. Reuse a label only across the
      // immediately adjacent boundary; an absent participant returning later
      // cannot be identified safely without voice evidence.
      for (const localSpeaker of localSpeakers) {
        if (speakerMap.has(localSpeaker)) continue;
        const historical = speakerHistory.get(localSpeaker);
        if (
          historical?.lastSeenChunk === chunk.index - 1
          && !usedGlobalSpeakers.has(historical.global)
        ) {
          speakerMap.set(localSpeaker, historical.global);
          usedGlobalSpeakers.add(historical.global);
        }
      }

      // In the common stable-participant case, one or more strong anchors can
      // determine the only remaining identity. Never use elimination without
      // at least one real boundary anchor.
      const unmappedLocal = localSpeakers.filter((speaker) => !speakerMap.has(speaker));
      const unusedPrevious = previousChunkSpeakers.filter((speaker) => !usedGlobalSpeakers.has(speaker));
      if (
        boundaryAnchorCount > 0
        && localSpeakers.length === previousChunkSpeakers.length
        && unmappedLocal.length === 1
        && unusedPrevious.length === 1
      ) {
        speakerMap.set(unmappedLocal[0]!, unusedPrevious[0]!);
        usedGlobalSpeakers.add(unusedPrevious[0]!);
      }
    }

    // Never create more than four canonical identities. A previously seen
    // local label that returns without a trustworthy adjacent-boundary match
    // stays unresolved instead of impersonating an earlier participant.
    for (const localSpeaker of localSpeakers) {
      if (speakerMap.has(localSpeaker)) continue;
      const trulyNewLocalLabel = !speakerHistory.has(localSpeaker);
      if (trulyNewLocalLabel && nextGlobalSpeaker <= MAX_STABLE_SPEAKER_COUNT) {
        speakerMap.set(localSpeaker, `Speaker ${nextGlobalSpeaker}`);
        nextGlobalSpeaker += 1;
      } else {
        speakerMap.set(localSpeaker, UNRESOLVED_SPEAKER_LABEL);
      }
    }

    const alignedSegments = absoluteSegments.map((segment) => ({
      ...segment,
      speaker: speakerMap.get(segment.localSpeakerKey)!,
    }));
    for (const [localSpeaker, globalSpeaker] of speakerMap) {
      if (isStableSpeakerLabel(globalSpeaker)) {
        speakerHistory.set(localSpeaker, { global: globalSpeaker, lastSeenChunk: chunk.index });
      }
    }
    previousChunkSpeakers = [...new Set(
      alignedSegments
        .map((segment) => segment.speaker)
        .filter(isStableSpeakerLabel),
    )];

    const consumedPreviousSegments = new Set<number>();
    for (const segment of alignedSegments) {
      const normalizedSegment = {
        speaker: segment.speaker,
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        chunkIndex: chunk.index,
      };
      const duplicateIndex = chunk.index === 0 || !isStableSpeakerLabel(normalizedSegment.speaker)
        ? -1
        : merged.reduce((bestIndex, candidate, candidateIndex) => {
            if (
              consumedPreviousSegments.has(candidateIndex)
              || candidate.chunkIndex !== chunk.index - 1
              || candidate.speaker !== normalizedSegment.speaker
              || !insideSharedBoundary(candidate, sharedStartSeconds, sharedEndSeconds)
              || !insideSharedBoundary(normalizedSegment, sharedStartSeconds, sharedEndSeconds)
            ) return bestIndex;
            const score = boundaryMatchScore(candidate, normalizedSegment);
            if (
              score < 0.62
              || !sameProtectedBoundarySemantics(candidate.text, normalizedSegment.text)
            ) return bestIndex;
            if (bestIndex < 0) return candidateIndex;
            return score > boundaryMatchScore(merged[bestIndex]!, normalizedSegment)
              ? candidateIndex
              : bestIndex;
          }, -1);
      if (duplicateIndex < 0) {
        merged.push(normalizedSegment);
        continue;
      }
      consumedPreviousSegments.add(duplicateIndex);
      const existing = merged[duplicateIndex]!;
      if (normalizedText(normalizedSegment.text).length > normalizedText(existing.text).length) {
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
