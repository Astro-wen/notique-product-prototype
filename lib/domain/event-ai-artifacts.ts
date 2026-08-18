import type { TranscriptSegment } from "./types";

export const EVENT_SUMMARY_PROMPT_VERSION = "event-summary-prompt.v2" as const;
export const EVENT_SUMMARY_SCHEMA_VERSION = "event-summary.v2" as const;
export const READABLE_TRANSCRIPT_PROMPT_VERSION = "readable-transcript-prompt.v2" as const;
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

export type EventSummarySourceCharacterSpan = {
  segment_id: string;
  /** Inclusive Unicode code-point offset in the raw Segment text. */
  start_codepoint: number;
  /** Exclusive Unicode code-point offset in the raw Segment text. */
  end_codepoint: number;
};

export type EventSummaryItem = {
  item_key: string;
  text: string;
  support_quote: string;
  support_status: "source_linked_unverified";
  source_segment_ids: string[];
  source_character_span: EventSummarySourceCharacterSpan | null;
};

/**
 * The model identifies the raw source span, but never authors evidence text.
 * The server adds support_quote after validating and resolving that span.
 */
export type EventSummaryProviderItem = Omit<EventSummaryItem, "support_quote" | "support_status">;

export type EventSummaryProviderOutput = {
  schema_version: typeof EVENT_SUMMARY_SCHEMA_VERSION;
  event_id: string;
  sections: Array<{
    kind: EventSummarySectionKind;
    title: string;
    items: EventSummaryProviderItem[];
  }>;
};

export type EventAiArtifactContractMismatch = {
  kind: string;
  actual_prompt_version: string;
  actual_schema_version: string;
  expected_prompt_version: string | null;
  expected_schema_version: string | null;
};

/**
 * Artifact providers are compiled against one exact contract per kind. A
 * queued legacy Run must never be interpreted by a newer provider and then
 * persisted under its frozen legacy version. Succeeded legacy artifacts stay
 * readable; callers use this only before dispatching queued/processing Runs.
 */
export function eventAiArtifactContractMismatch(
  run: Record<string, unknown>,
): EventAiArtifactContractMismatch | null {
  const kind = typeof run.kind === "string" ? run.kind : "";
  const actualPrompt = typeof run.prompt_version === "string" ? run.prompt_version : "";
  const actualSchema = typeof run.schema_version === "string" ? run.schema_version : "";
  const expected = kind === "summary"
    ? { prompt: EVENT_SUMMARY_PROMPT_VERSION, schema: EVENT_SUMMARY_SCHEMA_VERSION }
    : kind === "readable_transcript"
      ? { prompt: READABLE_TRANSCRIPT_PROMPT_VERSION, schema: READABLE_TRANSCRIPT_SCHEMA_VERSION }
      : null;
  if (expected && actualPrompt === expected.prompt && actualSchema === expected.schema) return null;
  return {
    kind,
    actual_prompt_version: actualPrompt,
    actual_schema_version: actualSchema,
    expected_prompt_version: expected?.prompt ?? null,
    expected_schema_version: expected?.schema ?? null,
  };
}

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

export type ReadableTranscriptVerificationSegment = {
  readableSegmentKey: string;
  sourceSegmentIds: string[];
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  readableText: string;
  /** Verification input is built only from server-validated, unflagged rows. */
  requiresAttention: false;
};

/**
 * Human-attention rows remain part of the UI artifact, but are never an Agent
 * B input. This pure projection is also used in the verification input hash,
 * so a retry cannot silently reuse a response generated from a different set
 * of readable rows.
 */
export function readableTranscriptSegmentsForVerification(
  output: ReadableTranscriptOutput,
): ReadableTranscriptVerificationSegment[] {
  return output.segments
    .filter((segment) => segment.needs_human_check === false)
    .map((segment) => ({
      readableSegmentKey: segment.readable_key,
      sourceSegmentIds: [...segment.source_segment_ids],
      speaker: segment.speaker,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      readableText: segment.readable_text,
      requiresAttention: false,
    }));
}

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

const EVENT_SUMMARY_SUPPORT_QUOTE_MAX = 12_000;

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
  return validateEventSummary(value, input, "artifact");
}

/**
 * Validate the exact provider contract and deterministically enrich it with
 * raw support_quote text. A provider quote is intentionally not accepted: a
 * model can choose the source span, but it cannot author or paraphrase the
 * evidence shown to a user.
 */
export function validateEventSummaryProviderOutput(
  value: unknown,
  input: { eventId: string; segments: TranscriptSegment[] },
): ArtifactValidation<EventSummaryOutput> {
  return validateEventSummary(value, input, "provider");
}

function validateEventSummary(
  value: unknown,
  input: { eventId: string; segments: TranscriptSegment[] },
  mode: "provider" | "artifact",
): ArtifactValidation<EventSummaryOutput> {
  const issues: ArtifactContractIssue[] = [];
  if (!record(value)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  exactKeys(value, ["schema_version", "event_id", "sections"], "$", issues);
  if (value.schema_version !== EVENT_SUMMARY_SCHEMA_VERSION) {
    issues.push({ path: "$.schema_version", message: `Expected ${EVENT_SUMMARY_SCHEMA_VERSION}.` });
  }
  if (value.event_id !== input.eventId) issues.push({ path: "$.event_id", message: "Event ID does not match the input." });
  const rawById = new Map<string, TranscriptSegment>();
  const rawPosition = new Map<string, number>();
  const closedAssets = new Set<string>();
  let currentAssetVersionId: string | null = null;
  const lastOrdinalByAsset = new Map<string, number>();
  input.segments.forEach((segment, index) => {
    const path = `$input.segments[${index}]`;
    if (!segment.id || rawById.has(segment.id)) {
      issues.push({ path: `${path}.id`, message: "Raw source segment IDs must be non-empty and unique." });
    } else {
      rawById.set(segment.id, segment);
      rawPosition.set(segment.id, index);
    }
    if (segment.eventId !== input.eventId) {
      issues.push({ path: `${path}.eventId`, message: "Raw source segment belongs to a different Event." });
    }
    if (!segment.assetVersionId) {
      issues.push({ path: `${path}.assetVersionId`, message: "Raw source segment is missing its Asset Version." });
    }
    if (currentAssetVersionId !== segment.assetVersionId) {
      if (currentAssetVersionId !== null) closedAssets.add(currentAssetVersionId);
      if (closedAssets.has(segment.assetVersionId)) {
        issues.push({ path: `${path}.assetVersionId`, message: "Raw source Asset Version groups must not be interleaved." });
      }
      currentAssetVersionId = segment.assetVersionId;
    }
    const previousOrdinal = lastOrdinalByAsset.get(segment.assetVersionId);
    if (!Number.isInteger(segment.ordinal) || segment.ordinal < 0 || (previousOrdinal !== undefined && segment.ordinal <= previousOrdinal)) {
      issues.push({ path: `${path}.ordinal`, message: "Raw source ordinals must increase within each Asset Version." });
    }
    lastOrdinalByAsset.set(segment.assetVersionId, segment.ordinal);
    if (!segment.textRaw) {
      issues.push({ path: `${path}.textRaw`, message: "Raw source text must be non-empty." });
    }
  });
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
          exactKeys(
            item,
            mode === "provider"
              ? ["item_key", "text", "source_segment_ids", "source_character_span"]
              : [
                  "item_key", "text", "support_quote", "support_status",
                  "source_segment_ids", "source_character_span",
                ],
            itemPath,
            issues,
          );
          const itemKey = stringValue(item.item_key, `${itemPath}.item_key`, issues, 128);
          if (seenKeys.has(itemKey)) issues.push({ path: `${itemPath}.item_key`, message: "Duplicate summary item key." });
          seenKeys.add(itemKey);
          const ids = segmentIds(item.source_segment_ids, `${itemPath}.source_segment_ids`, issues);
          let resolvedIds = ids;
          let citedSegments: TranscriptSegment[] = [];
          ids.forEach((id) => {
            const segment = rawById.get(id);
            if (!segment) issues.push({ path: `${itemPath}.source_segment_ids`, message: `Unknown raw segment ID ${id}.` });
            else citedSegments.push(segment);
          });
          if (citedSegments.length === ids.length && citedSegments.length) {
            const assetVersionId = citedSegments[0].assetVersionId;
            if (citedSegments.some((segment) => segment.assetVersionId !== assetVersionId)) {
              issues.push({
                path: `${itemPath}.source_segment_ids`,
                message: "A summary source span must stay within one raw Asset Version.",
              });
            }
            const positions = ids.map((id) => rawPosition.get(id));
            const positionsAreOrdered = positions.every((position, index) =>
              position !== undefined && (index === 0 || Number(position) > Number(positions[index - 1])));
            if (!positionsAreOrdered) {
              issues.push({
                path: `${itemPath}.source_segment_ids`,
                message: "Summary source segments must be contiguous and in raw order.",
              });
            } else if (
              mode === "provider" && positions.length > 1 &&
              positions.some((position, index) => index > 0 && position !== Number(positions[index - 1]) + 1)
            ) {
              const first = Number(positions[0]);
              const last = Number(positions.at(-1));
              const expanded = input.segments.slice(first, last + 1);
              if (
                expanded.length > 24 ||
                expanded.some((segment) => segment.assetVersionId !== assetVersionId)
              ) {
                issues.push({
                  path: `${itemPath}.source_segment_ids`,
                  message: "Summary source segments must be contiguous and in raw order.",
                });
              } else {
                resolvedIds = expanded.map((segment) => segment.id);
                citedSegments = expanded;
              }
            } else if (
              positions.some((position, index) => index > 0 && position !== Number(positions[index - 1]) + 1)
            ) {
              issues.push({
                path: `${itemPath}.source_segment_ids`,
                message: "Summary source segments must be contiguous and in raw order.",
              });
            }
          }
          let sourceCharacterSpan: EventSummarySourceCharacterSpan | null = null;
          let deterministicQuote = citedSegments.length === resolvedIds.length
            ? citedSegments.map((segment) => segment.textRaw).join("\n")
            : "";
          if (item.source_character_span !== null) {
            const spanPath = `${itemPath}.source_character_span`;
            if (!record(item.source_character_span)) {
              issues.push({ path: spanPath, message: "Expected a character span object or null." });
            } else {
              exactKeys(
                item.source_character_span,
                ["segment_id", "start_codepoint", "end_codepoint"],
                spanPath,
                issues,
              );
              const segmentId = stringValue(
                item.source_character_span.segment_id,
                `${spanPath}.segment_id`,
                issues,
                128,
              );
              const start = item.source_character_span.start_codepoint;
              const end = item.source_character_span.end_codepoint;
              if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) {
                issues.push({ path: `${spanPath}.start_codepoint`, message: "Expected a non-negative Unicode code-point offset." });
              }
              if (typeof end !== "number" || !Number.isSafeInteger(end) || end < 0) {
                issues.push({ path: `${spanPath}.end_codepoint`, message: "Expected a non-negative Unicode code-point offset." });
              }
              if (resolvedIds.length !== 1 || resolvedIds[0] !== segmentId) {
                issues.push({
                  path: spanPath,
                  message: "A character span must name the one and only cited raw Segment.",
                });
              }
              const spanSegment = resolvedIds.length === 1 && resolvedIds[0] === segmentId
                ? rawById.get(segmentId)
                : undefined;
              if (
                spanSegment && typeof start === "number" && typeof end === "number" &&
                Number.isSafeInteger(start) && Number.isSafeInteger(end)
              ) {
                const codePoints = Array.from(spanSegment.textRaw);
                if (start >= end) {
                  issues.push({ path: spanPath, message: "Character span must be non-empty and ordered." });
                } else if (end > codePoints.length) {
                  issues.push({ path: `${spanPath}.end_codepoint`, message: "Character span exceeds the raw Segment." });
                } else {
                  deterministicQuote = codePoints.slice(start, end).join("");
                  if (!deterministicQuote.trim()) {
                    issues.push({ path: spanPath, message: "Character span must contain non-whitespace raw text." });
                  }
                  sourceCharacterSpan = {
                    segment_id: segmentId,
                    start_codepoint: start,
                    end_codepoint: end,
                  };
                }
              }
            }
          }
          if (Array.from(deterministicQuote).length > EVENT_SUMMARY_SUPPORT_QUOTE_MAX) {
            issues.push({
              path: `${itemPath}.source_character_span`,
              message: `Resolved raw support quote exceeds ${EVENT_SUMMARY_SUPPORT_QUOTE_MAX} Unicode code points; cite one Segment with a smaller character span.`,
            });
          }
          if (mode === "artifact") {
            const suppliedQuote = typeof item.support_quote === "string" ? item.support_quote : "";
            if (!suppliedQuote) {
              issues.push({ path: `${itemPath}.support_quote`, message: "Expected a non-empty string." });
            } else if (Array.from(suppliedQuote).length > EVENT_SUMMARY_SUPPORT_QUOTE_MAX) {
              issues.push({
                path: `${itemPath}.support_quote`,
                message: `Expected at most ${EVENT_SUMMARY_SUPPORT_QUOTE_MAX} Unicode code points.`,
              });
            }
            if (suppliedQuote && suppliedQuote !== deterministicQuote) {
              issues.push({
                path: `${itemPath}.support_quote`,
                message: "Persisted support quote must equal the server-resolved raw source span.",
              });
            }
            if (item.support_status !== "source_linked_unverified") {
              issues.push({
                path: `${itemPath}.support_status`,
                message: "Summary semantic support must remain explicitly unverified until human review.",
              });
            }
          }
          const summaryText = stringValue(item.text, `${itemPath}.text`, issues, 2_000);
          items.push({
            item_key: itemKey,
            text: summaryText,
            support_quote: deterministicQuote,
            support_status: "source_linked_unverified",
            source_segment_ids: resolvedIds,
            source_character_span: sourceCharacterSpan,
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

const PROTECTED_TOKEN_PATTERN = /(?:[$€£¥]\s*\d[\d,.]*|\b\d+(?:[.,]\d+)*(?:%|\s*(?:mm|cm|m|km|in|ft|inch|inches|feet|hour|hours|day|days|week|weeks|month|months|year|years))?\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday)\b|\b(?:no|not|never|without|cannot|can['’]t|won['’]t|don['’]t|doesn['’]t|didn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t)\b|(?:今天|明天|后天|昨天|星期[一二三四五六日天]|周[一二三四五六日天]|不能|不要|不会|未|不|没|无|非))/giu;
const ENGLISH_NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)";
const ENGLISH_ORDINAL_WORD = "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth|thousandth|millionth|billionth|trillionth)";
const ENGLISH_NUMBER_WORD_TOKEN_PATTERN = new RegExp(
  `\\b(?:${ENGLISH_NUMBER_WORD}|${ENGLISH_ORDINAL_WORD}|point)\\b`,
  "giu",
);
const ENGLISH_QUANTITY_UNIT = "(?:dollars?|euros?|pounds?|minutes?|hours?|days?|weeks?|months?|years?|feet|foot|inches?|miles?|kilometers?|metres?|meters?|centimeters?|millimeters?|percent)";
const ENGLISH_NUMBER_WORD_QUANTITY_PATTERN = new RegExp(
  `\\b${ENGLISH_NUMBER_WORD}(?:[\\s,-]+(?:and[\\s-]+)?${ENGLISH_NUMBER_WORD})*[\\s-]+${ENGLISH_QUANTITY_UNIT}\\b`,
  "giu",
);
const LEXICAL_TOKEN_PATTERN = /(?:\p{Script=Han}|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*)/gu;
const READABILITY_FILLER_PHRASE_PATTERN = /\bi\s+mean\b/giu;
const READABILITY_FILLERS = new Set(["uh", "um", "erm", "hmm", "mm", "ah", "嗯", "呃", "额", "啊"]);
const HIGH_RISK_SEMANTIC_LANGUAGE_PATTERN = /(?:\b(?:responsible|responsibility|owner|ownership|assigned|assignee|approve|approved|approval|approver|authorize|authorized|decision|decision[- ]?maker|decide|commit|committed|commitment|promise|promised|guarantee|guaranteed|condition|conditional|unless|provided|must|shall|will|deadline|due|risk|liable|liability)\b|(?:负责|责任人|负责人|审批人|审批|批准|授权|决策人|决策|承诺|保证|条件|前提|除非|如果|必须|截止|到期|风险|责任))/giu;

type ProtectedSemanticToken = {
  value: string;
  previous_anchors: string[];
  next_anchors: string[];
};

function normalizedLexeme(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’‘`´ʼ]/g, "'");
}

function lexicalValues(text: string): string[] {
  return [...text.normalize("NFKC").replace(/[’‘`´ʼ]/g, "'").matchAll(LEXICAL_TOKEN_PATTERN)]
    .map((match) => normalizedLexeme(match[0]));
}

type LexicalTokenSpan = {
  start: number;
  end: number;
  text: string;
  value: string;
};

function lexicalTokenSpans(text: string): LexicalTokenSpan[] {
  const normalized = text.normalize("NFKC").replace(/[’‘`´ʼ]/g, "'");
  return [...normalized.matchAll(LEXICAL_TOKEN_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    value: normalizedLexeme(match[0]),
  }));
}

function sameLexicalContent(left: string, right: string): boolean {
  const leftValues = lexicalValues(left);
  const rightValues = lexicalValues(right);
  return leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index]);
}

function boundaryFragments(text: string, tokens: LexicalTokenSpan[]): string[] {
  const normalized = text.normalize("NFKC").replace(/[’‘`´ʼ]/g, "'");
  if (!tokens.length) return [normalized];
  return [
    normalized.slice(0, tokens[0].start),
    ...tokens.slice(1).map((token, index) => normalized.slice(tokens[index].end, token.start)),
    normalized.slice(tokens[tokens.length - 1].end),
  ];
}

function semanticBoundaryMarker(
  fragment: string,
  boundaryIndex: number,
  tokens: LexicalTokenSpan[],
): string {
  let marker = fragment.normalize("NFKC").replace(/\s/g, "").replace(/，/g, ",").replace(/[−‐‑‒–—]/g, "-");
  const trailing = boundaryIndex === tokens.length;
  if (trailing) {
    // Adding a final full stop is readability-only. Question and exclamation
    // marks remain because they change the utterance type.
    if (marker === "." || marker === "。") marker = "";
  } else if (boundaryIndex > 0) {
    const left = tokens[boundaryIndex - 1].text;
    const right = tokens[boundaryIndex].text;
    // A decimal point between two digit runs is part of one numeric value,
    // not a sentence boundary. Amount/value preservation is checked again by
    // protectedSemanticTokens.
    if (/^\d+$/u.test(left) && /^\d+$/u.test(right) && marker === ".") marker = "";
  }
  return marker;
}

function preservesUnflaggedPunctuation(rawText: string, readableText: string): boolean {
  const rawTokens = lexicalTokenSpans(rawText);
  const readableTokens = lexicalTokenSpans(readableText);
  if (
    rawTokens.length !== readableTokens.length ||
    rawTokens.some((token, index) => token.value !== readableTokens[index]?.value)
  ) return false;
  const rawBoundaries = boundaryFragments(rawText, rawTokens);
  const readableBoundaries = boundaryFragments(readableText, readableTokens);
  return rawBoundaries.every((fragment, index) =>
    semanticBoundaryMarker(fragment, index, rawTokens) ===
    semanticBoundaryMarker(readableBoundaries[index] ?? "", index, readableTokens));
}

function sentenceInitialTokenIndexes(text: string, tokens: LexicalTokenSpan[]): Set<number> {
  const indexes = new Set<number>();
  if (tokens.length) indexes.add(0);
  const boundaries = boundaryFragments(text, tokens);
  for (let index = 1; index < tokens.length; index += 1) {
    if (/[.!?。！？]/u.test(boundaries[index] ?? "")) indexes.add(index);
  }
  return indexes;
}

function sentenceInitialCapitalization(original: string, replacement: string): boolean {
  const originalCharacters = Array.from(original);
  if (!originalCharacters.length || original !== original.toLocaleLowerCase()) return false;
  const expected = `${originalCharacters[0].toLocaleUpperCase()}${originalCharacters.slice(1).join("")}`;
  return replacement === expected;
}

function preservesUnflaggedCapitalization(rawText: string, readableText: string): boolean {
  const rawTokens = lexicalTokenSpans(rawText);
  const readableTokens = lexicalTokenSpans(readableText);
  if (
    rawTokens.length !== readableTokens.length ||
    rawTokens.some((token, index) => token.value !== readableTokens[index]?.value)
  ) return false;
  const sentenceStarts = sentenceInitialTokenIndexes(rawText, rawTokens);
  return rawTokens.every((token, index) => {
    const candidate = readableTokens[index];
    if (!candidate) return false;
    const original = token.text.replace(/[’‘`´ʼ]/g, "'");
    const replacement = candidate.text.replace(/[’‘`´ʼ]/g, "'");
    return original === replacement ||
      sentenceStarts.has(index) && sentenceInitialCapitalization(original, replacement);
  });
}

/**
 * Agent B receives only a deliberately small readability subset. An
 * unflagged row may change whitespace/paragraph layout, add a final full
 * stop, and capitalize a sentence-initial word. Any lexical change or
 * semantic punctuation/casing change is retained only for human review.
 */
function safeForUnflaggedVerification(rawText: string, readableText: string): boolean {
  return sameLexicalContent(rawText, readableText) &&
    preservesUnflaggedPunctuation(rawText, readableText) &&
    preservesUnflaggedCapitalization(rawText, readableText);
}

function isSubsequence(candidate: string[], source: string[]): boolean {
  let candidateIndex = 0;
  for (const value of source) {
    if (candidate[candidateIndex] === value) candidateIndex += 1;
  }
  return candidateIndex === candidate.length;
}

function fillerStrippedLexicalValues(text: string): string[] {
  const withoutPhrases = text.replace(READABILITY_FILLER_PHRASE_PATTERN, " ");
  return lexicalValues(withoutPhrases).filter((value) => !READABILITY_FILLERS.has(value));
}

function validFillerEdit(original: string, replacement: string): boolean {
  const originalWithoutFillers = fillerStrippedLexicalValues(original);
  const replacementValues = lexicalValues(replacement);
  return originalWithoutFillers.length === replacementValues.length &&
    originalWithoutFillers.every((value, index) => value === replacementValues[index]);
}

function validRepetitionEdit(original: string, replacement: string): boolean {
  const originalValues = lexicalValues(original);
  const replacementValues = lexicalValues(replacement);
  if (
    replacementValues.length >= originalValues.length ||
    !isSubsequence(replacementValues, originalValues)
  ) return false;
  const originalCounts = new Map<string, number>();
  const replacementCounts = new Map<string, number>();
  originalValues.forEach((value) => originalCounts.set(value, (originalCounts.get(value) ?? 0) + 1));
  replacementValues.forEach((value) => replacementCounts.set(value, (replacementCounts.get(value) ?? 0) + 1));
  return [...originalCounts].every(([value, count]) => {
    const kept = replacementCounts.get(value) ?? 0;
    return kept === count || (kept > 0 && kept < count);
  });
}

function applyRecordedEdits(
  rawText: string,
  edits: ReadableTranscriptSegment["edits"],
): string | null {
  let transformed = rawText;
  for (const edit of edits) {
    // Typography/layout edits are validated independently and have no effect
    // on the lexical replay. Skipping them also permits honest overlapping
    // records such as capitalization of "we" plus punctuation of "we need".
    if (sameLexicalContent(edit.original, edit.replacement)) continue;
    const position = transformed.indexOf(edit.original);
    if (position < 0) return null;
    transformed = `${transformed.slice(0, position)}${edit.replacement}${transformed.slice(position + edit.original.length)}`;
  }
  return transformed;
}

function containsHighRiskSemanticLanguage(text: string): boolean {
  HIGH_RISK_SEMANTIC_LANGUAGE_PATTERN.lastIndex = 0;
  return HIGH_RISK_SEMANTIC_LANGUAGE_PATTERN.test(text);
}

function normalizedProtectedValue(value: string): string {
  return normalizedLexeme(value)
    .replace(/[\s,\-‐‑‒–—]/g, "")
    .replace(/[.,]+$/g, "");
}

/**
 * Preserve both the ordered high-risk tokens and their nearest semantic
 * anchors. A changed token value or order invalidates the artifact. Anchor
 * drift is retained only as a human-review row and is excluded from Agent B;
 * this lets harmless lexical cleanup remain visible without trusting it.
 */
function protectedSemanticTokens(text: string): ProtectedSemanticToken[] {
  const normalizedText = text.normalize("NFKC").replace(/[’‘`´ʼ]/g, "'");
  const protectedCandidates = [
    PROTECTED_TOKEN_PATTERN,
    ENGLISH_NUMBER_WORD_QUANTITY_PATTERN,
    ENGLISH_NUMBER_WORD_TOKEN_PATTERN,
  ]
    .flatMap((pattern) => [...normalizedText.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      value: normalizedProtectedValue(match[0]),
    })))
    .sort((left, right) => left.start - right.start || right.end - right.start - (left.end - left.start));
  const protectedMatches: typeof protectedCandidates = [];
  for (const candidate of protectedCandidates) {
    if (!protectedMatches.some((kept) => candidate.start < kept.end && candidate.end > kept.start)) {
      protectedMatches.push(candidate);
    }
  }
  const fillerPhraseRanges = [...normalizedText.matchAll(READABILITY_FILLER_PHRASE_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const overlapsProtected = (start: number, end: number) =>
    protectedMatches.some((match) => start < match.end && end > match.start);
  const overlapsFillerPhrase = (start: number, end: number) =>
    fillerPhraseRanges.some((match) => start < match.end && end > match.start);
  const lexical = [...normalizedText.matchAll(LEXICAL_TOKEN_PATTERN)]
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      value: normalizedLexeme(match[0]),
    }))
    .filter((token) =>
      !overlapsProtected(token.start, token.end) &&
      !overlapsFillerPhrase(token.start, token.end) &&
      !READABILITY_FILLERS.has(token.value));
  return protectedMatches.map((match) => ({
    value: match.value,
    previous_anchors: lexical
      .filter((token) => token.end <= match.start)
      .slice(-3)
      .map((token) => token.value),
    next_anchors: lexical
      .filter((token) => token.start >= match.end)
      .slice(0, 3)
      .map((token) => token.value),
  }));
}

type ProtectedSemanticComparison = "same" | "anchors_changed" | "values_changed";

function compareProtectedSemantics(
  rawText: string,
  readableText: string,
): ProtectedSemanticComparison {
  const raw = protectedSemanticTokens(rawText);
  const readable = protectedSemanticTokens(readableText);
  if (
    raw.length !== readable.length ||
    raw.some((token, index) => readable[index]?.value !== token.value)
  ) return "values_changed";
  const sameAnchors = raw.every((token, index) => {
    const candidate = readable[index];
    return candidate?.previous_anchors.join("\u0000") === token.previous_anchors.join("\u0000") &&
      candidate.next_anchors.join("\u0000") === token.next_anchors.join("\u0000");
  });
  return sameAnchors ? "same" : "anchors_changed";
}

export function validateReadableTranscriptOutput(
  value: unknown,
  input: { eventId: string; segments: TranscriptSegment[] },
  options: { allowRawFallback?: boolean } = {},
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
      const sameAssetVersion = raw.length > 0 &&
        raw.every((segment) => segment.assetVersionId === first.assetVersionId);
      if (!sameAssetVersion) {
        issues.push({
          path: `${path}.source_segment_ids`,
          message: "A readable segment cannot combine different raw Asset Versions.",
        });
      }
      const sameSpeaker = raw.length > 0 && raw.every((segment) => segment.speaker === first.speaker);
      if (!sameSpeaker) {
        issues.push({
          path: `${path}.source_segment_ids`,
          message: "A readable segment cannot combine different Speakers.",
        });
      }
      const expectedSpeaker = first?.speaker ?? null;
      if (candidate.speaker !== expectedSpeaker) issues.push({ path: `${path}.speaker`, message: "Speaker must match the raw source group." });
      if (candidate.start_ms !== (first?.startMs ?? null)) issues.push({ path: `${path}.start_ms`, message: "Start time must match the first raw segment." });
      if (candidate.end_ms !== (last?.endMs ?? null)) issues.push({ path: `${path}.end_ms`, message: "End time must match the last raw segment." });
      const repairableIssueStart = issues.length;
      const readableText = stringValue(candidate.readable_text, `${path}.readable_text`, issues, 12_000);
      const rawText = raw.map((segment) => segment.textRaw).join(" ");
      const forceHumanCheck = !safeForUnflaggedVerification(rawText, readableText);
      const protectedSemantics = compareProtectedSemantics(rawText, readableText);
      if (protectedSemantics === "values_changed") {
        issues.push({
          path: `${path}.readable_text`,
          message: "Protected amounts, dates, measurements, or negations changed value or order.",
        });
      } else if (protectedSemantics === "anchors_changed" && !forceHumanCheck) {
        // Anchor drift is allowed to remain visible only when the row is
        // deterministically withheld from Agent B. This guard fails closed if
        // the readability allow-list ever expands without handling anchors.
        issues.push({
          path: `${path}.readable_text`,
          message: "Protected values changed local meaning without requiring human review.",
        });
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
          if (
            ["punctuation", "capitalization", "paragraphing"].includes(kind) &&
            !sameLexicalContent(original, replacement)
          ) {
            issues.push({
              path: `${editPath}.kind`,
              message: `${kind} edits cannot add, remove, reorder, or replace lexical content.`,
            });
          }
          if (kind === "filler" && !validFillerEdit(original, replacement)) {
            issues.push({
              path: `${editPath}.kind`,
              message: "Filler edits may remove only recognized filler language.",
            });
          }
          if (kind === "repetition" && !validRepetitionEdit(original, replacement)) {
            issues.push({
              path: `${editPath}.kind`,
              message: "Repetition edits may remove only lexical content retained elsewhere in the same edit.",
            });
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
      const transformedByDeclaredEdits = applyRecordedEdits(rawText, edits);
      if (
        transformedByDeclaredEdits === null ||
        !sameLexicalContent(transformedByDeclaredEdits, readableText)
      ) {
        issues.push({
          path: `${path}.edits`,
          message: "Declared edit types do not account for the actual raw-to-readable lexical changes.",
        });
      }
      if (
        edits.some((edit) =>
          !["filler", "repetition"].includes(edit.kind) &&
          !sameLexicalContent(edit.original, edit.replacement)) &&
        containsHighRiskSemanticLanguage(`${rawText}\n${readableText}`) &&
        candidate.needs_human_check !== true
      ) {
        issues.push({
          path: `${path}.needs_human_check`,
          message: "Changes involving responsibility, approval, decision makers, commitments, conditions, deadlines, or risks require human attention.",
        });
      }
      const normalizedRawText = rawText.normalize("NFKC").replace(/\s+/g, " ").trim();
      const normalizedReadableText = readableText.normalize("NFKC").replace(/\s+/g, " ").trim();
      if (normalizedRawText !== normalizedReadableText && edits.length === 0) {
        issues.push({ path: `${path}.edits`, message: "Every readability change must have a visible edit record." });
      }
      if (options.allowRawFallback && issues.length > repairableIssueStart) {
        issues.splice(repairableIssueStart);
        segments.push({
          readable_key: key,
          source_segment_ids: ids,
          speaker: expectedSpeaker,
          start_ms: first?.startMs ?? null,
          end_ms: last?.endMs ?? null,
          readable_text: rawText,
          edits: [],
          needs_human_check: false,
        });
      } else {
        segments.push({
          readable_key: key,
          source_segment_ids: ids,
          speaker: expectedSpeaker,
          start_ms: first?.startMs ?? null,
          end_ms: last?.endMs ?? null,
          readable_text: readableText,
          edits,
          needs_human_check: candidate.needs_human_check === true || forceHumanCheck,
        });
      }
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
