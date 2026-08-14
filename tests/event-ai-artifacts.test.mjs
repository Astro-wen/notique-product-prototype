import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  chunkReadableTranscriptSource,
  mergeReadableTranscriptChunks,
  validateEventSummaryOutput,
  validateReadableTranscriptOutput,
} from "../lib/domain/event-ai-artifacts.ts";

const raw = [
  {
    id: "seg_1", assetVersionId: "av_1", eventId: "evt_1", ordinal: 0,
    speaker: "Alex", startMs: 1_000, endMs: 4_000,
    textRaw: "we cannot spend more than $12,500", textNormalized: "we cannot spend more than $12,500",
    parserVersion: "test.v1",
  },
  {
    id: "seg_2", assetVersionId: "av_1", eventId: "evt_1", ordinal: 1,
    speaker: "Alex", startMs: 4_100, endMs: 8_000,
    textRaw: "and it needs approval on September 8", textNormalized: "and it needs approval on September 8",
    parserVersion: "test.v1",
  },
];

function readable(overrides = {}) {
  return {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [
      {
        readable_key: "read_1",
        source_segment_ids: ["seg_1", "seg_2"],
        speaker: "Alex",
        start_ms: 1_000,
        end_ms: 8_000,
        readable_text: "We cannot spend more than $12,500, and it needs approval on September 8.",
        edits: [{ kind: "punctuation", original: "$12,500 and", replacement: "$12,500, and", reason: "Sentence punctuation.", confidence: 0.99 }],
        needs_human_check: false,
        ...overrides,
      },
    ],
  };
}

test("readable transcript covers every raw segment once and keeps lineage", () => {
  const result = validateReadableTranscriptOutput(readable(), { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, true);
  assert.deepEqual(result.output.segments[0].source_segment_ids, ["seg_1", "seg_2"]);
  assert.equal(result.output.segments[0].start_ms, 1_000);
  assert.equal(result.output.segments[0].end_ms, 8_000);
});

test("readable transcript fails closed when money or negation changes", () => {
  const result = validateReadableTranscriptOutput(readable({
    readable_text: "We can spend more than $15,000, and it needs approval on September 8.",
  }), { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".readable_text")));
});

test("readable transcript cannot omit, repeat, or reorder raw segments", () => {
  const output = readable();
  output.segments[0].source_segment_ids = ["seg_2"];
  const result = validateReadableTranscriptOutput(output, { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("Every raw segment")));
});

test("readable transcript exposes every change and flags semantic corrections", () => {
  assert.equal(
    validateReadableTranscriptOutput(readable({ edits: [] }), { eventId: "evt_1", segments: raw }).valid,
    false,
  );
  const silentCorrection = readable({
    edits: [{
      kind: "context_correction",
      original: "needs approval",
      replacement: "requires approval",
      reason: "Context cleanup.",
      confidence: 0.95,
    }],
    readable_text: "We cannot spend more than $12,500, and it requires approval on September 8.",
    needs_human_check: false,
  });
  const result = validateReadableTranscriptOutput(silentCorrection, { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith("needs_human_check")));
});

test("long readable transcripts split deterministically and merge in raw order", () => {
  const segments = Array.from({ length: 7 }, (_, index) => ({
    ...raw[index % raw.length],
    id: `seg_${index}`,
    ordinal: index,
    textRaw: `segment ${index}`,
    textNormalized: `segment ${index}`,
  }));
  const chunks = chunkReadableTranscriptSource(segments, { segments: 3, characters: 10_000 });
  assert.deepEqual(chunks.map((chunk) => chunk.segments.map((segment) => segment.id)), [
    ["seg_0", "seg_1", "seg_2"],
    ["seg_3", "seg_4", "seg_5"],
    ["seg_6"],
  ]);
  assert.deepEqual(
    chunkReadableTranscriptSource(segments, { segments: 3, characters: 10_000 }),
    chunks,
  );
  const merged = mergeReadableTranscriptChunks("evt_1", chunks.map((chunk) => ({
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: chunk.segments.map((segment) => ({
      readable_key: "local_key",
      source_segment_ids: [segment.id],
      speaker: segment.speaker,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      readable_text: segment.textRaw,
      edits: [],
      needs_human_check: false,
    })),
  })));
  assert.deepEqual(
    merged.segments.flatMap((segment) => segment.source_segment_ids),
    segments.map((segment) => segment.id),
  );
  assert.equal(new Set(merged.segments.map((segment) => segment.readable_key)).size, 7);
});

test("summary accepts only grounded items from the same Event", () => {
  const valid = validateEventSummaryOutput({
    schema_version: "event-summary.v1",
    event_id: "evt_1",
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{ item_key: "sum_1", text: "The budget cannot exceed $12,500.", support_quote: "cannot spend more than $12,500", source_segment_ids: ["seg_1"] }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(valid.valid, true);

  const unsupported = validateEventSummaryOutput({
    ...valid.output,
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{ item_key: "sum_1", text: "Unsupported", support_quote: "unsupported", source_segment_ids: ["seg_other"] }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(unsupported.valid, false);

  const fabricatedQuote = validateEventSummaryOutput({
    ...valid.output,
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{ item_key: "sum_2", text: "Grounded-looking claim", support_quote: "Alex approved everything", source_segment_ids: ["seg_1"] }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(fabricatedQuote.valid, false);
});

test("artifact jobs use durable Background Responses and independent retries", async () => {
  const [jobs, worker, repository] = await Promise.all([
    readFile(new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/db/event-ai-artifact-repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(jobs, /resumeProviderResponseId/);
  assert.match(jobs, /ModelBackgroundPendingError/);
  assert.match(jobs, /provider_request_id = \?/);
  assert.match(worker, /dispatchEventAiArtifactsForExtraction/);
  assert.match(worker, /kind === "artifact"/);
  assert.match(repository, /createEventAiArtifactRetry/);
  assert.match(repository, /Only a failed AI artifact can be regenerated/);
  assert.match(repository, /Complete fact analysis is required before this reading aid can be generated/);
  assert.match(repository, /er\.status IN \('succeeded','completed','completed_with_warnings'\)/);
  assert.match(repository, /listEventAiArtifactRunDebug/);
  assert.match(repository, /mutation_guards[\s\S]*event_ai_artifact_runs[\s\S]*lease_owner/);
  assert.match(repository, /status = 'processing' AND lease_owner = \?/);
  assert.match(jobs, /chunkReadableTranscriptSource/);
  assert.match(jobs, /readable_transcript:chunk:\$\{chunk\.chunk_index\}/);
  assert.match(jobs, /listReadableTranscriptChunks/);
  assert.match(repository, /event_ai_artifact_chunks/);
  assert.match(repository, /READABLE_TRANSCRIPT_CHUNK_INPUT_CHANGED/);
  assert.match(repository, /persistReadableTranscriptChunk/);
});

test("Agent A remains raw-only while Agent B gets a mapped readability aid", async () => {
  const [processor, provider, context] = await Promise.all([
    readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/ai/model-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/context-pack.ts", import.meta.url), "utf8"),
  ]);
  assert.match(processor, /inventoryProvider\.inventoryClaims\(\s*input\.contextPack/);
  assert.match(processor, /contextWithReadableTranscript/);
  assert.match(processor, /\["queued", "processing"\][\s\S]*ReadableTranscriptPendingError/);
  assert.match(processor, /releaseRunForReadableTranscriptPoll/);
  assert.match(processor, /last_error_code = 'READABLE_TRANSCRIPT_PENDING'/);
  assert.match(processor, /attempt = CASE WHEN attempt > 0 THEN attempt - 1 ELSE 0 END/);
  assert.match(processor, /verifierProvider\.verifyClaims\(\s*verificationContext/);
  assert.match(provider, /not Evidence[\s\S]*authoritative raw transcript_segments IDs/i);
  assert.match(context, /readable_transcript_segments/);
});

test("project deletion is reversible, blocks active jobs, and deletes R2 before D1", async () => {
  const [repository, route, page] = await Promise.all([
    readFile(new URL("../lib/server/db/core-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/[...segments]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /active_job_count[\s\S]*event_ai_artifact_runs/);
  assert.match(repository, /INSERT INTO mutation_guards[\s\S]*UPDATE projects SET deleted_at/);
  assert.match(repository, /Promise\.all\(keyRows\.map[\s\S]*DELETE FROM projects/);
  assert.match(repository, /project-purge:\$\{projectId\}[\s\S]*NOT EXISTS \(SELECT 1 FROM mutation_guards WHERE id = \?\)/);
  assert.match(repository, /Stored project files could not be fully deleted[\s\S]*remains locked in the recycle bin/);
  assert.match(route, /segments\[1\] === "trash"/);
  assert.match(route, /segments\[2\] === "restore"/);
  assert.match(route, /segments\[2\] === "permanent"/);
  assert.match(page, /输入完整项目名称确认/);
  assert.match(page, /已移到回收站[\s\S]*撤销/);
});
