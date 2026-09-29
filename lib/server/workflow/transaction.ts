import type { MutationReceipt } from '../../shared/workflow-v2.ts';
import { digestValue, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';

export type WorkflowMutation = {
  projectId: string;
  eventId: string;
  endpoint: string;
  key: string;
  payload: unknown;
  expectedContextVersion: number;
};
export type MutationPlan = {
  statements: D1PreparedStatement[];
  guards: Array<{ sql: string; values: unknown[] }>;
  changedRefs: MutationReceipt['changedRefs'];
  invalidatedVersionIds: string[];
  basisInvalidatedVersionIds?: string[];
  restoredBasisActionIds?: string[];
  refreshNarrative?: boolean;
  advanceContext?: boolean;
  kind: string;
};
export const mutationId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-','')}`;

const accessPredicate = `EXISTS (SELECT 1 FROM projects p JOIN events e ON e.project_id = p.id AND e.workspace_id = p.workspace_id
  WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL AND e.id = ? AND e.material_status <> 'archived'
  AND (? = 1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = p.workspace_id AND wm.actor_id = ? AND wm.revoked_at IS NULL AND wm.role IN ('editor','owner'))))`;
const accessValues = (scope: WorkflowScope, input: WorkflowMutation) => [input.projectId,scope.workspaceId,input.eventId,scope.access === 'demo' ? 1 : 0,scope.actorId];

async function authorize(db: D1Database, scope: WorkflowScope, input: WorkflowMutation) {
  const permitted = await db.prepare(`SELECT (${accessPredicate}) AS permitted`).bind(...accessValues(scope,input)).first<{permitted:number}>();
  if (!permitted?.permitted) throw new WorkflowFault(403,'forbidden','当前账号无法修改这份记录');
}
async function replay(db: D1Database, scope: WorkflowScope, input: WorkflowMutation, hash: string): Promise<MutationReceipt | null> {
  const row = await db.prepare('SELECT request_hash,response_json FROM mutation_replays WHERE workspace_id=? AND actor_id=? AND endpoint_scope=? AND idempotency_key=?')
    .bind(scope.workspaceId,scope.actorId,input.endpoint,input.key).first<{request_hash:string;response_json:string}>();
  if (!row) return null;
  if (row.request_hash !== hash) throw new WorkflowFault(409,'idempotency_conflict','这次提交的内容发生了变化，请重新保存');
  return JSON.parse(row.response_json) as MutationReceipt;
}

/** Preflight is advisory. Access, context, source and member guards are rechecked
 * in the same D1 transaction as the ledger, invalidation, outbox and receipt. */
export async function commitWorkflowMutation(
  db: D1Database,
  scope: WorkflowScope,
  input: WorkflowMutation,
  prepare: (transaction: { mutationId: string; timestamp: string; contextVersion: number }) => Promise<MutationPlan>,
  timestamp = new Date().toISOString(),
): Promise<MutationReceipt> {
  if (!input.key.trim() || input.key.length > 128) throw new WorkflowFault(409,'idempotency_conflict','保存需要有效的提交标识');
  await authorize(db,scope,input);
  const hash = await digestValue({projectId:input.projectId,eventId:input.eventId,payload:input.payload});
  const existing = await replay(db,scope,input,hash);
  if (existing) return existing;
  const version = await db.prepare('SELECT context_version FROM projects WHERE id=? AND workspace_id=?').bind(input.projectId,scope.workspaceId).first<{context_version:number}>();
  if (version?.context_version !== input.expectedContextVersion) throw new WorkflowFault(409,'version_conflict','记录已有新变化，请核对后保存',{currentContextVersion:version?.context_version});
  const id = mutationId('wmut');
  let contextVersion = input.expectedContextVersion + 1;
  const plan = await prepare({mutationId:id,timestamp,contextVersion});
  if (plan.advanceContext === false) contextVersion = input.expectedContextVersion;
  const guardId = mutationId('wguard');
  const bind = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  // D1 permits 100 bound parameters in one statement. All guards remain before
  // every write in the same atomic batch, even for a 20-member review.
  const conditions=[{sql:accessPredicate,values:accessValues(scope,input)},
    {sql:'EXISTS (SELECT 1 FROM projects WHERE id=? AND workspace_id=? AND context_version=?)',values:[input.projectId,scope.workspaceId,input.expectedContextVersion]},...plan.guards];
  const chunks:Array<typeof conditions>=[];
  let chunk:typeof conditions=[],parameters=2;
  for(const condition of conditions) {
    if(condition.values.length>98)throw new Error('A workflow guard exceeds the D1 parameter limit');
    if(parameters+condition.values.length>100){chunks.push(chunk);chunk=[];parameters=2;}
    chunk.push(condition);parameters+=condition.values.length;
  }
  if(chunk.length)chunks.push(chunk);
  const guardIds=chunks.map((_,index)=>`${guardId}_${index}`);
  const guardStatements=chunks.map((conditions,index)=>bind(
    `INSERT INTO mutation_guards (id,guard_value,created_at) SELECT ?, CASE WHEN ${conditions.map(g=>`(${g.sql})`).join(' AND ')} THEN 1 ELSE 0 END, ?`,
    guardIds[index],...conditions.flatMap(g=>g.values),timestamp));
  const affected = [...new Set(plan.invalidatedVersionIds)];
  const invalidation: D1PreparedStatement[] = [];
  if (affected.length) {
    invalidation.push(bind(`UPDATE workflow_narratives SET freshness='stale',updated_at=? WHERE workspace_id=? AND project_id=? AND id IN (SELECT derived_id FROM derived_dependencies WHERE workspace_id=? AND derived_type='narrative' AND claim_version_id IN (SELECT value FROM json_each(?)))`,timestamp,scope.workspaceId,input.projectId,scope.workspaceId,JSON.stringify(affected)));
  }
  const changedBasis = [...new Set(plan.basisInvalidatedVersionIds ?? affected)];
  if (changedBasis.length) {
    invalidation.push(bind(`UPDATE action_metadata SET basis_state='needs_review',updated_at=? WHERE workspace_id=? AND project_id=? AND EXISTS (SELECT 1 FROM json_each(basis_version_refs_json) b WHERE json_extract(b.value,'$.claimVersionId') IN (SELECT value FROM json_each(?))) AND claim_id NOT IN (SELECT value FROM json_each(?))`,timestamp,scope.workspaceId,input.projectId,JSON.stringify(changedBasis),JSON.stringify(plan.restoredBasisActionIds ?? [])));
  }
  // Legacy narratives without dependency rows cannot remain current after a write.
  if (plan.refreshNarrative !== false) invalidation.push(bind(`UPDATE workflow_narratives SET freshness='stale',updated_at=? WHERE workspace_id=? AND project_id=? AND (event_id=? OR event_id IS NULL) AND NOT EXISTS (SELECT 1 FROM derived_dependencies d WHERE d.derived_type='narrative' AND d.derived_id=workflow_narratives.id AND d.workspace_id=?)`,timestamp,scope.workspaceId,input.projectId,input.eventId,scope.workspaceId));
  const receipt: MutationReceipt = {mutationId:id,contextVersion,changedRefs:plan.changedRefs,affectedViews:['workspace','overview','narrative','report'],refreshState:plan.refreshNarrative === false ? 'current' : 'updating'};
  const statements = [
    ...guardStatements,
    ...plan.statements,
    bind('UPDATE projects SET context_version=?,ledger_version=ledger_version+1,updated_at=? WHERE id=? AND workspace_id=?',contextVersion,timestamp,input.projectId,scope.workspaceId),
    ...invalidation,
    bind('DELETE FROM workflow_snapshots WHERE workspace_id=? AND project_id=?',scope.workspaceId,input.projectId),
    // Freeze the exact text and version after this mutation, inside the same
    // transaction. Later edits cannot rewrite the recent-change history.
    bind(`INSERT INTO workflow_changes (id,workspace_id,project_id,event_id,mutation_id,context_version,actor_id,kind,changed_refs_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,COALESCE(json_group_array(json_set(j.value,
        '$.claimRefs',json(CASE WHEN json_extract(j.value,'$.entityType') IN ('claim','action','question') THEN
          COALESCE((SELECT json_group_array(json_object('claimId',c.id,'claimVersionId',c.current_version_id)) FROM claims c WHERE c.id=json_extract(j.value,'$.id') AND c.workspace_id=? AND c.project_id=?),'[]')
        WHEN json_extract(j.value,'$.entityType')='outcome' THEN COALESCE((SELECT json_group_array(json_object('claimId',cv.claim_id,'claimVersionId',cv.id))
          FROM workflow_outcomes o JOIN outcome_versions ov ON ov.id=o.current_version_id JOIN claims subject ON subject.id=o.subject_claim_id
          JOIN claim_versions cv ON cv.id=subject.current_version_id OR cv.id IN (SELECT value FROM json_each(ov.answer_claim_version_ids_json))
          WHERE o.id=json_extract(j.value,'$.id') AND o.workspace_id=? AND o.project_id=?),'[]') ELSE '[]' END),
        '$.text',COALESCE(CASE WHEN json_extract(j.value,'$.entityType') IN ('claim','action','question') THEN
          (SELECT v.statement FROM claims c JOIN claim_versions v ON v.id=c.current_version_id WHERE c.id=json_extract(j.value,'$.id') AND c.workspace_id=? AND c.project_id=?)
        WHEN json_extract(j.value,'$.entityType')='outcome' THEN
          (SELECT ov.text FROM workflow_outcomes o JOIN outcome_versions ov ON ov.id=o.current_version_id WHERE o.id=json_extract(j.value,'$.id') AND o.workspace_id=? AND o.project_id=?) END,''))), '[]'),?
      FROM json_each(?) j`,mutationId('wch'),scope.workspaceId,input.projectId,input.eventId,id,contextVersion,scope.actorId,plan.kind,
      scope.workspaceId,input.projectId,scope.workspaceId,input.projectId,scope.workspaceId,input.projectId,scope.workspaceId,input.projectId,timestamp,JSON.stringify(plan.changedRefs)),
    ...(plan.refreshNarrative === false ? [] : [bind(`INSERT INTO workflow_outbox (id,workspace_id,project_id,event_id,kind,task_key,input_revision,payload_json,available_at,created_at,updated_at)
      SELECT 'wjob_'||lower(hex(randomblob(16))),e.workspace_id,e.project_id,e.id,'narrative', 'narrative:'||e.project_id||':'||e.id||':'||?, ?,json_object('eventId',e.id,'contextVersion',?),?,?,?
      FROM events e WHERE e.workspace_id=? AND e.project_id=? AND e.material_status<>'archived' AND (e.id=? OR EXISTS (SELECT 1 FROM workflow_narratives n WHERE n.workspace_id=e.workspace_id AND n.project_id=e.project_id AND n.event_id=e.id AND n.freshness='stale'))`,contextVersion,contextVersion,contextVersion,new Date(Date.parse(timestamp)+2000).toISOString(),timestamp,timestamp,scope.workspaceId,input.projectId,input.eventId)]),
    bind('INSERT INTO mutation_replays (id,workspace_id,actor_id,endpoint_scope,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)',mutationId('mrep'),scope.workspaceId,scope.actorId,input.endpoint,input.key,hash,JSON.stringify(receipt),timestamp),
    bind('DELETE FROM mutation_guards WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(guardIds)),
  ];
  try { await db.batch(statements); }
  catch(error) {
    // A concurrent retry may have committed this exact request. Recheck access
    // before returning its receipt, including when a membership was just revoked.
    await authorize(db,scope,input);
    const raced = await replay(db,scope,input,hash);
    if (raced) return raced;
    const message = error instanceof Error ? error.message : String(error);
    if (/mutation_guards|ck_mutation_guards_true/.test(message)) throw new WorkflowFault(409,'version_conflict','内容或依据已有变化，请核对后保存');
    throw error;
  }
  return receipt;
}
