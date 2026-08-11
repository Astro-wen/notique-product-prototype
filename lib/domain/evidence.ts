import type {
  CanonicalTranscriptEvidence,
  InvalidEvidence,
  TranscriptSegment,
} from "./types";

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
    const normalizedHint = normalizeWithSourceMap(quoteHint).value;
    const normalizedMatches = occurrences(normalizedRaw.value, normalizedHint);
    if (!normalizedHint || normalizedMatches.length === 0) {
      return invalid("EVIDENCE_QUOTE_MISMATCH", "Quote could not be located in the source transcript.");
    }
    if (normalizedMatches.length > 1) {
      return invalid("EVIDENCE_QUOTE_AMBIGUOUS", "Normalized quote occurs more than once.");
    }
    const start = normalizedRaw.sourceIndexes[normalizedMatches[0]];
    const finalNormalizedIndex = normalizedMatches[0] + normalizedHint.length - 1;
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
