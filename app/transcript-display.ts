import { parsePlainTranscriptCue } from '../lib/domain/transcript.ts';

export type TranscriptDisplaySegment = {
  key: string;
  assetVersionId: string | null;
  speaker: string | null;
  text: string;
  startMs: number | null;
  endMs: number | null;
  sourceIds: string[];
  edits: Record<string, unknown>[];
  needsCheck: boolean;
};

export type TranscriptDisplayGroup = TranscriptDisplaySegment & {
  segmentCount: number;
  interruptionMarker: string | null;
};

const MAX_GROUP_GAP_MS = 3_000;
const MAX_GROUP_DURATION_MS = 90_000;
const MAX_GROUP_CHARACTERS = 1_500;
const MAX_BACKCHANNEL_GAP_MS = 2_500;
const BRIEF_BACKCHANNEL_PATTERN = /^(?:(?:ok(?:ay)?|right|sure|m+h+m*|mm(?:-?hmm)?|uh-?huh|got it)|(?:嗯+|啊+|哦+|对|好(?:的)?|行|是(?:的)?|明白|可以|没错))[.!?,，。！？、\s]*$/iu;
const INCOMPLETE_TURN_PATTERN = /(?:\b(?:i['’](?:d|ll|m|ve)|we['’](?:d|ll|re|ve)|you['’](?:d|ll|re|ve)|would|could|should|to|and|or|but|if|because|that|about)|(?:然后|但是|因为|所以|如果|就是|我想|我们|还有)|[,;:，；：、—-])\s*$/iu;
const STANDALONE_FILLER_PATTERN = /(^|[\s,(—-])(?:uh+|um+|erm+|hmm+)(?=$|[\s,.!?;:)—-])/giu;
const CLEAR_OVERLAP_MS = 250;

function speakerIdentity(speaker: string | null): string | null {
  const normalized = speaker?.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!normalized) return null;
  if (/unknown|unresolved|待确认|未知/.test(normalized)) return null;
  return normalized;
}

function joinTranscriptText(left: string, right: string): string {
  const before = left.trimEnd();
  const after = right.trimStart();
  if (!before) return after;
  if (!after) return before;
  const cjkBefore = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(before);
  const cjkAfter = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(after);
  const endsWithCjkPunctuation = /[，。；：！？、]$/u.test(before);
  const startsWithPunctuation = /^[,.;:!?，。；：！？、)\]】》”’]/u.test(after);
  return `${before}${(cjkBefore || endsWithCjkPunctuation) && cjkAfter || startsWithPunctuation ? "" : " "}${after}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function cleanReadableText(text: string): string {
  return text
    .replace(STANDALONE_FILLER_PATTERN, "$1")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function usesRawFallback(segment: Pick<TranscriptDisplaySegment, "key">): boolean {
  return segment.key.includes("raw_fallback_");
}

function sameSpeaker(left: TranscriptDisplaySegment, right: TranscriptDisplaySegment): boolean {
  const leftSpeaker = speakerIdentity(left.speaker);
  return Boolean(leftSpeaker && leftSpeaker === speakerIdentity(right.speaker));
}

function nearby(left: TranscriptDisplaySegment, right: TranscriptDisplaySegment): boolean {
  if (left.endMs == null || right.startMs == null) return false;
  const gapMs = right.startMs - left.endMs;
  return gapMs >= -250 && gapMs <= MAX_BACKCHANNEL_GAP_MS;
}

function languageMatchedInterruptionMarker(text: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "（割り込み）";
  if (/\p{Script=Hangul}/u.test(text)) return "(말 끊음)";
  if (/\p{Script=Han}/u.test(text)) return "（打断）";
  return "(interrupt)";
}

function isObviousInterruption(
  left: TranscriptDisplayGroup,
  interruption: TranscriptDisplayGroup,
  right: TranscriptDisplayGroup | undefined,
): boolean {
  const leftSpeaker = speakerIdentity(left.speaker);
  const interruptionSpeaker = speakerIdentity(interruption.speaker);
  if (!leftSpeaker || !interruptionSpeaker || leftSpeaker === interruptionSpeaker) return false;
  if (!left.assetVersionId || left.assetVersionId !== interruption.assetVersionId) return false;
  const overlapMs = left.endMs != null && interruption.startMs != null
    ? left.endMs - interruption.startMs
    : 0;
  if (overlapMs >= CLEAR_OVERLAP_MS) return true;
  if (!right || !sameSpeaker(left, right) || right.assetVersionId !== left.assetVersionId) return false;
  if (!nearby(left, interruption) || !nearby(interruption, right)) return false;
  if (!BRIEF_BACKCHANNEL_PATTERN.test(interruption.text.trim())) return false;
  return INCOMPLETE_TURN_PATTERN.test(left.text.trimEnd());
}

function markObviousInterruptions(groups: TranscriptDisplayGroup[]): TranscriptDisplayGroup[] {
  return groups.map((group, index) => {
    const left = groups[index - 1];
    if (!left || !isObviousInterruption(left, group, groups[index + 1])) return group;
    return {
      ...group,
      interruptionMarker: languageMatchedInterruptionMarker(group.text),
    };
  });
}

function canMerge(
  group: TranscriptDisplayGroup,
  next: TranscriptDisplaySegment,
): boolean {
  // Speaker labels such as "Speaker 1" restart for every source. Never join
  // passages across Asset Versions: doing so can make a click on the latter
  // passage seek the former recording.
  if (!group.assetVersionId || group.assetVersionId !== next.assetVersionId) return false;
  const currentSpeaker = speakerIdentity(group.speaker);
  const nextSpeaker = speakerIdentity(next.speaker);
  if (!currentSpeaker || currentSpeaker !== nextSpeaker) return false;

  if (group.endMs != null && next.startMs != null) {
    const gapMs = next.startMs - group.endMs;
    if (gapMs < -1_000 || gapMs > MAX_GROUP_GAP_MS) return false;
  }

  if (
    group.startMs != null
    && next.endMs != null
    && next.endMs - group.startMs > MAX_GROUP_DURATION_MS
  ) return false;

  return group.text.length + next.text.length + 1 <= MAX_GROUP_CHARACTERS;
}

type PreparedDisplaySegment = {
  segment: TranscriptDisplaySegment;
  segmentCount: number;
  explicitTurn: boolean;
};

/** Older TXT imports stored a cue and its speech as separate immutable rows.
 * Derive their presentation together while retaining every original anchor. */
function prepareLegacyCueSegments(segments: TranscriptDisplaySegment[]): PreparedDisplaySegment[] {
  const prepared: PreparedDisplaySegment[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const first = segments[index];
    const firstCue = parsePlainTranscriptCue(first.text);
    if (!first.assetVersionId || !firstCue || firstCue.text) {
      prepared.push({ segment: first, segmentCount: 1, explicitTurn: false });
      continue;
    }
    const headers: TranscriptDisplaySegment[] = [];
    let speaker: string | null = null;
    let startMs: number | null = null;
    let cursor = index;
    let conflicting = false;
    // A timestamp line followed by a speaker line is also one explicit cue.
    for (; cursor < Math.min(segments.length, index + 3); cursor += 1) {
      const header = segments[cursor];
      const cue = parsePlainTranscriptCue(header.text);
      if (header.assetVersionId !== first.assetVersionId || !cue || cue.text) break;
      const cueSpeaker = cue.speaker ?? header.speaker;
      const cueTime = cue.startMs ?? header.startMs;
      if (
        cue.speaker && header.speaker && speakerIdentity(cue.speaker) !== speakerIdentity(header.speaker)
        || cue.startMs != null && header.startMs != null && cue.startMs !== header.startMs
        || speaker && cueSpeaker && speakerIdentity(speaker) !== speakerIdentity(cueSpeaker)
        || startMs != null && cueTime != null && startMs !== cueTime
      ) { conflicting = true; break; }
      speaker ??= cueSpeaker;
      startMs ??= cueTime;
      headers.push(header);
    }
    const body = segments[cursor];
    // v1 also mistook a prose prefix before a colon for a speaker. Recover it
    // only beneath an explicit cue, when punctuation identifies it as prose.
    const prosePrefix = body?.speaker && /[.,!?。！？]/u.test(body.speaker)
      && !parsePlainTranscriptCue(`${body.speaker}:`) ? body.speaker : null;
    if (
      conflicting || !headers.length || !body || body.assetVersionId !== first.assetVersionId
      || body.speaker != null && !prosePrefix || body.startMs != null || body.endMs != null
      || !body.text.trim() || parsePlainTranscriptCue(body.text)
      || /^[^\n]{1,80}[:：]\s*$/u.test(body.text)
    ) {
      prepared.push({ segment: first, segmentCount: 1, explicitTurn: false });
      continue;
    }
    prepared.push({
      segment: {
        ...body,
        key: [...headers.map(header => header.key), body.key].join("--"),
        speaker,
        startMs,
        text: prosePrefix ? `${prosePrefix}: ${body.text}` : body.text,
        sourceIds: unique([...headers.flatMap(header => header.sourceIds), ...body.sourceIds]),
        edits: [...headers.flatMap(header => header.edits), ...body.edits],
        needsCheck: headers.some(header => header.needsCheck) || body.needsCheck,
      },
      segmentCount: headers.length + 1,
      explicitTurn: true,
    });
    index = cursor;
  }
  return prepared;
}

/**
 * Combines adjacent fragments from the same speaker for reading only.
 * Every original segment ID and timestamp remains attached to the group so
 * evidence navigation still targets the immutable raw transcript.
 */
export function groupConsecutiveSpeakerSegments(
  segments: TranscriptDisplaySegment[],
): TranscriptDisplayGroup[] {
  const groups: TranscriptDisplayGroup[] = [];
  for (const { segment, segmentCount, explicitTurn } of prepareLegacyCueSegments(segments)) {
    const normalized: TranscriptDisplaySegment = {
      ...segment,
      text: segment.text.trim(),
      sourceIds: unique(segment.sourceIds),
      edits: [...segment.edits],
    };
    const previous = groups.at(-1);
    if (!previous || explicitTurn || !canMerge(previous, normalized)) {
      groups.push({ ...normalized, segmentCount, interruptionMarker: null });
      continue;
    }
    previous.key = `${previous.key}--${normalized.key}`;
    previous.text = joinTranscriptText(previous.text, normalized.text);
    previous.endMs = normalized.endMs ?? previous.endMs;
    previous.sourceIds = unique([...previous.sourceIds, ...normalized.sourceIds]);
    previous.edits = [...previous.edits, ...normalized.edits];
    previous.needsCheck ||= normalized.needsCheck;
    previous.segmentCount += segmentCount;
  }
  return markObviousInterruptions(groups);
}

/**
 * Readable-only presentation cleanup. The persisted Artifact and the raw
 * transcript stay untouched. Obvious cross-speaker interruptions remain as
 * their own turns and receive a language-matched presentation label; no
 * spoken content is hidden or rewritten by the interruption detector.
 */
export function groupReadableTranscriptSegments(
  segments: TranscriptDisplaySegment[],
): TranscriptDisplayGroup[] {
  const cleaned = segments.map((segment) => {
    if (usesRawFallback(segment)) return segment;
    const text = cleanReadableText(segment.text);
    if (text === segment.text.trim()) return segment;
    return {
      ...segment,
      text,
      edits: [
        ...segment.edits,
        {
          kind: "filler",
          original: segment.text,
          replacement: text,
          reason: "Removed a standalone hesitation for the readable view; raw audio and transcript are unchanged.",
          confidence: 1,
        },
      ],
    };
  });
  return groupConsecutiveSpeakerSegments(cleaned);
}

export function activeTranscriptGroupKeyAt(
  groups: TranscriptDisplayGroup[],
  currentMs: number,
): string | null {
  let activeKey: string | null = null;
  for (const group of groups) {
    if (group.startMs == null) continue;
    if (group.startMs > currentMs + 120) break;
    activeKey = group.key;
  }
  return activeKey;
}

/**
 * Resolves playback without ever borrowing audio from another transcript.
 * Explicit lineage always wins. The legacy fallback is deliberately narrow:
 * one transcript version and one recording in the entire Event.
 */
export function resolveTranscriptAudioAssetId({
  assetVersionId,
  mappedAudioAssetId,
  rawTranscriptVersionIds,
  eventAudioAssetIds,
}: {
  assetVersionId: string | null;
  mappedAudioAssetId: string | null;
  rawTranscriptVersionIds: Set<string>;
  eventAudioAssetIds: string[];
}): string | null {
  if (mappedAudioAssetId) return mappedAudioAssetId;
  if (
    !assetVersionId
    || rawTranscriptVersionIds.size !== 1
    || !rawTranscriptVersionIds.has(assetVersionId)
    || eventAudioAssetIds.length !== 1
  ) return null;
  return eventAudioAssetIds[0] ?? null;
}
