import type { TranscriptSegment } from "./types";

export const TRANSCRIPT_PARSER_VERSION = "transcript-parser.v1";

export type ParseTranscriptInput = {
  assetVersionId: string;
  eventId: string;
  filename?: string;
  content: string;
  format?: "auto" | "txt" | "vtt" | "srt" | "json";
};

type DraftSegment = {
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  text: string;
};

function stableSegmentId(assetVersionId: string, ordinal: number) {
  const scope = assetVersionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-48);
  return `seg_${scope}_${String(ordinal).padStart(5, "0")}`;
}

export function normalizeTranscriptText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTimestampMs(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![seconds, minutes, hours].every(Number.isFinite)) return null;
  if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60 || hours < 0) {
    return null;
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function splitSpeaker(text: string): { speaker: string | null; text: string } {
  const match = text.match(/^([^:\n]{1,80}):\s+(.+)$/);
  if (!match) return { speaker: null, text: text.trim() };
  const speaker = match[1].trim();
  if (/^(https?|note|warning)$/i.test(speaker)) {
    return { speaker: null, text: text.trim() };
  }
  return { speaker, text: match[2].trim() };
}

function parseCueText(lines: string[]) {
  const value = lines
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .trim();
  return splitSpeaker(value);
}

function parseTimedCues(content: string): DraftSegment[] {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const result: DraftSegment[] = [];
  let index = 0;

  while (index < lines.length) {
    const current = lines[index].trim();
    if (!current || current === "WEBVTT" || /^NOTE(?:\s|$)/.test(current)) {
      index += 1;
      continue;
    }

    let timingLine = current;
    if (!timingLine.includes("-->")) {
      timingLine = lines[index + 1]?.trim() ?? "";
      if (!timingLine.includes("-->")) {
        index += 1;
        continue;
      }
      index += 1;
    }

    const timing = timingLine.match(
      /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/,
    );
    index += 1;
    if (!timing) continue;

    const body: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      body.push(lines[index]);
      index += 1;
    }
    const parsed = parseCueText(body);
    if (!parsed.text) continue;
    result.push({
      speaker: parsed.speaker,
      startMs: parseTimestampMs(timing[1]),
      endMs: parseTimestampMs(timing[2]),
      text: parsed.text,
    });
  }
  return result;
}

function parseJson(content: string): DraftSegment[] {
  const parsed = JSON.parse(content) as unknown;
  const source = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { segments?: unknown }).segments)
      ? (parsed as { segments: unknown[] }).segments
      : null;
  if (!source) throw new Error("JSON transcript must contain a segments array.");

  return source.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Transcript segment ${index + 1} is not an object.`);
    }
    const item = entry as Record<string, unknown>;
    const text = item.text ?? item.text_raw ?? item.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new Error(`Transcript segment ${index + 1} has no text.`);
    }
    const start = item.start_ms ?? item.startMs ?? item.start;
    const end = item.end_ms ?? item.endMs ?? item.end;
    const parseTimeValue = (value: unknown) => {
      if (value == null) return null;
      if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
      if (typeof value === "string") return parseTimestampMs(value);
      return null;
    };
    return {
      speaker: typeof item.speaker === "string" ? item.speaker.trim() || null : null,
      startMs: parseTimeValue(start),
      endMs: parseTimeValue(end),
      text: text.trim(),
    };
  });
}

function parsePlainText(content: string): DraftSegment[] {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  const result: DraftSegment[] = [];
  const timestampPrefix = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\]?\s+(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const timed = line.match(timestampPrefix);
    const value = timed ? timed[2] : line;
    const parsed = splitSpeaker(value);
    if (!parsed.text) continue;
    result.push({
      speaker: parsed.speaker,
      startMs: timed ? parseTimestampMs(timed[1]) : null,
      endMs: null,
      text: parsed.text,
    });
  }
  return result;
}

function resolveFormat(input: ParseTranscriptInput) {
  if (input.format && input.format !== "auto") return input.format;
  const extension = input.filename?.toLowerCase().split(".").at(-1);
  if (extension === "vtt" || extension === "srt" || extension === "json") return extension;
  const trimmed = input.content.trimStart();
  if (trimmed.startsWith("WEBVTT")) return "vtt";
  if (trimmed.startsWith("{") || /^\[\s*(?:\{|\")/.test(trimmed)) return "json";
  if (/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(trimmed)) return "srt";
  return "txt";
}

export function parseTranscript(input: ParseTranscriptInput): TranscriptSegment[] {
  if (!input.assetVersionId || !input.eventId) {
    throw new Error("assetVersionId and eventId are required.");
  }
  if (!input.content.trim()) throw new Error("Transcript is empty.");

  const format = resolveFormat(input);
  let drafts: DraftSegment[];
  if (format === "json") drafts = parseJson(input.content);
  else if (format === "srt" || format === "vtt") drafts = parseTimedCues(input.content);
  else drafts = parsePlainText(input.content);

  const clean = drafts.filter((segment) => segment.text.trim());
  if (!clean.length) throw new Error("Transcript contains no readable segments.");
  if (clean.length > 20_000) throw new Error("Transcript contains too many segments.");

  return clean.map((segment, ordinal) => ({
    id: stableSegmentId(input.assetVersionId, ordinal),
    assetVersionId: input.assetVersionId,
    eventId: input.eventId,
    ordinal,
    speaker: segment.speaker,
    startMs: segment.startMs,
    endMs: segment.endMs,
    textRaw: segment.text,
    textNormalized: normalizeTranscriptText(segment.text),
    parserVersion: TRANSCRIPT_PARSER_VERSION,
  }));
}
