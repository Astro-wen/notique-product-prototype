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

async function loadApiClient() {
  const source = await readFile(path.join(root, "app/api-client.ts"), "utf8");
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
    pendingTotal: 0,
    trustState: "trusted",
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

test("a successful Event can leave draft review pending while the next Event becomes ready", async () => {
  const { planProjectWorkflow } = await loadWorkflow();
  const waitingReview = planProjectWorkflow({
    events: [
      workflowEvent({ id: "evt_1", runId: "run_1", runStatus: "succeeded", pendingCount: 2 }),
      workflowEvent({ id: "evt_2" }),
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(waitingReview.phase, "ready");
  assert.equal(waitingReview.currentEventId, "evt_2");
  assert.equal(waitingReview.completed, 1);
  assert.equal(waitingReview.pendingTotal, 2);
  assert.equal(waitingReview.trustState, "draft_ready");

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
  assert.equal(readyForSecond.trustState, "trusted");
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

test("workflow snapshot derives one truthful display state from material and job state", async () => {
  const { deriveProjectWorkflowDisplayStatus } = await loadWorkflow();
  const base = {
    materialStatus: "ready",
    materialTotal: 1,
    materialProcessing: 0,
    materialFailed: 0,
    transcriptionStatus: null,
    extractionStatus: null,
    extractionStage: null,
    scenarioStatus: "confirmed",
    pendingCount: 0,
    candidateCount: 1,
  };
  assert.equal(deriveProjectWorkflowDisplayStatus(base), "ready");
  assert.equal(
    deriveProjectWorkflowDisplayStatus({ ...base, transcriptionStatus: "processing" }),
    "transcribing",
  );
  assert.equal(
    deriveProjectWorkflowDisplayStatus({
      ...base,
      extractionStatus: "processing",
      extractionStage: "verify",
    }),
    "verify",
  );
  assert.equal(
    deriveProjectWorkflowDisplayStatus({
      ...base,
      extractionStatus: "succeeded",
      pendingCount: 2,
    }),
    "waiting_review",
  );
  assert.equal(
    deriveProjectWorkflowDisplayStatus({
      ...base,
      extractionStatus: "succeeded",
      candidateCount: 0,
    }),
    "needs_attention",
  );
});

test("workflow Event adapter exposes one status summary and rejects conflicting selected state", async () => {
  const { normalizeWorkflowEventSummary } = await loadApiClient();
  const event = {
    id: "evt_1",
    title: "Buyer intake",
    occurred_at: "2026-08-15T12:00:00.000Z",
    sequence_no: 1,
    material_status: "ready",
    display_status: "needs_attention",
    materials: { total: 3, ready: 2, processing: 0, failed: 1 },
    transcription: {
      run_id: "tr_1",
      status: "failed",
      error_code: "TRANSCRIPTION_OUTPUT_INVALID",
      processing_attempt_no: 1,
      dispatch_attempt_no: 1,
    },
    extraction: {
      run_id: "run_1",
      status: "completed_with_warnings",
      stage: "verify",
      error_code: null,
      processing_attempt_no: 1,
      dispatch_attempt_no: 1,
      created_at: "2026-08-15T12:00:00.000Z",
      queued_at: "2026-08-15T12:00:00.000Z",
      first_queued_at: "2026-08-15T12:00:00.000Z",
      current_queued_at: "2026-08-15T12:00:00.000Z",
      started_at: "2026-08-15T12:00:01.000Z",
      first_started_at: "2026-08-15T12:00:01.000Z",
      current_started_at: "2026-08-15T12:00:01.000Z",
      finished_at: "2026-08-15T12:01:00.000Z",
      updated_at: "2026-08-15T12:01:00.000Z",
    },
    ai_artifacts: {
      summary: { status: "failed" },
      readable_transcript: { status: "succeeded" },
    },
    pending_claim_count: 2,
    pending_occurrence_count: 1,
    candidate_count: 5,
    status_summary: {
      material_count: 3,
      material_ready_count: 2,
      material_processing_count: 0,
      material_failed_count: 1,
      transcription_status: "failed",
      extraction_status: "completed_with_warnings",
      pending_count: 3,
      candidate_count: 5,
      summary_status: "failed",
      readable_transcript_status: "succeeded",
    },
  };
  const normalized = normalizeWorkflowEventSummary(event);
  assert.deepEqual(normalized.statusSummary, {
    materialCount: 3,
    materialReadyCount: 2,
    materialProcessingCount: 0,
    materialFailedCount: 1,
    transcriptionStatus: "failed",
    extractionStatus: "completed_with_warnings",
    pendingCount: 3,
    candidateCount: 5,
    summaryStatus: "failed",
    readableTranscriptStatus: "succeeded",
  });
  assert.throws(
    () => normalizeWorkflowEventSummary({
      ...event,
      status_summary: { ...event.status_summary, summary_status: "succeeded" },
    }),
    /conflicting Event states/,
  );
});

test("workflow snapshot reading aids follow the active extraction and newest terminal retry", async () => {
  const repository = await readFile(
    path.join(root, "lib/server/db/workflow-repository.ts"),
    "utf8",
  );
  for (const kind of ["summary", "readable_transcript"]) {
    const start = repository.indexOf(`AND latest.kind = '${kind}'`);
    assert.ok(start >= 0, `missing ${kind} snapshot join`);
    const selection = repository.slice(start, start + 260);
    assert.match(selection, /latest\.extraction_run_id = e\.active_run_id/);
    assert.match(selection, /ORDER BY latest\.created_at DESC, latest\.id DESC LIMIT 1/);
  }
  assert.match(repository, /summary_status: summaryRun\?\.status \?\? null/);
  assert.match(
    repository,
    /readable_transcript_status: readableTranscriptRun\?\.status \?\? null/,
  );
});

test("workflow material counts exclude generated readable transcript assets", async () => {
  const repository = await readFile(
    new URL("../lib/server/db/workflow-repository.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    repository,
    /COALESCE\(json_extract\(metadata_json, '\$\.analysis_source'\), 1\) <> 0/,
  );
  assert.match(
    repository,
    /COALESCE\(json_extract\(metadata_json, '\$\.artifact_kind'\), ''\) <> 'readable_transcript'/,
  );
});

test("the project-level entry never preselects a Scenario or auto-reviews Claims", async () => {
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.doesNotMatch(page, /useState\(project\?\.scenarioCandidates\?\.\[0\]\?\.key/);
  assert.match(page, /开始处理全部沟通/);
  assert.match(page, /继续处理下一次沟通/);
  assert.match(page, /loadWorkflowSnapshot\(projectId(?:, true)?\)/);
  assert.match(page, /workflowSnapshotQuery\(projectId\)/);
  assert.match(page, /candidateCount: summary\?\.candidate_count/);
  assert.doesNotMatch(page, /api\.getRunReview\(latestRun\.id\)/);
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
  assert.match(
    simpleScreen,
    /\{workflowActionable && <button className="project-workflow-action"/,
    "a primary workflow action must stay hidden while it cannot be used",
  );
  assert.doesNotMatch(
    simpleScreen,
    /projectWorkflow\.phase !== "empty" && <button className="project-workflow-action"/,
    "waiting and running states must not render a disabled primary action",
  );
  assert.match(simpleScreen, /issueRetry[\s\S]*onProjectWorkflowAction/);
  assert.match(simpleScreen, /workflowReviewReady = pendingCount > 0 && analysisDone && !needsScenario/);
  assert.match(simpleScreen, /\{workflowReviewReady && <button[\s\S]*核对重要内容/);
});
