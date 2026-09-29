import { validatePhotoBbox } from '../../domain/evidence.ts';
import { projectWorkspace, readJson, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type MentionDecisionRequest, type MutationReceipt } from '../../shared/workflow-v2.ts';
import { decisionEnvelope, statement, type WriteContext } from './ledger-write.ts';
import { digestValue, PROJECT_LEDGER_SQL, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { commitWorkflowMutation, mutationId, type MutationPlan } from './transaction.ts';

type Candidate = {id:string;workspace_id:string;project_id:string;event_id:string;extraction_run_id:string;target_claim_id:string;target_claim_version_id:string;base_version_id:string;status:string;evidence_ref_json:string};
type Choice = {decision_id:string;candidate_id:string;candidate_fingerprint:string;after_status:string;converted_claim_id:string|null;converted_version_id:string|null};
type Decision = {id:string;revision:number;operation:string};
type Evidence = {kind:string;assetVersionId:string;segmentIdsJson:string|null;quoteRaw:string|null;startMs:number|null;endMs:number|null;pageNumber:number|null;bboxJson:string|null;observation:string|null;evidenceRole:string};
const mentionOperations=['confirm_mention','reject_mention','convert_mention'];
export const isMentionDecision=(operation:string)=>mentionOperations.includes(operation);
const candidateFingerprint=(c:Candidate)=>digestValue({id:c.id,workspace:c.workspace_id,project:c.project_id,event:c.event_id,run:c.extraction_run_id,target:c.target_claim_id,version:c.target_claim_version_id,base:c.base_version_id,evidence:c.evidence_ref_json});
const nativeId=(decisionId:string)=>`ovdt_${decisionId}`;

async function readLedger(ctx:WriteContext) {
  const values=[ctx.scope.workspaceId,ctx.scope.actorId,ctx.projectId,ctx.scope.access==='demo'?1:0];
  const row=await ctx.db.prepare(PROJECT_LEDGER_SQL).bind(...values).first<Record<string,unknown>>();
  if(!row)throw new WorkflowFault(404,'not_found','记录不存在或当前账号无法访问');
  const columns=Object.keys(row).filter(k=>!['id','can_edit'].includes(k));
  const guardValues:unknown[]=[];
  const ledgerSql=PROJECT_LEDGER_SQL.replace(/\?([1-4])\b/g,(_,n)=>{guardValues.push(values[Number(n)-1]);return '?';});
  const guard={sql:`EXISTS (SELECT 1 FROM (${ledgerSql}) saved WHERE ${columns.map(k=>`saved.${k}=?`).join(' AND ')})`,values:[...guardValues,...columns.map(k=>row[k])]};
  const ledger={access:{workspaceId:ctx.scope.workspaceId,actorId:ctx.scope.actorId,canEdit:Boolean(row.can_edit)},contextVersion:Number(row.context_version),...Object.fromEntries(columns.filter(k=>k!=='context_version').map(k=>[k,JSON.parse(String(row[k]))]))} as ProjectionLedger;
  return {ledger,guard};
}
async function readCandidate(ctx:WriteContext,id:string):Promise<Candidate> {
  const c=await ctx.db.prepare('SELECT * FROM claim_occurrence_candidates WHERE id=? AND workspace_id=? AND project_id=? AND event_id=?').bind(id,ctx.scope.workspaceId,ctx.projectId,ctx.eventId).first<Candidate>();
  if(!c)throw new WorkflowFault(404,'not_found','这条关联已不可访问');
  return c;
}
function candidateGuard(c:Candidate):MutationPlan['guards'][number] {
  return {sql:'EXISTS (SELECT 1 FROM claim_occurrence_candidates WHERE id=? AND workspace_id=? AND project_id=? AND event_id=? AND status=? AND evidence_ref_json=? AND target_claim_id=? AND target_claim_version_id=? AND base_version_id=? AND extraction_run_id=?)',values:[c.id,c.workspace_id,c.project_id,c.event_id,c.status,c.evidence_ref_json,c.target_claim_id,c.target_claim_version_id,c.base_version_id,c.extraction_run_id]};
}
function validEvidence(value:Evidence):boolean {
  if(!value || typeof value!=='object' || !['text','transcript','photo','document'].includes(value.kind) || typeof value.assetVersionId!=='string' || !value.assetVersionId || !['direct','corroborating','contextual'].includes(value.evidenceRole))return false;
  if([value.segmentIdsJson,value.quoteRaw,value.bboxJson,value.observation].some(v=>v!==null && typeof v!=='string'))return false;
  if([value.startMs,value.endMs].some(v=>v!==null && (!Number.isSafeInteger(v) || v<0)) || value.startMs!==null && value.endMs!==null && value.endMs<value.startMs)return false;
  if(value.pageNumber!==null && (!Number.isSafeInteger(value.pageNumber) || value.pageNumber<1))return false;
  if(value.kind==='photo' && value.bboxJson!==null && !validatePhotoBbox(readJson<unknown>(value.bboxJson,null)))return false;
  return true;
}
function evidenceStatements(ctx:WriteContext,evidence:Evidence[],versionId:string,support:'unreviewed'|'fully_supports'='unreviewed') {
  const ids=evidence.map(()=>mutationId('evr'));
  const statements=evidence.map((e,index)=>statement(ctx,`INSERT INTO evidence_refs (id,workspace_id,project_id,event_id,claim_version_id,kind,asset_version_id,segment_ids_json,quote_raw,start_ms,end_ms,page_number,bbox_json,observation,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'primary','valid',?,?)`,ids[index],ctx.scope.workspaceId,ctx.projectId,ctx.eventId,versionId,e.kind,e.assetVersionId,e.segmentIdsJson,e.quoteRaw,e.startMs,e.endMs,e.pageNumber,e.bboxJson,e.observation,e.evidenceRole,support,ctx.timestamp));
  return {statements,ids};
}
function repeatCounter(ctx:WriteContext,c:Candidate) {
  // Historical confirmation rows remain audit records. Pending/rejected candidates
  // contribute no repeat count, including after an association is reversed.
  return statement(ctx,`UPDATE claims SET repeat_count=(SELECT count(DISTINCT candidate.id) FROM claim_occurrence_candidates candidate JOIN occurrence_verdicts v ON v.candidate_id=candidate.id AND v.action='confirm' JOIN claim_occurrences o ON o.occurrence_verdict_id=v.id WHERE candidate.target_claim_id=claims.id AND candidate.workspace_id=claims.workspace_id AND candidate.project_id=claims.project_id AND candidate.status='confirmed'),
    last_repeated_at=(SELECT max(v.created_at) FROM claim_occurrence_candidates candidate JOIN occurrence_verdicts v ON v.candidate_id=candidate.id AND v.action='confirm' JOIN claim_occurrences o ON o.occurrence_verdict_id=v.id WHERE candidate.target_claim_id=claims.id AND candidate.workspace_id=claims.workspace_id AND candidate.project_id=claims.project_id AND candidate.status='confirmed') WHERE id=? AND workspace_id=? AND project_id=? AND type='open_question'`,c.target_claim_id,ctx.scope.workspaceId,ctx.projectId);
}
function staleNarrative(ctx:WriteContext) {return statement(ctx,"UPDATE workflow_narratives SET freshness='stale',updated_at=? WHERE workspace_id=? AND project_id=? AND event_id=?",ctx.timestamp,ctx.scope.workspaceId,ctx.projectId,ctx.eventId);}

/** Optional occurrence choices stay on the native occurrence ledger. Confirmation
 * carries the old stable identity. Conversion creates one independently reviewable draft. */
export async function decideMention(db:D1Database,scope:WorkflowScope,input:{projectId:string;eventId:string;mentionId:string;key:string;request:MentionDecisionRequest}):Promise<MutationReceipt> {
  const request=parseWorkflowRequest('MentionDecisionRequest',input.request);
  return commitWorkflowMutation(db,scope,{...input,endpoint:`reaffirmed-mentions/${input.mentionId}/decisions`,payload:request,expectedContextVersion:request.expectedContextVersion},async t=>{
    const ctx:WriteContext={db,scope,projectId:input.projectId,eventId:input.eventId,...t,decisionId:t.mutationId};
    const c=await readCandidate(ctx,input.mentionId),{ledger,guard}=await readLedger(ctx);
    const mention=projectWorkspace(ledger,ctx.eventId,ctx.timestamp,'mention-write').reaffirmedMentions?.find(m=>m.id===c.id);
    if(c.status!=='pending' || !mention || c.target_claim_id!==request.targetRef.claimId || c.target_claim_version_id!==request.targetRef.claimVersionId)throw new WorkflowFault(409,'version_conflict','关联已有变化，请核对当前内容后选择');
    if(request.operation!=='reject' && (mention.sourceStatus!=='ready' || mention.statement===null))throw new WorkflowFault(409,'dependency_conflict','本次出处已变化，请重新核对材料');
    if(request.operation==='confirm' && (mention.targetState!=='current' || mention.targetText===null || c.base_version_id!==c.target_claim_version_id))throw new WorkflowFault(409,'dependency_conflict','原事项已有变化，请核对后作为独立信息处理');
    const payload=readJson<{statement?:string;type?:string;evidence?:Evidence[]}>(c.evidence_ref_json,{});
    const validTypes=['budget','preference','requirement','decision','concern','risk','open_question','person_role','timing','property_fact','next_action','material','measurement','other'];
    if(request.operation!=='reject' && (!Array.isArray(payload.evidence) || !payload.evidence.length || payload.evidence.length>20 || payload.evidence.some(e=>!validEvidence(e)) || typeof payload.statement!=='string' || !payload.statement.trim() || payload.statement.length>4000 || !validTypes.includes(payload.type ?? '')))throw new WorkflowFault(422,'dependency_conflict','这条提议信息需要重新整理');
    const operation=`${request.operation}_mention`,status=request.operation==='confirm'?'confirmed':request.operation==='convert'?'converted':'rejected';
    const statements=[decisionEnvelope(ctx,operation,input.key),statement(ctx,'UPDATE claim_occurrence_candidates SET status=?,updated_at=? WHERE id=? AND workspace_id=?',status,ctx.timestamp,c.id,scope.workspaceId),statement(ctx,'INSERT INTO occurrence_verdicts (id,candidate_id,action,target_base_version_id,user_id,created_at) VALUES (?,?,?,?,?,?)',nativeId(ctx.decisionId),c.id,request.operation==='convert'?'convert_to_new_claim':request.operation,c.target_claim_version_id,scope.actorId,ctx.timestamp)];
    let claimId:string|null=null,versionId:string|null=null;
    const changedRefs:MutationReceipt['changedRefs']=[{entityType:'decision',id:ctx.decisionId,revision:1}];
    if(request.operation==='confirm') {
      const evidence=evidenceStatements(ctx,payload.evidence!,c.target_claim_version_id);
      statements.push(...evidence.statements,statement(ctx,'INSERT INTO claim_occurrences (id,claim_id,claim_version_id,event_id,evidence_ref_id,occurrence_verdict_id,confirmed_at,created_at) VALUES (?,?,?,?,?,?,?,?)',mutationId('occ'),c.target_claim_id,c.target_claim_version_id,ctx.eventId,evidence.ids[0],nativeId(ctx.decisionId),ctx.timestamp,ctx.timestamp),repeatCounter(ctx,c));
    } else if(request.operation==='convert') {
      claimId=mutationId('clm');versionId=mutationId('cv');
      statements.push(statement(ctx,`INSERT INTO claims (id,workspace_id,project_id,event_id,extraction_run_id,client_claim_key,type,materiality,review_status,lifecycle_status,current_version_id,first_event_id,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'medium','pending','active',?,?,'occurrence_conversion',?,?)`,claimId,scope.workspaceId,ctx.projectId,ctx.eventId,c.extraction_run_id,`occurrence-conversion:${c.id}:${ctx.decisionId}`,payload.type,versionId,ctx.eventId,ctx.timestamp,ctx.timestamp),statement(ctx,"INSERT INTO claim_versions (id,claim_id,version_no,statement,source,workflow_origin,created_at) VALUES (?,?,1,?,'ai',?,?)",versionId,claimId,payload.statement,payload.type==='next_action'?'ai_suggestion':'source_statement',ctx.timestamp),...evidenceStatements(ctx,payload.evidence!,versionId,'fully_supports').statements);
      changedRefs.push({entityType:'claim',id:claimId,revision:1});
    }
    statements.push(statement(ctx,'INSERT INTO workflow_mention_decisions (decision_id,workspace_id,project_id,event_id,candidate_id,candidate_fingerprint,after_status,converted_claim_id,converted_version_id) VALUES (?,?,?,?,?,?,?,?,?)',ctx.decisionId,scope.workspaceId,ctx.projectId,ctx.eventId,c.id,await candidateFingerprint(c),status,claimId,versionId),staleNarrative(ctx));
    return {statements,guards:[guard,candidateGuard(c)],changedRefs,invalidatedVersionIds:[],basisInvalidatedVersionIds:[],kind:operation};
  });
}

export async function revertMentionDecision(ctx:WriteContext,original:Decision,key:string):Promise<MutationPlan> {
  const choice=await ctx.db.prepare('SELECT * FROM workflow_mention_decisions WHERE decision_id=? AND workspace_id=? AND project_id=? AND event_id=?').bind(original.id,ctx.scope.workspaceId,ctx.projectId,ctx.eventId).first<Choice>();
  if(!choice)throw new WorkflowFault(409,'dependency_conflict','这次关联缺少恢复记录，请核对当前内容');
  const c=await readCandidate(ctx,choice.candidate_id),{guard}=await readLedger(ctx);
  if(c.status!==choice.after_status || await candidateFingerprint(c)!==choice.candidate_fingerprint)throw new WorkflowFault(409,'dependency_conflict','这条关联已有后续变化，请核对当前内容');
  const latest=await ctx.db.prepare('SELECT decision_id FROM workflow_mention_decisions WHERE workspace_id=? AND candidate_id=? AND decision_id<>? AND EXISTS (SELECT 1 FROM workflow_decisions d WHERE d.id=workflow_mention_decisions.decision_id AND d.reverted_by IS NULL)').bind(ctx.scope.workspaceId,c.id,original.id).first();
  if(latest)throw new WorkflowFault(409,'dependency_conflict','这条关联已有后续处理，请核对当前内容');
  const guards:MutationPlan['guards']=[guard,candidateGuard(c),{sql:'EXISTS (SELECT 1 FROM workflow_mention_decisions WHERE decision_id=? AND workspace_id=? AND candidate_id=? AND candidate_fingerprint=? AND after_status=? AND converted_claim_id IS ? AND converted_version_id IS ?)',values:[original.id,ctx.scope.workspaceId,c.id,choice.candidate_fingerprint,choice.after_status,choice.converted_claim_id,choice.converted_version_id]},{sql:'EXISTS (SELECT 1 FROM workflow_decisions WHERE id=? AND workspace_id=? AND revision=? AND reverted_by IS NULL)',values:[original.id,ctx.scope.workspaceId,original.revision]},{sql:'NOT EXISTS (SELECT 1 FROM workflow_mention_decisions m JOIN workflow_decisions d ON d.id=m.decision_id WHERE m.workspace_id=? AND m.candidate_id=? AND m.decision_id<>? AND d.reverted_by IS NULL)',values:[ctx.scope.workspaceId,c.id,original.id]}];
  const statements=[decisionEnvelope(ctx,'revert_mention',key),statement(ctx,'UPDATE workflow_decisions SET reversal_of=? WHERE id=?',original.id,ctx.decisionId),statement(ctx,'UPDATE workflow_decisions SET reverted_by=?,revision=revision+1 WHERE id=?',ctx.decisionId,original.id),statement(ctx,"UPDATE claim_occurrence_candidates SET status='pending',updated_at=? WHERE id=?",ctx.timestamp,c.id),statement(ctx,"INSERT INTO occurrence_verdicts (id,candidate_id,action,target_base_version_id,user_id,created_at) VALUES (?,?,'revert',?,?,?)",nativeId(ctx.decisionId),c.id,c.target_claim_version_id,ctx.scope.actorId,ctx.timestamp)];
  const changedRefs:MutationReceipt['changedRefs']=[{entityType:'decision',id:original.id,revision:original.revision+1}];
  if(choice.after_status==='converted') {
    const sql="EXISTS (SELECT 1 FROM claims c WHERE c.id=? AND c.workspace_id=? AND c.project_id=? AND c.event_id=? AND c.current_version_id=? AND c.workflow_revision=1 AND c.review_status='pending' AND c.lifecycle_status='active' AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.claim_id=c.id) AND NOT EXISTS (SELECT 1 FROM workflow_cards wc JOIN card_members cm ON cm.card_id=wc.id WHERE cm.claim_id=c.id AND wc.latest_decision_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM claim_relations r WHERE r.status='active' AND (r.source_claim_version_id=c.current_version_id OR r.target_claim_version_id=c.current_version_id)))";
    const values=[choice.converted_claim_id,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,choice.converted_version_id];
    if(!(await ctx.db.prepare(`SELECT (${sql}) AS valid`).bind(...values).first<{valid:number}>())?.valid)throw new WorkflowFault(409,'dependency_conflict','独立信息已有后续处理，请在当前记录上修正');
    guards.push({sql,values});statements.push(statement(ctx,"UPDATE claims SET review_status='rejected',lifecycle_status='withdrawn',workflow_revision=workflow_revision+1,updated_at=? WHERE id=?",ctx.timestamp,choice.converted_claim_id));
    changedRefs.push({entityType:'claim',id:choice.converted_claim_id!,revision:2});
  }
  if(choice.after_status==='confirmed')statements.push(repeatCounter(ctx,c));
  statements.push(staleNarrative(ctx));
  return {statements,guards,changedRefs,invalidatedVersionIds:choice.converted_version_id?[choice.converted_version_id]:[],basisInvalidatedVersionIds:[],kind:'revert_mention'};
}
