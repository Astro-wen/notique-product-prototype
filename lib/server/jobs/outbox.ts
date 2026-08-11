import { getD1 } from "@/db";
import {
  failExpiredProcessingRuns,
  processExtractionRun,
  type ExtractionProcessResult,
} from "@/lib/server/jobs/extraction-processor";
import { outboxLeaseDurationMs } from "@/lib/domain/model-config";
import { sha256Hex } from "@/lib/server/storage/keys";

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

async function leaseOutbox(row: Row, owner: string, timestamp: string): Promise<Row | null> {
  const db = getD1();
  const guardId = id("guard");
  let frozenTimeoutMs: unknown;
  try {
    const modelParams = JSON.parse(String(row.run_model_params_json ?? "{}")) as Record<
      string,
      unknown
    >;
    frozenTimeoutMs = modelParams.timeout_ms;
  } catch {
    frozenTimeoutMs = undefined;
  }
  const leaseExpiresAt = new Date(
    Date.parse(timestamp) + outboxLeaseDurationMs(frozenTimeoutMs),
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
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, row.id, MAX_OUTBOX_ATTEMPTS, timestamp, timestamp),
      db
        .prepare(
          `UPDATE queue_outbox
              SET status = 'sending', attempt = attempt + 1, lease_owner = ?,
                  lease_expires_at = ?, last_error_code = NULL, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'failed')
              AND attempt < ? AND next_attempt_at <= ?`,
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

async function markDispatchFailure(row: Row, owner: string, code: string): Promise<void> {
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
}

export async function dispatchDueOutbox(): Promise<DispatchResult> {
  const timestamp = now();
  const rows =
    (
      await getD1()
        .prepare(
          `SELECT o.*, r.model_params_json AS run_model_params_json
             FROM queue_outbox o
             JOIN extraction_runs r ON r.id = o.run_id
            WHERE o.status IN ('pending', 'failed') AND o.attempt < ?
              AND o.next_attempt_at <= ?
            ORDER BY o.next_attempt_at, o.created_at
            LIMIT ?`,
        )
        .bind(MAX_OUTBOX_ATTEMPTS, timestamp, POC_DISPATCH_BATCH_LIMIT)
        .all<Row>()
    ).results ?? [];
  const result: DispatchResult = { claimed: 0, sent: 0, deferred: 0, items: [] };
  for (const row of rows) {
    const owner = `dispatcher_${crypto.randomUUID()}`;
    const leased = await leaseOutbox(row, owner, timestamp);
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
      const processed = await processExtractionRun(String(leased.run_id));
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
           WHERE status = 'queued' AND queued_at <= ?
        )`,
    )
    .bind(timestamp, timestamp, longQueuedThreshold)
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

export async function sweepAndDispatch(): Promise<{
  sweep: SweepResult;
  dispatch: DispatchResult;
}> {
  const sweep = await sweepJobs();
  const dispatch = await dispatchDueOutbox();
  return { sweep, dispatch };
}
