import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadRecordingPolicy() {
  const source = await readFile(path.join(root, "lib/domain/browser-recording.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("browser recording selects only formats accepted by the existing audio pipeline", async () => {
  const policy = await loadRecordingPolicy();
  assert.equal(
    policy.chooseBrowserRecordingMime((value) => value === "audio/webm"),
    "audio/webm",
  );
  assert.equal(
    policy.chooseBrowserRecordingMime((value) => value === "audio/mp4"),
    "audio/mp4",
  );
  assert.equal(policy.chooseBrowserRecordingMime(() => false), null);
  assert.equal(policy.browserRecordingExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(policy.browserRecordingExtension("audio/mp4"), "m4a");
});

test("recording names and timers are deterministic and upload-safe", async () => {
  const policy = await loadRecordingPolicy();
  assert.equal(
    policy.browserRecordingFilename(new Date("2026-08-12T17:18:19.123Z"), "audio/webm"),
    "notique-recording-2026-08-12T17-18-19-123Z.webm",
  );
  assert.equal(policy.formatRecordingDuration(0), "00:00");
  assert.equal(policy.formatRecordingDuration(65.9), "01:05");
});

test("direct recorder includes permission, pause, preview, retry, save, and cleanup behavior", async () => {
  const recorder = await readFile(path.join(root, "app/direct-recorder.tsx"), "utf8");
  assert.match(recorder, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(recorder, /echoCancellation: true/);
  assert.match(recorder, /recorder\.pause\(\)/);
  assert.match(recorder, /recorder\.resume\(\)/);
  assert.match(recorder, /<audio controls src=\{previewUrl\}/);
  assert.match(recorder, /重新录制/);
  assert.match(recorder, /保存并生成逐字稿/);
  assert.match(recorder, /streamRef\.current\?\.getTracks\(\)\.forEach/);
  assert.match(recorder, /beforeunload/);
});

test("core UI presents one meeting workspace without removing advanced tools", async () => {
  const [page, styles] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
  ]);
  assert.match(page, /simple-meeting-rail/);
  assert.match(page, /meeting-tabs/);
  assert.match(page, /aria-label="来源"/);
  assert.match(page, />来源 </);
  assert.match(page, /aria-label="本次重点"/);
  assert.match(page, /aria-label="待确认"/);
  assert.match(page, /aria-label="整个项目"/);
  assert.match(page, /<DirectRecorder/);
  assert.match(page, /直接录音/);
  assert.match(page, /上传已有录音/);
  assert.match(page, /查看本次运行详情/);
  assert.match(page, /高级工具/);
  assert.match(styles, /\.simple-workspace/);
  assert.match(styles, /@media \(max-width: 800px\)[\s\S]*\.simple-event-select \{ display: grid !important; \}/);
  assert.match(styles, /@media \(max-width: 800px\)[\s\S]*\.simple-meeting-rail \{ display: none; \}/);
});
