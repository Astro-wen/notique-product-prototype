import { getBindings, getD1 } from "@/db";
import {
  cancelBinds,
  runCancellationStatements,
  type CancelContext,
  type CancelScope,
} from "@/lib/domain/run-cancellation";
import { cancelBackgroundResponses } from "@/lib/server/ai/model-provider";
import type { ModelProviderProfile } from '@/lib/server/ai/model-route';

type ProviderRequest = {
  id: string;
  provider: string;
  model: string;
  providerProfile?: ModelProviderProfile;
  providerBaseUrl?: string | null;
};

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
): Promise<ProviderRequest[]> {
  const column = scope === 'project' ? 'project_id' : 'event_id';
  const rows = (await getD1()
    .prepare(`SELECT s.provider_request_id,s.provider,s.model,NULL AS provider_profile,NULL AS provider_base_url
      FROM extraction_model_stages s JOIN extraction_runs r ON r.id=s.run_id
      WHERE r.${column}=? AND r.workspace_id=? AND r.status IN ('queued','processing')
        AND s.status='processing' AND s.provider_request_id IS NOT NULL
      UNION ALL
      SELECT provider_request_id,provider,model,provider_profile,provider_base_url FROM event_ai_artifact_runs
      WHERE ${column}=? AND workspace_id=? AND status IN ('queued','processing') AND provider_request_id IS NOT NULL
      UNION ALL
      SELECT c.provider_request_id,r.provider,r.model,r.provider_profile,r.provider_base_url
      FROM event_ai_artifact_chunks c JOIN event_ai_artifact_runs r ON r.id=c.artifact_run_id
      WHERE r.${column}=? AND r.workspace_id=? AND r.status IN ('queued','processing')
        AND c.status IN ('queued','processing') AND c.provider_request_id IS NOT NULL`)
    .bind(scopeId,workspaceId,scopeId,workspaceId,scopeId,workspaceId)
    .all<{provider_request_id:string;provider:string;model:string;provider_profile:ModelProviderProfile|null;provider_base_url:string|null}>()).results ?? [];
  return rows.map(row=>({id:row.provider_request_id,provider:row.provider,model:row.model,
    ...(row.provider_profile ? {providerProfile:row.provider_profile,providerBaseUrl:row.provider_base_url} : {}),
  }));
}

export function runCancellationBatch(scope: CancelScope, context: CancelContext): D1PreparedStatement[] {
  const db = getD1();
  return runCancellationStatements(scope).map((statement) =>
    db.prepare(statement.sql).bind(...cancelBinds(statement, context)));
}

export async function cancelRemoteResponses(requests: readonly ProviderRequest[]): Promise<void> {
  const groups=new Map<string,{route:Omit<ProviderRequest,'id'>;ids:Set<string>}>();
  for(const {id,...route} of requests){
    // Only OpenAI Responses have this cancellation endpoint. Chat-completion
    // IDs from other providers are usage identifiers, not resumable responses.
    if(route.provider!=='openai')continue;
    const key=JSON.stringify(route);
    const group=groups.get(key)??{route,ids:new Set<string>()};
    group.ids.add(id);groups.set(key,group);
  }
  await Promise.allSettled([...groups.values()].map(group=>
    cancelBackgroundResponses(getBindings(),[...group.ids],fetch,group.route)));
}
