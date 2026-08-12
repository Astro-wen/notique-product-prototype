import { getD1 } from "@/db";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import type { ReviewSessionRecord } from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

function integer(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function nullableInteger(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : Number(row[key]);
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function reviewSessionRecord(row: Row): ReviewSessionRecord {
  return {
    id: String(row.id ?? ""),
    project_id: String(row.project_id ?? ""),
    actor_id: String(row.actor_id ?? ""),
    status: String(row.status ?? "active") as ReviewSessionRecord["status"],
    started_at: String(row.started_at ?? ""),
    completed_at: nullableText(row, "completed_at"),
    duration_ms: nullableInteger(row, "duration_ms"),
    initial_pending_claim_count: integer(row, "initial_pending_claim_count"),
    initial_pending_occurrence_count: integer(
      row,
      "initial_pending_occurrence_count",
    ),
    remaining_pending_claim_count: integer(row, "remaining_pending_claim_count"),
    remaining_pending_occurrence_count: integer(
      row,
      "remaining_pending_occurrence_count",
    ),
    outcome: {
      confirmed_claim_count: integer(row, "confirmed_claim_count"),
      edited_claim_count: integer(row, "edited_claim_count"),
      rejected_claim_count: integer(row, "rejected_claim_count"),
      human_added_claim_count: integer(row, "human_added_claim_count"),
      confirmed_occurrence_count: integer(row, "confirmed_occurrence_count"),
      rejected_occurrence_count: integer(row, "rejected_occurrence_count"),
      accepted_relation_count: integer(row, "accepted_relation_count"),
      rejected_relation_count: integer(row, "rejected_relation_count"),
    },
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

async function reviewOutcomeColumns(
  scope: RequestScope,
  row: Row,
): Promise<Row> {
  const projectId = String(row.project_id ?? "");
  const startedAt = String(row.started_at ?? "");
  const endedAt = nullableText(row, "completed_at") ?? now();
  const result = await getD1()
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(CASE WHEN v.action = 'confirm' THEN 1 ELSE 0 END)
           FROM verdicts v WHERE v.project_id = ? AND v.user_id = ?
             AND v.created_at >= ? AND v.created_at <= ?), 0) AS confirmed_claim_count,
         COALESCE((SELECT SUM(CASE WHEN v.action = 'edit' THEN 1 ELSE 0 END)
           FROM verdicts v WHERE v.project_id = ? AND v.user_id = ?
             AND v.created_at >= ? AND v.created_at <= ?), 0) AS edited_claim_count,
         COALESCE((SELECT SUM(CASE WHEN v.action = 'reject' THEN 1 ELSE 0 END)
           FROM verdicts v WHERE v.project_id = ? AND v.user_id = ?
             AND v.created_at >= ? AND v.created_at <= ?), 0) AS rejected_claim_count,
         COALESCE((SELECT COUNT(*) FROM claims c
           WHERE c.project_id = ? AND c.workspace_id = ? AND c.source = 'human'
             AND c.created_at >= ? AND c.created_at <= ?), 0) AS human_added_claim_count,
         COALESCE((SELECT SUM(CASE WHEN ov.action = 'confirm' THEN 1 ELSE 0 END)
           FROM occurrence_verdicts ov
           JOIN claim_occurrence_candidates occ ON occ.id = ov.candidate_id
          WHERE occ.project_id = ? AND occ.workspace_id = ? AND ov.user_id = ?
            AND ov.created_at >= ? AND ov.created_at <= ?), 0) AS confirmed_occurrence_count,
         COALESCE((SELECT SUM(CASE WHEN ov.action = 'reject' THEN 1 ELSE 0 END)
           FROM occurrence_verdicts ov
           JOIN claim_occurrence_candidates occ ON occ.id = ov.candidate_id
          WHERE occ.project_id = ? AND occ.workspace_id = ? AND ov.user_id = ?
            AND ov.created_at >= ? AND ov.created_at <= ?), 0) AS rejected_occurrence_count,
         COALESCE((SELECT SUM(CASE WHEN rv.action = 'confirm' THEN 1 ELSE 0 END)
           FROM relation_verdicts rv
           JOIN claim_relations cr ON cr.id = rv.relation_id
          WHERE cr.project_id = ? AND cr.workspace_id = ? AND rv.user_id = ?
            AND rv.created_at >= ? AND rv.created_at <= ?), 0) AS accepted_relation_count,
         COALESCE((SELECT SUM(CASE WHEN rv.action = 'reject' THEN 1 ELSE 0 END)
           FROM relation_verdicts rv
           JOIN claim_relations cr ON cr.id = rv.relation_id
          WHERE cr.project_id = ? AND cr.workspace_id = ? AND rv.user_id = ?
            AND rv.created_at >= ? AND rv.created_at <= ?), 0) AS rejected_relation_count`,
    )
    .bind(
      projectId, scope.actorId, startedAt, endedAt,
      projectId, scope.actorId, startedAt, endedAt,
      projectId, scope.actorId, startedAt, endedAt,
      projectId, scope.workspaceId, startedAt, endedAt,
      projectId, scope.workspaceId, scope.actorId, startedAt, endedAt,
      projectId, scope.workspaceId, scope.actorId, startedAt, endedAt,
      projectId, scope.workspaceId, scope.actorId, startedAt, endedAt,
      projectId, scope.workspaceId, scope.actorId, startedAt, endedAt,
    )
    .first<Row>();
  return result ?? {};
}

async function pendingCounts(
  scope: RequestScope,
  projectId: string,
): Promise<{ claims: number; occurrences: number }> {
  const row = await getD1()
    .prepare(
      `SELECT
         COALESCE((
           SELECT COUNT(*) FROM claims c
            WHERE c.project_id = p.id AND c.workspace_id = p.workspace_id
              AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
              AND EXISTS (
                SELECT 1 FROM events latest
                 WHERE latest.id = c.event_id
                   AND latest.project_id = p.id
                   AND latest.workspace_id = p.workspace_id
                   AND latest.active_run_id = c.extraction_run_id
              )
         ), 0) AS pending_claim_count,
         COALESCE((
           SELECT COUNT(*) FROM claim_occurrence_candidates occ
            WHERE occ.project_id = p.id AND occ.workspace_id = p.workspace_id
              AND occ.status = 'pending'
              AND EXISTS (
                SELECT 1 FROM events latest
                 WHERE latest.id = occ.event_id
                   AND latest.project_id = p.id
                   AND latest.workspace_id = p.workspace_id
                   AND latest.active_run_id = occ.extraction_run_id
              )
         ), 0) AS pending_occurrence_count
       FROM projects p
       WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
    )
    .bind(projectId, scope.workspaceId)
    .first<Row>();
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");
  }
  return {
    claims: integer(row, "pending_claim_count"),
    occurrences: integer(row, "pending_occurrence_count"),
  };
}

async function sessionById(
  scope: RequestScope,
  sessionId: string,
): Promise<ReviewSessionRecord> {
  const row = await getD1()
    .prepare(
      `SELECT rs.*
         FROM review_sessions rs
         JOIN projects p ON p.id = rs.project_id
        WHERE rs.id = ? AND rs.workspace_id = ? AND rs.actor_id = ?
          AND p.deleted_at IS NULL`,
    )
    .bind(sessionId, scope.workspaceId, scope.actorId)
    .first<Row>();
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Review session was not found.");
  }
  const outcome = await reviewOutcomeColumns(scope, row);
  const record = reviewSessionRecord({ ...row, ...outcome });
  if (record.status !== "active") return record;
  const counts = await pendingCounts(scope, record.project_id);
  return {
    ...record,
    remaining_pending_claim_count: counts.claims,
    remaining_pending_occurrence_count: counts.occurrences,
  };
}

async function activeSession(
  scope: RequestScope,
  projectId: string,
): Promise<ReviewSessionRecord | null> {
  const row = await getD1()
    .prepare(
      `SELECT rs.*
         FROM review_sessions rs
         JOIN projects p ON p.id = rs.project_id
        WHERE rs.workspace_id = ? AND rs.project_id = ? AND rs.actor_id = ?
          AND rs.status = 'active' AND p.deleted_at IS NULL
        LIMIT 1`,
    )
    .bind(scope.workspaceId, projectId, scope.actorId)
    .first<Row>();
  if (!row) return null;
  return sessionById(scope, String(row.id));
}

export async function getReviewSession(
  scope: RequestScope,
  projectId: string,
): Promise<ReviewSessionRecord | null> {
  await pendingCounts(scope, projectId);
  const row = await getD1()
    .prepare(
      `SELECT rs.*
         FROM review_sessions rs
        WHERE rs.workspace_id = ? AND rs.project_id = ? AND rs.actor_id = ?
        ORDER BY CASE WHEN rs.status = 'active' THEN 0 ELSE 1 END,
                 rs.started_at DESC
        LIMIT 1`,
    )
    .bind(scope.workspaceId, projectId, scope.actorId)
    .first<Row>();
  return row ? sessionById(scope, String(row.id)) : null;
}

async function persistReplayForExistingSession(
  scope: RequestScope,
  projectId: string,
  session: ReviewSessionRecord,
  idempotencyKey: string,
  requestHash: string,
): Promise<void> {
  const endpointScope = `projects/${projectId}/review-sessions`;
  const timestamp = now();
  try {
    await getD1().batch([
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        requestHash,
        { reviewSessionId: session.id },
        timestamp,
      ),
    ]);
  } catch {
    const replay = await findMutationReplay<{ reviewSessionId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      {},
    );
    if (!replay.response) throw new ApiFault(409, "IDEMPOTENCY_CONFLICT", "Review session start could not be replayed.");
  }
}

export async function startReviewSession(
  scope: RequestScope,
  projectId: string,
  idempotencyKey: string,
): Promise<ReviewSessionRecord> {
  const endpointScope = `projects/${projectId}/review-sessions`;
  const replay = await findMutationReplay<{ reviewSessionId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    {},
  );
  if (replay.response) return sessionById(scope, replay.response.reviewSessionId);

  const existing = await activeSession(scope, projectId);
  if (existing) {
    await persistReplayForExistingSession(
      scope,
      projectId,
      existing,
      idempotencyKey,
      replay.requestHash,
    );
    return existing;
  }

  const counts = await pendingCounts(scope, projectId);
  if (counts.claims + counts.occurrences === 0) {
    throw new ApiFault(
      409,
      "REVIEW_SESSION_CONFLICT",
      "There is no pending work to time in this Project.",
    );
  }

  const reviewSessionId = id("rvs");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO review_sessions (
             id, workspace_id, project_id, actor_id, status,
             started_at, initial_pending_claim_count,
             initial_pending_occurrence_count,
             remaining_pending_claim_count,
             remaining_pending_occurrence_count,
             created_at, updated_at
           )
           SELECT ?, p.workspace_id, p.id, ?, 'active', ?,
             (SELECT COUNT(*) FROM claims c
               WHERE c.project_id = p.id AND c.workspace_id = p.workspace_id
                 AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
                 AND EXISTS (SELECT 1 FROM events latest
                   WHERE latest.id = c.event_id AND latest.project_id = p.id
                     AND latest.workspace_id = p.workspace_id
                     AND latest.active_run_id = c.extraction_run_id)),
             (SELECT COUNT(*) FROM claim_occurrence_candidates occ
               WHERE occ.project_id = p.id AND occ.workspace_id = p.workspace_id
                 AND occ.status = 'pending'
                 AND EXISTS (SELECT 1 FROM events latest
                   WHERE latest.id = occ.event_id AND latest.project_id = p.id
                     AND latest.workspace_id = p.workspace_id
                     AND latest.active_run_id = occ.extraction_run_id)),
             (SELECT COUNT(*) FROM claims c
               WHERE c.project_id = p.id AND c.workspace_id = p.workspace_id
                 AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
                 AND EXISTS (SELECT 1 FROM events latest
                   WHERE latest.id = c.event_id AND latest.project_id = p.id
                     AND latest.workspace_id = p.workspace_id
                     AND latest.active_run_id = c.extraction_run_id)),
             (SELECT COUNT(*) FROM claim_occurrence_candidates occ
               WHERE occ.project_id = p.id AND occ.workspace_id = p.workspace_id
                 AND occ.status = 'pending'
                 AND EXISTS (SELECT 1 FROM events latest
                   WHERE latest.id = occ.event_id AND latest.project_id = p.id
                     AND latest.workspace_id = p.workspace_id
                     AND latest.active_run_id = occ.extraction_run_id)),
             ?, ?
           FROM projects p
           WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
             AND (
               (SELECT COUNT(*) FROM claims c
                 WHERE c.project_id = p.id AND c.workspace_id = p.workspace_id
                   AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
                   AND EXISTS (SELECT 1 FROM events latest
                     WHERE latest.id = c.event_id AND latest.project_id = p.id
                       AND latest.workspace_id = p.workspace_id
                       AND latest.active_run_id = c.extraction_run_id))
               +
               (SELECT COUNT(*) FROM claim_occurrence_candidates occ
                 WHERE occ.project_id = p.id AND occ.workspace_id = p.workspace_id
                   AND occ.status = 'pending'
                   AND EXISTS (SELECT 1 FROM events latest
                     WHERE latest.id = occ.event_id AND latest.project_id = p.id
                       AND latest.workspace_id = p.workspace_id
                       AND latest.active_run_id = occ.extraction_run_id))
             ) > 0`,
        )
        .bind(
          reviewSessionId,
          scope.actorId,
          timestamp,
          timestamp,
          timestamp,
          projectId,
          scope.workspaceId,
        ),
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM review_sessions
              WHERE id = ? AND workspace_id = ? AND actor_id = ?
                AND status = 'active'
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, reviewSessionId, scope.workspaceId, scope.actorId, timestamp),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { reviewSessionId },
        timestamp,
      ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ reviewSessionId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      {},
    );
    if (recovered.response) return sessionById(scope, recovered.response.reviewSessionId);
    const concurrent = await activeSession(scope, projectId);
    if (concurrent) {
      await persistReplayForExistingSession(
        scope,
        projectId,
        concurrent,
        idempotencyKey,
        replay.requestHash,
      );
      return concurrent;
    }
    throw error;
  }
  return sessionById(scope, reviewSessionId);
}

export async function completeReviewSession(
  scope: RequestScope,
  sessionId: string,
  idempotencyKey: string,
): Promise<ReviewSessionRecord> {
  const endpointScope = `review-sessions/${sessionId}/complete`;
  const replay = await findMutationReplay<{ reviewSessionId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    {},
  );
  if (replay.response) return sessionById(scope, replay.response.reviewSessionId);

  const session = await sessionById(scope, sessionId);
  if (session.status === "completed") {
    await getD1().batch([
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { reviewSessionId: session.id },
        now(),
      ),
    ]);
    return session;
  }
  if (session.status !== "active") {
    throw new ApiFault(409, "REVIEW_SESSION_CONFLICT", "Review session is not active.");
  }
  const counts = await pendingCounts(scope, session.project_id);
  if (counts.claims + counts.occurrences > 0) {
    throw new ApiFault(
      409,
      "REVIEW_SESSION_CONFLICT",
      "Review session cannot finish while pending work remains.",
      {
        pending_claim_count: counts.claims,
        pending_occurrence_count: counts.occurrences,
      },
    );
  }

  const timestamp = now();
  const durationMs = Math.max(0, Date.parse(timestamp) - Date.parse(session.started_at));
  const guardId = id("guard");
  const db = getD1();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM review_sessions rs
              WHERE rs.id = ? AND rs.workspace_id = ? AND rs.actor_id = ?
                AND rs.status = 'active'
                AND NOT EXISTS (
                  SELECT 1 FROM claims c
                   WHERE c.project_id = rs.project_id
                     AND c.workspace_id = rs.workspace_id
                     AND c.review_status = 'pending'
                     AND c.lifecycle_status = 'active'
                     AND EXISTS (SELECT 1 FROM events latest
                       WHERE latest.id = c.event_id
                         AND latest.project_id = rs.project_id
                         AND latest.workspace_id = rs.workspace_id
                         AND latest.active_run_id = c.extraction_run_id)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM claim_occurrence_candidates occ
                   WHERE occ.project_id = rs.project_id
                     AND occ.workspace_id = rs.workspace_id
                     AND occ.status = 'pending'
                     AND EXISTS (SELECT 1 FROM events latest
                       WHERE latest.id = occ.event_id
                         AND latest.project_id = rs.project_id
                         AND latest.workspace_id = rs.workspace_id
                         AND latest.active_run_id = occ.extraction_run_id)
                )
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, sessionId, scope.workspaceId, scope.actorId, timestamp),
      db
        .prepare(
          `UPDATE review_sessions
              SET status = 'completed', completed_at = ?, duration_ms = ?,
                  remaining_pending_claim_count = 0,
                  remaining_pending_occurrence_count = 0,
                  updated_at = ?
            WHERE id = ? AND workspace_id = ? AND actor_id = ?
              AND status = 'active'`,
        )
        .bind(
          timestamp,
          durationMs,
          timestamp,
          sessionId,
          scope.workspaceId,
          scope.actorId,
        ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { reviewSessionId: sessionId },
        timestamp,
      ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<{ reviewSessionId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      {},
    );
    if (recovered.response) return sessionById(scope, recovered.response.reviewSessionId);
    throw new ApiFault(
      409,
      "REVIEW_SESSION_CONFLICT",
      "Review work changed before the timing session could finish.",
    );
  }
  return sessionById(scope, sessionId);
}
