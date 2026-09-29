import type { ReviewProgress, ReviewProgressRequest } from '../../shared/workflow-v2.ts';
import { digestValue, findWorkflowEvent, readWorkspace, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { mutationId } from './transaction.ts';

/** Personal reading metadata uses read permission and never changes business
 * context, decisions, acceptance or generation tasks. */
export async function saveReviewProgress(db:D1Database,scope:WorkflowScope,eventId:string,request:ReviewProgressRequest,key:string,timestamp=new Date().toISOString()):Promise<ReviewProgress> {
  if(!key.trim() || key.length>128) throw new WorkflowFault(409,'idempotency_conflict','保存位置需要有效的提交标识');
  const projectId=await findWorkflowEvent(db,scope,eventId);
  const endpoint=`events/${eventId}/review-progress`,hash=await digestValue(request);
  const replay=async()=>{
    const r=await db.prepare('SELECT request_hash,response_json FROM mutation_replays WHERE workspace_id=? AND actor_id=? AND endpoint_scope=? AND idempotency_key=?')
      .bind(scope.workspaceId,scope.actorId,endpoint,key).first<{request_hash:string;response_json:string}>();
    if(!r)return null;
    if(r.request_hash!==hash)throw new WorkflowFault(409,'idempotency_conflict','这次保存的位置发生了变化，请重新操作');
    return JSON.parse(r.response_json) as ReviewProgress;
  };
  const existing=await replay();if(existing)return existing;
  // Validate an actor-owned snapshot, including old V1 source writes that have
  // not yet adopted context-version invalidation.
  const snapshot=await readWorkspace(db,scope,eventId,{snapshotId:request.snapshotId,limit:50},timestamp);
  let card=snapshot.reviewCards.find(c=>c.id===request.lastCardId);
  if(request.lastCardId && !card) {
    let cursor=snapshot.nextCursor;
    while(cursor && !card) {const page=await readWorkspace(db,scope,eventId,{snapshotId:request.snapshotId,cursor,limit:50},timestamp);card=page.reviewCards.find(c=>c.id===request.lastCardId);cursor=page.nextCursor;}
    if(!card)throw new WorkflowFault(409,'cursor_expired','这条内容已更新，请从当前记录继续');
  }
  const result:ReviewProgress={lastCardId:request.lastCardId,finishedAt:request.mode==='finish_session'?timestamp:null,remainingCount:snapshot.counts.needsDecisionCount};
  const bind=(sql:string,...v:unknown[])=>db.prepare(sql).bind(...v);
  const guardId=mutationId('pguard');
  const statements=[bind(`INSERT INTO mutation_guards(id,guard_value,created_at) SELECT ?,CASE WHEN EXISTS
    (SELECT 1 FROM projects p JOIN events e ON e.project_id=p.id AND e.workspace_id=p.workspace_id
      JOIN workflow_snapshots s ON s.project_id=p.id AND s.event_id=e.id AND s.workspace_id=p.workspace_id
      WHERE p.id=? AND p.workspace_id=? AND p.deleted_at IS NULL AND p.context_version=? AND e.id=? AND e.material_status<>'archived'
      AND e.source_revision=? AND s.id=? AND s.actor_id=? AND s.expires_at>?
      AND (?=1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=p.workspace_id AND wm.actor_id=? AND wm.revoked_at IS NULL))) THEN 1 ELSE 0 END,?`,
    guardId,projectId,scope.workspaceId,snapshot.contextVersion,eventId,snapshot.sourceRevision,request.snapshotId,scope.actorId,timestamp,scope.access==='demo'?1:0,scope.actorId,timestamp)];
  if(card) {
    // Virtual cards need a durable identity for the bookmark FK. Persist their
    // existing projection as-is, without marking the item reviewed.
    statements.push(bind(`INSERT INTO workflow_cards(id,workspace_id,project_id,event_id,group_key,revision,kind,title,needs_decision,reason_code,reason,disposition,latest_decision_id,decision_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,card.id,scope.workspaceId,projectId,card.eventId ?? eventId,card.memberRefs[0].claimId,card.revision,card.kind,card.title,Number(card.needsDecision),card.reasonCode,card.reason,card.disposition==='processed'?'processed':'active',card.latestDecisionId,card.decisionRevision,card.createdAt ?? timestamp,timestamp));
    for(const ref of card.memberRefs)statements.push(bind(`INSERT INTO card_members(id,workspace_id,card_id,claim_id,claim_version_id,role,created_at)
      SELECT ?,?,?,?,?, 'primary',? WHERE NOT EXISTS (SELECT 1 FROM card_members WHERE card_id=? AND claim_version_id=?)`,mutationId('wcm'),scope.workspaceId,card.id,ref.claimId,ref.claimVersionId,timestamp,card.id,ref.claimVersionId));
  }
  statements.push(bind(`INSERT INTO review_progress(id,workspace_id,project_id,event_id,actor_id,last_card_id,snapshot_id,finished_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id,actor_id) DO UPDATE SET last_card_id=excluded.last_card_id,snapshot_id=excluded.snapshot_id,finished_at=excluded.finished_at,updated_at=excluded.updated_at`,mutationId('prg'),scope.workspaceId,projectId,eventId,scope.actorId,request.lastCardId,request.snapshotId,result.finishedAt,timestamp));
  statements.push(bind('INSERT INTO mutation_replays(id,workspace_id,actor_id,endpoint_scope,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)',mutationId('mrep'),scope.workspaceId,scope.actorId,endpoint,key,hash,JSON.stringify(result),timestamp),bind('DELETE FROM mutation_guards WHERE id=?',guardId));
  try {await db.batch(statements);}
  catch(error) {
    await findWorkflowEvent(db,scope,eventId);
    const raced=await replay();if(raced)return raced;
    if(/mutation_guards|ck_mutation_guards_true/.test(error instanceof Error?error.message:String(error)))throw new WorkflowFault(409,'cursor_expired','记录已有变化，请从当前位置继续');
    throw error;
  }
  return result;
}
