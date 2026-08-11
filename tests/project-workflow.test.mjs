import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadWorkflow() {
  const source = await readFile(path.join(root, "lib/domain/project-workflow.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

function workflowEvent(overrides = {}) {
  return {
    id: "evt_1",
    title: "第一次沟通",
    hasMaterial: true,
    ready: true,
    candidateCount: 1,
    pendingCount: 0,
    ...overrides,
  };
}

test("project workflow preserves the sequence returned by listEvents", async () => {
  const { sortProjectWorkflowEvents } = await loadWorkflow();
  const events = [
    workflowEvent({ id: "evt_backfilled", occurredAt: "2026-08-10T10:00:00Z" }),
    workflowEvent({ id: "evt_original", occurredAt: "2026-08-01T10:00:00Z" }),
  ];
  const ordered = sortProjectWorkflowEvents(events);
  assert.deepEqual(ordered.map((item) => item.id), ["evt_backfilled", "evt_original"]);
  assert.notEqual(ordered, events);
});

test("project workflow ignores empty placeholders and starts the first material-bearing Event", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_empty", hasMaterial: false, ready: false }),
      workflowEvent({ id: "evt_first_ready", title: "现场沟通" }),
      workflowEvent({ id: "evt_second_ready", title: "电话确认" }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.deepEqual(plan, {
    phase: "ready",
    total: 2,
    completed: 0,
    currentPosition: 1,
    currentEventId: "evt_first_ready",
    currentEventTitle: "现场沟通",
    currentRunId: undefined,
    ignoredEmptyCount: 1,
  });
});

test("project workflow resumes an existing in-progress Run instead of advancing", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [workflowEvent({ runId: "run_existing", runStatus: "processing" })],
    needsScenarioConfirmation: false,
  });
  assert.equal(plan.phase, "running");
  assert.equal(plan.currentRunId, "run_existing");
  assert.equal(plan.currentPosition, 1);
});

test("the first successful Event pauses for explicit Scenario confirmation", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [workflowEvent({ runId: "run_1", runStatus: "succeeded", pendingCount: 3 })],
    needsScenarioConfirmation: true,
  });
  assert.equal(plan.phase, "waiting_scenario");
  assert.equal(plan.completed, 0);
});

test("a successful Run with no Claim or Occurrence blocks later Events as empty output", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [
      workflowEvent({
        id: "evt_empty_output",
        runId: "run_empty_output",
        runStatus: "succeeded",
        candidateCount: 0,
      }),
      workflowEvent({ id: "evt_must_not_run" }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(plan.phase, "empty_output");
  assert.equal(plan.currentEventId, "evt_empty_output");
  assert.equal(plan.completed, 0);
  assert.equal(plan.currentPosition, 1);
});

test("a successful Event pauses for review before later Events can use its context", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const waitingReview = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_1", runId: "run_1", runStatus: "succeeded", pendingCount: 2 }),
      workflowEvent({ id: "evt_2" }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(waitingReview.phase, "waiting_review");
  assert.equal(waitingReview.currentEventId, "evt_1");
  assert.equal(waitingReview.completed, 0);

  const readyForSecond = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_1", runId: "run_1", runStatus: "succeeded", pendingCount: 0 }),
      workflowEvent({ id: "evt_2" }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(readyForSecond.phase, "ready");
  assert.equal(readyForSecond.currentEventId, "evt_2");
  assert.equal(readyForSecond.completed, 1);
  assert.equal(readyForSecond.currentPosition, 2);
});

test("an earlier material-bearing Event blocks later Events until its material is ready", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_audio", ready: false }),
      workflowEvent({ id: "evt_later", ready: true }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(plan.phase, "waiting_material");
  assert.equal(plan.currentEventId, "evt_audio");
});

test("project workflow completes only after every included Event is successful and reviewed", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_1", runId: "run_1", runStatus: "succeeded" }),
      workflowEvent({ id: "evt_2", runId: "run_2", runStatus: "completed_with_warnings" }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(plan.phase, "complete");
  assert.equal(plan.completed, 2);
  assert.equal(plan.total, 2);
});

test("completion preserves the count of material-free Events that were not processed", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const plan = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_done", runId: "run_done", runStatus: "succeeded" }),
      workflowEvent({ id: "evt_no_material", hasMaterial: false, ready: false }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(plan.phase, "complete");
  assert.equal(plan.total, 1);
  assert.equal(plan.completed, 1);
  assert.equal(plan.ignoredEmptyCount, 1);
});

test("the project-level entry never preselects a Scenario or auto-reviews Claims", async () => {
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.doesNotMatch(page, /useState\(project\?\.scenarioCandidates\?\.\[0\]\?\.key/);
  assert.match(page, /开始处理全部沟通/);
  assert.match(page, /继续处理下一次沟通/);
  assert.match(page, /api\.getRunReview\(latestRun\.id\)/);
  assert.match(page, /Claim 和再次出现记录都是 0/);
  assert.match(page, /次沟通没有材料，未纳入处理/);
  assert.match(page, /等待当前材料准备完成/);
  assert.match(page, /正在处理，请稍候/);
  assert.match(page, /请先确认使用场景/);

  const start = page.indexOf("async function advanceProjectWorkflow");
  const end = page.indexOf("async function beginSimpleTest", start);
  assert.ok(start >= 0 && end > start);
  const workflowAction = page.slice(start, end);
  assert.match(workflowAction, /requestExtractionForEvent\(current\.event\)/);
  assert.doesNotMatch(workflowAction, /confirmCurrentScenario|confirmScenario|saveVerdict|batchConfirm/);

  const simpleStart = page.indexOf("function SimpleTestScreen");
  const simpleEnd = page.indexOf("function PageHeader", simpleStart);
  assert.ok(simpleStart >= 0 && simpleEnd > simpleStart);
  const simpleScreen = page.slice(simpleStart, simpleEnd);
  assert.doesNotMatch(simpleScreen, /onAnalyze/);
  assert.doesNotMatch(simpleScreen, /onRetryRunStatus/);
  assert.match(simpleScreen, /onClick=\{onProjectWorkflowAction\}/);
  assert.match(simpleScreen, /issueRetry[\s\S]*onProjectWorkflowAction/);
  assert.match(simpleScreen, /workflowReviewReady = projectWorkflow\.phase === "waiting_review"/);
  assert.match(simpleScreen, /disabled=\{!workflowReviewReady \|\| Boolean\(busy\)\}/);
});
