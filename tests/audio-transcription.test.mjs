import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

test("audio policy accepts only the transcription provider formats and enforces 25 MiB", async () => {
  const policy = await loadAudioPolicy();
  assert.equal(policy.audioMimeFor("meeting.mp3", ""), "audio/mpeg");
  assert.equal(policy.audioMimeFor("meeting.m4a", "application/octet-stream"), "audio/mp4");
  assert.equal(policy.audioMimeFor("meeting.wav", "audio/wav"), "audio/wav");
  assert.equal(policy.audioMimeFor("meeting.aac", "audio/aac"), null);
  assert.equal(policy.audioMimeFor("meeting.mp3", "text/plain"), null);
  assert.equal(policy.MAX_AUDIO_BYTES, 25 * 1024 * 1024);
  assert.equal(policy.AUDIO_FILE_ACCEPT.includes(".m4a"), true);
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
  assert.match(deadLetter, /error_code = 'QUEUE_DISPATCH_FAILED'[\s\S]*finished_at = \?/);
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

test("diarized output requires ordered speaker segments and preserves exact timing", async () => {
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
  assert.throws(() => policy.validateDiarizedTranscriptOutput({
    segments: [
      { speaker: "B", start: 4, end: 5, text: "later" },
      { speaker: "A", start: 1, end: 2, text: "earlier" },
    ],
  }), /ordered/);
});

test("production route, durable worker, UI, and evidence playback share the audio contract", async () => {
  const [route, processor, outbox, page, repository, envExample] = await Promise.all([
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
  assert.match(outbox, /TRANSCRIPTION_MAX_ATTEMPTS/);
  assert.match(repository, /Audio must finish transcription before analysis/);
  assert.match(page, /上传录音/);
  assert.match(page, /resolveSimpleImportTarget/);
  assert.match(page, /audioSource/);
  assert.match(envExample, /^AI_TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize$/m);
  assert.match(envExample, /^MAX_AUDIO_BYTES=26214400$/m);
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
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const beginSimple = page.slice(
    page.indexOf("async function beginSimpleTest"),
    page.indexOf("async function attachSimpleFile"),
  );
  assert.match(beginSimple, /api\.createProject/);
  assert.match(beginSimple, /api\.createEvent/);
  assert.match(beginSimple, /await loadSimpleProject\(created\.id, createdEvent\.id\)/);
  assert.match(beginSimple, /async function beginSimpleTest\(/);
  assert.match(beginSimple, /if \(openTranscriptAfterCreate\) setShowImport\(true\)/);
  assert.match(page, /onStartOwn=\{\(\) => void beginSimpleTest\(\)\}/);
  assert.match(page, /else void beginSimpleTest\(true\)/);

  const attachSimple = page.slice(
    page.indexOf("async function attachSimpleFile"),
    page.indexOf("function goSimple"),
  );
  assert.match(attachSimple, /resolveSimpleImportTarget/);
  assert.match(attachSimple, /createEvent: async \(currentProject\)/);
  assert.match(attachSimple, /await launchTranscription\(init\.assetId, targetEvent\.id\)/);
  assert.match(
    attachSimple,
    /const issue = toIssue\(error\);[\s\S]*await loadSimpleProject[\s\S]*setEventIssue\(issue\)/,
    "refresh must finish before restoring the actionable transcription error",
  );
});

test("audio and extraction recovery remain actionable without duplicating an in-flight run", async () => {
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  const retryAudio = page.slice(
    page.indexOf("async function retryAudioTranscription"),
    page.indexOf("async function retryRunStatus"),
  );
  assert.match(retryAudio, /runInProgress\.has\(current\.status\)/);
  assert.match(retryAudio, /api\.kickLocalDispatcher/);
  assert.match(retryAudio, /api\.getTranscriptionRun\(current\.id\)/);
  assert.match(retryAudio, /launchTranscription\(audioAssetId, event\.id, current\?\.id/);
  assert.match(page, /重新转写/);
  assert.match(page, /重新检查后台状态/);
  assert.match(page, /重新分析/);
});

test("polling keeps attempt state per run, surfaces timeout recovery, and exposes the full transcript", async () => {
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(page, /transcriptionPollingRunKey\.current !== pollKey/);
  assert.match(page, /pollingRunKey\.current !== pollKey/);
  assert.match(page, /TRANSCRIPTION_POLL_TIMEOUT/);
  assert.match(page, /EXTRACTION_POLL_TIMEOUT/);
  assert.doesNotMatch(page, /\[event\?\.id, flash, transcriptionRun\]/);
  assert.doesNotMatch(page, /\[event\?\.id, loadClaimsForRun, project\?\.id, run\]/);

  const viewer = page.slice(
    page.indexOf("function TranscriptViewer"),
    page.indexOf("function recordArray"),
  );
  assert.match(viewer, /run\.segments\.map/);
  assert.doesNotMatch(viewer, /\.slice\(/);
  assert.match(page, /查看完整逐字稿/);
});
