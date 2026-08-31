import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadProgress() {
  const source = await readFile(path.join(root, "lib/domain/analysis-progress.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("inventory processing reports one durable checkpoint and three remaining steps", async () => {
  const { buildAnalysisProgress } = await loadProgress();
  const progress = buildAnalysisProgress({
    runStatus: "processing",
    pipelineStage: "inventory",
    stages: [{ stage: "inventory", status: "processing", attempt: 1 }],
  });

  assert.equal(progress.completed, 1);
  assert.equal(progress.total, 4);
  assert.equal(progress.percent, 25);
  assert.equal(progress.remaining, 3);
  assert.deepEqual(progress.nodes.map((node) => node.status), [
    "completed",
    "processing",
    "waiting",
    "waiting",
  ]);
});

test("an escalation remains part of verification instead of pretending the draft is ready", async () => {
  const { buildAnalysisProgress } = await loadProgress();
  const progress = buildAnalysisProgress({
    runStatus: "processing",
    pipelineStage: "verify_escalated",
    stages: [
      { stage: "inventory", status: "succeeded", attempt: 1 },
      { stage: "verify", status: "succeeded", attempt: 1 },
      { stage: "verify_escalated", status: "processing", attempt: 1 },
    ],
  });

  assert.equal(progress.percent, 50);
  assert.equal(progress.nodes[2].status, "processing");
  assert.equal(progress.nodes[3].status, "waiting");
});

test("a terminal successful run fills every checkpoint", async () => {
  const { buildAnalysisProgress } = await loadProgress();
  const progress = buildAnalysisProgress({
    runStatus: "completed_with_warnings",
    pipelineStage: "verify_escalated",
    stages: [],
  });

  assert.equal(progress.percent, 100);
  assert.equal(progress.remaining, 0);
  assert.ok(progress.nodes.every((node) => node.status === "completed"));
});

test("the workspace keeps analysis progress user-facing and hides internal diagnostics", async () => {
  const [page, styles] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "app/globals.css"), "utf8"),
  ]);
  assert.match(page, /analysisRunning \? "整理中 · 已可阅读"/);
  assert.match(page, /原始逐字稿已经可以先读/);
  assert.doesNotMatch(page, /data-testid="analysis-progress-journey"/);
  assert.doesNotMatch(page, /处理详情|测试版本·每秒更新|后端定期检查模型任务/);
  assert.match(styles, /\.reading-workspace-state\.running/);
});
