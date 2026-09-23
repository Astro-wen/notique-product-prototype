import { getD1 } from "@/db";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import type { RoutingSource } from "@/lib/domain/material-routing";

/**
 * 归属建议的读写（第三层）。
 *
 * 只写，不搬。这里始终只有一条摆着的数据和一个划掉的动作；接受建议之后真正的
 * 搬动在 lib/server/db/event-move-repository.ts，它搬完会把这条建议删掉。
 * 两件事分开，是因为建议可以错，而搬动必须对。
 */

type Row = Record<string, unknown>;

export type RoutingSuggestionRecord = {
  event_id: string;
  suggested_project_id: string;
  suggested_project_name: string | null;
  probability: number;
  judge: string;
  created_at: string;
  dismissed_at: string | null;
};

function now(): string {
  return new Date().toISOString();
}

function record(row: Row): RoutingSuggestionRecord {
  return {
    event_id: String(row.event_id),
    suggested_project_id: String(row.suggested_project_id),
    suggested_project_name: row.suggested_project_name == null ? null : String(row.suggested_project_name),
    probability: Number(row.probability),
    judge: String(row.judge),
    created_at: String(row.created_at),
    dismissed_at: row.dismissed_at == null ? null : String(row.dismissed_at),
  };
}

/**
 * 写入一条建议，同一条记录只留最新的一条。
 *
 * 建议的项目和记录当前所在的项目相同就什么都不写：那不是建议，是复述现状。
 * 返回是否真的写了，调用方（后台任务）据此决定要不要记日志，但不据此判成败。
 */
export async function writeRoutingSuggestion(input: {
  eventId: string;
  workspaceId: string;
  suggestedProjectId: string;
  probability: number;
  judge: string;
}): Promise<boolean> {
  if (!(input.probability >= 0 && input.probability <= 1)) return false;
  const changes = await getD1()
    .prepare(
      `INSERT INTO event_routing_suggestions (
         event_id, workspace_id, suggested_project_id, probability, judge, created_at
       )
       SELECT e.id, e.workspace_id, p.id, ?, ?, ?
         FROM events e
         JOIN projects p ON p.id = ? AND p.workspace_id = e.workspace_id AND p.deleted_at IS NULL
        WHERE e.id = ? AND e.workspace_id = ?
          -- 建议回它自己所在的项目没有任何信息量。
          AND e.project_id <> p.id
       ON CONFLICT(event_id) DO UPDATE SET
         suggested_project_id = excluded.suggested_project_id,
         probability = excluded.probability,
         judge = excluded.judge,
         created_at = excluded.created_at,
         -- 换了个建议的项目才重新出声；同一个项目被划掉过就不再纠缠。
         dismissed_at = CASE
           WHEN event_routing_suggestions.suggested_project_id = excluded.suggested_project_id
             THEN event_routing_suggestions.dismissed_at
           ELSE NULL
         END`,
    )
    .bind(
      input.probability,
      input.judge,
      now(),
      input.suggestedProjectId,
      input.eventId,
      input.workspaceId,
    )
    .run();
  return Number(changes.meta.changes ?? 0) > 0;
}

/** 读这条记录在手的建议。没有建议是常态，返回 null 不是错误。 */
export async function readRoutingSuggestion(
  scope: RequestScope,
  eventId: string,
): Promise<RoutingSuggestionRecord | null> {
  const event = await getD1()
    .prepare(`SELECT id FROM events WHERE id = ? AND workspace_id = ?`)
    .bind(eventId, scope.workspaceId)
    .first<Row>();
  if (!event) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");

  const row = await getD1()
    .prepare(
      `SELECT s.*, p.name AS suggested_project_name
         FROM event_routing_suggestions s
         JOIN projects p ON p.id = s.suggested_project_id AND p.deleted_at IS NULL
        WHERE s.event_id = ? AND s.workspace_id = ?`,
    )
    .bind(eventId, scope.workspaceId)
    .first<Row>();
  return row ? record(row) : null;
}

/** 划掉一条建议。划掉之后不再展示，重算也不会再弹同一个项目。 */
export async function dismissRoutingSuggestion(
  scope: RequestScope,
  eventId: string,
): Promise<void> {
  await getD1()
    .prepare(
      `UPDATE event_routing_suggestions SET dismissed_at = ?
        WHERE event_id = ? AND workspace_id = ? AND dismissed_at IS NULL`,
    )
    .bind(now(), eventId, scope.workspaceId)
    .run();
}

/**
 * 这条记录的项目是谁定的。建议层在开跑前读它，读到 "user" 就不跑。
 * 后台任务调用，所以按 workspace 而不是按请求作用域取。
 */
export async function readEventRoutingSource(eventId: string): Promise<RoutingSource | null> {
  const row = await getD1()
    .prepare(`SELECT routing_source FROM events WHERE id = ?`)
    .bind(eventId)
    .first<Row>();
  const value = row?.routing_source;
  return value === "user" || value === "skipped" ? value : null;
}

/** 选择器落库时写一次。只写一次，之后重传材料不改写用户当初的表态。 */
export async function setEventRoutingSource(
  scope: RequestScope,
  eventId: string,
  source: RoutingSource,
): Promise<void> {
  await getD1()
    .prepare(
      `UPDATE events SET routing_source = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND routing_source IS NULL`,
    )
    .bind(source, now(), eventId, scope.workspaceId)
    .run();
}
