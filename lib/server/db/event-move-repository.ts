import { getD1 } from "@/db";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import {
  MOVED_TABLES,
  MOVE_BLOCKER_CHECKS,
  eventMoveRewriteSql,
  moveBlockerBinds,
  moveBlockerCountsSql,
  moveBlockerGuardSql,
  moveBlockers,
  type BlockerContext,
  type MoveBlockerCounts,
} from "@/lib/domain/event-move";
import { getEvent } from "@/lib/server/db/core-repository";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import type { EventRecord } from "@/lib/shared/api-types";

/**
 * 把一条记录搬到另一个项目。
 *
 * 第三层出了建议却没人能接受它，建议就只是一句风凉话，所以这条路必须存在。
 * 允许搬的条件写在 lib/domain/event-move.ts 里，这里只负责数行数和真的搬。
 */

type Row = Record<string, unknown>;

export type EventMovePreview = {
  can_move: boolean;
  blockers: string[];
  source_project_id: string;
  target_project_id: string;
};

function now(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function blockerCounts(context: BlockerContext): Promise<MoveBlockerCounts> {
  const row = await getD1()
    .prepare(moveBlockerCountsSql())
    .bind(...moveBlockerBinds(context))
    .first<Row>();
  const counts = {} as MoveBlockerCounts;
  for (const check of MOVE_BLOCKER_CHECKS) {
    counts[check.key] = Number(row?.[check.key] ?? 0);
  }
  return counts;
}

async function eventPlacement(
  scope: RequestScope,
  eventId: string,
  targetProjectId: string,
): Promise<{ sourceProjectId: string }> {
  const event = await getD1()
    .prepare(
      `SELECT e.project_id
         FROM events e
         JOIN projects p ON p.id = e.project_id AND p.deleted_at IS NULL
        WHERE e.id = ? AND e.workspace_id = ?`,
    )
    .bind(eventId, scope.workspaceId)
    .first<Row>();
  if (!event) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");

  const target = await getD1()
    .prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .bind(targetProjectId, scope.workspaceId)
    .first<Row>();
  if (!target) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");

  return { sourceProjectId: String(event.project_id) };
}

/** 搬之前先看一眼能不能搬。界面拿它决定按钮亮不亮，拦不住并发，只是省一次白跑。 */
export async function getEventMovePreview(
  scope: RequestScope,
  eventId: string,
  targetProjectId: string,
): Promise<EventMovePreview> {
  const { sourceProjectId } = await eventPlacement(scope, eventId, targetProjectId);
  const counts = await blockerCounts({
    event: eventId,
    workspace: scope.workspaceId,
    sourceProject: sourceProjectId,
    targetProject: targetProjectId,
  });
  const blockers = moveBlockers(counts, { sourceProjectId, targetProjectId });
  return {
    can_move: blockers.length === 0,
    blockers,
    source_project_id: sourceProjectId,
    target_project_id: targetProjectId,
  };
}

/**
 * 真的搬。
 *
 * 整段在一个 batch 里，要么全成要么全不成：记录换了项目而它的片段、产物、结论
 * 还留在原项目，比拒绝搬动难收拾得多。
 *
 * 守卫那条语句把同一套判定条件再跑一遍。预览只是给界面看的，从预览到写入之间
 * 有一段人思考的时间，足够另一个标签页确认掉一条结论；条件不成立时守卫写进一个
 * 违反 CHECK 的值，整个 batch 连同已经改掉的行一起回滚。
 */
export async function moveEvent(
  scope: RequestScope,
  eventId: string,
  targetProjectId: string,
  idempotencyKey: string,
): Promise<EventRecord> {
  const endpointScope = `events/${eventId}/move`;
  const replay = await findMutationReplay<{ eventId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    { targetProjectId },
  );
  if (replay.response) {
    return getEvent(scope, replay.response.eventId).then((value) => value.event);
  }

  const preview = await getEventMovePreview(scope, eventId, targetProjectId);
  if (!preview.can_move) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", preview.blockers.join(" "), {
      blockers: preview.blockers,
    });
  }

  const context: BlockerContext = {
    event: eventId,
    workspace: scope.workspaceId,
    sourceProject: preview.source_project_id,
    targetProject: targetProjectId,
  };
  const timestamp = now();
  const guardId = id("guard");
  const db = getD1();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM events e
              WHERE e.id = ? AND e.workspace_id = ? AND e.project_id = ?
                AND EXISTS (
                  SELECT 1 FROM projects p
                   WHERE p.id = ? AND p.workspace_id = e.workspace_id AND p.deleted_at IS NULL
                )
           ) AND ${moveBlockerGuardSql()}
           THEN 1 ELSE 0 END, ?`,
        )
        .bind(
          guardId,
          eventId,
          scope.workspaceId,
          preview.source_project_id,
          targetProjectId,
          ...moveBlockerBinds(context),
          timestamp,
        ),
      // 目标项目先把序号推进一格，下一条语句才读得到空出来的号。原项目的号不回收：
      // 序号只用来排序和认第一条，中间断一个号没有任何东西会去数。
      db
        .prepare(
          `UPDATE projects
              SET next_event_sequence = next_event_sequence + 1,
                  ledger_version = ledger_version + 1,
                  context_version = context_version + 1,
                  updated_at = ?
            WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        )
        .bind(timestamp, targetProjectId, scope.workspaceId),
      db
        .prepare(
          `UPDATE events
              SET project_id = ?,
                  sequence_no = (
                    SELECT next_event_sequence - 1 FROM projects
                     WHERE id = ? AND workspace_id = ?
                  ),
                  updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .bind(targetProjectId, targetProjectId, scope.workspaceId, timestamp, eventId, scope.workspaceId),
      ...MOVED_TABLES.map((table) =>
        db.prepare(eventMoveRewriteSql(table)).bind(targetProjectId, eventId, scope.workspaceId),
      ),
      // 建议是冲着原来的归属提的，搬完它就没有内容了。留着只会在界面上再问一次。
      db
        .prepare(`DELETE FROM event_routing_suggestions WHERE event_id = ? AND workspace_id = ?`)
        .bind(eventId, scope.workspaceId),
      // 原项目少了一条记录，它缓存的视图和缺口检查都按账本版本作废。
      db
        .prepare(
          `UPDATE projects
              SET ledger_version = ledger_version + 1,
                  context_version = context_version + 1,
                  updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .bind(timestamp, preview.source_project_id, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { eventId },
        timestamp,
      ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ eventId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      { targetProjectId },
    );
    if (recovered.response) {
      return getEvent(scope, recovered.response.eventId).then((value) => value.event);
    }
    // 守卫拦下来的情况：这段时间里有人确认了东西，或者目标项目被删了。
    // 重新数一遍是为了把当下真实的原因告诉人，而不是只说一句失败了。
    const current = await getEventMovePreview(scope, eventId, targetProjectId).catch(() => null);
    if (current && !current.can_move) {
      throw new ApiFault(409, "RUN_STATE_CONFLICT", current.blockers.join(" "), {
        blockers: current.blockers,
      });
    }
    throw error;
  }
  return getEvent(scope, eventId).then((value) => value.event);
}
