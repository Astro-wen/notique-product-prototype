import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const processorPath = resolve(root, "lib/server/jobs/transcription-processor.ts");
const stub = source => `data:text/javascript,${encodeURIComponent(source)}`;
const stubs = new Map([
  ["@/db", stub("export const getD1=()=>globalThis.transcriptionStagingFixture.db;export const getEvidenceBucket=()=>globalThis.transcriptionStagingFixture.bucket;export const getBindings=()=>globalThis.transcriptionStagingFixture.bindings;")],
  ["@/lib/server/http/api", stub("export class ApiFault extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}")],
]);

// Execute the production staging function; expose its private entry point only
// inside this test loader so no additional production API is required.
registerHooks({
  resolve(specifier, context, next) {
    if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
    let target;
    if (specifier.startsWith("@/")) target = resolve(root, specifier.slice(2));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) target = fileURLToPath(new URL(specifier, context.parentURL));
    if (target?.startsWith(root) && !target.includes("/node_modules/")) {
      for (const candidate of [target, `${target}.ts`, `${target}/index.ts`]) {
        if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith("file:") && url.endsWith(".ts") && fileURLToPath(url).startsWith(root) && !url.includes("/node_modules/")) {
      const filename = fileURLToPath(url);
      const source = readFileSync(filename, "utf8") + (filename === processorPath ? "\nexport { loadOrCreateStagedResult, callProvider };\n" : "");
      return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform" }), shortCircuit: true };
    }
    return next(url, context);
  },
});

const { loadOrCreateStagedResult, SPEAKER_SEED_READY_SQL } = await import("../lib/server/jobs/transcription-processor.ts");
const { sha256Hex, transcriptionStagingObjectKey } = await import("../lib/server/storage/keys.ts");
const { diarizedTranscriptJson, validateDiarizedTranscriptOutput } = await import("../lib/domain/audio-transcription.ts");
const resultKey = transcriptionStagingObjectKey({ workspaceId: "ws_test", projectId: "prj_test", eventId: "evt_test", runId: "tr_test" });

function providerBody(text) {
  return { duration: 1, text, segments: [{ speaker: "A", start: 0, end: 1, text }] };
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE transcription_runs (
    id TEXT PRIMARY KEY, status TEXT, lease_owner TEXT,
    staged_result_r2_key TEXT, staged_result_sha256 TEXT,
    provider_request_id TEXT, updated_at TEXT
  )`);
  sqlite.prepare("INSERT INTO transcription_runs VALUES (?, 'processing', 'old', ?, NULL, NULL, NULL)").run("tr_test", resultKey);
  const state = { providerCalls: 0, putAttempts: 0, createdObjects: 0, failNextResultSql: false };
  const objects = new Map();
  const db = {
    prepare(query) {
      return {
        bind(...values) {
          return {
            async first() { return sqlite.prepare(query).get(...values) ?? null; },
            async all() { return { results: sqlite.prepare(query).all(...values) }; },
            async run() {
              if (state.failNextResultSql && /SET staged_result_sha256/.test(query)) {
                state.failNextResultSql = false;
                throw new Error("synthetic SQL outage after R2 write");
              }
              const result = sqlite.prepare(query).run(...values);
              return { success: true, meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  };
  const bucket = {
    async get(key) {
      if (key === "audio/test.wav") return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      const stored = objects.get(key);
      return stored ? { customMetadata: { ...stored.customMetadata }, text: async () => stored.content } : null;
    },
    async put(key, bytes, options) {
      state.putAttempts++;
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      state.createdObjects++;
      objects.set(key, { content: new TextDecoder().decode(bytes), customMetadata: { ...options.customMetadata } });
      return { key };
    },
  };
  const providerQueue = [];
  const providerWaiters = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), "https://synthetic.example/audio/transcriptions");
    state.providerCalls++;
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const call = {
      finish(text, requestId) {
        finish(new Response(JSON.stringify(providerBody(text)), { headers: { "content-type": "application/json", "x-request-id": requestId } }));
      },
    };
    if (providerWaiters.length) providerWaiters.shift()(call);
    else providerQueue.push(call);
    return response;
  };
  globalThis.transcriptionStagingFixture = {
    db, bucket,
    bindings: { AI_PROVIDER: "openai", AI_API_KEY: "synthetic-test-key", AI_API_BASE_URL: "https://synthetic.example" },
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.transcriptionStagingFixture;
    sqlite.close();
  });
  return {
    state, objects,
    nextProvider: () => providerQueue.length ? Promise.resolve(providerQueue.shift()) : new Promise(resolve => providerWaiters.push(resolve)),
    row: () => sqlite.prepare("SELECT * FROM transcription_runs WHERE id = 'tr_test'").get(),
    run: () => ({ ...sqlite.prepare("SELECT * FROM transcription_runs WHERE id = 'tr_test'").get(), workspace_id: "ws_test", project_id: "prj_test", event_id: "evt_test", audio_asset_version_id: "av_test", r2_original_key: "audio/test.wav", mime_type: "audio/wav", filename: "test.wav", model: "synthetic-model" }),
    owner: owner => sqlite.prepare("UPDATE transcription_runs SET lease_owner = ? WHERE id = 'tr_test'").run(owner),
    update: (query, ...values) => sqlite.prepare(query).run(...values),
  };
}

test("a late old lease response cannot overwrite the new owner's staged result", async t => {
  const f = fixture(t);
  const oldAttempt = loadOrCreateStagedResult(f.run(), "old");
  const oldRejected = assert.rejects(oldAttempt, error => error.code === "TRANSCRIPTION_PERSIST_RETRY");
  const oldProvider = await f.nextProvider();
  f.owner("new");
  const newAttempt = loadOrCreateStagedResult(f.run(), "new");
  const newProvider = await f.nextProvider();
  newProvider.finish("New owner's transcript.", "req_new");
  const staged = await newAttempt;
  const storedBefore = f.objects.get(resultKey).content;
  oldProvider.finish("Old owner's late transcript.", "req_old");
  await oldRejected;
  assert.equal(f.objects.get(resultKey).content, storedBefore);
  assert.equal(staged.transcript.text, "New owner's transcript.");
  assert.equal(f.row().staged_result_sha256, await sha256Hex(new TextEncoder().encode(storedBefore).buffer));
  assert.equal(f.row().provider_request_id, "req_new");
  assert.equal(f.row().lease_owner, "new");
  assert.equal(f.state.putAttempts, 2);
  assert.equal(f.state.createdObjects, 1);
});

test("the current owner adopts an old owner's first write using the stored body and request ID", async t => {
  const f = fixture(t);
  const oldAttempt = loadOrCreateStagedResult(f.run(), "old");
  const oldRejected = assert.rejects(oldAttempt, error => error.code === "TRANSCRIPTION_PERSIST_RETRY");
  const oldProvider = await f.nextProvider();
  f.owner("new");
  const newAttempt = loadOrCreateStagedResult(f.run(), "new");
  const newProvider = await f.nextProvider();
  oldProvider.finish("First valid transcript.", "req_old");
  await oldRejected;
  assert.equal(f.row().staged_result_sha256, null, "the expired owner cannot record SQL state");
  const stored = f.objects.get(resultKey);
  stored.customMetadata.sha256 = "0".repeat(64);
  newProvider.finish("Later competing transcript.", "req_new");
  const staged = await newAttempt;
  const actualSha = await sha256Hex(new TextEncoder().encode(stored.content).buffer);
  assert.equal(staged.transcript.text, "First valid transcript.");
  assert.equal(staged.resultSha, actualSha, "hash the stored body instead of trusting metadata or the losing response");
  assert.equal(staged.providerRequestId, "req_old");
  assert.equal(f.row().staged_result_sha256, actualSha);
  assert.equal(f.row().provider_request_id, "req_old");
  assert.equal(f.row().lease_owner, "new");
  assert.equal(f.state.createdObjects, 1);
});

test("R2 output survives SQL failure and a subsequent owner recovers it without a provider call", async t => {
  const f = fixture(t);
  f.state.failNextResultSql = true;
  const firstAttempt = loadOrCreateStagedResult(f.run(), "old");
  const firstRejected = assert.rejects(firstAttempt, error => error.code === "TRANSCRIPTION_PERSIST_RETRY");
  const firstProvider = await f.nextProvider();
  firstProvider.finish("Recover this transcript.", "req_first");
  await firstRejected;
  assert.equal(f.row().staged_result_sha256, null);
  assert.ok(f.objects.has(resultKey));
  f.owner("new");
  const recovered = await loadOrCreateStagedResult(f.run(), "new");
  assert.equal(recovered.transcript.text, "Recover this transcript.");
  assert.equal(recovered.providerRequestId, "req_first");
  assert.equal(f.row().staged_result_sha256, recovered.resultSha);
  assert.equal(f.row().provider_request_id, "req_first");
  assert.equal(f.state.providerCalls, 1);
  assert.equal(f.state.putAttempts, 1);
  assert.equal(f.state.createdObjects, 1);
});

test("a conditional-write collision rejects an invalid stored transcript without replacing it", async t => {
  const f = fixture(t);
  const attempt = loadOrCreateStagedResult(f.run(), "old");
  const rejected = assert.rejects(attempt, error => error.code === "TRANSCRIPTION_OUTPUT_INVALID");
  const provider = await f.nextProvider();
  f.objects.set(resultKey, { content: '{"segments":[]}', customMetadata: { provider_request_id: "req_existing" } });
  provider.finish("A competing valid transcript.", "req_later");
  await rejected;
  assert.equal(f.objects.get(resultKey).content, '{"segments":[]}');
  assert.equal(f.row().staged_result_sha256, null);
  assert.equal(f.state.createdObjects, 0);
});

test("checkpoint recovery still rejects a stored body whose hash disagrees with the Run", async t => {
  const f = fixture(t);
  const content = diarizedTranscriptJson(validateDiarizedTranscriptOutput(providerBody("Existing transcript.")));
  f.objects.set(resultKey, { content, customMetadata: { provider_request_id: "req_existing" } });
  f.update("UPDATE transcription_runs SET staged_result_sha256 = ? WHERE id = 'tr_test'", "0".repeat(64));
  await assert.rejects(loadOrCreateStagedResult(f.run(), "old"), error => error.code === "TRANSCRIPTION_OUTPUT_INVALID");
  assert.equal(f.state.providerCalls, 0);
  assert.equal(f.state.putAttempts, 0);
  assert.equal(f.objects.get(resultKey).content, content);
});

test("checkpoint recovery keeps SQL owner fencing when no checksum was recorded", async t => {
  const f = fixture(t);
  const content = diarizedTranscriptJson(validateDiarizedTranscriptOutput(providerBody("Existing transcript.")));
  f.objects.set(resultKey, { content, customMetadata: { provider_request_id: "req_existing" } });
  const staleRun = f.run();
  f.owner("new");
  await assert.rejects(loadOrCreateStagedResult(staleRun, "old"), error => error.code === "TRANSCRIPTION_PERSIST_RETRY");
  assert.equal(f.row().staged_result_sha256, null);
  assert.equal(f.row().lease_owner, "new");
  assert.equal(f.state.providerCalls, 0);
  assert.equal(f.state.putAttempts, 0);
});


test("later transcription requests share seed voice samples and keep their mapping with the staged result", async t => {
  const f = fixture(t);
  f.update("ALTER TABLE transcription_runs ADD COLUMN parent_run_id TEXT");
  f.update("ALTER TABLE transcription_runs ADD COLUMN workspace_id TEXT");
  f.update("ALTER TABLE transcription_runs ADD COLUMN chunk_index INTEGER");
  f.update("ALTER TABLE transcription_runs ADD COLUMN audio_asset_version_id TEXT");
  f.update("ALTER TABLE transcription_runs ADD COLUMN derived_transcript_asset_version_id TEXT");
  f.update("CREATE TABLE asset_versions (id TEXT PRIMARY KEY, r2_original_key TEXT)");
  f.update("CREATE TABLE text_segments (asset_version_id TEXT, workspace_id TEXT, ordinal INTEGER, speaker TEXT, start_ms INTEGER, end_ms INTEGER, text_raw TEXT)");
  f.update("INSERT INTO asset_versions VALUES ('av_seed', 'audio/seed.wav')");
  f.update("INSERT INTO transcription_runs (id,status,parent_run_id,workspace_id,chunk_index,audio_asset_version_id,derived_transcript_asset_version_id) VALUES ('seed','succeeded','parent','ws_test',0,'av_seed','av_seed_text')");
  f.update("INSERT INTO text_segments VALUES ('av_seed_text','ws_test',0,'A',0,9000,'Agent explanation')");
  f.update("INSERT INTO text_segments VALUES ('av_seed_text','ws_test',1,'B',10000,19000,'Buyer explanation')");
  const pcm = Buffer.alloc(44 + 20 * 32000);
  pcm.write('RIFF',0); pcm.writeUInt32LE(pcm.length-8,4); pcm.write('WAVEfmt ',8);pcm.writeUInt32LE(16,16);
  pcm.writeUInt16LE(1,20);pcm.writeUInt16LE(1,22);pcm.writeUInt32LE(16000,24);pcm.writeUInt32LE(32000,28);pcm.writeUInt16LE(2,32);pcm.writeUInt16LE(16,34);pcm.write('data',36);pcm.writeUInt32LE(pcm.length-44,40);
  const oldGet=globalThis.transcriptionStagingFixture.bucket.get;
  globalThis.transcriptionStagingFixture.bucket.get=async key => key==='audio/seed.wav' ? {arrayBuffer:async()=>pcm.buffer.slice(pcm.byteOffset,pcm.byteOffset+pcm.byteLength)} : oldGet(key);
  let calls=0;
  globalThis.fetch=async (_url, options)=> {
    calls++;
    assert.deepEqual(options.body.getAll('known_speaker_names[]'),['nq_voice_1','nq_voice_2']);
    assert.equal(options.body.getAll('known_speaker_references[]').length,2);
    for(const url of options.body.getAll('known_speaker_references[]')) assert.match(url,/^data:audio\/wav;base64,/);
    return new Response(JSON.stringify({duration:1,text:'Buyer question',segments:[{speaker:'nq_voice_2',start:0,end:1,text:'Buyer question'}]}),{headers:{'content-type':'application/json'}});
  };
  const run={...f.run(),parent_run_id:'parent',chunk_index:1};
  const staged=await loadOrCreateStagedResult(run,'old');
  assert.deepEqual(staged.knownSpeakers,{nq_voice_1:'Speaker 1',nq_voice_2:'Speaker 2'});
  const replay=await loadOrCreateStagedResult({...run,...f.row()},'old');
  assert.deepEqual(replay.knownSpeakers,staged.knownSpeakers);
  assert.equal(calls,1);
  assert.equal(replay.transcript.segments[0].speaker,'nq_voice_2');
});

test("seed gating waits without consuming an attempt, then releases parallel lanes for terminal seeds", async t => {
  const f=fixture(t);
  f.update('ALTER TABLE transcription_runs ADD COLUMN parent_run_id TEXT');
  f.update('ALTER TABLE transcription_runs ADD COLUMN workspace_id TEXT');
  f.update('ALTER TABLE transcription_runs ADD COLUMN chunk_index INTEGER');
  f.update("INSERT INTO transcription_runs (id,status,parent_run_id,workspace_id,chunk_index) VALUES ('seed','queued','parent','ws_test',0)");
  f.update("INSERT INTO transcription_runs (id,status,parent_run_id,workspace_id,chunk_index) VALUES ('later','queued','parent','ws_test',1)");
  const eligible=()=>globalThis.transcriptionStagingFixture.db.prepare(`SELECT r.id FROM transcription_runs r WHERE ${SPEAKER_SEED_READY_SQL} ORDER BY r.id`).bind().all();
  assert.equal((await eligible()).results.some(r=>r.id==='later'),false);
  f.update("UPDATE transcription_runs SET status='processing' WHERE id='seed'");
  assert.equal((await eligible()).results.some(r=>r.id==='later'),false);
  for(const status of ['succeeded','failed','cancelled']) {
    f.update("UPDATE transcription_runs SET status=? WHERE id='seed'",status);
    assert.equal((await eligible()).results.some(r=>r.id==='later'),true);
  }
  f.update("UPDATE transcription_runs SET workspace_id='another' WHERE id='seed'");
  assert.equal((await eligible()).results.some(r=>r.id==='later'),false);
});
