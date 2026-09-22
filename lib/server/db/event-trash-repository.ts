import { getD1, getEvidenceBucket } from "@/db";
import { eventMoveRewriteSql } from "@/lib/domain/event-move";
import {
  CLAIM_LINKED_TABLES,
  RECORD_OWNED_TABLES,
  RECORD_TRASH_ROLE,
  TRASH_BLOCKER_CHECKS,
  allTrashBlockerBinds,
  claimLinkedRewrite,
  recordTrashProjectId,
  trashBlockerCountsSql,
  trashBlockerGuardSql,
  trashBlockers,
  type TrashBlockerCounts,
} from "@/lib/domain/event-trash";
import { getEvent } from "@/lib/server/db/core-repository";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import { recordPurgePlan } from "@/lib/server/db/record-purge-repository";
import {
  activeProviderRequestIds,
  cancelRemoteResponses,
  runCancellationBatch,
} from "@/lib/server/db/run-cancellation-repository";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import type {
  EventRecord,
  EventTrashPreviewRecord,
  TrashedEventRecord,
} from "@/lib/shared/api-types";

/**
 * 单条记录的回收站。规则、语句和为什么这样做都在 lib/domain/event-trash.ts。
 */

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function all(sql: string, bindings: unknown[]): Promise<Row[]> {
  return (await getD1().prepare(sql).bind(...bindings).all<Row>()).results ?? [];
}

/** 和项目删除预览同一个口径：不算易读稿、切块等系统生成的材料。 */
const MATERIAL_FILTER = `COALESCE(json_extract(a.metadata_json, '$.artifact_kind'), '') <> 'readable_transcript'
  AND COALESCE(json_extract(a.metadata_json, '$.analysis_source'), 1) <> 0
  AND COALESCE(json_extract(a.metadata_json, '$.transcription_chunk'), 0) <> 1`;

async function liveEvent(scope: RequestScope, eventId: string): Promise<Row> {
  const row = await first(
    `SELECT e.id, e.project_id, e.sequence_no, e.title, p.scenario_status
       FROM events e
       JOIN projects p ON p.id = e.project_id AND p.workspace_id = e.workspace_id
      WHERE e.id = ? AND e.workspace_id = ? AND p.deleted_at IS NULL`,
    [eventId, scope.workspaceId],
  );
  if (!row) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  return row;
}

async function blockerCounts(eventId: string, workspaceId: string): Promise<TrashBlockerCounts> {
  const row = await first(trashBlockerCountsSql(), allTrashBlockerBinds(eventId, workspaceId));
  const counts = {} as TrashBlockerCounts;
  for (const check of TRASH_BLOCKER_CHECKS) counts[check.key] = Number(row?.[check.key] ?? 0);
  return counts;
}

export async function getEventTrashPreview(
  scope: RequestScope,
  eventId: string,
): Promise<EventTrashPreviewRecord> {
  const event = await liveEvent(scope, eventId);
  const [blockers, counts] = await Promise.all([
    blockerCounts(eventId, scope.workspaceId).then(trashBlockers),
    first(
      `SELECT
         (SELECT COUNT(*) FROM assets a WHERE a.event_id = ? AND a.workspace_id = ? AND ${MATERIAL_FILTER}) AS material_count,
         (SELECT COUNT(*) FROM claims c WHERE c.event_id = ? AND c.workspace_id = ?
            AND c.review_status = 'verified') AS confirmed_count,
         (SELECT COUNT(*) FROM transcription_runs WHERE event_id = ? AND workspace_id = ? AND status IN ('queued','processing')) +
         (SELECT COUNT(*) FROM extraction_runs WHERE event_id = ? AND workspace_id = ? AND status IN ('queued','processing')) +
         (SELECT COUNT(*) FROM event_ai_artifact_runs WHERE event_id = ? AND workspace_id = ? AND status IN ('queued','processing'))
           AS active_job_count`,
      [
        eventId, scope.workspaceId,
        eventId, scope.workspaceId,
        eventId, scope.workspaceId,
        eventId, scope.workspaceId,
        eventId, scope.workspaceId,
      ],
    ),
  ]);
  return {
    event_id: eventId,
    event_title: String(event.title),
    project_id: String(event.project_id),
    material_count: Number(counts?.material_count ?? 0),
    confirmed_count: Number(counts?.confirmed_count ?? 0),
    active_job_count: Number(counts?.active_job_count ?? 0),
    can_trash: blockers.length === 0,
    blockers,
  };
}

/**
 * 把一条记录移进回收站。
 *
 * 一批提交，要么全成要么全不成。守卫把判定条件再跑一遍：从预览到点确认之间，
 * 别的标签页可能刚给这条记录添了一条跨记录的关系。
 */
export async function moveEventToTrash(
  scope: RequestScope,
  eventId: string,
  idempotencyKey: string,
): Promise<{ event_id: string; project_id: string }> {
  const endpointScope = `events/${eventId}/trash`;
  const replay = await findMutationReplay<{ event_id: string; project_id: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    {},
  );
  if (replay.response) return replay.response;

  const event = await liveEvent(scope, eventId);
  const sourceProjectId = String(event.project_id);
  const sequenceNo = Number(event.sequence_no);
  const scenarioStatus = String(event.scenario_status);
  const blockers = trashBlockers(await blockerCounts(eventId, scope.workspaceId));
  if (blockers.length) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", blockers.join(" "), { blockers });
  }

  const binId = recordTrashProjectId(scope.workspaceId);
  const timestamp = now();
  const guardId = id("guard");
  const providerRequests = await activeProviderRequestIds("event", eventId, scope.workspaceId);
  const db = getD1();
  // 场景没确认之前，只有序号为 1 的记录能替项目定场景。把它移走，剩下的记录就
  // 再也没人能定场景了。所以让剩下最早的那条顶上来当第 1 条，场景退回未判定：
  // 原来的候选是从被删掉的材料里判出来的，不该留着。
  const anchorLeaves = sequenceNo === 1 && scenarioStatus !== "confirmed";
  const hasClaims = `EXISTS (SELECT 1 FROM claims WHERE event_id = ? AND workspace_id = ?)`;

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT OR IGNORE INTO projects (
         id, workspace_id, name, scenario_status, locale, deleted_at, system_role,
         name_source, created_at, updated_at
       ) VALUES (?, ?, 'Record trash', 'confirmed', 'en-US', ?, ?, 'manual', ?, ?)`,
    ).bind(binId, scope.workspaceId, timestamp, RECORD_TRASH_ROLE, timestamp, timestamp),
    db.prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM events e
           JOIN projects p ON p.id = e.project_id AND p.workspace_id = e.workspace_id
          WHERE e.id = ? AND e.workspace_id = ? AND e.project_id = ?
            AND p.deleted_at IS NULL AND p.scenario_status = ?
       ) AND ${trashBlockerGuardSql()}
       THEN 1 ELSE 0 END, ?`,
    ).bind(
      guardId,
      eventId,
      scope.workspaceId,
      sourceProjectId,
      scenarioStatus,
      ...allTrashBlockerBinds(eventId, scope.workspaceId),
      timestamp,
    ),
    ...runCancellationBatch("event", {
      timestamp,
      scopeId: eventId,
      workspace: scope.workspaceId,
      reason: "event_trashed",
    }),
    db.prepare(
      `INSERT INTO trashed_events (
         event_id, workspace_id, original_project_id, original_sequence_no, trashed_at,
         scenario_snapshot_json, promoted_event_id, promoted_from_sequence_no
       ) VALUES (?, ?, ?, ?, ?, (
         SELECT CASE WHEN ? = 1 AND scenario_status = 'pending_confirmation'
           THEN json_object(
             'candidates', json(scenario_candidates_json),
             'assessment_run_id', scenario_assessment_run_id
           )
           ELSE NULL END
           FROM projects WHERE id = ? AND workspace_id = ?
       ), (
         SELECT id FROM events
          WHERE ? = 1 AND project_id = ? AND workspace_id = ? AND id <> ?
          ORDER BY sequence_no LIMIT 1
       ), (
         SELECT sequence_no FROM events
          WHERE ? = 1 AND project_id = ? AND workspace_id = ? AND id <> ?
          ORDER BY sequence_no LIMIT 1
       ))`,
    ).bind(
      eventId,
      scope.workspaceId,
      sourceProjectId,
      sequenceNo,
      timestamp,
      anchorLeaves ? 1 : 0,
      sourceProjectId,
      scope.workspaceId,
      anchorLeaves ? 1 : 0, sourceProjectId, scope.workspaceId, eventId,
      anchorLeaves ? 1 : 0, sourceProjectId, scope.workspaceId, eventId,
    ),
    // 收容项目里序号也要唯一，先推进一格再让记录占住空出来的号。
    db.prepare(
      `UPDATE projects SET next_event_sequence = next_event_sequence + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    ).bind(timestamp, binId, scope.workspaceId),
    db.prepare(
      `UPDATE events
          SET project_id = ?,
              sequence_no = (SELECT next_event_sequence - 1 FROM projects WHERE id = ? AND workspace_id = ?),
              updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    ).bind(binId, binId, scope.workspaceId, timestamp, eventId, scope.workspaceId),
    ...RECORD_OWNED_TABLES.map((table) =>
      db.prepare(eventMoveRewriteSql(table)).bind(binId, eventId, scope.workspaceId)),
    ...CLAIM_LINKED_TABLES.map((table) => {
      const rewrite = claimLinkedRewrite(table);
      const pairs = Array.from({ length: rewrite.pairs }, () => [eventId, scope.workspaceId]).flat();
      return db.prepare(rewrite.sql).bind(binId, ...pairs);
    }),
    db.prepare(`DELETE FROM event_routing_suggestions WHERE event_id = ? AND workspace_id = ?`)
      .bind(eventId, scope.workspaceId),
  ];

  if (anchorLeaves) {
    statements.push(
      db.prepare(
        `UPDATE events SET sequence_no = 1, updated_at = ?
          WHERE id = (
            SELECT id FROM events WHERE project_id = ? AND workspace_id = ?
             ORDER BY sequence_no LIMIT 1
          )`,
      ).bind(timestamp, sourceProjectId, scope.workspaceId),
      db.prepare(
        `UPDATE projects
            SET scenario_status = 'unassessed', scenario_assessment_run_id = NULL,
                scenario_candidates_json = '[]', scenario_lease_expires_at = NULL,
                next_event_sequence = CASE
                  WHEN EXISTS (SELECT 1 FROM events WHERE project_id = ? AND workspace_id = ?)
                  THEN next_event_sequence ELSE 1 END,
                updated_at = ?
          WHERE id = ? AND workspace_id = ? AND scenario_status <> 'confirmed'`,
      ).bind(sourceProjectId, scope.workspaceId, timestamp, sourceProjectId, scope.workspaceId),
    );
  }

  statements.push(
    // 原项目的账本少了这条记录的结论，缓存的视图按版本作废。没有结论的记录不动
    // 版本：动了会让同项目里正在分析的别的记录因为上下文变了而白跑一趟。
    db.prepare(
      `UPDATE projects
          SET ledger_version = ledger_version + CASE WHEN ${hasClaims} THEN 1 ELSE 0 END,
              context_version = context_version + CASE WHEN ${hasClaims} THEN 1 ELSE 0 END,
              updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    ).bind(eventId, scope.workspaceId, eventId, scope.workspaceId, timestamp, sourceProjectId, scope.workspaceId),
    mutationReplayStatement(
      scope,
      endpointScope,
      idempotencyKey,
      replay.requestHash,
      { event_id: eventId, project_id: sourceProjectId },
      timestamp,
    ),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    const recovered = await findMutationReplay<{ event_id: string; project_id: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      {},
    );
    if (recovered.response) return recovered.response;
    const current = await getEventTrashPreview(scope, eventId).catch(() => null);
    if (current && !current.can_trash) {
      throw new ApiFault(409, "RUN_STATE_CONFLICT", current.blockers.join(" "), { blockers: current.blockers });
    }
    throw error;
  }
  await cancelRemoteResponses(providerRequests);
  return { event_id: eventId, project_id: sourceProjectId };
}

export async function listTrashedEvents(scope: RequestScope): Promise<TrashedEventRecord[]> {
  const rows = await all(
    `SELECT t.event_id, t.original_project_id, t.trashed_at,
            e.title, e.occurred_at, e.created_at,
            p.name AS project_name, p.deleted_at AS project_deleted_at,
            (SELECT COUNT(*) FROM assets a WHERE a.event_id = e.id AND a.workspace_id = e.workspace_id
               AND ${MATERIAL_FILTER}) AS material_count
       FROM trashed_events t
       JOIN events e ON e.id = t.event_id AND e.workspace_id = t.workspace_id
       LEFT JOIN projects p ON p.id = t.original_project_id AND p.workspace_id = t.workspace_id
      WHERE t.workspace_id = ?
      ORDER BY t.trashed_at DESC`,
    [scope.workspaceId],
  );
  return rows.map((row) => ({
    event_id: String(row.event_id),
    event_title: String(row.title),
    occurred_at: row.occurred_at == null ? null : String(row.occurred_at),
    created_at: String(row.created_at),
    trashed_at: String(row.trashed_at),
    project_id: String(row.original_project_id),
    project_name: row.project_name == null ? null : String(row.project_name),
    project_in_trash: row.project_deleted_at != null,
    material_count: Number(row.material_count ?? 0),
  }));
}

async function trashedEvent(scope: RequestScope, eventId: string): Promise<Row> {
  const row = await first(
    `SELECT t.*, p.deleted_at AS project_deleted_at, p.id AS live_project_id
       FROM trashed_events t
       LEFT JOIN projects p ON p.id = t.original_project_id AND p.workspace_id = t.workspace_id
      WHERE t.event_id = ? AND t.workspace_id = ?`,
    [eventId, scope.workspaceId],
  );
  if (!row) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Deleted record was not found.");
  return row;
}

/** 从回收站恢复一条记录，搬回原项目。原来的序号没被占就用原来的，占了就排到最后。 */
export async function restoreEvent(
  scope: RequestScope,
  eventId: string,
  idempotencyKey: string,
): Promise<EventRecord> {
  const endpointScope = `events/${eventId}/restore`;
  const replay = await findMutationReplay<{ eventId: string }>(scope, endpointScope, idempotencyKey, {});
  if (replay.response) return getEvent(scope, replay.response.eventId).then((value) => value.event);

  const trashed = await trashedEvent(scope, eventId);
  if (trashed.live_project_id == null) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "原项目已经永久删除，这条记录没有地方可回。");
  }
  if (trashed.project_deleted_at != null) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "原项目也在回收站里，先恢复项目再恢复这条记录。");
  }
  const targetId = String(trashed.original_project_id);
  const originalSequence = Number(trashed.original_sequence_no);
  const binId = recordTrashProjectId(scope.workspaceId);
  const timestamp = now();
  const guardId = id("guard");
  const db = getD1();
  const sequenceTaken = `EXISTS (SELECT 1 FROM events WHERE project_id = ? AND workspace_id = ? AND sequence_no = ?)`;
  const hasClaims = `EXISTS (SELECT 1 FROM claims WHERE event_id = ? AND workspace_id = ?)`;

  await db.batch([
    db.prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM trashed_events t
           JOIN events e ON e.id = t.event_id AND e.project_id = ?
           JOIN projects p ON p.id = t.original_project_id
          WHERE t.event_id = ? AND t.workspace_id = ?
            AND p.deleted_at IS NULL AND p.system_role IS NULL
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, binId, eventId, scope.workspaceId, timestamp),
    // 删它的时候有别的记录顶上来当了第一条。那条还在第一条的位置、它原来的号也
    // 还空着，就换回去，让恢复的这条回到原位。中间有人动过就不换，按下面的规则排。
    db.prepare(
      `UPDATE events
          SET sequence_no = (
                SELECT promoted_from_sequence_no FROM trashed_events WHERE event_id = ? AND workspace_id = ?
              ),
              updated_at = ?
        WHERE id = (SELECT promoted_event_id FROM trashed_events WHERE event_id = ? AND workspace_id = ?)
          AND project_id = ? AND workspace_id = ? AND sequence_no = 1
          AND NOT EXISTS (
            SELECT 1 FROM events other
             WHERE other.project_id = ? AND other.workspace_id = ?
               AND other.sequence_no = (
                 SELECT promoted_from_sequence_no FROM trashed_events WHERE event_id = ? AND workspace_id = ?
               )
          )`,
    ).bind(
      eventId, scope.workspaceId,
      timestamp,
      eventId, scope.workspaceId,
      targetId, scope.workspaceId,
      targetId, scope.workspaceId,
      eventId, scope.workspaceId,
    ),
    db.prepare(
      `UPDATE projects SET next_event_sequence = next_event_sequence + 1
        WHERE id = ? AND workspace_id = ? AND ${sequenceTaken}`,
    ).bind(targetId, scope.workspaceId, targetId, scope.workspaceId, originalSequence),
    db.prepare(
      `UPDATE events
          SET project_id = ?,
              sequence_no = CASE WHEN ${sequenceTaken}
                THEN (SELECT next_event_sequence - 1 FROM projects WHERE id = ? AND workspace_id = ?)
                ELSE ? END,
              updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    ).bind(
      targetId,
      targetId, scope.workspaceId, originalSequence,
      targetId, scope.workspaceId,
      originalSequence,
      timestamp,
      eventId, scope.workspaceId,
    ),
    ...RECORD_OWNED_TABLES.map((table) =>
      db.prepare(eventMoveRewriteSql(table)).bind(targetId, eventId, scope.workspaceId)),
    ...CLAIM_LINKED_TABLES.map((table) => {
      const rewrite = claimLinkedRewrite(table);
      const pairs = Array.from({ length: rewrite.pairs }, () => [eventId, scope.workspaceId]).flat();
      return db.prepare(rewrite.sql).bind(targetId, ...pairs);
    }),
    // 下一条新记录的序号要排在恢复回来的这条后面，不然会撞号。
    db.prepare(
      `UPDATE projects
          SET next_event_sequence = MAX(
                next_event_sequence,
                (SELECT sequence_no FROM events WHERE id = ? AND workspace_id = ?) + 1
              ),
              ledger_version = ledger_version + CASE WHEN ${hasClaims} THEN 1 ELSE 0 END,
              context_version = context_version + CASE WHEN ${hasClaims} THEN 1 ELSE 0 END,
              updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    ).bind(
      eventId, scope.workspaceId,
      eventId, scope.workspaceId,
      eventId, scope.workspaceId,
      timestamp,
      targetId, scope.workspaceId,
    ),
    // 误删第一条又恢复：它回到第 1 条，而项目的场景还停在删除时清空的状态，
    // 就把删除时存下的候选放回去。别的情况都不碰场景。
    db.prepare(
      `UPDATE projects
          SET scenario_status = 'pending_confirmation',
              scenario_candidates_json = (
                SELECT json_extract(scenario_snapshot_json, '$.candidates')
                  FROM trashed_events WHERE event_id = ? AND workspace_id = ?
              ),
              scenario_assessment_run_id = (
                SELECT json_extract(scenario_snapshot_json, '$.assessment_run_id')
                  FROM trashed_events WHERE event_id = ? AND workspace_id = ?
              ),
              updated_at = ?
        WHERE id = ? AND workspace_id = ? AND scenario_status = 'unassessed'
          AND (SELECT sequence_no FROM events WHERE id = ? AND workspace_id = ?) = 1
          AND EXISTS (
            SELECT 1 FROM trashed_events
             WHERE event_id = ? AND workspace_id = ? AND scenario_snapshot_json IS NOT NULL
          )`,
    ).bind(
      eventId, scope.workspaceId,
      eventId, scope.workspaceId,
      timestamp,
      targetId, scope.workspaceId,
      eventId, scope.workspaceId,
      eventId, scope.workspaceId,
    ),
    db.prepare(`DELETE FROM trashed_events WHERE event_id = ? AND workspace_id = ?`).bind(eventId, scope.workspaceId),
    mutationReplayStatement(scope, endpointScope, idempotencyKey, replay.requestHash, { eventId }, timestamp),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
  return getEvent(scope, eventId).then((value) => value.event);
}

/** 从回收站里永久删掉一条记录，连同存储里的文件。 */
export async function permanentlyDeleteEvent(
  scope: RequestScope,
  eventId: string,
  idempotencyKey: string,
): Promise<{ eventId: string; permanentlyDeleted: true }> {
  const endpointScope = `events/${eventId}/permanent`;
  const replay = await findMutationReplay<{ eventId: string; permanentlyDeleted: true }>(
    scope,
    endpointScope,
    idempotencyKey,
    {},
  );
  if (replay.response) return replay.response;
  await trashedEvent(scope, eventId);

  const plan = await recordPurgePlan([eventId], scope.workspaceId);
  try {
    await Promise.all(plan.keys.map((key) => getEvidenceBucket().delete(key)));
  } catch {
    throw new ApiFault(503, "R2_BINDING_UNAVAILABLE", "Stored files could not be fully deleted. The record stays in the recycle bin so deletion can be retried safely.");
  }
  const response = { eventId, permanentlyDeleted: true as const };
  const timestamp = now();
  const guardId = id("guard");
  const db = getD1();
  await db.batch([
    db.prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM trashed_events WHERE event_id = ? AND workspace_id = ?
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, eventId, scope.workspaceId, timestamp),
    ...plan.statements,
    mutationReplayStatement(scope, endpointScope, idempotencyKey, replay.requestHash, response, timestamp),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
  return response;
}
