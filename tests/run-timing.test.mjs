import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadTiming() {
  const source = await readFile(path.join(root, "lib/domain/run-timing.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("two-stage timing reports queue, preparation, model stages, persistence, and review", async () => {
  const { buildRunTimingItems, runTotalDurationMs } = await loadTiming();
  const run = {
    status: "succeeded",
    createdAt: "2026-08-12T00:00:00.000Z",
    queuedAt: "2026-08-12T00:00:01.000Z",
    startedAt: "2026-08-12T00:00:04.000Z",
    finishedAt: "2026-08-12T00:00:30.000Z",
    stages: [
      { stage: "inventory", status: "succeeded", reasoningEffort: "xhigh", startedAt: "2026-08-12T00:00:06.000Z", finishedAt: "2026-08-12T00:00:16.000Z", durationMs: 10_000, cachedTokens: 0 },
      { stage: "verify", status: "succeeded", reasoningEffort: "high", startedAt: "2026-08-12T00:00:16.000Z", finishedAt: "2026-08-12T00:00:27.000Z", durationMs: 11_000, cachedTokens: 900 },
    ],
  };
  const items = buildRunTimingItems(run, Date.parse("2026-08-12T00:01:00.000Z"), { awaitingReview: true });
  assert.deepEqual(items.map((item) => item.key), ["queue", "prepare", "inventory", "verify", "persist", "review"]);
  assert.equal(items.find((item) => item.key === "queue").durationMs, 3_000);
  assert.equal(items.find((item) => item.key === "prepare").durationMs, 2_000);
  assert.equal(items.find((item) => item.key === "verify").cachedTokens, 900);
  assert.equal(items.find((item) => item.key === "review").durationMs, 30_000);
  assert.equal(runTotalDurationMs(run, Date.now()), 30_000);
});

test("a live stage uses the supplied clock without changing persisted timestamps", async () => {
  const { buildRunTimingItems, runTotalDurationMs } = await loadTiming();
  const run = {
    status: "processing",
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:02.000Z",
    stages: [
      { stage: "inventory", status: "processing", reasoningEffort: "xhigh", startedAt: "2026-08-12T00:00:05.000Z" },
    ],
  };
  const now = Date.parse("2026-08-12T00:00:15.000Z");
  const items = buildRunTimingItems(run, now);
  assert.equal(items.find((item) => item.key === "inventory").durationMs, 10_000);
  assert.equal(items.find((item) => item.key === "inventory").status, "running");
  assert.equal(runTotalDurationMs(run, now), 15_000);
});

test("legacy single-stage runs retain a useful analysis timer", async () => {
  const { buildRunTimingItems } = await loadTiming();
  const items = buildRunTimingItems({
    status: "succeeded",
    createdAt: "2026-08-12T00:00:00.000Z",
    startedAt: "2026-08-12T00:00:02.000Z",
    finishedAt: "2026-08-12T00:00:12.000Z",
    stages: [],
  }, Date.now());
  assert.equal(items.find((item) => item.key === "analysis").durationMs, 10_000);
});

test("a processing model stage becomes recoverable after the timeout window", async () => {
  const { EXTRACTION_STAGE_STALE_AFTER_MS, runNeedsRecovery } = await loadTiming();
  const run = {
    status: "processing",
    createdAt: "2026-08-12T08:55:57.000Z",
    startedAt: "2026-08-12T08:55:58.000Z",
    stages: [{
      stage: "inventory",
      status: "processing",
      reasoningEffort: "xhigh",
      startedAt: "2026-08-12T08:56:00.000Z",
    }],
  };
  assert.equal(
    runNeedsRecovery(run, Date.parse("2026-08-12T09:05:59.999Z")),
    false,
  );
  assert.equal(
    runNeedsRecovery(
      run,
      Date.parse("2026-08-12T08:56:00.000Z") + EXTRACTION_STAGE_STALE_AFTER_MS,
    ),
    true,
  );
});
