/**
 * 把一条记录移进回收站、恢复、永久删除要用的判定和语句。
 *
 * 做法：每个工作区有一个隐藏的收容项目，它本身就在回收站里（deleted_at 非空，
 * system_role = 'record_trash'）。移走一条记录就是把它和挂在它上面的行整体
 * 搬进这个项目。全站读取都已经排除回收站里的项目，记录就此从所有地方消失，
 * 不必在九十多处读记录和结论的查询里各补一个过滤。恢复就是搬回去。
 *
 * 和跨项目搬动（event-move.ts）的区别：搬去别的项目要保证两边账本都说得通，
 * 所以连人工判断过的记录都不让搬。移进回收站只需要保证原项目剩下的东西不断
 * 引用，人工判断跟着记录一起走、一起回来就行。所以这里只拦「和别的记录连着」
 * 的那几类，其余一律放行。正在跑的任务不拦，删的时候一起停下，见
 * run-cancellation.ts。
 *
 * 这个文件不碰数据库，只生成语句和理由，迁移级测试拿真实表结构跑同一批语句。
 */

import { MOVED_TABLES, type MovedTable } from "./event-move.ts";

export const RECORD_TRASH_ROLE = "record_trash";

/** 收容项目的 id 由工作区决定，并发的两次删除只会建出同一个。 */
export function recordTrashProjectId(workspaceId: string): string {
  return `prj_record_trash_${workspaceId}`;
}

/** 这条记录上的结论，按记录圈，不按项目圈：移动途中项目归属会变。 */
const RECORD_CLAIMS = `SELECT id FROM claims WHERE event_id = ? AND workspace_id = ?`;
const RECORD_CLAIM_VERSIONS = `SELECT cv.id FROM claim_versions cv
                                 JOIN claims c ON c.id = cv.claim_id
                                WHERE c.event_id = ? AND c.workspace_id = ?`;

export type TrashBlockerKey = "crossRelations" | "crossOccurrences" | "crossLinks";

export type TrashBlockerCheck = { key: TrashBlockerKey; sql: string; binds: number };

/**
 * 挡路的只有这三类，都是一头在这条记录、另一头在别的记录。
 * binds 是这条语句要几组 (event_id, workspace_id)。
 */
export const TRASH_BLOCKER_CHECKS: readonly TrashBlockerCheck[] = [
  {
    key: "crossRelations",
    // 结论关系的一头在这条记录，另一头不在。两头都在这条记录的关系跟着一起搬。
    sql: `SELECT 1 FROM claim_relations r
           WHERE (r.source_claim_version_id IN (${RECORD_CLAIM_VERSIONS}))
              <> (r.target_claim_version_id IN (${RECORD_CLAIM_VERSIONS}))`,
    binds: 2,
  },
  {
    key: "crossOccurrences",
    // 重复出现天生跨两条记录：结论在一条，重复在另一条。两个方向都算。
    sql: `SELECT 1 FROM claim_occurrences occ
           WHERE (occ.event_id = ? AND occ.claim_id NOT IN (${RECORD_CLAIMS}))
              OR (occ.claim_id IN (${RECORD_CLAIMS}) AND occ.event_id <> ?)
          UNION ALL
          SELECT 1 FROM claim_occurrence_candidates cand
           WHERE (cand.event_id = ? AND cand.target_claim_id NOT IN (${RECORD_CLAIMS}))
              OR (cand.target_claim_id IN (${RECORD_CLAIMS}) AND cand.event_id <> ?)`,
    binds: 0,
  },
  {
    key: "crossLinks",
    // 草稿关联一头在这条记录；以及这条记录里的结论首次出现在别的记录。
    sql: `SELECT 1 FROM draft_link_candidates dl
           WHERE (dl.source_claim_id IN (${RECORD_CLAIMS}))
              <> (dl.target_draft_claim_id IN (${RECORD_CLAIMS}))
          UNION ALL
          SELECT 1 FROM claims c
           WHERE c.event_id = ? AND c.workspace_id = ?
             AND c.first_event_id IS NOT NULL AND c.first_event_id <> c.event_id`,
    binds: 3,
  },
];

/** 每条判定语句的绑定值。crossOccurrences 的占位符顺序不规则，单独排。 */
export function trashBlockerBinds(check: TrashBlockerCheck, eventId: string, workspaceId: string): string[] {
  if (check.key === "crossOccurrences") {
    return [
      eventId, eventId, workspaceId,
      eventId, workspaceId, eventId,
      eventId, eventId, workspaceId,
      eventId, workspaceId, eventId,
    ];
  }
  return Array.from({ length: check.binds }, () => [eventId, workspaceId]).flat();
}

export function trashBlockerCountsSql(): string {
  return `SELECT ${TRASH_BLOCKER_CHECKS
    .map((check) => `(SELECT COUNT(*) FROM (${check.sql})) AS ${check.key}`)
    .join(", ")}`;
}

export function trashBlockerGuardSql(): string {
  return TRASH_BLOCKER_CHECKS.map((check) => `NOT EXISTS (${check.sql})`).join(" AND ");
}

export function allTrashBlockerBinds(eventId: string, workspaceId: string): string[] {
  return TRASH_BLOCKER_CHECKS.flatMap((check) => trashBlockerBinds(check, eventId, workspaceId));
}

export type TrashBlockerCounts = Record<TrashBlockerKey, number>;

const REASONS: ReadonlyArray<[TrashBlockerKey, (count: number) => string]> = [
  ["crossRelations", (n) => `这条记录的结论和别的记录有 ${n} 条关系，删掉之后关系的另一头会落空。`],
  ["crossOccurrences", (n) => `有 ${n} 处重复出现连着别的记录，删掉之后那边的重复会找不到原话。`],
  ["crossLinks", (n) => `有 ${n} 处引用连着别的记录，删掉之后这些引用会落空。`],
];

export function trashBlockers(counts: TrashBlockerCounts): string[] {
  const reasons: string[] = [];
  for (const [key, describe] of REASONS) {
    const count = Math.floor(Number(counts[key]));
    if (Number.isFinite(count) && count > 0) reasons.push(describe(count));
  }
  return reasons;
}

/**
 * 只有 project_id、要按结论圈的表。它们跟着结论走，不然原项目按项目数判断、
 * 签字、笔记的时候，会数到已经移走的结论。
 *
 * 关系和草稿关联只搬两头都在这条记录里的；一头在外的已经被上面的判定拦下。
 */
export type ClaimLinkedTable =
  | "verdicts"
  | "claim_evidence_review_attestations"
  | "user_notes"
  | "claim_relations"
  | "draft_link_candidates";

export const CLAIM_LINKED_TABLES: readonly ClaimLinkedTable[] = [
  "verdicts",
  "claim_evidence_review_attestations",
  "user_notes",
  "claim_relations",
  "draft_link_candidates",
];

/** 改归属的语句，绑定值依次是：新项目 id，然后若干组 (event_id, workspace_id)。 */
export function claimLinkedRewrite(table: ClaimLinkedTable): { sql: string; pairs: number } {
  switch (table) {
    case "claim_relations":
      return {
        sql: `UPDATE claim_relations SET project_id = ?
               WHERE source_claim_version_id IN (${RECORD_CLAIM_VERSIONS})
                 AND target_claim_version_id IN (${RECORD_CLAIM_VERSIONS})`,
        pairs: 2,
      };
    case "draft_link_candidates":
      return {
        sql: `UPDATE draft_link_candidates SET project_id = ?
               WHERE source_claim_id IN (${RECORD_CLAIMS})
                 AND target_draft_claim_id IN (${RECORD_CLAIMS})`,
        pairs: 2,
      };
    default:
      return {
        sql: `UPDATE ${table} SET project_id = ? WHERE claim_id IN (${RECORD_CLAIMS})`,
        pairs: 1,
      };
  }
}

/** 挂在记录上、带 event_id 的表，改归属的语句和跨项目搬动同一条。 */
export const RECORD_OWNED_TABLES: readonly MovedTable[] = MOVED_TABLES;

/**
 * 永久删除一条记录时要手动清的行。
 *
 * 大部分行会顺着外键从 events 级联删掉；这几张表没有指向记录或结论的外键，
 * 不手动清就会留下孤儿行。顺序要紧：先清只能靠结论 id 找到的，再删结论本身，
 * 最后删记录。
 */
export function recordPurgeStatements(): Array<{ sql: string; pairs: number }> {
  return [
    { sql: `DELETE FROM claim_occurrences WHERE event_id = ? OR claim_id IN (${RECORD_CLAIMS})`, pairs: 1 },
    { sql: `DELETE FROM claim_occurrence_candidates WHERE event_id = ? AND workspace_id = ?`, pairs: 1 },
    { sql: `DELETE FROM user_notes WHERE claim_id IN (${RECORD_CLAIMS})`, pairs: 1 },
    {
      sql: `DELETE FROM claim_relations
             WHERE source_claim_version_id IN (${RECORD_CLAIM_VERSIONS})
                OR target_claim_version_id IN (${RECORD_CLAIM_VERSIONS})`,
      pairs: 2,
    },
    { sql: `DELETE FROM text_segments WHERE event_id = ? AND workspace_id = ?`, pairs: 1 },
    // 结论版本、判断、签字、证据顺着外键从结论级联。
    { sql: `DELETE FROM claims WHERE event_id = ? AND workspace_id = ?`, pairs: 1 },
    // 材料、各类任务、阅读产物、归属建议、回收站登记顺着外键从记录级联。
    { sql: `DELETE FROM events WHERE id = ? AND workspace_id = ?`, pairs: 1 },
  ];
}

/**
 * 永久删除语句的绑定值。claim_occurrences 那条前面多一个裸的 event_id。
 */
export function recordPurgeBinds(index: number, eventId: string, workspaceId: string): string[] {
  const statement = recordPurgeStatements()[index]!;
  const pairs = Array.from({ length: statement.pairs }, () => [eventId, workspaceId]).flat();
  return index === 0 ? [eventId, ...pairs] : pairs;
}

/** 存储里要删的文件：原件、模型用的派生件、暂存件、转写暂存结果。 */
export function recordStorageKeysSql(): string {
  return `SELECT key FROM (
            SELECT av.r2_original_key AS key FROM asset_versions av
              JOIN assets a ON a.id = av.asset_id WHERE a.event_id = ? AND a.workspace_id = ?
            UNION SELECT av.r2_model_key AS key FROM asset_versions av
              JOIN assets a ON a.id = av.asset_id WHERE a.event_id = ? AND a.workspace_id = ?
            UNION SELECT a.staged_r2_key AS key FROM assets a WHERE a.event_id = ? AND a.workspace_id = ?
            UNION SELECT tr.staged_result_r2_key AS key FROM transcription_runs tr
              WHERE tr.event_id = ? AND tr.workspace_id = ?
          ) WHERE key IS NOT NULL`;
}
