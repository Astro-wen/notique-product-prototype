/**
 * 删除时停下还在跑的任务。
 *
 * 之前的做法是有任务在跑就不让删，而转写失败又会无限重排，结果是一条卡死的任务
 * 把整个项目锁住。现在反过来：删的时候把任务一起停下。停下的任务标成 failed，
 * 错误码是 RUN_CANCELLED。用 failed 而不是另起一个状态，是因为现有的重试入口都
 * 只认 failed，从回收站恢复以后用户点一下重试就能接着跑。
 *
 * 为什么标一下就停得住：三类任务在写结果时都要求 status = 'processing' 且
 * lease_owner 还是自己，写结果那一批语句前面有守卫行，条件不成立整批回滚。标成
 * failed 并清掉 lease_owner 以后，正在路上的那次调用回来也写不进去。
 *
 * 这个文件不碰数据库，只生成语句，理由和 event-move.ts 一样：迁移级测试要能拿
 * 真实表结构把线上跑的那几条语句原样跑一遍。
 */

export const RUN_CANCELLED = "RUN_CANCELLED";

/** 按项目停，还是按一条记录停。只决定用哪一列圈范围。 */
export type CancelScope = "project" | "event";

const SCOPE_COLUMN: Record<CancelScope, "project_id" | "event_id"> = {
  project: "project_id",
  event: "event_id",
};

export type CancelBind = "timestamp" | "scopeId" | "workspace" | "details" | "code";

export type CancelStatement = { sql: string; binds: readonly CancelBind[] };

const ACTIVE = `status IN ('queued', 'processing')`;

function activeRuns(table: string, scope: CancelScope): string {
  return `SELECT id FROM ${table} WHERE ${SCOPE_COLUMN[scope]} = ? AND workspace_id = ? AND ${ACTIVE}`;
}

/**
 * 停任务的全部语句，按执行顺序排好。
 *
 * 顺序有讲究：前四条靠子查询找「还在跑的任务」，必须在任务本身被标成 failed
 * 之前执行，否则子查询什么都找不到。
 */
export function runCancellationStatements(scope: CancelScope): CancelStatement[] {
  const column = SCOPE_COLUMN[scope];
  const failRun = (table: string): CancelStatement => ({
    sql: `UPDATE ${table}
             SET status = 'failed', error_code = ?, error_details_json = ?,
                 lease_owner = NULL, lease_expires_at = NULL,
                 finished_at = ?, updated_at = ?
           WHERE ${column} = ? AND workspace_id = ? AND ${ACTIVE}`,
    binds: ["code", "details", "timestamp", "timestamp", "scopeId", "workspace"],
  });
  return [
    // 抽取的阶段行。留着 processing 会让以后按阶段恢复的逻辑以为还有一次调用在路上。
    {
      sql: `UPDATE extraction_model_stages
               SET status = 'failed', error_code = ?, finished_at = ?, updated_at = ?
             WHERE status = 'processing'
               AND run_id IN (${activeRuns("extraction_runs", scope)})`,
      binds: ["code", "timestamp", "timestamp", "scopeId", "workspace"],
    },
    // 长逐字稿分块生成易读稿时的块。块的写入只看块自己的状态，不一起标掉就会有块在任务
    // 已经停了之后还写进来。
    {
      sql: `UPDATE event_ai_artifact_chunks
               SET status = 'failed', error_code = ?, updated_at = ?
             WHERE ${ACTIVE}
               AND artifact_run_id IN (${activeRuns("event_ai_artifact_runs", scope)})`,
      binds: ["code", "timestamp", "scopeId", "workspace"],
    },
    // 录音上记着转写状态，界面读它来决定显示转圈还是重试。
    {
      sql: `UPDATE assets
               SET metadata_json = json_set(
                     COALESCE(metadata_json, '{}'),
                     '$.transcription_status', 'failed',
                     '$.transcription_error_code', ?
                   ),
                   updated_at = ?
             WHERE json_extract(COALESCE(metadata_json, '{}'), '$.transcription_run_id')
                   IN (${activeRuns("transcription_runs", scope)})`,
      binds: ["code", "timestamp", "scopeId", "workspace"],
    },
    // 正在替项目定场景的那次抽取停了，场景退回未判定，和抽取正常失败时一样。
    {
      sql: `UPDATE projects
               SET scenario_status = 'unassessed', scenario_assessment_run_id = NULL,
                   scenario_candidates_json = '[]', scenario_lease_expires_at = NULL,
                   updated_at = ?
             WHERE scenario_status = 'assessing'
               AND scenario_assessment_run_id IN (${activeRuns("extraction_runs", scope)})`,
      binds: ["timestamp", "scopeId", "workspace"],
    },
    failRun("transcription_runs"),
    failRun("extraction_runs"),
    failRun("event_ai_artifact_runs"),
  ];
}

/**
 * 已经交给模型供应商、还在后台跑的响应。本地标停以后再逐个发 cancel，
 * 省下供应商那边继续计费的时间。发不成也无所谓，本地已经不收它的结果了。
 */
export function activeProviderRequestsSql(scope: CancelScope): string {
  return `SELECT provider_request_id FROM extraction_model_stages
           WHERE status = 'processing' AND provider_request_id IS NOT NULL
             AND run_id IN (${activeRuns("extraction_runs", scope)})
          UNION
          SELECT provider_request_id FROM event_ai_artifact_runs
           WHERE ${SCOPE_COLUMN[scope]} = ? AND workspace_id = ? AND ${ACTIVE}
             AND provider_request_id IS NOT NULL
          UNION
          SELECT provider_request_id FROM event_ai_artifact_chunks
           WHERE ${ACTIVE} AND provider_request_id IS NOT NULL
             AND artifact_run_id IN (${activeRuns("event_ai_artifact_runs", scope)})`;
}

/** 上面那条查询的绑定值：三段，每段都是范围 id 加工作区。 */
export function activeProviderRequestsBinds(scopeId: string, workspaceId: string): string[] {
  return [scopeId, workspaceId, scopeId, workspaceId, scopeId, workspaceId];
}

export type CancelContext = {
  timestamp: string;
  scopeId: string;
  workspace: string;
  reason: "project_trashed" | "event_trashed";
};

/** 把一条语句的绑定值按占位符顺序排出来。 */
export function cancelBinds(statement: CancelStatement, context: CancelContext): string[] {
  const details = JSON.stringify({
    message: context.reason === "project_trashed"
      ? "Stopped because the project was moved to trash."
      : "Stopped because the record was moved to trash.",
    cancelled_by: context.reason,
  });
  const values: Record<CancelBind, string> = {
    timestamp: context.timestamp,
    scopeId: context.scopeId,
    workspace: context.workspace,
    details,
    code: RUN_CANCELLED,
  };
  return statement.binds.map((name) => values[name]);
}
