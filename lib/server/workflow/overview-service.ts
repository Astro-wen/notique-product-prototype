import { currentRecordBullets } from '../../domain/workflow-v2.ts';
import { isCompletionRecord, projectWorkspace, readJson, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type ProjectOverview, type VersionRef, type WorkspaceQuery } from '../../shared/workflow-v2.ts';
import { digestValue, loadWorkflowLedger, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';

const changeLabels:Record<string,string>={confirm:'采纳了重点',edit:'修改了重点',reject:'移出了重点',accept_action:'更新了跟进',resolve_conflict:'处理了新旧信息',revert:'撤销了处理',source_highlight:'选录了原话',complete:'完成了行动',reopen:'重新跟进',cancel:'取消了行动',save_outcome:'补充了结果',replace_outcome:'修正了结果',withdraw_outcome:'撤回了结果'};
type FrozenChange={entityType:string;id:string;claimRefs?:VersionRef[];text?:string};

/** Project review shares the same ledger and current-record rules as a single
 * communication. Human edits, answers and source changes have one interpretation. */
export function projectOverview(ledger:ProjectionLedger,now:string):ProjectOverview {
  const records=ledger.events.toSorted((a,b)=>b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id)).map(event=>({event,snapshot:projectWorkspace(ledger,event.id,now,'')}));
  const byId=new Map(ledger.claims.map(c=>[c.id,c]));
  const bullets=new Map<string,ProjectOverview['currentBullets'][number]>();
  for(const {event,snapshot} of records)for(const bullet of currentRecordBullets(snapshot.bullets,snapshot.questions)) {
    const sourceEvent=byId.get(bullet.claimRefs[0]?.claimId)?.event_id ?? event.id;
    const action=snapshot.actions.find(a=>bullet.claimRefs.some(r=>r.claimId===a.id));
    if(!bullets.has(bullet.id))bullets.set(bullet.id,{...bullet,eventId:sourceEvent,...(action?{executionState:action.executionState}:{})});
  }
  const recentChanges:ProjectOverview['recentChanges']=(ledger.changes ?? []).filter(c=>c.event_id && ledger.events.some(e=>e.id===c.event_id) && changeLabels[c.kind]).toSorted((a,b)=>b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map(change=>{
    const frozen=readJson<FrozenChange[]>(change.changed_refs_json,[]).filter(r=>r.text && r.claimRefs?.length);
    const primary=frozen.find(r=>r.entityType==='outcome') ?? frozen.find(r=>{const claim=byId.get(r.id);return !claim || !isCompletionRecord(claim);});
    const claimRefs=primary?.claimRefs ?? [];
    const evidence=claimRefs.map(ref=>ledger.evidence.filter(e=>e.claim_version_id===ref.claimVersionId && e.evidence_role!=='contextual'));
    const owned=claimRefs.every(ref=>byId.has(ref.claimId) && ledger.events.some(e=>e.id===byId.get(ref.claimId)?.event_id));
    const sourceStatus=!owned || evidence.some(refs=>!refs.length || refs.some(e=>e.availability==='missing' || e.structural_validation_status!=='valid'))?'missing':evidence.some(refs=>refs.some(e=>e.availability==='stale'))?'stale':'ready';
    // Legacy change rows carry IDs only. Keep their operation visible without
    // substituting today's wording for an unknown historical version.
    const text=primary && sourceStatus==='ready'?`${changeLabels[change.kind]}：${primary.text}`:primary?`${changeLabels[change.kind]}，当时的依据需要重新核对。`:changeLabels[change.kind];
    return {id:change.id,eventId:change.event_id!,text,claimRefs,createdAt:change.created_at};
  });
  const currentBullets=[...bullets.values()];
  const openQuestions=[...new Map(records.flatMap(({event,snapshot})=>snapshot.questions.filter(q=>q.resolutionState==='open').map(q=>[q.id,{...q,eventId:byId.get(q.id)?.event_id ?? event.id}] as const))).values()];
  const nextActions=[...new Map(records.flatMap(({event,snapshot})=>snapshot.actions.filter(a=>a.executionState==='open').map(a=>[a.id,{...a,eventId:byId.get(a.id)?.event_id ?? event.id}] as const))).values()];
  return {access:ledger.access ?? {workspaceId:'',actorId:'',canEdit:false},snapshotId:'',contextVersion:ledger.contextVersion,nextCursor:null,
    currentBullets,recentChanges,openQuestions,nextActions,
    counts:{draftCount:currentBullets.filter(b=>b.reviewState==='draft').length,needsDecisionCount:records.reduce((n,{event,snapshot})=>n+snapshot.reviewCards.filter(card=>card.needsDecision && card.disposition==='active' && (card.eventId ?? event.id)===event.id).length,0),openActionCount:nextActions.length,openQuestionCount:openQuestions.length},
    recordSummaries:records.map(({event,snapshot})=>({eventId:event.id,title:event.title,occurredAt:event.occurred_at,narrative:snapshot.narrative,coverage:snapshot.coverage,counts:snapshot.counts,reviewProgress:snapshot.reviewProgress!}))};
}

export async function readProjectOverview(db:D1Database,scope:WorkflowScope,projectId:string,rawQuery:WorkspaceQuery={},timestamp=new Date().toISOString()):Promise<ProjectOverview> {
  const query=parseWorkflowRequest('OverviewQuery',rawQuery);
  const ledger=await loadWorkflowLedger(db,scope,projectId);
  if(query.minContextVersion!==undefined && ledger.contextVersion<query.minContextVersion)throw new WorkflowFault(503,'snapshot_busy','正在同步刚保存的内容，请稍后重试');
  const projected=projectOverview(ledger,timestamp);
  const fingerprint=await digestValue({workspace:scope.workspaceId,actor:scope.actorId,projectId,sources:ledger.assets,events:ledger.events,projected:{...projected,recordSummaries:projected.recordSummaries.map(record=>({...record,reviewProgress:undefined}))}});
  const window=Math.floor(Date.parse(timestamp)/900_000);
  let snapshot={...projected,snapshotId:`wpo_${fingerprint}_${window}`};
  if(query.snapshotId) {
    const cached=await db.prepare(`SELECT payload_json FROM workflow_snapshots WHERE id=? AND workspace_id=? AND project_id=? AND event_id IS NULL AND actor_id=? AND expires_at>?`).bind(query.snapshotId,scope.workspaceId,projectId,scope.actorId,timestamp).first<{payload_json:string}>();
    if(!cached)throw new WorkflowFault(409,'cursor_expired','项目已有变化，请重新读取');
    const saved=JSON.parse(cached.payload_json) as {fingerprint:string;snapshot:ProjectOverview};
    if(saved.fingerprint!==fingerprint)throw new WorkflowFault(409,'cursor_expired','内容或来源已变化，请重新读取项目');
    snapshot=saved.snapshot;
  } else {
    await db.prepare(`INSERT INTO workflow_snapshots (id,workspace_id,project_id,event_id,actor_id,context_version,source_revision,payload_json,expires_at,created_at) VALUES (?,?,?,NULL,?,?,0,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(snapshot.snapshotId,scope.workspaceId,projectId,scope.actorId,snapshot.contextVersion,JSON.stringify({fingerprint,snapshot}),new Date((window+1)*900_000).toISOString(),timestamp).run();
  }
  const start=query.cursor?Number(query.cursor):0;
  if(!Number.isSafeInteger(start) || start<0 || query.cursor!==undefined && !/^\d+$/.test(query.cursor) || start>snapshot.recentChanges.length)throw new WorkflowFault(409,'cursor_expired','列表位置无效，请重新读取');
  const end=start+(query.limit ?? 20);
  return {...snapshot,recordSummaries:projected.recordSummaries,recentChanges:snapshot.recentChanges.slice(start,end),nextCursor:end<snapshot.recentChanges.length?String(end):null};
}
