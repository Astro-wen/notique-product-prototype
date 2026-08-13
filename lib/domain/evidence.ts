import type {
  CanonicalTranscriptEvidence,
  InvalidEvidence,
  TranscriptSegment,
} from "./types";

export const DEFAULT_EVIDENCE_CONTEXT_SEGMENTS = 2;
export const EVIDENCE_AUDIO_PREROLL_MS = 3_000;

export type EvidenceContextTranscriptSegment = {
  id: string;
  eventId: string;
  assetVersionId: string;
  ordinal: number;
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  textRaw: string;
};

export type TranscriptEvidenceContextWindow = {
  before: EvidenceContextTranscriptSegment[];
  target: EvidenceContextTranscriptSegment[];
  after: EvidenceContextTranscriptSegment[];
};

function sameTranscriptScope(
  segment: EvidenceContextTranscriptSegment,
  expected: EvidenceContextTranscriptSegment,
) {
  return (
    segment.eventId === expected.eventId &&
    segment.assetVersionId === expected.assetVersionId
  );
}

/**
 * Produces the small Evidence reader window from already-scoped query results.
 * Callers can fetch only the nearest rows; this helper never requires loading
 * an Event's full Transcript.
 */
export function buildTranscriptEvidenceContextWindow(
  targetSegments: readonly EvidenceContextTranscriptSegment[],
  beforeCandidates: readonly EvidenceContextTranscriptSegment[],
  afterCandidates: readonly EvidenceContextTranscriptSegment[],
  contextSize = DEFAULT_EVIDENCE_CONTEXT_SEGMENTS,
): TranscriptEvidenceContextWindow {
  if (!Number.isSafeInteger(contextSize) || contextSize < 0 || contextSize > 10) {
    throw new Error("Evidence context size must be an integer between 0 and 10.");
  }
  const target = [...targetSegments].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id),
  );
  if (!target.length) {
    return { before: [], target: [], after: [] };
  }
  const expected = target[0];
  const all = [...target, ...beforeCandidates, ...afterCandidates];
  if (all.some((segment) => !sameTranscriptScope(segment, expected))) {
    throw new Error("Evidence context cannot cross an Event or Transcript asset version.");
  }
  if (new Set(target.map((segment) => segment.id)).size !== target.length) {
    throw new Error("Evidence target segments must be unique.");
  }

  const firstOrdinal = target[0].ordinal;
  const lastOrdinal = target.at(-1)!.ordinal;
  const before = beforeCandidates
    .filter((segment) => segment.ordinal < firstOrdinal)
    .slice()
    .sort((left, right) => right.ordinal - left.ordinal || right.id.localeCompare(left.id))
    .slice(0, contextSize)
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const after = afterCandidates
    .filter((segment) => segment.ordinal > lastOrdinal)
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .slice(0, contextSize);
  return { before, target, after };
}

export function evidenceAudioStartMs(
  evidenceStartMs: number | null,
  hasAudioSource: boolean,
): number | null {
  if (!hasAudioSource || evidenceStartMs === null || !Number.isFinite(evidenceStartMs)) {
    return null;
  }
  return Math.max(0, Math.round(evidenceStartMs) - EVIDENCE_AUDIO_PREROLL_MS);
}

type CanonicalizeOptions = {
  expectedEventId: string;
  allowedSegmentIds: ReadonlySet<string>;
  requireContiguous?: boolean;
  kind?: "transcript" | "text";
};

type NormalizedWithMap = {
  value: string;
  sourceIndexes: number[];
};

function isSeparator(value: string) {
  return /[\p{P}\s]/u.test(value);
}

export function normalizeWithSourceMap(raw: string): NormalizedWithMap {
  let value = "";
  const sourceIndexes: number[] = [];
  let pendingSpaceIndex: number | null = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (isSeparator(char)) {
      if (value && !value.endsWith(" ")) pendingSpaceIndex ??= index;
      continue;
    }

    if (pendingSpaceIndex != null) {
      value += " ";
      sourceIndexes.push(pendingSpaceIndex);
      pendingSpaceIndex = null;
    }

    const normalized = char.normalize("NFKC");
    for (const outputChar of normalized) {
      value += outputChar;
      sourceIndexes.push(index);
    }
  }
  return { value: value.trim(), sourceIndexes };
}

function occurrences(haystack: string, needle: string) {
  const result: number[] = [];
  if (!needle) return result;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    result.push(index);
    from = index + 1;
  }
  return result;
}

const ELLIPSIS_GAP = /(?:\.{3,}|…+)/u;

type OrderedMatch = {
  start: number;
  end: number;
};

type PartialOrderedMatch = OrderedMatch & {
  count: 1 | 2;
  originStart: number | null;
};

/**
 * Locate one ellipsis-separated quote in normalized source text.
 *
 * The count is deliberately capped at two: callers only need to distinguish a
 * unique ordered match from an ambiguous one. Each fragment must begin after
 * the previous fragment ends, so an ellipsis cannot reorder or overlap text.
 */
function locateUniqueOrderedFragments(
  source: string,
  fragments: readonly string[],
):
  | { kind: "missing" }
  | { kind: "ambiguous" }
  | { kind: "unique"; match: OrderedMatch } {
  if (!fragments.length) return { kind: "missing" };
  const fragmentOccurrences = fragments.map((fragment) => occurrences(source, fragment));
  if (fragmentOccurrences.some((matches) => matches.length === 0)) {
    return { kind: "missing" };
  }

  let partials: PartialOrderedMatch[] = fragmentOccurrences[0].map((start) => ({
    start,
    end: start + fragments[0].length,
    count: 1,
    originStart: start,
  }));

  for (let fragmentIndex = 1; fragmentIndex < fragments.length; fragmentIndex += 1) {
    const fragment = fragments[fragmentIndex];
    const next: PartialOrderedMatch[] = [];
    let eligibleIndex = 0;
    let eligibleCount: 0 | 1 | 2 = 0;
    let uniqueOrigin: number | null = null;

    for (const start of fragmentOccurrences[fragmentIndex]) {
      while (
        eligibleIndex < partials.length &&
        partials[eligibleIndex].end <= start
      ) {
        const partial = partials[eligibleIndex];
        if (eligibleCount === 0 && partial.count === 1) {
          eligibleCount = 1;
          uniqueOrigin = partial.originStart;
        } else {
          eligibleCount = 2;
          uniqueOrigin = null;
        }
        eligibleIndex += 1;
      }
      if (eligibleCount > 0) {
        next.push({
          start,
          end: start + fragment.length,
          count: eligibleCount === 1 ? 1 : 2,
          originStart: eligibleCount === 1 ? uniqueOrigin : null,
        });
      }
    }

    if (!next.length) return { kind: "missing" };
    partials = next;
  }

  let total: 0 | 1 | 2 = 0;
  let unique: PartialOrderedMatch | null = null;
  for (const partial of partials) {
    if (total === 0 && partial.count === 1) {
      total = 1;
      unique = partial;
    } else {
      total = 2;
      unique = null;
      break;
    }
  }
  if (total === 0) return { kind: "missing" };
  if (total === 2 || !unique || unique.originStart == null) {
    return { kind: "ambiguous" };
  }
  return {
    kind: "unique",
    match: { start: unique.originStart, end: unique.end },
  };
}

function invalid(code: InvalidEvidence["code"], message: string): InvalidEvidence {
  return { valid: false, code, message };
}

export function canonicalizeTranscriptEvidence(
  segmentIds: string[],
  quoteHint: string,
  segmentById: ReadonlyMap<string, TranscriptSegment>,
  options: CanonicalizeOptions,
): CanonicalTranscriptEvidence | InvalidEvidence {
  if (!segmentIds.length || new Set(segmentIds).size !== segmentIds.length) {
    return invalid("EVIDENCE_ID_INVALID", "At least one unique segment ID is required.");
  }
  if (!quoteHint.trim()) {
    return invalid("EVIDENCE_QUOTE_MISMATCH", "Quote hint is empty.");
  }

  const selected: TranscriptSegment[] = [];
  for (const id of segmentIds) {
    if (!options.allowedSegmentIds.has(id)) {
      return invalid("EVIDENCE_SCOPE_INVALID", `Segment ${id} was not part of this model input.`);
    }
    const segment = segmentById.get(id);
    if (!segment) return invalid("EVIDENCE_ID_INVALID", `Segment ${id} does not exist.`);
    if (segment.eventId !== options.expectedEventId) {
      return invalid("EVIDENCE_SCOPE_INVALID", `Segment ${id} belongs to another event.`);
    }
    selected.push(segment);
  }

  const assetVersionId = selected[0].assetVersionId;
  if (selected.some((segment) => segment.assetVersionId !== assetVersionId)) {
    return invalid("EVIDENCE_SCOPE_INVALID", "One transcript reference cannot cross asset versions.");
  }

  const sorted = [...selected].sort((a, b) => a.ordinal - b.ordinal);
  if (sorted.some((segment, index) => segment.id !== selected[index].id)) {
    return invalid("EVIDENCE_SEGMENT_ORDER_INVALID", "Segment IDs are not in source order.");
  }
  if (
    options.requireContiguous !== false &&
    sorted.some((segment, index) => index > 0 && segment.ordinal !== sorted[index - 1].ordinal + 1)
  ) {
    return invalid("EVIDENCE_SEGMENT_ORDER_INVALID", "Referenced segments are not contiguous.");
  }

  const raw = sorted.map((segment) => segment.textRaw).join("\n");
  const exactMatches = occurrences(raw, quoteHint);
  let quoteRaw: string;
  let matchMode: "exact" | "normalized";

  if (exactMatches.length === 1) {
    quoteRaw = raw.slice(exactMatches[0], exactMatches[0] + quoteHint.length);
    matchMode = "exact";
  } else if (exactMatches.length > 1) {
    return invalid("EVIDENCE_QUOTE_AMBIGUOUS", "Quote occurs more than once in the selected segments.");
  } else {
    const normalizedRaw = normalizeWithSourceMap(raw);
    let normalizedStart: number;
    let normalizedEnd: number;

    if (ELLIPSIS_GAP.test(quoteHint)) {
      const fragments = quoteHint
        .split(ELLIPSIS_GAP)
        .map((fragment) => normalizeWithSourceMap(fragment).value)
        .filter(Boolean);
      const located = locateUniqueOrderedFragments(normalizedRaw.value, fragments);
      if (located.kind === "missing") {
        return invalid(
          "EVIDENCE_QUOTE_MISMATCH",
          "Ellipsis-separated quote fragments could not be located in source order.",
        );
      }
      if (located.kind === "ambiguous") {
        return invalid(
          "EVIDENCE_QUOTE_AMBIGUOUS",
          "Ellipsis-separated quote fragments have more than one ordered match.",
        );
      }
      normalizedStart = located.match.start;
      normalizedEnd = located.match.end;
    } else {
      const normalizedHint = normalizeWithSourceMap(quoteHint).value;
      const normalizedMatches = occurrences(normalizedRaw.value, normalizedHint);
      if (!normalizedHint || normalizedMatches.length === 0) {
        return invalid("EVIDENCE_QUOTE_MISMATCH", "Quote could not be located in the source transcript.");
      }
      if (normalizedMatches.length > 1) {
        return invalid("EVIDENCE_QUOTE_AMBIGUOUS", "Normalized quote occurs more than once.");
      }
      normalizedStart = normalizedMatches[0];
      normalizedEnd = normalizedStart + normalizedHint.length;
    }

    const start = normalizedRaw.sourceIndexes[normalizedStart];
    const finalNormalizedIndex = normalizedEnd - 1;
    const end = normalizedRaw.sourceIndexes[finalNormalizedIndex] + 1;
    quoteRaw = raw.slice(start, end);
    matchMode = "normalized";
  }

  return {
    valid: true,
    kind: options.kind ?? "transcript",
    assetVersionId,
    segmentIds: sorted.map((segment) => segment.id),
    quoteRaw,
    startMs: sorted[0].startMs,
    endMs: sorted.at(-1)?.endMs ?? null,
    parts: sorted.map((segment) => ({
      segmentId: segment.id,
      speaker: segment.speaker,
      startMs: segment.startMs,
      endMs: segment.endMs,
      textRaw: segment.textRaw,
    })),
    matchMode,
  };
}

export function validatePhotoBbox(value: unknown): value is [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  const [xMin, yMin, xMax, yMax] = value;
  return (
    xMin >= 0 &&
    yMin >= 0 &&
    xMax <= 1 &&
    yMax <= 1 &&
    xMin < xMax &&
    yMin < yMax
  );
}

export function validateDocumentPage(pageNumber: number | null, pageCount: number | null) {
  if (pageNumber == null) return true;
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return false;
  return pageCount == null || pageNumber <= pageCount;
}
