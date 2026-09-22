import { getD1 } from "@/db";
import {
  recordPurgeBinds,
  recordPurgeStatements,
  recordStorageKeysSql,
} from "@/lib/domain/event-trash";

/**
 * 永久删除记录的数据库一侧。单独成文件，是因为项目永久删除也要用它清掉项目
 * 名下还在回收站里的记录，而 core-repository 不能反过来依赖记录回收站那一层。
 */

type Row = Record<string, unknown>;

/** 永久删除要做的事：存储里的文件键和一串删除语句。 */
export async function recordPurgePlan(
  eventIds: readonly string[],
  workspaceId: string,
): Promise<{ keys: string[]; statements: D1PreparedStatement[] }> {
  const db = getD1();
  const keys: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const eventId of eventIds) {
    const keyBinds = Array.from({ length: 4 }, () => [eventId, workspaceId]).flat();
    const rows = (await db.prepare(recordStorageKeysSql()).bind(...keyBinds).all<Row>()).results ?? [];
    keys.push(...rows.map((row) => String(row.key)));
    recordPurgeStatements().forEach((statement, index) => {
      statements.push(db.prepare(statement.sql).bind(...recordPurgeBinds(index, eventId, workspaceId)));
    });
  }
  return { keys, statements };
}

/** 某个项目名下还在回收站里的记录。项目永久删除时一起清。 */
export async function trashedEventIdsForProject(projectId: string, workspaceId: string): Promise<string[]> {
  const rows = (await getD1()
    .prepare(`SELECT event_id FROM trashed_events WHERE original_project_id = ? AND workspace_id = ?`)
    .bind(projectId, workspaceId)
    .all<Row>()).results ?? [];
  return rows.map((row) => String(row.event_id));
}
