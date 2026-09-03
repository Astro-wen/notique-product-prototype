import { getD1 } from "@/db";
import {
  failExpiredProcessingRuns,
  processExtractionRun,
  recoverExpiredTargetedExtractionRun,
  type ExtractionProcessResult,
} from "@/lib/server/jobs/extraction-processor";
import { outboxLeaseDurationMs } from "@/lib/domain/model-config";
import { sha256Hex } from "@/lib/server/storage/keys";
import {
  dispatchDueTranscriptionOutbox,
  sweepTranscriptionJobs,
  type TranscriptionDispatchResult,
  type TranscriptionSweepResult,
} from "@/lib/server/jobs/transcription-outbox";
import {
  ensureAutomaticExtractionRuns,
  type AutomaticExtractionEnsureResult,
} from "@/lib/server/jobs/automatic-extraction";

type Row = Record<string, unknown>;

export type DispatchResult = {
  claimed: number;
  sent: number;
  deferred: number;
  items: Array<{
    outboxId: string;
    runId: string;
    outcome: ExtractionProcessResult["status"] | "dispatch_failed";
    errorCode?: string;
  }>;
};

export type SweepResult = {
  recoveredOutbox: number;
  deadLetteredOutbox: number;
  failedExpiredRuns: number;
  failedUndeliverableRuns: number;
  requeuedLongRunningMessages: number;
};

const MAX_OUTBOX_ATTEMPTS = 3;
const POC_DISPATCH_BATCH_LIMIT = 1;
// Cloudflare may cancel HTTP waitUntil work after 30 seconds. Give the
// checkpoint a small fencing margin while still making an interrupted browser
// wake recoverable by the next 15-second same-Run kick.
const TARGETED_HTTP_CHECKPOINT_LEASE_MS = 40_000;
const EXTRACTION_TERMINAL_STATES = [
  "succeeded",
  "completed_with_warnings",
  "failed",
  "cancelled",
] as const;

type DispatchTarget = { runId: string; workspaceId: string };

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function backoff(attempt: number): number {
  return Math.min(60_000, 2 ** Math.max(0, attempt - 1) * 2_000);
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function hashText(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value).buffer);
}

async function leaseOutbox(
  row: Row,
  owner: string,
  timestamp: string,
  leaseDurationMs?: number,
): Promise<Row | null> {
  const db = getD1();
  const guardId = id("guard");
  let frozenTimeoutMs: unknown;
  let frozenMaxStages: unknown;
  try {
    const modelParams = JSON.parse(String(row.run_model_params_json ?? "{}")) as Record<
      string,
      unknown
    >;
    frozenTimeoutMs = modelParams.timeout_ms;
    frozenMaxStages = modelParams.max_model_stages;
  } catch {
    frozenTimeoutMs = undefined;
    frozenMaxStages = undefined;
  }
  const leaseExpiresAt = new Date(
    Date.parse(timestamp) + (
      leaseDurationMs ?? outboxLeaseDurationMs(frozenTimeoutMs, frozenMaxStages)
    ),
  ).toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM queue_outbox
              WHERE id = ? AND status IN ('pending', 'failed')
                AND attempt < ? AND next_attempt_at <= ?
                AND EXISTS (
                  SELECT 1 FROM extraction_runs r
                   WHERE r.id = queue_outbox.run_id AND (
                     r.status = 'queued' OR (
                       r.status = 'processing' AND r.lease_owner IS NULL
                       AND EXISTS (
                         SELECT 1 FROM extraction_model_stages s
                          WHERE s.run_id = r.id AND s.status = 'processing'
                            AND s.provider_request_id IS NOT NULL
                       )
                     )
                   )
                )
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, row.id, MAX_OUTBOX_ATTEMPTS, timestamp, timestamp),
      db
        .prepare(
          `UPDATE queue_outbox
              SET status = 'sending', attempt = attempt + 1, lease_owner = ?,
                  lease_expires_at = ?, last_error_code = NULL, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'failed')
              AND attempt < ? AND next_attempt_at <= ?
              AND EXISTS (
                SELECT 1 FROM extraction_runs r
                 WHERE r.id = queue_outbox.run_id AND (
                   r.status = 'queued' OR (
                     r.status = 'processing' AND r.lease_owner IS NULL
                     AND EXISTS (
                       SELECT 1 FROM extraction_model_stages s
                        WHERE s.run_id = r.id AND s.status = 'processing'
                          AND s.provider_request_id IS NOT NULL
                     )
                   )
                 )
              )`,
        )
        .bind(
          owner,
          leaseExpiresAt,
          timestamp,
          row.id,
          MAX_OUTBOX_ATTEMPTS,
          timestamp,
        ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    return null;
  }
  return first(
    `SELECT * FROM queue_outbox WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
    [row.id, owner],
  );
}

async function markSent(row: Row, owner: string): Promise<void> {
  const timestamp = now();
  await getD1()
    .prepare(
      `UPDATE queue_outbox
          SET status = 'sent', sent_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
    )
    .bind(timestamp, timestamp, row.id, owner)
    .run();
}

function hasFrozenTwoPassPipeline(row: Row): boolean {
  try {
    const modelParams = JSON.parse(String(row.run_model_params_json ?? "{}")) as Record<
      string,
      unknown
    >;
    return modelParams.two_pass_pipeline === true;
  } catch {
    return false;
  }
}

async function markDispatchFailure(row: Row, owner: string, code: string): Promise<boolean> {
  const timestamp = now();
  const attempt = Number(row.attempt);
  const terminal = attempt >= MAX_OUTBOX_ATTEMPTS;
  await getD1()
    .prepare(
      `UPDATE queue_outbox
          SET status = 'failed', next_attempt_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = ?, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
    )
    .bind(
      terminal
        ? "9999-12-31T23:59:59.999Z"
        : new Date(Date.parse(timestamp) + backoff(attempt)).toISOString(),
      code,
      timestamp,
      row.id,
      owner,
    )
    .run();
  return terminal;
}

async function failDeferredRun(runId: string, code: string): Promise<void> {
  const timestamp = now();
  await getD1().batch([
    getD1()
      .prepare(
        `UPDATE extraction_runs
            SET status = 'failed', finished_at = ?, error_code = ?,
                error_details_json = '{"reason":"stage_retry_exhausted"}', updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .bind(timestamp, code, timestamp, runId),
    getD1()
      .prepare(
        `UPDATE extraction_model_stages
            SET status = 'failed', validated_output_json = NULL,
                finished_at = ?,
                duration_ms = MAX(0, CAST(
                  (julianday(?) - julianday(started_at)) * 86400000 AS INTEGER
                )),
                error_code = 'STAGE_RETRY_EXHAUSTED',
                error_details_json = '{"reason":"transport_retry_exhausted"}',
                updated_at = ?
          WHERE run_id = ? AND status = 'processing'`,
      )
      .bind(timestamp, timestamp, timestamp, runId),
    getD1()
      .prepare(
        `UPDATE projects
            SET scenario_status = 'unassessed', scenario_assessment_run_id = NULL,
                scenario_candidates_json = '[]', scenario_lease_expires_at = NULL,
                updated_at = ?
          WHERE scenario_status = 'assessing' AND scenario_assessment_run_id = ?`,
      )
      .bind(timestamp, runId),
  ]);
}

async function prepareTargetedExtractionOutbox(
  target: DispatchTarget,
  timestamp: string,
): Promise<"queued" | "processing" | "terminal" | "missing"> {
  const row = await first(
    `SELECT r.status, r.lease_owner,
            CASE WHEN EXISTS (
              SELECT 1 FROM extraction_model_stages s
               WHERE s.run_id = r.id AND s.status = 'processing'
                 AND s.provider_request_id IS NOT NULL
            ) THEN 1 ELSE 0 END AS background_resumable
       FROM extraction_runs r WHERE r.id = ? AND r.workspace_id = ?`,
    [target.runId, target.workspaceId],
  );
  if (!row) return "missing";
  const status = String(row.status);
  if (
    EXTRACTION_TERMINAL_STATES.includes(
      status as (typeof EXTRACTION_TERMINAL_STATES)[number],
    )
  ) {
    await getD1()
      .prepare(
        `UPDATE queue_outbox
            SET status = 'sent', sent_at = COALESCE(sent_at, ?),
                lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = 'RUN_ALREADY_TERMINAL', updated_at = ?
          WHERE run_id = ? AND status <> 'sent'`,
      )
      .bind(timestamp, timestamp, target.runId)
      .run();
    return "terminal";
  }
  if (status === "processing") {
    if (row.lease_owner != null || Number(row.background_resumable) !== 1) {
      return "processing";
    }
    await getD1()
      .prepare(
        `UPDATE queue_outbox
            SET status = 'pending', sent_at = NULL, next_attempt_at = ?,
                lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = 'TARGETED_BACKGROUND_POLL', updated_at = ?
          WHERE run_id = ? AND attempt < ? AND status IN ('sent', 'failed')`,
      )
      .bind(timestamp, timestamp, target.runId, MAX_OUTBOX_ATTEMPTS)
      .run();
    return "queued";
  }
  if (status !== "queued") return "missing";
  await getD1()
    .prepare(
      `UPDATE queue_outbox
          SET status = 'pending', sent_at = NULL, next_attempt_at = ?,
              lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = 'TARGETED_REKICK', updated_at = ?
        WHERE run_id = ? AND attempt < ?
          AND status IN ('sent', 'failed')`,
    )
    .bind(timestamp, timestamp, target.runId, MAX_OUTBOX_ATTEMPTS)
    .run();
  // The reset above only touches rows under the attempt cap; a run whose rows
  // are all capped has nothing left to dispatch and must fail instead of
  // reporting "queued" forever. Production reaches runs through exactly this
  // targeted path, so the sweep-side closure alone is not enough.
  const exhaustion = await first(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN attempt >= ? THEN 1 ELSE 0 END) AS capped
       FROM queue_outbox WHERE run_id = ?`,
    [MAX_OUTBOX_ATTEMPTS, target.runId],
  );
  const total = Number(exhaustion?.total ?? 0);
  if (total > 0 && Number(exhaustion?.capped ?? 0) === total) {
    const closure = now();
    await getD1()
      .prepare(
        `UPDATE queue_outbox
            SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                next_attempt_at = '9999-12-31T23:59:59.999Z',
                last_error_code = 'OUTBOX_MAX_ATTEMPTS', updated_at = ?
          WHERE run_id = ? AND attempt >= ?`,
      )
      .bind(closure, target.runId, MAX_OUTBOX_ATTEMPTS)
      .run();
    await getD1()
      .prepare(
        `UPDATE extraction_runs
            SET status = 'failed', finished_at = ?, error_code = 'QUEUE_DISPATCH_FAILED',
                error_details_json = '{"reason":"outbox_dead_lettered"}', updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .bind(closure, closure, target.runId)
      .run();
    return "terminal";
  }
  return "queued";
}

async function clearTerminalExtractionOutbox(timestamp: string): Promise<void> {
  await getD1()
    .prepare(
      `UPDATE queue_outbox
          SET status = 'sent', sent_at = COALESCE(sent_at, ?),
              lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = 'RUN_ALREADY_TERMINAL', updated_at = ?
        WHERE status <> 'sent' AND run_id IN (
          SELECT id FROM extraction_runs
           WHERE status IN ('succeeded', 'completed_with_warnings', 'failed', 'cancelled')
        )`,
    )
    .bind(timestamp, timestamp)
    .run();
}

export async function dispatchDueOutbox(
  target?: DispatchTarget,
): Promise<DispatchResult> {
  const timestamp = now();
  if (target) {
    // A previous HTTP checkpoint may have been cancelled after its 202
    // response. Recover only an expired short lease; a live owner is never
    // disturbed, and any persisted OpenAI Response ID remains resumable.
    await recoverExpiredTargetedExtractionRun(
      target.workspaceId,
      target.runId,
      timestamp,
    );
    const state = await prepareTargetedExtractionOutbox(target, timestamp);
    if (state !== "queued") {
      return {
        claimed: 0,
        sent: 0,
        deferred: state === "processing" ? 1 : 0,
        items: [],
      };
    }
  } else {
    await clearTerminalExtractionOutbox(timestamp);
  }
  const targetClause = target
    ? " AND o.run_id = ? AND r.workspace_id = ?"
    : "";
  const bindings: unknown[] = [MAX_OUTBOX_ATTEMPTS, timestamp];
  if (target) bindings.push(target.runId, target.workspaceId);
  bindings.push(POC_DISPATCH_BATCH_LIMIT);
  const rows =
    (
      await getD1()
        .prepare(
          `SELECT o.*, r.model_params_json AS run_model_params_json,
                    r.provider AS run_provider
             FROM queue_outbox o
             JOIN extraction_runs r ON r.id = o.run_id
            WHERE o.status IN ('pending', 'failed') AND o.attempt < ?
              AND o.next_attempt_at <= ?
              AND (
                r.status = 'queued' OR (
                  r.status = 'processing' AND r.lease_owner IS NULL
                  AND EXISTS (
                    SELECT 1 FROM extraction_model_stages s
                     WHERE s.run_id = r.id AND s.status = 'processing'
                       AND s.provider_request_id IS NOT NULL
                  )
                )
              )
              ${targetClause}
            ORDER BY o.next_attempt_at, o.created_at
            LIMIT ?`,
        )
        .bind(...bindings)
        .all<Row>()
    ).results ?? [];
  const result: DispatchResult = { claimed: 0, sent: 0, deferred: 0, items: [] };
  for (const row of rows) {
    const targetedHttpCheckpoint = Boolean(
      target && String(row.run_provider) === "openai" && hasFrozenTwoPassPipeline(row),
    );
    if (target && !targetedHttpCheckpoint) {
      // Single-pass and non-OpenAI providers may perform one long synchronous
      // call. Never put them behind the short HTTP recovery lease: leave the
      // durable message due for the scheduled worker's normal long lease.
      result.deferred += 1;
      continue;
    }
    const owner = `dispatcher_${crypto.randomUUID()}`;
    const leased = await leaseOutbox(
      row,
      owner,
      timestamp,
      targetedHttpCheckpoint ? TARGETED_HTTP_CHECKPOINT_LEASE_MS : undefined,
    );
    if (!leased) {
      result.deferred += 1;
      continue;
    }
    result.claimed += 1;
    try {
      const payloadHash = await hashText(String(leased.payload_json));
      if (payloadHash !== String(leased.payload_hash)) {
        await markDispatchFailure(leased, owner, "OUTBOX_PAYLOAD_HASH_MISMATCH");
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: "dispatch_failed",
          errorCode: "OUTBOX_PAYLOAD_HASH_MISMATCH",
        });
        continue;
      }
      const payload = JSON.parse(String(leased.payload_json)) as { run_id?: unknown };
      if (payload.run_id !== leased.run_id) {
        await markDispatchFailure(leased, owner, "OUTBOX_PAYLOAD_INVALID");
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: "dispatch_failed",
          errorCode: "OUTBOX_PAYLOAD_INVALID",
        });
        continue;
      }
      const processed = await processExtractionRun(
        String(leased.run_id),
        targetedHttpCheckpoint
          ? {
              leaseDurationMs: TARGETED_HTTP_CHECKPOINT_LEASE_MS,
              dispatchOutboxOwner: owner,
            }
          : undefined,
      );
      if (processed.status === "background_pending") {
        // The processor atomically released the Run and this exact owned
        // outbox delivery. Never issue a second, post-hoc release here: after
        // lease recovery it could race with a newer dispatcher owner.
        result.deferred += 1;
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: processed.status,
        });
        continue;
      }
      if (processed.status === "deferred") {
        const code = processed.errorCode ?? "MODEL_PROVIDER_REQUEST_FAILED";
        const terminal = await markDispatchFailure(leased, owner, code);
        if (terminal) await failDeferredRun(String(leased.run_id), code);
        result.deferred += 1;
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: processed.status,
          errorCode: code,
        });
        continue;
      }
      if (processed.status === "lease_not_acquired") {
        const runState = await first(
          `SELECT status FROM extraction_runs WHERE id = ?`,
          [leased.run_id],
        );
        const status = String(runState?.status ?? "missing");
        if (
          status === "processing" ||
          ["succeeded", "completed_with_warnings", "failed", "cancelled"].includes(status)
        ) {
          await markSent(leased, owner);
          result.sent += 1;
        } else {
          await markDispatchFailure(leased, owner, "RUN_LEASE_NOT_ACQUIRED");
          result.deferred += 1;
        }
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: processed.status,
          ...(status === "queued" || status === "missing"
            ? { errorCode: "RUN_LEASE_NOT_ACQUIRED" }
            : {}),
        });
        continue;
      }
      // A processor-level `failed` result is terminal and persisted on the run;
      // the outbox message itself has therefore been handled successfully.
      await markSent(leased, owner);
      result.sent += 1;
      result.items.push({
        outboxId: String(leased.id),
        runId: String(leased.run_id),
        outcome: processed.status,
        ...(processed.errorCode ? { errorCode: processed.errorCode } : {}),
      });
    } catch (error) {
      const code = error instanceof Error ? error.name : "OUTBOX_DISPATCH_FAILED";
      await markDispatchFailure(leased, owner, code);
      result.items.push({
        outboxId: String(leased.id),
        runId: String(leased.run_id),
        outcome: "dispatch_failed",
        errorCode: code,
      });
    }
  }
  return result;
}

export async function sweepJobs(timestamp = now()): Promise<SweepResult> {
  const db = getD1();
  const expiredRuns = await failExpiredProcessingRuns(timestamp);
  const recovered = await db
    .prepare(
      `UPDATE queue_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, last_error_code = 'OUTBOX_LEASE_EXPIRED', updated_at = ?
        WHERE status = 'sending' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ? AND attempt < ?`,
    )
    .bind(timestamp, timestamp, timestamp, MAX_OUTBOX_ATTEMPTS)
    .run();
  const deadLettered = await db
    .prepare(
      `UPDATE queue_outbox
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = '9999-12-31T23:59:59.999Z',
              last_error_code = 'OUTBOX_MAX_ATTEMPTS', updated_at = ?
        WHERE status = 'sending' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ? AND attempt >= ?`,
    )
    .bind(timestamp, timestamp, MAX_OUTBOX_ATTEMPTS)
    .run();
  const longQueuedThreshold = new Date(Date.parse(timestamp) - 2 * 60_000).toISOString();
  const requeued = await db
    .prepare(
      `UPDATE queue_outbox
          SET status = 'pending', sent_at = NULL, next_attempt_at = ?,
              last_error_code = 'LONG_QUEUED_RUN', updated_at = ?
        WHERE status = 'sent' AND run_id IN (
          SELECT id FROM extraction_runs
           WHERE status = 'queued' AND COALESCE(current_queued_at, queued_at) <= ?
        )`,
    )
    .bind(timestamp, timestamp, longQueuedThreshold)
    .run();
  // Same zombie the transcription outbox had: a retry cycle ends with rows in
  // 'pending' at the attempt cap while the run sits 'queued'. The dispatcher
  // refuses capped rows and dead-lettering above only covers 'sending', so
  // without this clause the run showed 正在启动分析 forever.
  await db
    .prepare(
      `UPDATE queue_outbox
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = '9999-12-31T23:59:59.999Z',
              last_error_code = 'OUTBOX_MAX_ATTEMPTS', updated_at = ?
        WHERE status IN ('pending', 'failed') AND attempt >= ?
          AND next_attempt_at < '9999-12-31T23:59:59.999Z'
          AND EXISTS (
            SELECT 1 FROM extraction_runs r
             WHERE r.id = queue_outbox.run_id AND r.status = 'queued'
          )`,
    )
    .bind(timestamp, MAX_OUTBOX_ATTEMPTS)
    .run();
  const failedRuns = await db
    .prepare(
      `UPDATE extraction_runs
          SET status = 'failed', finished_at = ?, error_code = 'QUEUE_DISPATCH_FAILED',
              error_details_json = '{"reason":"outbox_dead_lettered"}', updated_at = ?
        WHERE status = 'queued' AND id IN (
          SELECT run_id FROM queue_outbox
           WHERE status = 'failed' AND attempt >= ?
             AND next_attempt_at = '9999-12-31T23:59:59.999Z'
        )`,
    )
    .bind(timestamp, timestamp, MAX_OUTBOX_ATTEMPTS)
    .run();
  await db
    .prepare(
      `UPDATE projects
          SET scenario_status = 'unassessed', scenario_assessment_run_id = NULL,
              scenario_candidates_json = '[]', scenario_lease_expires_at = NULL,
              updated_at = ?
        WHERE scenario_status = 'assessing' AND scenario_assessment_run_id IN (
          SELECT id FROM extraction_runs WHERE status = 'failed'
        )`,
    )
    .bind(timestamp)
    .run();
  return {
    recoveredOutbox: Number(recovered.meta.changes ?? 0),
    deadLetteredOutbox: Number(deadLettered.meta.changes ?? 0),
    failedExpiredRuns: expiredRuns,
    failedUndeliverableRuns: Number(failedRuns.meta.changes ?? 0),
    requeuedLongRunningMessages: Number(requeued.meta.changes ?? 0),
  };
}

/**
 * Runs a recovery stage without letting its failure silence the others.
 *
 * These stages used to share one Promise.all, so a single throwing statement
 * took down every recovery behind it — including the automatic analysis that
 * decides whether a finished transcript is ever read.
 */
async function stage<T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error("recovery_stage_failed", {
      stage: name,
      message: error instanceof Error ? error.message : "Unexpected error",
    });
    return fallback;
  }
}

const EMPTY_SWEEP: SweepResult = {
  recoveredOutbox: 0,
  deadLetteredOutbox: 0,
  failedExpiredRuns: 0,
  failedUndeliverableRuns: 0,
  requeuedLongRunningMessages: 0,
};
const EMPTY_TRANSCRIPTION_SWEEP: TranscriptionSweepResult = {
  recoveredOutbox: 0,
  deadLetteredOutbox: 0,
  requeuedExpiredRuns: 0,
  failedUndeliverableRuns: 0,
  requeuedLongRunningMessages: 0,
  deadLetteredExhaustedPending: 0,
  failedChunkedParents: 0,
};
const EMPTY_DISPATCH: DispatchResult = { claimed: 0, sent: 0, deferred: 0, items: [] };
const EMPTY_AUTOMATIC: AutomaticExtractionEnsureResult = {
  scanned: 0,
  created: 0,
  reused: 0,
  covered: 0,
  deferred: 0,
  items: [],
};

/**
 * Everything the background recovery does except the long audio work.
 *
 * Production has no working Cron trigger: an extraction Run created while
 * nothing was watching sat 'queued' and untouched for as long as it was left
 * there, and Events whose transcripts had been ready for days had no Run at
 * all. So the browser's own dispatch request carries this instead. It is all
 * lease-guarded and idempotent, which is what makes it safe to run from any
 * number of open tabs — and safe to keep running if the Cron ever does fire.
 *
 * The default commissions nothing. Recovery finishing work someone already
 * asked for is free of surprises; recovery deciding on its own to analyse an
 * Event costs money, and a browser running that across the workspace would
 * mean opening the app spends money on projects the reader never looked at.
 * So `commission` is explicit: the Cron may scan the workspace, a browser may
 * only name the Event on its screen.
 *
 * Long audio transcription stays out: it takes minutes, and the page already
 * drives it through the targeted streaming dispatch that holds a connection
 * open for exactly that purpose.
 */
export async function recoverAndDispatch(input?: {
  commission?: "workspace" | { eventId: string };
}): Promise<{
  sweep: SweepResult;
  dispatch: DispatchResult;
  transcription_sweep: TranscriptionSweepResult;
  automatic_extraction: AutomaticExtractionEnsureResult;
}> {
  const [transcription_sweep, sweep] = await Promise.all([
    stage("transcription_sweep", sweepTranscriptionJobs, EMPTY_TRANSCRIPTION_SWEEP),
    stage("extraction_sweep", sweepJobs, EMPTY_SWEEP),
  ]);
  const commission = input?.commission;
  const automatic_extraction = commission
    ? await stage(
      "automatic_extraction",
      () => ensureAutomaticExtractionRuns(
        commission === "workspace" ? undefined : { eventId: commission.eventId },
      ),
      EMPTY_AUTOMATIC,
    )
    : EMPTY_AUTOMATIC;
  // Dispatching is not commissioning: these Runs exist because someone already
  // asked for them, and leaving them queued is the stall this whole mechanism
  // exists to end.
  const dispatch = await stage("extraction_dispatch", () => dispatchDueOutbox(), EMPTY_DISPATCH);
  return { sweep, dispatch, transcription_sweep, automatic_extraction };
}

export async function sweepAndDispatch(): Promise<{
  sweep: SweepResult;
  dispatch: DispatchResult;
  transcription_sweep: TranscriptionSweepResult;
  transcription_dispatch: TranscriptionDispatchResult;
  automatic_extraction: AutomaticExtractionEnsureResult;
}> {
  const recovered = await recoverAndDispatch({ commission: "workspace" });
  const transcription_dispatch = await stage(
    "transcription_dispatch",
    () => dispatchDueTranscriptionOutbox(),
    { claimed: 0, sent: 0, deferred: 0, items: [] } as TranscriptionDispatchResult,
  );
  return { ...recovered, transcription_dispatch };
}

export async function dispatchAllDueOutbox(): Promise<{
  transcription: TranscriptionDispatchResult;
  extraction: DispatchResult;
}> {
  const [transcription, extraction] = await Promise.all([
    dispatchDueTranscriptionOutbox(),
    dispatchDueOutbox(),
  ]);
  return { transcription, extraction };
}

export async function dispatchExtractionRun(
  workspaceId: string,
  runId: string,
): Promise<DispatchResult> {
  return dispatchDueOutbox({ workspaceId, runId });
}
