import { getD1 } from "@/db";
import {
  processTranscriptionRun,
  requeueExpiredTranscriptionRuns,
  type TranscriptionProcessResult,
} from "@/lib/server/jobs/transcription-processor";
import {
  TRANSCRIPTION_MAX_ATTEMPTS,
  transcriptionRetryDecision,
} from "@/lib/domain/transcription-retry";
import { sha256Hex } from "@/lib/server/storage/keys";

type Row = Record<string, unknown>;

export type TranscriptionDispatchResult = {
  claimed: number;
  sent: number;
  deferred: number;
  items: Array<{
    outboxId: string;
    runId: string;
    outcome: TranscriptionProcessResult["status"] | "dispatch_failed";
    errorCode?: string;
  }>;
};

export type TranscriptionSweepResult = {
  recoveredOutbox: number;
  deadLetteredOutbox: number;
  requeuedExpiredRuns: number;
  failedUndeliverableRuns: number;
  requeuedLongRunningMessages: number;
};

const MAX_OUTBOX_ATTEMPTS = TRANSCRIPTION_MAX_ATTEMPTS;
const BATCH_LIMIT = 1;

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

async function lease(row: Row, owner: string, timestamp: string): Promise<Row | null> {
  const timeoutMs = Number(row.run_timeout_ms ?? 300_000);
  const leaseMs = Math.max(120_000, Math.min(timeoutMs + 60_000, 660_000));
  const leaseExpiresAt = new Date(Date.parse(timestamp) + leaseMs).toISOString();
  const db = getD1();
  const guardId = id("guard");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM transcription_queue_outbox
              WHERE id = ? AND status IN ('pending', 'failed')
                AND attempt < ? AND next_attempt_at <= ?
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, row.id, MAX_OUTBOX_ATTEMPTS, timestamp, timestamp),
      db
        .prepare(
          `UPDATE transcription_queue_outbox
              SET status = 'sending', attempt = attempt + 1, lease_owner = ?,
                  lease_expires_at = ?, last_error_code = NULL, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'failed')
              AND attempt < ? AND next_attempt_at <= ?`,
        )
        .bind(owner, leaseExpiresAt, timestamp, row.id, MAX_OUTBOX_ATTEMPTS, timestamp),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    return null;
  }
  return first(
    `SELECT * FROM transcription_queue_outbox
      WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
    [row.id, owner],
  );
}

async function markSent(row: Row, owner: string): Promise<void> {
  const timestamp = now();
  await getD1()
    .prepare(
      `UPDATE transcription_queue_outbox
          SET status = 'sent', sent_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_owner = ?`,
    )
    .bind(timestamp, timestamp, row.id, owner)
    .run();
}

async function markFailure(row: Row, owner: string, code: string): Promise<boolean> {
  const timestamp = now();
  const attempt = Number(row.attempt);
  const terminal = attempt >= MAX_OUTBOX_ATTEMPTS;
  const updated = await getD1()
    .prepare(
      `UPDATE transcription_queue_outbox
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
  return Number(updated.meta.changes ?? 0) === 1;
}

async function markRetryExhaustedRun(runId: string, code: string): Promise<void> {
  const timestamp = now();
  await getD1().batch([
    getD1()
      .prepare(
        `UPDATE transcription_runs
            SET status = 'failed', finished_at = ?, error_code = 'TRANSCRIPTION_RETRY_EXHAUSTED',
                error_details_json = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .bind(
        timestamp,
        JSON.stringify({ reason: "provider_retry_exhausted", last_error_code: code }),
        timestamp,
        runId,
      ),
    getD1()
      .prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_status', 'failed',
              '$.transcription_error_code', 'TRANSCRIPTION_RETRY_EXHAUSTED'
            ), updated_at = ?
          WHERE id = (SELECT audio_asset_id FROM transcription_runs WHERE id = ?)
            AND json_extract(
              COALESCE(metadata_json, '{}'),
              '$.transcription_run_id'
            ) = ?
            AND EXISTS (
              SELECT 1 FROM transcription_runs
               WHERE id = ? AND status = 'failed'
                 AND error_code = 'TRANSCRIPTION_RETRY_EXHAUSTED'
                 AND finished_at = ?
            )`,
      )
      .bind(timestamp, runId, runId, runId, timestamp),
  ]);
}

export async function dispatchDueTranscriptionOutbox(): Promise<TranscriptionDispatchResult> {
  const timestamp = now();
  const rows = (
    await getD1()
      .prepare(
        `SELECT o.*, r.request_timeout_ms AS run_timeout_ms
           FROM transcription_queue_outbox o
           JOIN transcription_runs r ON r.id = o.run_id
          WHERE o.status IN ('pending', 'failed') AND o.attempt < ?
            AND o.next_attempt_at <= ?
          ORDER BY o.next_attempt_at, o.created_at
          LIMIT ?`,
      )
      .bind(MAX_OUTBOX_ATTEMPTS, timestamp, BATCH_LIMIT)
      .all<Row>()
  ).results ?? [];
  const result: TranscriptionDispatchResult = {
    claimed: 0,
    sent: 0,
    deferred: 0,
    items: [],
  };
  for (const row of rows) {
    const owner = `transcription_dispatcher_${crypto.randomUUID()}`;
    const leased = await lease(row, owner, timestamp);
    if (!leased) {
      result.deferred += 1;
      continue;
    }
    result.claimed += 1;
    try {
      if (await hashText(String(leased.payload_json)) !== String(leased.payload_hash)) {
        await markFailure(leased, owner, "OUTBOX_PAYLOAD_HASH_MISMATCH");
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: "dispatch_failed",
          errorCode: "OUTBOX_PAYLOAD_HASH_MISMATCH",
        });
        continue;
      }
      const payload = JSON.parse(String(leased.payload_json)) as {
        transcription_run_id?: unknown;
      };
      if (payload.transcription_run_id !== leased.run_id) {
        await markFailure(leased, owner, "OUTBOX_PAYLOAD_INVALID");
        result.items.push({
          outboxId: String(leased.id),
          runId: String(leased.run_id),
          outcome: "dispatch_failed",
          errorCode: "OUTBOX_PAYLOAD_INVALID",
        });
        continue;
      }
      const processed = await processTranscriptionRun(String(leased.run_id));
      if (processed.status === "retryable") {
        const code = processed.errorCode || "TRANSCRIPTION_RETRYABLE_FAILURE";
        const retryDecision = transcriptionRetryDecision({
          runId: String(leased.run_id),
          outboxId: String(leased.id),
          errorCode: code,
          outboxAttempt: Number(leased.attempt),
          maxAttempts: MAX_OUTBOX_ATTEMPTS,
        });
        const markedFailure = await markFailure(leased, owner, code);
        if (retryDecision.exhausted && markedFailure) {
          await markRetryExhaustedRun(retryDecision.runId, retryDecision.errorCode);
        } else {
          result.deferred += 1;
        }
        result.items.push({
          outboxId: retryDecision.outboxId,
          runId: retryDecision.runId,
          outcome: processed.status,
          errorCode: retryDecision.errorCode,
        });
        continue;
      }
      if (processed.status === "lease_not_acquired") {
        const run = await first(`SELECT status FROM transcription_runs WHERE id = ?`, [leased.run_id]);
        const status = String(run?.status ?? "missing");
        if (["processing", "succeeded", "failed", "cancelled"].includes(status)) {
          await markSent(leased, owner);
          result.sent += 1;
        } else {
          await markFailure(leased, owner, "RUN_LEASE_NOT_ACQUIRED");
          result.deferred += 1;
        }
      } else {
        await markSent(leased, owner);
        result.sent += 1;
      }
      result.items.push({
        outboxId: String(leased.id),
        runId: String(leased.run_id),
        outcome: processed.status,
        ...(processed.errorCode ? { errorCode: processed.errorCode } : {}),
      });
    } catch (error) {
      const code = error instanceof Error ? error.name : "OUTBOX_DISPATCH_FAILED";
      await markFailure(leased, owner, code);
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

export async function sweepTranscriptionJobs(
  timestamp = now(),
): Promise<TranscriptionSweepResult> {
  const db = getD1();
  const requeuedExpiredRuns = await requeueExpiredTranscriptionRuns(timestamp);
  const recovered = await db
    .prepare(
      `UPDATE transcription_queue_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, last_error_code = 'OUTBOX_LEASE_EXPIRED', updated_at = ?
        WHERE status = 'sending' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ? AND attempt < ?`,
    )
    .bind(timestamp, timestamp, timestamp, MAX_OUTBOX_ATTEMPTS)
    .run();
  const deadLettered = await db
    .prepare(
      `UPDATE transcription_queue_outbox
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = '9999-12-31T23:59:59.999Z',
              last_error_code = 'OUTBOX_MAX_ATTEMPTS', updated_at = ?
        WHERE status = 'sending' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ? AND attempt >= ?`,
    )
    .bind(timestamp, timestamp, MAX_OUTBOX_ATTEMPTS)
    .run();
  const threshold = new Date(Date.parse(timestamp) - 2 * 60_000).toISOString();
  const requeued = await db
    .prepare(
      `UPDATE transcription_queue_outbox
          SET status = 'pending', sent_at = NULL, next_attempt_at = ?,
              last_error_code = 'LONG_QUEUED_RUN', updated_at = ?
        WHERE status = 'sent' AND run_id IN (
          SELECT id FROM transcription_runs
           WHERE status = 'queued' AND queued_at <= ?
        )`,
    )
    .bind(timestamp, timestamp, threshold)
    .run();
  const [failedRuns] = await db.batch([
    db
      .prepare(
        `UPDATE transcription_runs
            SET status = 'failed', finished_at = ?, error_code = 'QUEUE_DISPATCH_FAILED',
                error_details_json = '{"reason":"outbox_dead_lettered"}', updated_at = ?
          WHERE status = 'queued' AND id IN (
            SELECT run_id FROM transcription_queue_outbox
             WHERE status = 'failed' AND attempt >= ?
               AND next_attempt_at = '9999-12-31T23:59:59.999Z'
          )`,
      )
      .bind(timestamp, timestamp, MAX_OUTBOX_ATTEMPTS),
    db
      .prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_status', 'failed',
              '$.transcription_error_code', 'QUEUE_DISPATCH_FAILED'
            ), updated_at = ?
          WHERE EXISTS (
            SELECT 1 FROM transcription_runs
             WHERE id = json_extract(
               COALESCE(assets.metadata_json, '{}'),
               '$.transcription_run_id'
             )
               AND audio_asset_id = assets.id
               AND workspace_id = assets.workspace_id
               AND status = 'failed'
               AND error_code = 'QUEUE_DISPATCH_FAILED'
               AND finished_at = ?
          )`,
      )
      .bind(timestamp, timestamp),
  ]);
  return {
    recoveredOutbox: Number(recovered.meta.changes ?? 0),
    deadLetteredOutbox: Number(deadLettered.meta.changes ?? 0),
    requeuedExpiredRuns,
    failedUndeliverableRuns: Number(failedRuns.meta.changes ?? 0),
    requeuedLongRunningMessages: Number(requeued.meta.changes ?? 0),
  };
}
