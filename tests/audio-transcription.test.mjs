import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { declarationSource, uiSource } from "./helpers/ui-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTypeScriptModule(relativePath) {
  const source = await readFile(path.join(root, relativePath), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

async function loadAudioPolicy() {
  return loadTypeScriptModule("lib/domain/audio-transcription.ts");
}

test("audio policy accepts only the transcription provider formats and enforces 100 MiB", async () => {
  const policy = await loadAudioPolicy();
  assert.equal(policy.audioMimeFor("meeting.mp3", ""), "audio/mpeg");
  assert.equal(policy.audioMimeFor("meeting.m4a", "application/octet-stream"), "audio/mp4");
  assert.equal(policy.audioMimeFor("meeting.wav", "audio/wav"), "audio/wav");
  assert.equal(policy.audioMimeFor("meeting.aac", "audio/aac"), null);
  assert.equal(policy.audioMimeFor("meeting.mp3", "text/plain"), null);
  assert.equal(policy.MAX_AUDIO_BYTES, 100 * 1024 * 1024);
  assert.equal(policy.AUDIO_FILE_ACCEPT.includes(".m4a"), true);
  assert.equal(policy.audioPreparationConcurrency({ mobile: true, hardwareConcurrency: 12 }), 1);
  assert.equal(policy.audioPreparationConcurrency({ mobile: false, hardwareConcurrency: 4 }), 2);
  assert.equal(policy.audioPreparationConcurrency({ mobile: false, hardwareConcurrency: 8 }), 3);
  assert.equal(policy.audioPreparationConcurrency({ mobile: false, hardwareConcurrency: 12 }), 4);
});

test("long audio is split into deterministic overlapping time chunks without coverage gaps", async () => {
  const chunking = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  assert.equal(chunking.shouldChunkAudio({ durationMs: 4 * 60_000, sizeBytes: 4_000_000 }), false);
  assert.equal(chunking.shouldChunkAudio({ durationMs: 6 * 60_000, sizeBytes: 4_000_000 }), true);
  assert.equal(chunking.shouldChunkAudio({ durationMs: 60_000, sizeBytes: 19 * 1024 * 1024 }), true);
  assert.equal(chunking.AUDIO_CHUNK_OVERLAP_MS, 15_000);
  assert.equal(chunking.AUDIO_CHUNK_MAX_PARALLEL, 6);
  assert.equal(chunking.audioChunkParallelism(1), 1);
  assert.equal(chunking.audioChunkParallelism(5), 5);
  assert.equal(chunking.audioChunkParallelism(6), 6);
  assert.equal(chunking.audioChunkParallelism(10), 6);

  const chunks = chunking.planAudioChunks(10 * 60_000, 3 * 60_000, 5_000);
  assert.deepEqual(chunks, [
    { index: 0, startMs: 0, endMs: 180_000 },
    { index: 1, startMs: 175_000, endMs: 355_000 },
    { index: 2, startMs: 350_000, endMs: 530_000 },
    { index: 3, startMs: 525_000, endMs: 600_000 },
  ]);
  assert.equal(chunks[0].startMs, 0);
  assert.equal(chunks.at(-1).endMs, 600_000);
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index - 1].endMs - chunks[index].startMs, 5_000);
  }

  assert.deepEqual(
    chunking.stableCompletedChunkPrefix([
      { index: 2, status: "succeeded" },
      { index: 0, status: "succeeded" },
      { index: 1, status: "processing" },
    ]),
    [{ index: 0, status: "succeeded" }],
  );
  assert.deepEqual(
    chunking.stableCompletedChunkPrefix([
      { index: 1, status: "succeeded" },
      { index: 0, status: "succeeded" },
    ]).map((chunk) => chunk.index),
    [0, 1],
  );

  const preview = chunking.stableTranscriptPreview([
    {
      index: 0,
      startMs: 0,
      endMs: 180_000,
      assetVersionId: "chunk-0",
      transcript: {
        durationSeconds: 180,
        text: "Stable sentence. Boundary sentence.",
        segments: [
          { speaker: "A", text: "Stable sentence.", startSeconds: 150, endSeconds: 164 },
          { speaker: "A", text: "Boundary sentence.", startSeconds: 164.5, endSeconds: 170 },
        ],
      },
    },
  ], 165_000);
  assert.equal(preview.stableUntilMs, 165_000);
  assert.deepEqual(preview.segments.map((segment) => segment.text), ["Stable sentence."]);
});

test("chunk transcripts merge onto the original timeline and remove only proven boundary duplicates", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0,
      startMs: 0,
      endMs: 180_000,
      assetVersionId: "av_chunk_0",
      transcript: {
        durationSeconds: 180,
        text: "Opening. The budget is five hundred thousand dollars.",
        segments: [
          { speaker: "A", text: "Opening.", startSeconds: 10, endSeconds: 12 },
          {
            speaker: "B",
            text: "The budget is five hundred thousand dollars.",
            startSeconds: 176,
            endSeconds: 179,
          },
        ],
      },
    },
    {
      index: 1,
      startMs: 175_000,
      endMs: 355_000,
      assetVersionId: "av_chunk_1",
      transcript: {
        durationSeconds: 180,
        text: "The budget is five hundred thousand dollars. Three bedrooms are required.",
        segments: [
          {
            speaker: "A",
            text: "The budget is five hundred thousand dollars.",
            startSeconds: 1,
            endSeconds: 4,
          },
          {
            speaker: "B",
            text: "Three bedrooms are required.",
            startSeconds: 8,
            endSeconds: 11,
          },
        ],
      },
    },
  ]);
  assert.equal(merged.durationSeconds, 355);
  assert.deepEqual(merged.segments.map((segment) => segment.text), [
    "Opening.",
    "The budget is five hundred thousand dollars.",
    "Three bedrooms are required.",
  ]);
  assert.equal(merged.segments[1].startSeconds, 176);
  assert.equal(merged.segments[1].endSeconds, 179);
  assert.equal(merged.segments[2].startSeconds, 183);
  assert.deepEqual(merged.segments.map((segment) => segment.speaker), [
    "Speaker 1",
    "Speaker 2",
    "Speaker 1",
  ]);
});

test("chunk speaker stitching never invents Speaker 5 through Speaker 13", async () => {
  const chunking = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const firstSegments = ["A", "B", "C", "D", "E"].map((speaker, index) => ({
    speaker,
    text: `First chunk speaker ${speaker}.`,
    startSeconds: 10 + index * 10,
    endSeconds: 12 + index * 10,
  }));
  const secondSegments = ["A", "B", "C", "D", "E"].map((speaker, index) => ({
    speaker,
    text: `Second chunk speaker ${speaker}.`,
    startSeconds: 20 + index * 10,
    endSeconds: 22 + index * 10,
  }));
  const merged = chunking.mergeChunkTranscripts([
    {
      index: 0,
      startMs: 0,
      endMs: 180_000,
      assetVersionId: "av_chunk_0",
      transcript: { durationSeconds: 180, text: "first", segments: firstSegments },
    },
    {
      index: 1,
      startMs: 165_000,
      endMs: 345_000,
      assetVersionId: "av_chunk_1",
      transcript: { durationSeconds: 180, text: "second", segments: secondSegments },
    },
  ]);

  assert.equal(chunking.MAX_STABLE_SPEAKER_COUNT, 4);
  assert.deepEqual(new Set(merged.segments.map((segment) => segment.speaker)), new Set([
    "Speaker 1",
    "Speaker 2",
    "Speaker 3",
    "Speaker 4",
    "Speaker unknown",
  ]));
  assert.equal(merged.segments.some((segment) => /Speaker (?:[5-9]|1[0-9])/.test(segment.speaker)), false);
});

test("silent chunk boundaries reuse the prior local speaker map instead of creating new identities", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const chunks = Array.from({ length: 7 }, (_, index) => ({
    index,
    startMs: index * 165_000,
    endMs: index * 165_000 + 180_000,
    assetVersionId: `av_chunk_${index}`,
    transcript: {
      durationSeconds: 180,
      text: `Chunk ${index}`,
      segments: [
        { speaker: "A", text: `Unique buyer sentence ${index}.`, startSeconds: 30, endSeconds: 35 },
        { speaker: "B", text: `Unique agent sentence ${index}.`, startSeconds: 90, endSeconds: 95 },
      ],
    },
  }));
  const merged = mergeChunkTranscripts(chunks);
  assert.deepEqual(new Set(merged.segments.map((segment) => segment.speaker)), new Set([
    "Speaker 1",
    "Speaker 2",
  ]));
});

test("a speaker returning without boundary evidence stays unresolved instead of becoming Speaker 4", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: "first", segments: [
        { speaker: "A", text: "Agent opening.", startSeconds: 20, endSeconds: 24 },
        { speaker: "B", text: "Buyer response.", startSeconds: 60, endSeconds: 64 },
        { speaker: "C", text: "Partner response.", startSeconds: 100, endSeconds: 104 },
      ] },
    },
    {
      index: 1, startMs: 165_000, endMs: 345_000, assetVersionId: "av1",
      transcript: { durationSeconds: 180, text: "second", segments: [
        { speaker: "A", text: "Agent follow-up.", startSeconds: 30, endSeconds: 34 },
        { speaker: "B", text: "Buyer follow-up.", startSeconds: 70, endSeconds: 74 },
      ] },
    },
    {
      index: 2, startMs: 330_000, endMs: 510_000, assetVersionId: "av2",
      transcript: { durationSeconds: 180, text: "third", segments: [
        { speaker: "C", text: "Partner returns.", startSeconds: 30, endSeconds: 34 },
      ] },
    },
  ]);
  assert.equal(merged.segments.find((segment) => segment.text === "Partner returns.")?.speaker, "Speaker unknown");
  assert.equal(merged.segments.some((segment) => segment.speaker === "Speaker 4"), false);
});

test("normalized anonymous labels reuse one identity across silent boundaries", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: "first", segments: [
        { speaker: "A", text: "Opening statement.", startSeconds: 30, endSeconds: 34 },
      ] },
    },
    {
      index: 1, startMs: 165_000, endMs: 345_000, assetVersionId: "av1",
      transcript: { durationSeconds: 180, text: "second", segments: [
        { speaker: "speaker-a", text: "Later statement.", startSeconds: 40, endSeconds: 44 },
      ] },
    },
  ]);
  assert.deepEqual(new Set(merged.segments.map((segment) => segment.speaker)), new Set(["Speaker 1"]));
});

test("a split boundary sentence aligns rotated labels and deduplicates only the proven copy", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: "first", segments: [
        { speaker: "A", text: "Agent setup.", startSeconds: 40, endSeconds: 44 },
        { speaker: "B", text: "The client needs three bedrooms near the station.", startSeconds: 170, endSeconds: 174 },
      ] },
    },
    {
      index: 1, startMs: 165_000, endMs: 345_000, assetVersionId: "av1",
      transcript: { durationSeconds: 180, text: "second", segments: [
        { speaker: "A", text: "three bedrooms near the station", startSeconds: 5, endSeconds: 9 },
        { speaker: "B", text: "I will send matching listings.", startSeconds: 20, endSeconds: 24 },
      ] },
    },
  ]);
  assert.equal(merged.segments.filter((segment) => segment.text.includes("three bedrooms")).length, 1);
  assert.equal(merged.segments.find((segment) => segment.text.startsWith("The client needs"))?.speaker, "Speaker 2");
  assert.equal(merged.segments.find((segment) => segment.text.startsWith("I will send"))?.speaker, "Speaker 1");
});

test("Chinese partial boundary text aligns without whitespace tokenization", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: "first", segments: [
        { speaker: "A", text: "客户希望三房并且靠近地铁站", startSeconds: 170, endSeconds: 174 },
      ] },
    },
    {
      index: 1, startMs: 165_000, endMs: 345_000, assetVersionId: "av1",
      transcript: { durationSeconds: 180, text: "second", segments: [
        { speaker: "B", text: "三房并且靠近地铁站", startSeconds: 5, endSeconds: 9 },
      ] },
    },
  ]);
  assert.deepEqual(merged.segments.map((segment) => segment.text), ["客户希望三房并且靠近地铁站"]);
});

test("nearby generic acknowledgements do not establish identity or delete real turns", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: "first", segments: [
        { speaker: "B", text: "Buyer context.", startSeconds: 100, endSeconds: 104 },
        { speaker: "A", text: "Okay", startSeconds: 175, endSeconds: 176 },
      ] },
    },
    {
      index: 1, startMs: 165_000, endMs: 345_000, assetVersionId: "av1",
      transcript: { durationSeconds: 180, text: "second", segments: [
        { speaker: "B", text: "Okay", startSeconds: 10.4, endSeconds: 11.4 },
      ] },
    },
  ]);
  const acknowledgements = merged.segments.filter((segment) => segment.text === "Okay");
  assert.equal(acknowledgements.length, 2);
  assert.deepEqual(new Set(acknowledgements.map((segment) => segment.speaker)), new Set(["Speaker 1", "Speaker 2"]));
});

test("boundary dedup keeps conflicting amounts, dates, units, and negations", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const mergePair = (leftText, rightText) => mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: leftText, segments: [
        { speaker: "A", text: leftText, startSeconds: 170, endSeconds: 174 },
      ] },
    },
    {
      index: 1, startMs: 165_000, endMs: 345_000, assetVersionId: "av1",
      transcript: { durationSeconds: 180, text: rightText, segments: [
        { speaker: "A", text: rightText, startSeconds: 5, endSeconds: 9 },
      ] },
    },
  ]).segments.map((segment) => segment.text);

  assert.deepEqual(mergePair(
    "The budget is 500,000 dollars.",
    "The budget is 550,000 dollars.",
  ), ["The budget is 500,000 dollars.", "The budget is 550,000 dollars."]);
  assert.deepEqual(mergePair(
    "Closing is on 2026-09-12.",
    "Closing is on 2026-09-21.",
  ), ["Closing is on 2026-09-12.", "Closing is on 2026-09-21."]);
  assert.deepEqual(mergePair(
    "The lot is 5 acres.",
    "The lot is 5 hectares.",
  ), ["The lot is 5 acres.", "The lot is 5 hectares."]);
  assert.deepEqual(mergePair(
    "I can waive the inspection.",
    "I can't waive the inspection.",
  ), ["I can waive the inspection.", "I can't waive the inspection."]);
  assert.deepEqual(mergePair(
    "客户想要临街的房子。",
    "客户不想要临街的房子。",
  ), ["客户想要临街的房子。", "客户不想要临街的房子。"]);
});

test("provider unknown labels never become a numbered Speaker", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const merged = mergeChunkTranscripts([
    {
      index: 0, startMs: 0, endMs: 180_000, assetVersionId: "av0",
      transcript: { durationSeconds: 180, text: "voices", segments: [
        { speaker: "Speaker unknown", text: "Unclear background voice.", startSeconds: 20, endSeconds: 24 },
        { speaker: "A", text: "Known speaker.", startSeconds: 40, endSeconds: 44 },
      ] },
    },
  ]);
  assert.equal(merged.segments.find((segment) => segment.text.startsWith("Unclear"))?.speaker, "Speaker unknown");
  assert.equal(merged.segments.find((segment) => segment.text.startsWith("Known"))?.speaker, "Speaker 1");
});

test("chunk merging fails closed on missing indices or non-overlapping source ranges", async () => {
  const { mergeChunkTranscripts } = await loadTypeScriptModule("lib/domain/audio-chunking.ts");
  const transcript = {
    durationSeconds: 5,
    text: "Hello",
    segments: [{ speaker: "A", text: "Hello", startSeconds: 0, endSeconds: 1 }],
  };
  assert.throws(() => mergeChunkTranscripts([
    { index: 1, startMs: 0, endMs: 5_000, assetVersionId: "av", transcript },
  ]), /contiguous/);
  assert.throws(() => mergeChunkTranscripts([
    { index: 0, startMs: 0, endMs: 5_000, assetVersionId: "av0", transcript },
    { index: 1, startMs: 5_000, endMs: 10_000, assetVersionId: "av1", transcript },
  ]), /must overlap/);
});

test("audio magic validation rejects renamed files", async () => {
  const policy = await loadAudioPolicy();
  const wav = new Uint8Array(12);
  wav.set(Buffer.from("RIFF"), 0);
  wav.set(Buffer.from("WAVE"), 8);
  assert.equal(policy.validAudioMagic("audio/wav", wav), true);
  assert.equal(policy.validAudioMagic("audio/mpeg", wav), false);
  assert.equal(policy.validAudioMagic("audio/mpeg", Uint8Array.from([0x49, 0x44, 0x33, 0x04])), true);
});

test("blank upload intent creates its Project and Event before preserving the selected file target", async () => {
  const { resolveSimpleImportTarget } = await loadTypeScriptModule(
    "lib/domain/simple-import-target.ts",
  );
  const calls = [];
  const target = await resolveSimpleImportTarget({
    project: null,
    event: null,
    createTest: async () => {
      calls.push("create-test");
      return { project: { id: "prj_blank" }, event: { id: "evt_blank" } };
    },
    createEvent: async () => {
      calls.push("unexpected-create-event");
      return { id: "evt_unexpected" };
    },
  });
  assert.deepEqual(calls, ["create-test"]);
  assert.deepEqual(target, {
    project: { id: "prj_blank" },
    event: { id: "evt_blank" },
    createdProject: true,
    createdEvent: true,
  });

  const projectOnlyTarget = await resolveSimpleImportTarget({
    project: null,
    event: null,
    createTest: async () => {
      calls.push("create-project-only");
      return { project: { id: "prj_project_only" }, event: null };
    },
    createEvent: async (project) => {
      calls.push(`create-event-for-${project.id}`);
      return { id: "evt_project_only" };
    },
  });
  assert.deepEqual(calls.slice(-2), [
    "create-project-only",
    "create-event-for-prj_project_only",
  ]);
  assert.equal(projectOnlyTarget.project.id, "prj_project_only");
  assert.equal(projectOnlyTarget.event.id, "evt_project_only");

  const existingProjectTarget = await resolveSimpleImportTarget({
    project: { id: "prj_existing" },
    event: null,
    createTest: async () => null,
    createEvent: async (project) => ({ id: `evt_for_${project.id}` }),
  });
  assert.equal(existingProjectTarget.project.id, "prj_existing");
  assert.equal(existingProjectTarget.event.id, "evt_for_prj_existing");
  assert.equal(existingProjectTarget.createdProject, false);
  assert.equal(existingProjectTarget.createdEvent, true);
});

test("transcription retry logic distinguishes transient provider failures and exhausts one Run deterministically", async () => {
  const retry = await loadTypeScriptModule("lib/domain/transcription-retry.ts");
  assert.deepEqual(retry.classifyTranscriptionHttpFailure(429), {
    code: "TRANSCRIPTION_RATE_LIMITED",
    retryable: true,
  });
  assert.deepEqual(retry.classifyTranscriptionHttpFailure(503), {
    code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE",
    retryable: true,
  });
  assert.deepEqual(retry.classifyTranscriptionHttpFailure(400), {
    code: "AUDIO_TRANSCRIPTION_FAILED",
    retryable: false,
  });
  assert.equal(retry.classifyTranscriptionTransportFailure(true).retryable, true);
  assert.equal(retry.classifyTranscriptionTransportFailure(false).retryable, true);
  const runId = "trun_same";
  const outboxId = "tbox_same";
  const transientFailures = [
    retry.classifyTranscriptionHttpFailure(429),
    retry.classifyTranscriptionHttpFailure(503),
    retry.classifyTranscriptionTransportFailure(true),
  ];
  const decisions = transientFailures.map((failure, index) =>
    retry.transcriptionRetryDecision({
      runId,
      outboxId,
      errorCode: failure.code,
      outboxAttempt: index + 1,
    }));
  assert.deepEqual(decisions.map((item) => item.runId), [runId, runId, runId]);
  assert.deepEqual(decisions.map((item) => item.outboxId), [outboxId, outboxId, outboxId]);
  assert.deepEqual(decisions.map((item) => item.runStatus), ["queued", "queued", "failed"]);
  assert.deepEqual(decisions.map((item) => item.outboxStatus), ["failed", "failed", "failed"]);
  assert.deepEqual(decisions.map((item) => item.exhausted), [false, false, true]);
  assert.equal(
    retry.transcriptionRetryState({ retryable: false, outboxAttempt: 1 }).runStatus,
    "failed",
  );
});

test("the transcription timeout remains active while the streamed body is read", async () => {
  const source = await readFile(
    path.join(root, "lib/server/jobs/transcription-processor.ts"),
    "utf8",
  );
  const bodyRead = source.indexOf("body = await response.text()");
  const timerClear = source.indexOf("clearTimeout(timer)", bodyRead);
  assert.ok(bodyRead >= 0, "the provider response body must be consumed");
  assert.ok(timerClear > bodyRead, "the abort timer must remain active through response.text()");
});

test("long audio retries can extend an older Run without shortening its timeout", async () => {
  const processor = await readFile(
    path.join(root, "lib/server/jobs/transcription-processor.ts"),
    "utf8",
  );
  const outbox = await readFile(
    path.join(root, "lib/server/jobs/transcription-outbox.ts"),
    "utf8",
  );
  const repository = await readFile(
    path.join(root, "lib/server/db/transcription-repository.ts"),
    "utf8",
  );
  assert.match(processor, /DEFAULT_TRANSCRIPTION_TIMEOUT_MS\s*=\s*600_000/);
  assert.match(processor, /export function transcriptionTimeoutMs/);
  assert.match(processor, /Math\.max\([\s\S]{0,300}persisted[\s\S]{0,300}configuredMs/);
  assert.match(processor, /TRANSCRIPTION_RENEWABLE_LEASE_MS\s*=\s*120_000/);
  assert.match(processor, /TRANSCRIPTION_LEASE_HEARTBEAT_MS\s*=\s*30_000/);
  assert.match(outbox, /transcriptionLeaseExpiresAt\(timestamp\)/);
  assert.match(outbox, /startDispatchLeaseHeartbeat\(leased, owner\)/);
  assert.match(outbox, /processTranscriptionRun\(String\(leased\.run_id\), owner\)/);
  assert.match(outbox, /transcription_queue_outbox[\s\S]{0,500}status = 'sending' AND lease_owner = \?[\s\S]{0,500}transcription_runs[\s\S]{0,500}status = 'processing' AND lease_owner = \?/);
  assert.match(repository, /DEFAULT_TRANSCRIPTION_TIMEOUT_MS\s*=\s*600_000/);
});

test("a staged provider result survives a later persistence failure and prevents a second provider charge", async () => {
  const retry = await loadTypeScriptModule("lib/domain/transcription-retry.ts");
  let providerCalls = 0;
  let stagedLoads = 0;
  let stagedResult = null;

  async function attempt(stagedResultAvailable) {
    return retry.loadOrStageTranscriptionResult({
      stagedResultAvailable,
      loadStagedResult: async () => {
        stagedLoads += 1;
        return stagedResult;
      },
      callProvider: async () => {
        providerCalls += 1;
        return { transcript: "provider-result", providerRequestId: "req_1" };
      },
      stageProviderResult: async (providerResult) => {
        stagedResult = { ...providerResult, resultKey: "staged/run_1.json" };
        return stagedResult;
      },
    });
  }

  const first = await attempt(false);
  await assert.rejects(
    async () => {
      assert.equal(first.resultKey, "staged/run_1.json");
      throw new Error("simulated transcript persistence failure");
    },
    /persistence failure/,
  );
  const retried = await attempt(true);
  assert.equal(retried.resultKey, "staged/run_1.json");
  assert.equal(providerCalls, 1, "the retry must load staged output instead of billing the provider again");
  assert.equal(stagedLoads, 1);
});

test("stale transcription workers cannot overwrite the current Run status on an audio Asset", async () => {
  const processor = await readFile(
    path.join(root, "lib/server/jobs/transcription-processor.ts"),
    "utf8",
  );
  const outbox = await readFile(
    path.join(root, "lib/server/jobs/transcription-outbox.ts"),
    "utf8",
  );
  const section = (source, start, end) => {
    const startIndex = source.indexOf(start);
    return source.slice(startIndex, source.indexOf(end, startIndex + start.length));
  };

  for (const transition of [
    section(processor, "async function markFailed", "async function markRetryable"),
    section(processor, "async function markRetryable", "export async function processTranscriptionRun"),
  ]) {
    assert.match(transition, /\$\.transcription_run_id'[\s\S]*= \?/);
    assert.match(transition, /EXISTS \([\s\S]*SELECT 1 FROM transcription_runs/);
  }

  const expired = section(
    processor,
    "export async function requeueExpiredTranscriptionRuns",
    "\n}",
  );
  assert.match(expired, /id = json_extract\([\s\S]*\$\.transcription_run_id/);
  assert.match(expired, /audio_asset_id = assets\.id[\s\S]*workspace_id = assets\.workspace_id/);

  const exhausted = section(
    outbox,
    "async function markRetryExhaustedRun",
    "export async function dispatchDueTranscriptionOutbox",
  );
  assert.match(exhausted, /\$\.transcription_run_id'[\s\S]*= \?/);
  assert.match(exhausted, /status = 'failed'[\s\S]*TRANSCRIPTION_RETRY_EXHAUSTED/);
  assert.match(outbox, /const markedFailure = await markFailure[\s\S]*retryDecision\.exhausted && markedFailure/);

  const deadLetter = section(outbox, "const \[failedRuns\]", "return {");
  assert.match(deadLetter, /db\.batch\(\[/);
  assert.match(deadLetter, /\$\.transcription_status', 'failed'/);
  assert.match(deadLetter, /id = json_extract\([\s\S]*\$\.transcription_run_id/);
  assert.match(deadLetter, /error_code = 'TRANSCRIPTION_RETRY_EXHAUSTED',[\s\S]*finished_at = \?/);
});

test("single byte Range parser supports explicit, open, and suffix ranges and rejects invalid requests", async () => {
  const { parseSingleByteRange, planByteRangeResponse } = await loadTypeScriptModule(
    "lib/server/http/byte-range.ts",
  );
  assert.deepEqual(parseSingleByteRange(null, 1000), { kind: "none" });
  assert.deepEqual(parseSingleByteRange("bytes=10-19", 1000), {
    kind: "range",
    start: 10,
    end: 19,
    length: 10,
  });
  assert.deepEqual(parseSingleByteRange("bytes=990-", 1000), {
    kind: "range",
    start: 990,
    end: 999,
    length: 10,
  });
  assert.deepEqual(parseSingleByteRange("bytes=-25", 1000), {
    kind: "range",
    start: 975,
    end: 999,
    length: 25,
  });
  assert.deepEqual(parseSingleByteRange("bytes=995-2000", 1000), {
    kind: "range",
    start: 995,
    end: 999,
    length: 5,
  });
  for (const header of ["bytes=1000-", "bytes=20-10", "bytes=0-1,4-5", "items=0-1", "bytes=-0"]) {
    assert.deepEqual(parseSingleByteRange(header, 1000), { kind: "unsatisfiable" });
  }

  assert.deepEqual(planByteRangeResponse(null, 1000), {
    status: 200,
    acceptRanges: "bytes",
    contentLength: 1000,
  });
  assert.deepEqual(planByteRangeResponse("bytes=0-9", 1000), {
    status: 206,
    acceptRanges: "bytes",
    contentLength: 10,
    contentRange: "bytes 0-9/1000",
    range: { offset: 0, length: 10 },
  });
  assert.deepEqual(planByteRangeResponse("bytes=-10", 1000), {
    status: 206,
    acceptRanges: "bytes",
    contentLength: 10,
    contentRange: "bytes 990-999/1000",
    range: { offset: 990, length: 10 },
  });
  assert.deepEqual(planByteRangeResponse("bytes=1000-", 1000), {
    status: 416,
    acceptRanges: "bytes",
    contentLength: 0,
    contentRange: "bytes */1000",
  });
  assert.deepEqual(planByteRangeResponse(null, 0), {
    status: 200,
    acceptRanges: "bytes",
    contentLength: 0,
  });
  assert.deepEqual(planByteRangeResponse("bytes=0-0", 0), {
    status: 416,
    acceptRanges: "bytes",
    contentLength: 0,
    contentRange: "bytes */0",
  });
});

test("diarized output sorts overlapping speaker segments and preserves exact timing", async () => {
  const policy = await loadAudioPolicy();
  const output = policy.validateDiarizedTranscriptOutput({
    duration: 8.5,
    text: "We need the maple cabinets. Confirmed.",
    segments: [
      { speaker: "Aaron", start: 0.25, end: 4.5, text: "We need the maple cabinets." },
      { speaker: "Client", start: 4.75, end: 8.5, text: "Confirmed." },
    ],
  });
  assert.equal(output.segments.length, 2);
  assert.equal(output.segments[0].startSeconds, 0.25);
  assert.equal(output.segments[1].speaker, "Client");
  const reordered = policy.validateDiarizedTranscriptOutput({
    segments: [
      { speaker: "B", start: 4, end: 5, text: "later" },
      { speaker: "A", start: 1, end: 2, text: "earlier" },
    ],
  });
  assert.deepEqual(reordered.segments.map((segment) => segment.speaker), ["A", "B"]);

  const withProviderSilencePlaceholder = policy.validateDiarizedTranscriptOutput({
    segments: [
      { speaker: "A", start: 0, end: 1, text: "Spoken content" },
      { speaker: "A", start: 1, end: 1.4, text: "   " },
      { speaker: "B", start: 1.5, end: 2, text: "More content" },
    ],
  });
  assert.deepEqual(
    withProviderSilencePlaceholder.segments.map((segment) => segment.text),
    ["Spoken content", "More content"],
  );
  assert.throws(
    () => policy.validateDiarizedTranscriptOutput({
      segments: [{ speaker: "A", start: 0, end: 1, text: "" }],
    }),
    /did not contain any spoken text/,
  );
});

test("diarized streaming output requires completion and preserves every segment", async () => {
  const policy = await loadAudioPolicy();
  const body = [
    'event: transcript.text.segment',
    'data: {"type":"transcript.text.segment","id":"seg_2","start":4,"end":6,"text":"Second","speaker":"B"}',
    '',
    'event: transcript.text.segment',
    'data: {"type":"transcript.text.segment","id":"seg_1","start":0,"end":3,"text":"First","speaker":"A"}',
    '',
    'event: transcript.text.done',
    'data: {"type":"transcript.text.done","text":"First Second"}',
    '',
    'data: [DONE]',
  ].join("\n");
  const output = policy.parseDiarizedTranscriptProviderBody(body, "text/event-stream");
  assert.equal(output.text, "First Second");
  assert.deepEqual(output.segments.map((segment) => segment.speaker), ["A", "B"]);
  assert.throws(
    () => policy.parseDiarizedTranscriptProviderBody(
      'data: {"type":"transcript.text.segment","start":0,"end":1,"text":"Partial","speaker":"A"}\n',
      "text/event-stream",
    ),
    /before the final completion event/,
  );
});

test("production route, durable worker, UI, and evidence playback share the audio contract", async () => {
  const [route, processor, outbox, uiSource, repository, envExample] = await Promise.all([
    readFile(path.join(root, "app/api/v1/[...segments]/route.ts"), "utf8"),
    readFile(path.join(root, "lib/server/jobs/transcription-processor.ts"), "utf8"),
    readFile(path.join(root, "lib/server/jobs/transcription-outbox.ts"), "utf8"),
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "lib/server/db/core-repository.ts"), "utf8"),
    readFile(path.join(root, ".env.example"), "utf8"),
  ]);
  assert.match(route, /transcription-runs/);
  assert.match(processor, /\/audio\/transcriptions/);
  assert.match(processor, /response_format", "diarized_json"/);
  assert.match(processor, /chunking_strategy", "auto"/);
  assert.match(processor, /stream", "true"/);
  assert.match(processor, /parseDiarizedTranscriptProviderBody/);
  assert.match(outbox, /TRANSCRIPTION_MAX_ATTEMPTS/);
  assert.match(repository, /Audio must finish transcription before analysis/);
  assert.match(uiSource, /上传已有录音/);
  assert.match(uiSource, /DirectRecorder/);
  assert.match(uiSource, /resolveSimpleImportTarget/);
  assert.match(uiSource, /audioSource/);
  assert.match(envExample, /^AI_TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize$/m);
  assert.match(envExample, /^MAX_AUDIO_BYTES=104857600$/m);
});

test("chunked transcription uses hidden child assets, bounded parallel jobs, and one canonical parent transcript", async () => {
  const [route, repository, processor, outbox, workflow, uiSource, client] = await Promise.all([
    readFile(path.join(root, "app/api/v1/[...segments]/route.ts"), "utf8"),
    readFile(path.join(root, "lib/server/db/transcription-repository.ts"), "utf8"),
    readFile(path.join(root, "lib/server/jobs/transcription-processor.ts"), "utf8"),
    readFile(path.join(root, "lib/server/jobs/transcription-outbox.ts"), "utf8"),
    readFile(path.join(root, "lib/server/db/workflow-repository.ts"), "utf8"),
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/api-client.ts"), "utf8"),
  ]);
  const getHandler = route.slice(route.indexOf("async function getHandler"), route.indexOf("async function postHandler"));
  const postHandler = route.slice(route.indexOf("async function postHandler"), route.indexOf("async function putHandler"));
  assert.doesNotMatch(getHandler, /retry-failed-chunks/);
  assert.match(postHandler, /retry-failed-chunks/);
  assert.match(postHandler, /idempotencyKey\(request\)/);
  assert.match(repository, /orchestration_mode, chunk_count, completed_chunk_count/);
  assert.match(repository, /metadata\.transcription_chunk !== true/);
  assert.match(repository, /metadata\.analysis_source !== false/);
  assert.match(repository, /TRANSCRIPTION_REPLACED_BY_CHUNKED/);
  assert.match(repository, /status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= \?/);
  assert.match(repository, /uq_transcription_runs_parent_chunk|parent_run_id/);
  assert.match(processor, /mergeChunkTranscripts/);
  assert.match(processor, /source_audio_asset_version_id: parent\.audio_asset_version_id/);
  assert.match(outbox, /AUDIO_CHUNK_MAX_PARALLEL/);
  assert.match(outbox, /audioChunkParallelism/);
  assert.match(outbox, /SELECT orchestration_mode, chunk_count/);
  assert.match(outbox, /Promise\.all/);
  assert.match(workflow, /parent_run_id IS NULL/);
  assert.match(uiSource, /prepareLongAudioTranscription/);
  assert.match(uiSource, /api\.downloadAsset\(audioAssetId\)/);
  assert.match(uiSource, /旧的整段任务已换成/);
  assert.match(client, /retryFailedTranscriptionChunks\(runId: Id, idempotencyKey: string\)/);
});

test("audio smoke test uses the production Event response envelope and stays on loopback", async () => {
  const smoke = await readFile(path.join(root, "scripts/run-audio-transcription-smoke.mjs"), "utf8");
  assert.match(smoke, /Audio smoke test is restricted to localhost/);
  assert.match(smoke, /const persistedEvent = await request\(baseUrl, "GET", `\/api\/v1\/events\//);
  assert.match(smoke, /Array\.isArray\(persistedEvent\.assets\)/);
  assert.match(smoke, /item\.processing_status === "ready"/);
  assert.doesNotMatch(smoke, /request\([^\n]+events[^\n]+\)\)\.event;/);
});

test("simple flow supports audio-first setup and preserves a transcription start error after refresh", async () => {
  const beginSimple = declarationSource("beginSimpleTest");
  assert.match(beginSimple, /api\.createProject/);
  assert.doesNotMatch(beginSimple, /api\.createEvent/);
  assert.match(beginSimple, /await loadSimpleProject\(created\.id\)/);
  assert.match(beginSimple, /return \{ project: created, event: null \}/);
  assert.match(beginSimple, /async function beginSimpleTest\(/);
  assert.match(beginSimple, /if \(openTranscriptAfterCreate\) setShowImport\(true\)/);
  assert.match(
    uiSource,
    /onStartOwn=\{\(\) => \{ setSimpleFlow\(true\); setShowNewProject\(true\); \}\}/,
    "the named buyer-project flow must open the form instead of silently creating a test record",
  );
  assert.match(
    uiSource,
    /if \(simpleFlow\) await loadSimpleProject\(created\.id\)/,
    "a buyer project created from the core workspace must remain in the guided workspace",
  );
  assert.match(uiSource, /Transcript 会成为第一条沟通/);

  const attachSimple = declarationSource("attachSimpleFile");
  assert.match(attachSimple, /resolveSimpleImportTarget/);
  assert.match(attachSimple, /createEvent: async \(currentProject\)/);
  assert.match(attachSimple, /await loadSimpleProject\(targetProjectId, targetEventId\);[\s\S]*void prepareLongAudioTranscription\([\s\S]*init\.assetId,[\s\S]*targetEventId/);
  assert.match(attachSimple, /可以继续添加下一份录音/);
  assert.match(attachSimple, /\.catch\(\(error\) => setEventIssue\(toIssue\(error\)\)\)/);
  assert.match(
    attachSimple,
    /const issue = toIssue\(error\);[\s\S]*await loadSimpleProject[\s\S]*setEventIssue\(finalizeStarted[\s\S]*: issue\)/,
    "refresh must finish before restoring the actionable transcription error",
  );
});

test("audio and extraction recovery remain actionable without duplicating an in-flight run", async () => {
  const retryAudio = declarationSource("retryAudioTranscription");
  assert.match(retryAudio, /runInProgress\.has\(current\.status\)/);
  assert.match(retryAudio, /api\.kickDispatcher/);
  assert.match(retryAudio, /api\.getTranscriptionRun\(current\.id\)/);
  assert.match(retryAudio, /launchTranscription\(audioAssetId, event\.id, current\?\.id/);
  assert.match(uiSource, /重新转写/);
  assert.match(uiSource, /重新检查后台状态/);
  assert.match(uiSource, /重新分析/);
});

test("polling keeps attempt state per run, surfaces timeout recovery, and exposes the full transcript", async () => {
  assert.match(uiSource, /transcriptionPollingRunKey\.current !== pollKey/);
  assert.match(uiSource, /pollingRunKey\.current !== pollKey/);
  assert.match(uiSource, /TRANSCRIPTION_POLL_TIMEOUT/);
  assert.match(uiSource, /EXTRACTION_POLL_TIMEOUT/);
  assert.doesNotMatch(uiSource, /\[event\?\.id, flash, transcriptionRun\]/);
  assert.doesNotMatch(uiSource, /\[event\?\.id, loadClaimsForRun, project\?\.id, run\]/);

  const viewer = declarationSource("TranscriptViewer");
  assert.match(viewer, /run\.segments\.map/);
  assert.doesNotMatch(viewer, /\.slice\(/);
  assert.match(uiSource, /查看完整逐字稿/);
});

test("the sweep closes the lease-expiry zombie loop with real SQL", async () => {
  const outbox = await readFile(
    path.join(root, "lib/server/jobs/transcription-outbox.ts"),
    "utf8",
  );

  // Production state observed on 2026-09-01: five chunk runs cycled
  // dispatch → lease expiry → requeue until their outbox rows sat in
  // 'pending' at the attempt cap. The dispatcher refuses rows at the cap and
  // dead-lettering only covered 'sending', so runs stayed 'queued' and the
  // chunked parent stayed 'processing' forever while the UI showed progress.
  const extract = (fragment) => {
    const statements = [...outbox.matchAll(/`((?:UPDATE|SELECT)[\s\S]*?)`/g)].map((m) => m[1]);
    const found = statements.find((sql) => sql.includes(fragment));
    assert.ok(found, `sweep must contain SQL with: ${fragment}`);
    return found;
  };
  const exhaustedPendingSql = extract("WHERE status IN ('pending', 'failed') AND attempt >= ?");
  const failRunsSql = extract("SELECT run_id FROM transcription_queue_outbox");
  const failParentsSql = extract("error_code = 'TRANSCRIPTION_CHUNK_FAILED',");
  assert.match(failParentsSql, /NOT EXISTS[\s\S]*?status NOT IN \('succeeded', 'failed', 'cancelled'\)/);

  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE transcription_runs (
      id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT,
      orchestration_mode TEXT, parent_run_id TEXT, chunk_index INTEGER,
      audio_asset_id TEXT, error_code TEXT, error_details_json TEXT,
      finished_at TEXT, updated_at TEXT
    );
    CREATE TABLE transcription_queue_outbox (
      id TEXT PRIMARY KEY, run_id TEXT, status TEXT, attempt INTEGER,
      next_attempt_at TEXT, lease_owner TEXT, lease_expires_at TEXT,
      last_error_code TEXT, updated_at TEXT
    );
    INSERT INTO transcription_runs VALUES
      ('parent', 'ws', 'processing', 'chunked', NULL, NULL, 'audio-parent', 'TRANSCRIPTION_CHUNK_FAILED', NULL, NULL, ''),
      ('chunk-0', 'ws', 'queued', 'chunk', 'parent', 0, 'a0', 'TRANSCRIPTION_TIMEOUT', NULL, NULL, ''),
      ('chunk-1', 'ws', 'queued', 'chunk', 'parent', 1, 'a1', 'TRANSCRIPTION_TIMEOUT', NULL, NULL, ''),
      ('chunk-5', 'ws', 'succeeded', 'chunk', 'parent', 5, 'a5', NULL, NULL, '2026-09-01T10:30:00.000Z', ''),
      ('fresh', 'ws', 'queued', 'single', NULL, NULL, 'a9', NULL, NULL, NULL, '');
    INSERT INTO transcription_queue_outbox VALUES
      ('o0', 'chunk-0', 'pending', 3, '2026-09-01T10:40:00.000Z', NULL, NULL, 'TRANSCRIPTION_TIMEOUT', ''),
      ('o1', 'chunk-1', 'pending', 3, '2026-09-01T10:40:00.000Z', NULL, NULL, 'TRANSCRIPTION_TIMEOUT', ''),
      ('o9', 'fresh', 'pending', 0, '2026-09-01T10:40:00.000Z', NULL, NULL, NULL, '');
  `);
  const timestamp = "2026-09-01T10:45:00.000Z";

  database.prepare(exhaustedPendingSql).run(timestamp, 3);
  // The failed-runs clause strips its outer batch bindings to (ts, ts, max).
  database.prepare(failRunsSql).run(timestamp, timestamp, 3);
  database.prepare(failParentsSql).run(timestamp, timestamp);

  const runStatus = (id) => ({ ...database.prepare(
    `SELECT status, error_code FROM transcription_runs WHERE id = ?`,
  ).get(id) });
  const outboxStatus = (id) => ({ ...database.prepare(
    `SELECT status, next_attempt_at FROM transcription_queue_outbox WHERE id = ?`,
  ).get(id) });

  assert.deepEqual(runStatus("chunk-0"), { status: "failed", error_code: "TRANSCRIPTION_RETRY_EXHAUSTED" });
  assert.deepEqual(runStatus("chunk-1"), { status: "failed", error_code: "TRANSCRIPTION_RETRY_EXHAUSTED" });
  assert.deepEqual(outboxStatus("o0"), { status: "failed", next_attempt_at: "9999-12-31T23:59:59.999Z" });
  // The parent fails only when no child can still make progress, and keeps
  // the retryable chunk-failure code the retry button understands.
  assert.deepEqual(runStatus("parent"), { status: "failed", error_code: "TRANSCRIPTION_CHUNK_FAILED" });
  // A fresh run under the attempt cap is untouched by every clause.
  assert.deepEqual(runStatus("fresh"), { status: "queued", error_code: null });
  assert.deepEqual(outboxStatus("o9"), { status: "pending", next_attempt_at: "2026-09-01T10:40:00.000Z" });

  // Production drives transcription through the browser's targeted kicks, so
  // the exhaustion closure must live on that path too — the sweep alone never
  // runs when no cron fires. Execute the targeted closure SQL as well.
  const targetedDeadLetterSql = extract("WHERE run_id = ? AND attempt >= ?");
  const database2 = new DatabaseSync(":memory:");
  database2.exec(`
    CREATE TABLE transcription_queue_outbox (
      id TEXT PRIMARY KEY, run_id TEXT, status TEXT, attempt INTEGER,
      next_attempt_at TEXT, lease_owner TEXT, lease_expires_at TEXT,
      last_error_code TEXT, updated_at TEXT
    );
    INSERT INTO transcription_queue_outbox VALUES
      ('t0', 'chunk-z', 'pending', 3, '2026-09-01T10:40:00.000Z', NULL, NULL, 'TRANSCRIPTION_TIMEOUT', ''),
      ('t1', 'other', 'pending', 1, '2026-09-01T10:40:00.000Z', NULL, NULL, NULL, '');
  `);
  database2.prepare(targetedDeadLetterSql).run("2026-09-01T10:45:00.000Z", "chunk-z", 3);
  assert.equal(
    ({ ...database2.prepare(`SELECT status, next_attempt_at FROM transcription_queue_outbox WHERE id = 't0'`).get() }).status,
    "failed",
  );
  assert.equal(
    ({ ...database2.prepare(`SELECT status FROM transcription_queue_outbox WHERE id = 't1'`).get() }).status,
    "pending",
    "another run's rows stay untouched",
  );
  assert.match(outbox, /markRetryExhaustedRun\(target\.runId, "TRANSCRIPTION_TIMEOUT"\)/);
  assert.match(outbox, /failExhaustedChunkParents\(timestamp\);[\s\S]{0,20}return "terminal"/);

  // Fair dispatch: retry-looping rows must not starve fresh work.
  assert.match(outbox, /ORDER BY o\.attempt, o\.next_attempt_at, o\.created_at/);
  // Each recovery cycle idles for the long-queued threshold, so it stays small.
  assert.match(outbox, /Date\.parse\(timestamp\) - 45_000/);
});
