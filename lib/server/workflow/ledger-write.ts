import { type LedgerClaim, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import type { VersionRef } from '../../shared/workflow-v2.ts';
import { WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { mutationId, type MutationPlan } from './transaction.ts';

export type WriteContext = {db:D1Database;scope:WorkflowScope;projectId:string;eventId:string;timestamp:string;contextVersion:number;decisionId:string};
export const statement = (ctx:WriteContext, sql:string,...values:unknown[])=>ctx.db.prepare(sql).bind(...values);
export const asRef = (claim:LedgerClaim):VersionRef=>({claimId:claim.id,claimVersionId:claim.current_version_id});
export function claimGuard(claim:LedgerClaim,scope:WorkflowScope):MutationPlan['guards'][number] {
  return {sql:`EXISTS (SELECT 1 FROM claims WHERE id=? AND workspace_id=? AND project_id=? AND event_id=? AND current_version_id=? AND workflow_revision=? AND review_status=? AND lifecycle_status=? AND type=?)`,values:[claim.id,scope.workspaceId,claim.project_id,claim.event_id,claim.current_version_id,claim.workflow_revision,claim.review_status,claim.lifecycle_status,claim.type]};
}
export function decisionEnvelope(ctx:WriteContext, operation:string,key:string) {
  return statement(ctx,`INSERT INTO workflow_decisions (id,workspace_id,project_id,event_id,actor_id,operation,idempotency_key,context_version,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,ctx.decisionId,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,ctx.scope.actorId,operation,key,ctx.contextVersion,ctx.timestamp);
}
export function humanClaim(ctx:WriteContext,anchor:LedgerClaim,text:string,kind:'answer'|'completion'|'result',evidenceIds:string[]=[]) {
  const claimId=mutationId('clm'),versionId=mutationId('cv'),verdictId=mutationId('vdt'),noteId=mutationId('unote'),memberId=mutationId('wdm');
  const normalized=kind==='completion'?{status:'completed',completed_action_claim_id:anchor.id,workflow_kind:kind}:{workflow_kind:kind};
  const type=kind==='completion'?'next_action':'other';
  const statements=[
    statement(ctx,`INSERT INTO claims (id,workspace_id,project_id,event_id,extraction_run_id,client_claim_key,type,materiality,review_status,lifecycle_status,current_version_id,first_event_id,source,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'high','verified','active',?,?,'human',?,?)`,claimId,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,anchor.extraction_run_id,claimId,type,versionId,ctx.eventId,ctx.timestamp,ctx.timestamp),
    statement(ctx,`INSERT INTO claim_versions (id,claim_id,version_no,statement,normalized_value_json,source,created_by,workflow_origin,created_at) VALUES (?,?,1,?,?,'human',?,'user_input',?)`,versionId,claimId,text,JSON.stringify(normalized),ctx.scope.actorId,ctx.timestamp),
    statement(ctx,`INSERT INTO verdicts (id,workspace_id,project_id,claim_id,action,base_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,'confirm',?,?,?,?,?)`,verdictId,ctx.scope.workspaceId,ctx.projectId,claimId,versionId,ctx.scope.actorId,ctx.decisionId,memberId,ctx.timestamp),
    statement(ctx,'INSERT INTO user_notes (id,workspace_id,project_id,claim_id,verdict_id,author_id,body,created_at) VALUES (?,?,?,?,?,?,?,?)',noteId,ctx.scope.workspaceId,ctx.projectId,claimId,verdictId,ctx.scope.actorId,text,ctx.timestamp),
    statement(ctx,`INSERT INTO evidence_refs (id,workspace_id,project_id,event_id,claim_version_id,kind,user_note_id,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict,created_at) VALUES (?,?,?,?,?,'user_note',?,'direct','secondary','valid','fully_supports',?)`,mutationId('evr'),ctx.scope.workspaceId,ctx.projectId,ctx.eventId,versionId,noteId,ctx.timestamp),
    statement(ctx,`INSERT INTO decision_members (id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,memberId,ctx.scope.workspaceId,ctx.decisionId,claimId,verdictId,versionId,versionId,JSON.stringify({exists:false}),JSON.stringify({versionId,reviewStatus:'verified',lifecycleStatus:'active',workflowRevision:1}),ctx.timestamp),
  ];
  for(const evidenceId of evidenceIds) statements.push(statement(ctx,`INSERT INTO evidence_refs (id,workspace_id,project_id,event_id,claim_version_id,kind,asset_version_id,user_note_id,segment_ids_json,quote_raw,start_ms,end_ms,page_number,bbox_json,observation,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict,created_at)
    SELECT ?,workspace_id,project_id,event_id,?,kind,asset_version_id,user_note_id,segment_ids_json,quote_raw,start_ms,end_ms,page_number,bbox_json,observation,'contextual',provenance_grade,structural_validation_status,'unreviewed',? FROM evidence_refs WHERE id=? AND workspace_id=? AND project_id=?`,mutationId('evr'),versionId,ctx.timestamp,evidenceId,ctx.scope.workspaceId,ctx.projectId));
  return {claimId,versionId,statements};
}
export function resolveRelation(ctx:WriteContext,sourceVersionId:string,targetVersionId:string,reason:string) {
  const id=mutationId('rel');
  return {id,statements:[
    statement(ctx,`INSERT INTO claim_relations (id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status,reason,created_at) VALUES (?,?,?,'resolves',?,?,?,'active',?,?)`,id,ctx.scope.workspaceId,ctx.projectId,sourceVersionId,targetVersionId,ctx.contextVersion,reason,ctx.timestamp),
    statement(ctx,`INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'confirm','proposed',?,?)`,mutationId('rvdt'),id,ctx.scope.actorId,ctx.timestamp),
  ]};
}
export function outcomeResultRelation(ctx:WriteContext,sourceVersionId:string,targetVersionId:string) {
  const id=mutationId('rel');
  return {id,statements:[
    statement(ctx,`INSERT INTO claim_relations (id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status,reason,created_at) VALUES (?,?,?,'informed_by',?,?,?,'active',?,?)`,id,ctx.scope.workspaceId,ctx.projectId,sourceVersionId,targetVersionId,ctx.contextVersion,JSON.stringify({workflowOutcomeResult:true}),ctx.timestamp),
    statement(ctx,`INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'confirm','proposed',?,?)`,mutationId('rvdt'),id,ctx.scope.actorId,ctx.timestamp),
  ]};
}
export function evidenceGuards(ledger:ProjectionLedger,ids:string[],ctx:WriteContext):MutationPlan['guards'] {
  return ids.map(id=>{
    const e=ledger.evidence.find(e=>e.id===id);
    if(!e || e.availability!=='ready' || e.structural_validation_status!=='valid') throw new WorkflowFault(422,'dependency_conflict','所选依据已变化，请重新选择');
    return {sql:`EXISTS (SELECT 1 FROM evidence_refs er JOIN claim_versions cv ON cv.id=er.claim_version_id JOIN claims c ON c.id=cv.claim_id
      LEFT JOIN asset_versions av ON av.id=er.asset_version_id LEFT JOIN assets a ON a.id=av.asset_id
      WHERE er.id=? AND er.workspace_id=? AND er.project_id=? AND c.workspace_id=er.workspace_id AND c.project_id=er.project_id AND er.structural_validation_status='valid'
      AND EXISTS (SELECT 1 FROM events e WHERE e.id=er.event_id AND e.project_id=er.project_id AND e.workspace_id=er.workspace_id AND e.material_status<>'archived')
      AND (er.kind='user_note' AND EXISTS (SELECT 1 FROM user_notes n WHERE n.id=er.user_note_id AND n.workspace_id=er.workspace_id AND n.project_id=er.project_id AND n.claim_id=c.id AND length(n.author_id)>0)
      OR a.workspace_id=er.workspace_id AND a.project_id=er.project_id AND a.event_id=er.event_id AND a.current_version_id=er.asset_version_id AND a.processing_status='ready'
      AND (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS (SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.event_id=a.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id')))))`,values:[id,ctx.scope.workspaceId,ctx.projectId]};
  });
}
