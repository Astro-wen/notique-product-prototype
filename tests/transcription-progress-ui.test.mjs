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

test("chunk progress exposes an honest percentage and one stable node per segment", async () => {
  const { buildChunkProgress } = await loadTypeScriptModule("lib/domain/transcription-progress.ts");
  const progress = buildChunkProgress({
    total: 10,
    completed: 3,
    chunks: [
      { index: 0, status: "succeeded" },
      { index: 1, status: "succeeded" },
      { index: 2, status: "processing" },
      { index: 3, status: "failed" },
    ],
  });

  assert.equal(progress.percent, 30);
  assert.equal(progress.remaining, 7);
  assert.equal(progress.nodes.length, 10);
  assert.equal(progress.nodes.filter((node) => node.status === "completed").length, 3);
  assert.equal(progress.nodes[2].status, "processing");
  assert.equal(progress.nodes[3].status, "failed");
});

test("browser preparation includes the active segment without marking it complete", async () => {
  const { buildChunkProgress } = await loadTypeScriptModule("lib/domain/transcription-progress.ts");
  const progress = buildChunkProgress({
    total: 10,
    completed: 9,
    currentIndex: 9,
    currentFraction: 0.8,
  });

  assert.equal(progress.percent, 98);
  assert.equal(progress.remaining, 1);
  assert.equal(progress.nodes[8].status, "completed");
  assert.equal(progress.nodes[9].status, "processing");
});

test("anonymous diarization labels are shown as Speaker 1, Speaker 2, Speaker 3", async () => {
  const { displaySpeakerLabel } = await loadTypeScriptModule("lib/domain/speaker-label.ts");
  assert.equal(displaySpeakerLabel("A"), "Speaker 1");
  assert.equal(displaySpeakerLabel("B"), "Speaker 2");
  assert.equal(displaySpeakerLabel("speaker-C"), "Speaker 3");
  assert.equal(displaySpeakerLabel("Speaker 0"), "Speaker 1");
  assert.equal(displaySpeakerLabel("Buyer"), "Buyer");
  assert.equal(displaySpeakerLabel(null), "说话人未标注");
});

test("the meeting workspace uses the persistent progress journey instead of per-chunk toasts", async () => {
  const [page, styles] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
  ]);
  assert.match(page, /data-testid="transcription-journey"/);
  assert.match(page, /还差 \$\{progress\.remaining\} 段完成识别/);
  assert.match(page, /系统会自动继续，不需要手动开启后台任务/);
  assert.doesNotMatch(page, /正在整理长录音：第 \$\{item\.index \+ 1\}/);
  assert.match(styles, /\.transcription-progress-bar/);
  assert.match(styles, /\.transcription-chunk-node\.completed/);
  assert.match(styles, /\.transcription-milestones/);
});
