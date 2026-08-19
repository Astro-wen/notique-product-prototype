export type TranscriptDisplaySegment = {
  key: string;
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
};

const MAX_GROUP_GAP_MS = 3_000;
const MAX_GROUP_DURATION_MS = 90_000;
const MAX_GROUP_CHARACTERS = 1_500;

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

function canMerge(
  group: TranscriptDisplayGroup,
  next: TranscriptDisplaySegment,
): boolean {
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

/**
 * Combines adjacent fragments from the same speaker for reading only.
 * Every original segment ID and timestamp remains attached to the group so
 * evidence navigation still targets the immutable raw transcript.
 */
export function groupConsecutiveSpeakerSegments(
  segments: TranscriptDisplaySegment[],
): TranscriptDisplayGroup[] {
  const groups: TranscriptDisplayGroup[] = [];
  for (const segment of segments) {
    const normalized: TranscriptDisplaySegment = {
      ...segment,
      text: segment.text.trim(),
      sourceIds: unique(segment.sourceIds),
      edits: [...segment.edits],
    };
    const previous = groups.at(-1);
    if (!previous || !canMerge(previous, normalized)) {
      groups.push({ ...normalized, segmentCount: 1 });
      continue;
    }
    previous.key = `${previous.key}--${normalized.key}`;
    previous.text = joinTranscriptText(previous.text, normalized.text);
    previous.endMs = normalized.endMs ?? previous.endMs;
    previous.sourceIds = unique([...previous.sourceIds, ...normalized.sourceIds]);
    previous.edits = [...previous.edits, ...normalized.edits];
    previous.needsCheck ||= normalized.needsCheck;
    previous.segmentCount += 1;
  }
  return groups;
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
