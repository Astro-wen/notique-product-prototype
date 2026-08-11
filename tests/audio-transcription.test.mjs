import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadAudioPolicy() {
  const source = await readFile(path.join(root, "lib/domain/audio-transcription.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
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
  assert.match(outbox, /MAX_OUTBOX_ATTEMPTS = 3/);
  assert.match(repository, /Audio must finish transcription before analysis/);
  assert.match(page, /上传录音/);
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
