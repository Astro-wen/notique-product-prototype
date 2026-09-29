import { selectSourceRanges } from '../../domain/workflow-v2.ts';
import type { SourceHighlightRequest } from '../../shared/workflow-v2.ts';
import { decisionEnvelope, statement, type WriteContext } from './ledger-write.ts';
import { digestValue, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { commitWorkflowMutation, mutationId, type MutationPlan } from './transaction.ts';

type Segment = {id:string;asset_version_id:string;ordinal:number;text_raw:string;start_ms:number|null;end_ms:number|null;kind:string};
const sourcePredicate = `ts.workspace_id=? AND ts.project_id=? AND ts.event_id=? AND ts.asset_version_id=?
  AND a.kind IN ('text','transcript')
  AND a.workspace_id=ts.workspace_id AND a.project_id=ts.project_id AND a.event_id=ts.event_id
  AND av.asset_id=a.id AND a.current_version_id=av.id AND a.processing_status='ready'
  AND COALESCE(json_extract(a.metadata_json,'$.analysis_source'),1)<>0
  AND COALESCE(json_extract(a.metadata_json,'$.artifact_kind'),'')<>'readable_transcript'
  AND COALESCE(json_extract(a.metadata_json,'$.transcription_chunk'),0)<>1
  AND (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS
    (SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.project_id=a.project_id
      AND audio.event_id=a.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id')))`;
const sourceFrom = 'text_segments ts JOIN assets a ON a.id=ts.asset_id JOIN asset_versions av ON av.id=ts.asset_version_id';

export function addSourceHighlight(db:D1Database,scope:WorkflowScope,input:{projectId:string;eventId:string;key:string;request:SourceHighlightRequest}) {
  const {projectId,eventId,key,request}=input;
  return commitWorkflowMutation(db,scope,{projectId,eventId,key,endpoint:`events/${eventId}/highlights`,payload:request,expectedContextVersion:request.expectedContextVersion},async tx=>{
    const ctx:WriteContext={db,scope,projectId,eventId,timestamp:tx.timestamp,contextVersion:tx.contextVersion,decisionId:tx.mutationId};
    const segmentIds=[...new Set(request.ranges.map(r=>r.segmentId))];
    const sourceValues=[scope.workspaceId,projectId,eventId,request.assetVersionId];
    const rows=(await db.prepare(`SELECT ts.id,ts.asset_version_id,ts.ordinal,ts.text_raw,ts.start_ms,ts.end_ms,a.kind FROM ${sourceFrom}
      WHERE ${sourcePredicate} AND ts.id IN (${segmentIds.map(()=>'?').join(',')})`).bind(...sourceValues,...segmentIds).all<Segment>()).results ?? [];
    if(rows.length!==segmentIds.length) throw new WorkflowFault(409,'version_conflict','原文或材料版本已变化，请重新选取');
    const selected=selectSourceRanges(request,rows.map(s=>({id:s.id,assetVersionId:s.asset_version_id,ordinal:s.ordinal,textRaw:s.text_raw})));
    const selectionKey=`source_selection:${await digestValue({eventId,assetVersionId:request.assetVersionId,ranges:selected.ranges})}`;
    const guards:MutationPlan['guards']=rows.map(s=>({sql:`EXISTS (SELECT 1 FROM ${sourceFrom} WHERE ${sourcePredicate} AND ts.id=? AND ts.ordinal=? AND ts.text_raw=?)`,values:[...sourceValues,s.id,s.ordinal,s.text_raw]}));
    const existing=await db.prepare('SELECT id,current_version_id,workflow_revision,review_status,lifecycle_status FROM claims WHERE workspace_id=? AND project_id=? AND event_id=? AND client_claim_key=?')
      .bind(scope.workspaceId,projectId,eventId,selectionKey).first<{id:string;current_version_id:string;workflow_revision:number;review_status:string;lifecycle_status:string}>();
    if(existing) {
      if(existing.review_status==='rejected' || ['withdrawn','superseded'].includes(existing.lifecycle_status)) throw new WorkflowFault(409,'dependency_conflict','这段原话已选录并移出当前记录，请先核对原来的处理',{claimId:existing.id});
      guards.push({sql:'EXISTS (SELECT 1 FROM claims WHERE id=? AND current_version_id=? AND workflow_revision=? AND review_status=? AND lifecycle_status=?)',values:[existing.id,existing.current_version_id,existing.workflow_revision,existing.review_status,existing.lifecycle_status]});
      return {statements:[],guards,changedRefs:[{entityType:'claim',id:existing.id,revision:existing.workflow_revision}],invalidatedVersionIds:[],refreshNarrative:false,advanceContext:false,kind:'source_highlight_existing'};
    }
    const runId=`human_selection_${await digestValue({workspaceId:scope.workspaceId,eventId})}`;
    const claimId=mutationId('clm'),versionId=mutationId('cv'),memberId=mutationId('wdm'),verdictId=mutationId('vdt');
    const normalized=JSON.stringify({workflow_kind:'source_highlight',source_selection:{assetVersionId:request.assetVersionId,ranges:selected.ranges}});
    const statements=[
      // Human selections can precede AI extraction. This dedicated ledger anchor
      // never replaces active_run_id and never queues a model request.
      statement(ctx,`INSERT INTO extraction_runs (id,workspace_id,project_id,event_id,status,idempotency_key,input_hash,input_snapshot_hash,input_manifest_json,context_version,context_snapshot_hash,provider,prompt_version,schema_version,parser_version,finished_at,created_at,updated_at)
        VALUES (?,?,?,?,'succeeded','workflow-source-selections','human','human','[]',?,'human','human','user-selection-v1','user-selection-v1','source',?,?,?) ON CONFLICT(id) DO NOTHING`,runId,scope.workspaceId,projectId,eventId,tx.contextVersion,tx.timestamp,tx.timestamp,tx.timestamp),
      decisionEnvelope(ctx,'source_highlight',key),
      statement(ctx,`INSERT INTO claims(id,workspace_id,project_id,event_id,extraction_run_id,client_claim_key,type,materiality,review_status,lifecycle_status,current_version_id,first_event_id,source,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'other','normal','verified','active',?,?,'human',?,?)`,claimId,scope.workspaceId,projectId,eventId,runId,selectionKey,versionId,eventId,tx.timestamp,tx.timestamp),
      statement(ctx,`INSERT INTO claim_versions(id,claim_id,version_no,statement,normalized_value_json,source,created_by,workflow_origin,created_at) VALUES (?,?,1,?,?,'human',?,'user_selection',?)`,versionId,claimId,selected.quote,normalized,scope.actorId,tx.timestamp),
      statement(ctx,`INSERT INTO verdicts(id,workspace_id,project_id,claim_id,action,base_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,'confirm',?,?,?,?,?)`,verdictId,scope.workspaceId,projectId,claimId,versionId,scope.actorId,tx.mutationId,memberId,tx.timestamp),
      statement(ctx,`INSERT INTO decision_members(id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,'{"exists":false}',?,?)`,memberId,scope.workspaceId,tx.mutationId,claimId,verdictId,versionId,versionId,JSON.stringify({versionId,reviewStatus:'verified',lifecycleStatus:'active',workflowRevision:1}),tx.timestamp),
    ];
    for(const range of selected.ranges) {
      const s=rows.find(s=>s.id===range.segmentId)!;
      statements.push(statement(ctx,`INSERT INTO evidence_refs(id,workspace_id,project_id,event_id,claim_version_id,kind,asset_version_id,segment_ids_json,quote_raw,start_ms,end_ms,page_number,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'direct','primary','valid','fully_supports',?)`,mutationId('evr'),scope.workspaceId,projectId,eventId,versionId,s.kind==='transcript'?'transcript':'text',request.assetVersionId,JSON.stringify([s.id]),s.text_raw.slice(range.startOffset,range.endOffset),s.start_ms,s.end_ms,null,tx.timestamp));
    }
    return {statements,guards,changedRefs:[{entityType:'claim',id:claimId,revision:1},{entityType:'decision',id:tx.mutationId,revision:1}],invalidatedVersionIds:[],kind:'source_highlight'};
  });
}
