import { getBindings, getD1 } from "@/db";
import {
  activeProviderRequestsBinds,
  activeProviderRequestsSql,
  cancelBinds,
  runCancellationStatements,
  type CancelContext,
  type CancelScope,
} from "@/lib/domain/run-cancellation";
import { cancelBackgroundResponses } from "@/lib/server/ai/model-provider";

/**
 * 删除时停任务的数据库一侧。规则和语句在 lib/domain/run-cancellation.ts。
 *
 * 用法固定三步：先 activeProviderRequestIds 记下要远程取消的响应，再把
 * runCancellationBatch 的语句拼进删除的那一批里一起提交，提交成功以后调
 * cancelRemoteResponses。顺序反过来会在删除失败时白白取消掉还要用的响应。
 */

export async function activeProviderRequestIds(
  scope: CancelScope,
  scopeId: string,
  workspaceId: string,
): Promise<string[]> {
  const rows = (await getD1()
    .prepare(activeProviderRequestsSql(scope))
    .bind(...activeProviderRequestsBinds(scopeId, workspaceId))
    .all<{ provider_request_id: string }>()).results ?? [];
  return [...new Set(rows.map((row) => String(row.provider_request_id)).filter(Boolean))];
}

export function runCancellationBatch(scope: CancelScope, context: CancelContext): D1PreparedStatement[] {
  const db = getD1();
  return runCancellationStatements(scope).map((statement) =>
    db.prepare(statement.sql).bind(...cancelBinds(statement, context)));
}

export async function cancelRemoteResponses(responseIds: readonly string[]): Promise<void> {
  await cancelBackgroundResponses(getBindings(), responseIds).catch(() => undefined);
}
