import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { statementContaining } from "./helpers/ui-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("browser dispatch accepts one workspace-scoped Run and returns before processing", async () => {
  const worker = await readFile(path.join(root, "worker/index.ts"), "utf8");
  assert.match(worker, /body\.kind !== "extraction"[\s\S]*body\.kind !== "transcription"/);
  assert.match(worker, /SELECT status FROM \$\{table\} WHERE id = \? AND workspace_id = \?/);
  assert.match(worker, /ctx\.waitUntil\(Promise\.all\(\[[\s\S]*dispatchExtractionRun\([\s\S]*dispatchEventAiArtifactsForExtraction\([\s\S]*\.catch/);
  assert.match(worker, /run_id: input\.runId[\s\S]*run_status: run\.status[\s\S]*202/);
  assert.doesNotMatch(
    worker.slice(worker.indexOf('if (url.pathname === "/api/v1/jobs/dispatch")'), worker.indexOf("return handler.fetch")),
    /await sweepAndDispatch\(\)/,
  );
});

test("production audio keeps the HTTP request open instead of losing the queued Run", async () => {
  const worker = await readFile(path.join(root, "worker/index.ts"), "utf8");
  const transcription = await readFile(
    path.join(root, "lib/server/jobs/transcription-outbox.ts"),
    "utf8",
  );
  assert.match(worker, /env\.APP_ENV === "local"[\s\S]*dispatchTranscriptionRun/);
  assert.match(worker, /streamTranscriptionDispatch[\s\S]*setInterval\(\(\) => controller\.enqueue/);
  assert.match(worker, /return streamTranscriptionDispatch\(workspaceId, input\.runId, requestId, run\.status\)/);
  assert.doesNotMatch(worker, /await dispatchTranscriptionRun\(workspaceId, input\.runId\)/);
  assert.doesNotMatch(worker, /await wakeTranscriptionRun\(workspaceId, input\.runId\)/);
  assert.match(worker, /scheduled[\s\S]*ctx\.waitUntil\(Promise\.all\(\[sweepAndDispatch\(\),\s*sweepAndDispatchEventAiArtifacts\(\)\]\)\)/);
  assert.match(transcription, /export async function wakeTranscriptionRun/);
  assert.match(transcription, /return prepareTargetedTranscriptionOutbox/);
});

test("targeted audio wakes a stale processing lease instead of leaving it stuck", async () => {
  const outbox = await readFile(
    path.join(root, "lib/server/jobs/transcription-outbox.ts"),
    "utf8",
  );
  assert.match(outbox, /lease_expires_at <=/);
  assert.match(outbox, /status = 'queued'[\s\S]{0,500}targeted_lease_expired/);
  assert.match(outbox, /status = 'pending'[\s\S]{0,500}TRANSCRIPTION_TIMEOUT/);
});

test("targeted extraction and transcription dispatch only lease queued matching Runs", async () => {
  const extraction = await readFile(path.join(root, "lib/server/jobs/outbox.ts"), "utf8");
  const transcription = await readFile(
    path.join(root, "lib/server/jobs/transcription-outbox.ts"),
    "utf8",
  );
  for (const source of [extraction, transcription]) {
    assert.match(source, /target\.runId, target\.workspaceId/);
    assert.match(source, /r\.status = 'queued'/);
    assert.match(source, /TARGETED_REKICK/);
    assert.match(source, /RUN_ALREADY_TERMINAL/);
  }
  assert.match(extraction, /dispatchExtractionRun/);
  assert.match(extraction, /recoverExpiredTargetedExtractionRun/);
  assert.match(extraction, /TARGETED_HTTP_CHECKPOINT_LEASE_MS = 40_000/);
  assert.match(transcription, /dispatchTranscriptionRun/);
});

test("an interrupted HTTP extraction checkpoint is recoverable on the next same-Run wake", async () => {
  const processor = await readFile(
    path.join(root, "lib/server/jobs/extraction-processor.ts"),
    "utf8",
  );
  const outbox = await readFile(
    path.join(root, "lib/server/jobs/outbox.ts"),
    "utf8",
  );
  assert.match(outbox, /leaseOutbox\([\s\S]*leaseDurationMs\?: number/);
  assert.match(outbox, /targetedHttpCheckpoint \? TARGETED_HTTP_CHECKPOINT_LEASE_MS/);
  assert.match(outbox, /leaseDurationMs: TARGETED_HTTP_CHECKPOINT_LEASE_MS/);
  assert.match(outbox, /dispatchOutboxOwner: owner/);
  assert.match(processor, /options\?\.leaseDurationMs/);
  assert.match(processor, /options\?\.dispatchOutboxOwner/);
  assert.match(processor, /export async function recoverExpiredTargetedExtractionRun/);
  assert.match(processor, /reason":"expired_http_checkpoint"/);
  assert.match(processor, /status = 'sending'[\s\S]*lease_expires_at <= \?/);
  assert.match(processor, /attempt = CASE WHEN attempt > 0 THEN attempt - 1 ELSE 0 END/);
});

test("targeted HTTP extraction is fenced and only handles frozen two-pass OpenAI Runs", async () => {
  const [outbox, processor] = await Promise.all([
    readFile(path.join(root, "lib/server/jobs/outbox.ts"), "utf8"),
    readFile(path.join(root, "lib/server/jobs/extraction-processor.ts"), "utf8"),
  ]);

  assert.match(outbox, /run_provider\) === "openai" && hasFrozenTwoPassPipeline\(row\)/);
  assert.match(
    outbox,
    /if \(target && !targetedHttpCheckpoint\) \{[\s\S]*result\.deferred \+= 1;[\s\S]*continue;/,
  );
  assert.match(outbox, /leaseDurationMs \?\? outboxLeaseDurationMs/);
  assert.doesNotMatch(outbox, /capExtractionRunDispatchLease/);
  assert.doesNotMatch(outbox, /scheduleBackgroundResponsePoll/);

  const release = processor.slice(
    processor.indexOf("async function releaseRunForBackgroundPoll"),
    processor.indexOf("export async function processExtractionRun"),
  );
  assert.match(release, /mutation_guards/);
  assert.match(release, /lease_owner = \?/);
  assert.match(release, /dispatchOutboxOwner/);
  assert.match(release, /status = 'sending'\s*\n\s*AND \(\? IS NULL OR lease_owner = \?\)/);

  for (const name of ["markRunFailed", "deferRunForStageRetry"]) {
    const start = processor.indexOf(`async function ${name}`);
    const end = processor.indexOf("\nasync function ", start + 1);
    const block = processor.slice(start, end < 0 ? undefined : end);
    assert.match(block, /INSERT INTO mutation_guards/);
    assert.match(block, /status = 'processing' AND lease_owner = \?/);
  }
});

test("an escalated background stage is a dependency barrier and usage includes failed attempts", async () => {
  const processor = await readFile(
    path.join(root, "lib/server/jobs/extraction-processor.ts"),
    "utf8",
  );
  assert.match(processor, /const existingEscalated = await getLatestExtractionModelStage/);
  assert.match(
    processor,
    /const escalationInFlight = Boolean\([\s\S]*existingEscalated\.status === "processing"[\s\S]*existingEscalated\.status === "succeeded"/,
  );
  assert.match(
    processor,
    /if \(escalationInFlight\) \{[\s\S]*stage: "verify_escalated"/,
    "a persisted escalation Response must be resumed before any base Verify retry",
  );
  assert.match(
    processor,
    /async function persistedExtractionUsage\(runId: string\)[\s\S]*status IN \('succeeded', 'failed'\)/,
    "failed provider attempts must remain part of usage accounting",
  );
  assert.match(
    processor,
    /const persistedUsage = await persistedExtractionUsage\(String\(leased\.id\)\)/,
  );
  assert.match(
    processor,
    /processing_stage\.status = 'processing'/,
    "terminal persistence must be fenced while any background stage is still processing",
  );
});

test("ordinary request scope lookup is read-only and mutations initialize explicitly", async () => {
  const context = await readFile(path.join(root, "lib/server/http/context.ts"), "utf8");
  const route = await readFile(path.join(root, "app/api/v1/[...segments]/route.ts"), "utf8");
  const scopeBody = context.slice(
    context.indexOf("export async function getRequestScope"),
    context.indexOf("export async function initializeRequestWorkspace"),
  );
  assert.doesNotMatch(scopeBody, /INSERT INTO workspaces/);
  assert.match(context, /ON CONFLICT\(id\) DO NOTHING/);
  assert.match(route, /async function postHandler[\s\S]*initializeRequestWorkspace\(scope\)/);
  assert.match(route, /async function putHandler[\s\S]*initializeRequestWorkspace\(scope\)/);
  assert.match(route, /async function deleteHandler[\s\S]*initializeRequestWorkspace\(scope\)/);
});

test("workflow snapshot aggregates materials, jobs, pending review, and one next action", async () => {
  const repository = await readFile(
    path.join(root, "lib/server/db/workflow-repository.ts"),
    "utf8",
  );
  const route = await readFile(path.join(root, "app/api/v1/[...segments]/route.ts"), "utf8");
  assert.match(repository, /WITH material_counts AS/);
  assert.match(repository, /LEFT JOIN extraction_runs/);
  assert.match(repository, /LEFT JOIN transcription_runs/);
  assert.match(repository, /pending_claim_count/);
  assert.match(repository, /next_action/);
  assert.match(route, /segments\[2\] === "workflow-snapshot"/);
});

test("queued browser wake survives polling object replacement and only targets the existing Run", async () => {
  const extractionWake = statementContaining("[queuedExtractionRunId, queuedExtractionRunStatus]");
  const transcriptionWake = statementContaining("[queuedTranscriptionRunId, queuedTranscriptionRunStatus]");

  assert.match(extractionWake, /\[queuedExtractionRunId, queuedExtractionRunStatus\]/);
  assert.match(transcriptionWake, /\[queuedTranscriptionRunId, queuedTranscriptionRunStatus\]/);
  assert.doesNotMatch(extractionWake, /\}, \[run\]\)/);
  assert.doesNotMatch(transcriptionWake, /\}, \[transcriptionRun\]\)/);

  for (const block of [extractionWake, transcriptionWake]) {
    assert.match(block, /\.delete\([^)]*RunId\)/);
    assert.doesNotMatch(block, /createExtractionRun|createTranscriptionRun|requestExtractionForEvent/);
  }
  assert.match(extractionWake, /window\.setTimeout\([\s\S]*ACTIVE_BACKGROUND_WAKE_MS/);
  assert.match(transcriptionWake, /window\.setTimeout\([\s\S]*15_000/);
  assert.match(
    extractionWake,
    /if \(queuedExtractionRunStatus === "queued"[\s\S]*?const scheduleWake[\s\S]*?scheduleWake\(\)/,
  );
  assert.match(extractionWake, /processing Run may hold a durable[\s\S]*api\.kickDispatcher/);
  assert.match(
    transcriptionWake,
    /if \(!localDispatchTranscriptionRuns\.current\.has[\s\S]*?\n\s*}\n\s*const runId[\s\S]*?window\.setTimeout/,
  );
});

test("primary queued status stays simple while server queue cycles remain durable", async () => {
  const [page, repository, types] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "lib/server/db/workflow-repository.ts"), "utf8"),
    readFile(path.join(root, "lib/shared/api-types.ts"), "utf8"),
  ]);
  assert.match(page, /if \(run\.status === "queued"\) return "正在启动分析"/);
  assert.match(page, /queued: "正在启动分析"/);

  assert.doesNotMatch(page, /function runTimingItems/);
  assert.doesNotMatch(page, /处理详情/);
  assert.doesNotMatch(page, /item\.attempt[\s\S]*第 \$\{item\.attempt\} 次/);
  assert.match(repository, /er\.first_queued_at AS extraction_first_queued_at/);
  assert.match(repository, /er\.current_queued_at AS extraction_current_queued_at/);
  assert.match(repository, /first_queued_at: nullableText\(row, "extraction_first_queued_at"\)/);
  assert.match(types, /extraction:[\s\S]*first_queued_at: string \| null;[\s\S]*current_started_at: string \| null;/);
});
