import type { TranscriptSegment } from "./types";

export const EVENT_SUMMARY_PROMPT_VERSION = "event-summary-prompt.v1" as const;
export const EVENT_SUMMARY_SCHEMA_VERSION = "event-summary.v1" as const;
export const READABLE_TRANSCRIPT_PROMPT_VERSION = "readable-transcript-prompt.v1" as const;
export const READABLE_TRANSCRIPT_SCHEMA_VERSION = "readable-transcript.v1" as const;

export type EventAiArtifactKind = "summary" | "readable_transcript";
export type EventAiArtifactRunStatus = "queued" | "processing" | "succeeded" | "failed";
export type EventSummarySectionKind =
  | "overview"
  | "key_fact"
  | "decision"
  | "preference"
  | "open_question"
  | "risk"
  | "next_step";

export type EventSummaryItem = {
  item_key: string;
  text: string;
  support_quote: string;
  source_segment_ids: string[];
};

export type EventSummaryOutput = {
  schema_version: typeof EVENT_SUMMARY_SCHEMA_VERSION;
  event_id: string;
  sections: Array<{
    kind: EventSummarySectionKind;
    title: string;
    items: EventSummaryItem[];
  }>;
};

export type ReadableTranscriptEditKind =
  | "punctuation"
  | "capitalization"
  | "paragraphing"
  | "filler"
  | "repetition"
  | "glossary"
  | "context_correction";

export type ReadableTranscriptSegment = {
  readable_key: string;
  source_segment_ids: string[];
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  readable_text: string;
  edits: Array<{
    kind: ReadableTranscriptEditKind;
    original: string;
    replacement: string;
    reason: string;
    confidence: number;
  }>;
  needs_human_check: boolean;
};

export type ReadableTranscriptOutput = {
  schema_version: typeof READABLE_TRANSCRIPT_SCHEMA_VERSION;
  event_id: string;
  segments: ReadableTranscriptSegment[];
};

export const READABLE_TRANSCRIPT_CHUNK_LIMITS = {
  segments: 120,
  characters: 45_000,
} as const;

export type ReadableTranscriptSourceChunk = {
  chunkIndex: number;
  segments: TranscriptSegment[];
};

/**
 * Split only at raw segment boundaries. The split is deterministic so a
 * retried artifact run can resume the same provider response instead of
 * paying for a replacement request.
 */
export function chunkReadableTranscriptSource(
  segments: TranscriptSegment[],
  limits: { segments?: number; characters?: number } = {},
): ReadableTranscriptSourceChunk[] {
  const segmentLimit = Math.max(1, Math.floor(limits.segments ?? READABLE_TRANSCRIPT_CHUNK_LIMITS.segments));
  const characterLimit = Math.max(1, Math.floor(limits.characters ?? READABLE_TRANSCRIPT_CHUNK_LIMITS.characters));
  const chunks: ReadableTranscriptSourceChunk[] = [];
  let current: TranscriptSegment[] = [];
  let characters = 0;
  const flush = () => {
    if (!current.length) return;
    chunks.push({ chunkIndex: chunks.length, segments: current });
    current = [];
    characters = 0;
  };
  for (const segment of segments) {
    const nextCharacters = segment.textRaw.length + 1;
    if (
      current.length > 0 &&
      (current.length >= segmentLimit || characters + nextCharacters > characterLimit)
    ) {
      flush();
    }
    current.push(segment);
    characters += nextCharacters;
  }
  flush();
  return chunks;
}

export function mergeReadableTranscriptChunks(
  eventId: string,
  chunks: ReadableTranscriptOutput[],
): ReadableTranscriptOutput {
  return {
    schema_version: READABLE_TRANSCRIPT_SCHEMA_VERSION,
    event_id: eventId,
    segments: chunks.flatMap((chunk, chunkIndex) =>
      chunk.segments.map((segment, segmentIndex) => ({
        ...segment,
        readable_key: `chunk_${chunkIndex}_${segmentIndex}_${segment.readable_key}`,
      })),
    ),
  };
}

export type ArtifactContractIssue = { path: string; message: string };
export type ArtifactValidation<T> = {
  valid: boolean;
  issues: ArtifactContractIssue[];
  output: T | null;
};

const SUMMARY_KINDS = new Set<EventSummarySectionKind>([
  "overview",
  "key_fact",
  "decision",
  "preference",
  "open_question",
  "risk",
  "next_step",
]);
const EDIT_KINDS = new Set<ReadableTranscriptEditKind>([
  "punctuation",
  "capitalization",
  "paragraphing",
  "filler",
  "repetition",
  "glossary",
  "context_correction",
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: ArtifactContractIssue[],
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: "Unexpected field." });
  }
  for (const key of expected) {
    if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "Missing required field." });
  }
}

function stringValue(
  value: unknown,
  path: string,
  issues: ArtifactContractIssue[],
  max: number,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    issues.push({ path, message: `Expected a non-empty string with at most ${max} characters.` });
    return "";
  }
  return value;
}

function segmentIds(
  value: unknown,
  path: string,
  issues: ArtifactContractIssue[],
  max = 24,
): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    issues.push({ path, message: `Expected 1 to ${max} source segment IDs.` });
    return [];
  }
  const output: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const id = stringValue(item, `${path}[${index}]`, issues, 128);
    if (!id) return;
    if (seen.has(id)) issues.push({ path: `${path}[${index}]`, message: "Duplicate segment ID." });
    else {
      seen.add(id);
      output.push(id);
    }
  });
  return output;
}

export function validateEventSummaryOutput(
  value: unknown,
  input: { eventId: string; segments: TranscriptSegment[] },
): ArtifactValidation<EventSummaryOutput> {
  const issues: ArtifactContractIssue[] = [];
  if (!record(value)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  exactKeys(value, ["schema_version", "event_id", "sections"], "$", issues);
  if (value.schema_version !== EVENT_SUMMARY_SCHEMA_VERSION) {
    issues.push({ path: "$.schema_version", message: `Expected ${EVENT_SUMMARY_SCHEMA_VERSION}.` });
  }
  if (value.event_id !== input.eventId) issues.push({ path: "$.event_id", message: "Event ID does not match the input." });
  const allowedIds = new Set(input.segments.map((segment) => segment.id));
  const seenKeys = new Set<string>();
  const sections: EventSummaryOutput["sections"] = [];
  let summaryItemCount = 0;
  if (!Array.isArray(value.sections) || value.sections.length > 8) {
    issues.push({ path: "$.sections", message: "Expected at most 8 summary sections." });
  } else {
    value.sections.forEach((candidate, sectionIndex) => {
      const path = `$.sections[${sectionIndex}]`;
      if (!record(candidate)) {
        issues.push({ path, message: "Expected a section object." });
        return;
      }
      exactKeys(candidate, ["kind", "title", "items"], path, issues);
      const kind = candidate.kind as EventSummarySectionKind;
      if (!SUMMARY_KINDS.has(kind)) issues.push({ path: `${path}.kind`, message: "Unknown summary section kind." });
      const title = stringValue(candidate.title, `${path}.title`, issues, 120);
      const items: EventSummaryItem[] = [];
      if (!Array.isArray(candidate.items) || candidate.items.length > 12) {
        issues.push({ path: `${path}.items`, message: "Expected at most 12 summary items." });
      } else {
        summaryItemCount += candidate.items.length;
        candidate.items.forEach((item, itemIndex) => {
          const itemPath = `${path}.items[${itemIndex}]`;
          if (!record(item)) {
            issues.push({ path: itemPath, message: "Expected a summary item object." });
            return;
          }
          exactKeys(item, ["item_key", "text", "support_quote", "source_segment_ids"], itemPath, issues);
          const itemKey = stringValue(item.item_key, `${itemPath}.item_key`, issues, 128);
          if (seenKeys.has(itemKey)) issues.push({ path: `${itemPath}.item_key`, message: "Duplicate summary item key." });
          seenKeys.add(itemKey);
          const ids = segmentIds(item.source_segment_ids, `${itemPath}.source_segment_ids`, issues);
          ids.forEach((id) => {
            if (!allowedIds.has(id)) issues.push({ path: `${itemPath}.source_segment_ids`, message: `Unknown raw segment ID ${id}.` });
          });
          const supportQuote = stringValue(item.support_quote, `${itemPath}.support_quote`, issues, 2_000);
          const citedText = ids
            .map((id) => input.segments.find((segment) => segment.id === id)?.textRaw ?? "")
            .join(" ")
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .trim();
          const normalizedQuote = supportQuote.normalize("NFKC").replace(/\s+/g, " ").trim();
          if (normalizedQuote && !citedText.includes(normalizedQuote)) {
            issues.push({ path: `${itemPath}.support_quote`, message: "Support quote must be exact text from the cited raw segments." });
          }
          items.push({
            item_key: itemKey,
            text: stringValue(item.text, `${itemPath}.text`, issues, 2_000),
            support_quote: supportQuote,
            source_segment_ids: ids,
          });
        });
      }
      sections.push({ kind, title, items });
    });
  }
  if (summaryItemCount > 40) {
    issues.push({ path: "$.sections", message: "A concise summary may contain at most 40 supported items." });
  }
  const output: EventSummaryOutput = {
    schema_version: EVENT_SUMMARY_SCHEMA_VERSION,
    event_id: input.eventId,
    sections,
  };
  return { valid: issues.length === 0, issues, output: issues.length ? null : output };
}

function protectedTokens(text: string): string[] {
  const pattern = /(?:[$€£¥]\s*\d[\d,.]*|\b\d+(?:[.,]\d+)?(?:%|\s*(?:mm|cm|m|km|in|ft|inch|inches|feet|hour|hours|day|days|week|weeks|month|months|year|years))?\b|\b(?:no|not|never|without|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|未|不|没|无|非|不能|不要|不会)\b)/giu;
  return (text.match(pattern) ?? []).map((token) => token.toLocaleLowerCase().replace(/[\s,]/g, ""));
}

function sameMultiset(left: string[], right: string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

export function validateReadableTranscriptOutput(
  value: unknown,
  input: { eventId: string; segments: TranscriptSegment[] },
): ArtifactValidation<ReadableTranscriptOutput> {
  const issues: ArtifactContractIssue[] = [];
  if (!record(value)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  exactKeys(value, ["schema_version", "event_id", "segments"], "$", issues);
  if (value.schema_version !== READABLE_TRANSCRIPT_SCHEMA_VERSION) {
    issues.push({ path: "$.schema_version", message: `Expected ${READABLE_TRANSCRIPT_SCHEMA_VERSION}.` });
  }
  if (value.event_id !== input.eventId) issues.push({ path: "$.event_id", message: "Event ID does not match the input." });
  const rawById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const rawPosition = new Map(input.segments.map((segment, index) => [segment.id, index]));
  const covered: string[] = [];
  const seenKeys = new Set<string>();
  const segments: ReadableTranscriptSegment[] = [];
  if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > input.segments.length) {
    issues.push({ path: "$.segments", message: "Readable segments must cover the raw transcript without creating extra groups." });
  } else {
    value.segments.forEach((candidate, index) => {
      const path = `$.segments[${index}]`;
      if (!record(candidate)) {
        issues.push({ path, message: "Expected a readable segment object." });
        return;
      }
      exactKeys(candidate, [
        "readable_key", "source_segment_ids", "speaker", "start_ms", "end_ms",
        "readable_text", "edits", "needs_human_check",
      ], path, issues);
      const key = stringValue(candidate.readable_key, `${path}.readable_key`, issues, 128);
      if (seenKeys.has(key)) issues.push({ path: `${path}.readable_key`, message: "Duplicate readable key." });
      seenKeys.add(key);
      const ids = segmentIds(candidate.source_segment_ids, `${path}.source_segment_ids`, issues, 24);
      const raw = ids.map((id) => rawById.get(id)).filter((item): item is TranscriptSegment => Boolean(item));
      ids.forEach((id) => {
        if (!rawById.has(id)) issues.push({ path: `${path}.source_segment_ids`, message: `Unknown raw segment ID ${id}.` });
      });
      const positions = ids.map((id) => rawPosition.get(id)).filter((position): position is number => position !== undefined);
      if (positions.some((position, rawIndex) => rawIndex > 0 && position !== positions[rawIndex - 1] + 1)) {
        issues.push({ path: `${path}.source_segment_ids`, message: "Source segments must be contiguous and ordered." });
      }
      covered.push(...ids);
      const first = raw[0];
      const last = raw[raw.length - 1];
      const expectedSpeaker = raw.length && raw.every((segment) => segment.speaker === first.speaker) ? first.speaker : null;
      if (candidate.speaker !== expectedSpeaker) issues.push({ path: `${path}.speaker`, message: "Speaker must match the raw source group." });
      if (candidate.start_ms !== (first?.startMs ?? null)) issues.push({ path: `${path}.start_ms`, message: "Start time must match the first raw segment." });
      if (candidate.end_ms !== (last?.endMs ?? null)) issues.push({ path: `${path}.end_ms`, message: "End time must match the last raw segment." });
      const readableText = stringValue(candidate.readable_text, `${path}.readable_text`, issues, 12_000);
      const rawText = raw.map((segment) => segment.textRaw).join(" ");
      if (!sameMultiset(protectedTokens(rawText), protectedTokens(readableText))) {
        issues.push({ path: `${path}.readable_text`, message: "Protected amounts, dates, measurements, or negations changed." });
      }
      const edits: ReadableTranscriptSegment["edits"] = [];
      if (!Array.isArray(candidate.edits) || candidate.edits.length > 40) {
        issues.push({ path: `${path}.edits`, message: "Expected at most 40 edit records." });
      } else {
        candidate.edits.forEach((edit, editIndex) => {
          const editPath = `${path}.edits[${editIndex}]`;
          if (!record(edit)) {
            issues.push({ path: editPath, message: "Expected an edit object." });
            return;
          }
          exactKeys(edit, ["kind", "original", "replacement", "reason", "confidence"], editPath, issues);
          const kind = edit.kind as ReadableTranscriptEditKind;
          if (!EDIT_KINDS.has(kind)) issues.push({ path: `${editPath}.kind`, message: "Unknown edit kind." });
          const confidence = Number(edit.confidence);
          if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            issues.push({ path: `${editPath}.confidence`, message: "Confidence must be between 0 and 1." });
          }
          const original = typeof edit.original === "string" ? edit.original : "";
          const replacement = typeof edit.replacement === "string" ? edit.replacement : "";
          if (original.length > 2_000) issues.push({ path: `${editPath}.original`, message: "Original edit text is too long." });
          if (replacement.length > 2_000) issues.push({ path: `${editPath}.replacement`, message: "Replacement edit text is too long." });
          if (original && !rawText.includes(original)) {
            issues.push({ path: `${editPath}.original`, message: "Edit original must occur in the mapped raw text." });
          }
          if (replacement && !readableText.includes(replacement)) {
            issues.push({ path: `${editPath}.replacement`, message: "Edit replacement must occur in the readable text." });
          }
          edits.push({
            kind,
            original,
            replacement,
            reason: stringValue(edit.reason, `${editPath}.reason`, issues, 500),
            confidence,
          });
        });
      }
      if (typeof candidate.needs_human_check !== "boolean") {
        issues.push({ path: `${path}.needs_human_check`, message: "Expected a boolean." });
      }
      if (
        edits.some((edit) => edit.kind === "context_correction" && edit.original !== edit.replacement) &&
        candidate.needs_human_check !== true
      ) {
        issues.push({ path: `${path}.needs_human_check`, message: "Context corrections must be surfaced for human attention." });
      }
      const normalizedRawText = rawText.normalize("NFKC").replace(/\s+/g, " ").trim();
      const normalizedReadableText = readableText.normalize("NFKC").replace(/\s+/g, " ").trim();
      if (normalizedRawText !== normalizedReadableText && edits.length === 0) {
        issues.push({ path: `${path}.edits`, message: "Every readability change must have a visible edit record." });
      }
      segments.push({
        readable_key: key,
        source_segment_ids: ids,
        speaker: expectedSpeaker,
        start_ms: first?.startMs ?? null,
        end_ms: last?.endMs ?? null,
        readable_text: readableText,
        edits,
        needs_human_check: candidate.needs_human_check === true,
      });
    });
  }
  const expectedIds = input.segments.map((segment) => segment.id);
  if (covered.length !== expectedIds.length || covered.some((id, index) => id !== expectedIds[index])) {
    issues.push({ path: "$.segments", message: "Every raw segment must appear exactly once in original order." });
  }
  const output: ReadableTranscriptOutput = {
    schema_version: READABLE_TRANSCRIPT_SCHEMA_VERSION,
    event_id: input.eventId,
    segments,
  };
  return { valid: issues.length === 0, issues, output: issues.length ? null : output };
}
