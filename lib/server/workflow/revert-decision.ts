import { isMentionDecision, revertMentionDecision } from './mention-decision.ts';
import { projectWorkspace, frozenActionOverlapRefs, actionBasisRefs, claimOrigin, claimSourceStatus, readJson, resolveActionBasis, type LedgerClaim, type LedgerRelation, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type MutationReceipt, type RevertDecisionRequest } from '../../shared/workflow-v2.ts';
import { actionMetadataGuard, relationGuard } from './action-basis.ts';
import { decisionState, type DecisionState } from './decision-state.ts';
import { claimGuard, decisionEnvelope, evidenceGuards, statement, type WriteContext } from './ledger-write.ts';
import { loadWorkflowLedger, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { commitWorkflowMutation, mutationId, type MutationPlan } from './transaction.ts';

type DecisionRow={id:string;card_id:string|null;revision:number;operation:string;reverted_by:string|null;context_version:number};
type MemberRow={claim_id:string;before_state_json:string;after_state_json:string};
const relationValues=(r:LedgerRelation)=>[r.status,r.contradiction_status??null,r.reason??null,r.resolved_at??null,r.resolved_by_verdict_id??null,r.resolved_by_relation_id??null];

export async function revertDecision(db:D1Database,scope:WorkflowScope,input:{projectId:string;eventId:string;decisionId:string;key:string;request:RevertDecisionRequest}):Promise<MutationReceipt> {
  const request=parseWorkflowRequest('RevertDecisionRequest',input.request);
  return commitWorkflowMutation(db,scope,{...input,endpoint:`decisions/${input.decisionId}/revert`,payload:request,expectedContextVersion:request.expectedContextVersion},async t=>{
    const ctx:WriteContext={db,scope,projectId:input.projectId,eventId:input.eventId,...t,decisionId:t.mutationId};
    const original=await db.prepare('SELECT id,card_id,revision,operation,reverted_by,context_version FROM workflow_decisions WHERE id=? AND workspace_id=? AND project_id=? AND event_id=?').bind(input.decisionId,scope.workspaceId,input.projectId,input.eventId).first<DecisionRow>();
    if(!original || original.reverted_by || original.revision!==request.expectedDecisionRevision) throw new WorkflowFault(409,'version_conflict','这次决定已经变化，请重新读取');
    if(isMentionDecision(original.operation))return revertMentionDecision(ctx,original,input.key);
    const rows=await db.prepare('SELECT claim_id,before_state_json,after_state_json FROM decision_members WHERE decision_id=? AND workspace_id=?').bind(original.id,scope.workspaceId).all<MemberRow>();
    if(!original.card_id || !['confirm','edit','reject','accept_action','resolve_conflict','review_members'].includes(original.operation) || !(rows.results ?? []).length) throw new WorkflowFault(409,'dependency_conflict','这次操作请通过对应内容的修正入口处理');
    const ledger=await loadWorkflowLedger(db,scope,input.projectId);
    const card=ledger.cards.find(c=>c.id===original.card_id);
    const members=(rows.results ?? []).map(row=>({claim:ledger.claims.find(c=>c.id===row.claim_id),before:readJson<DecisionState|null>(row.before_state_json,null),after:readJson<DecisionState|null>(row.after_state_json,null)}));
    const unavailable=members.filter(m=>!m.claim || !m.before || !m.after || m.claim.current_version_id!==m.after.versionId || m.claim.workflow_revision!==m.after.workflowRevision || m.claim.review_status!==m.after.reviewStatus || m.claim.lifecycle_status!==m.after.lifecycleStatus || m.after.type!==undefined && m.claim.type!==m.after.type);
    if(!card || card.latest_decision_id!==original.id || unavailable.length) throw new WorkflowFault(409,'dependency_conflict','这次决定已有后续变化，请在当前内容上修正',{affectedItems:unavailable.map(m=>({claimId:m.claim?.id,text:m.claim?.statement ?? '相关内容已不可用'}))});
    const root=members.find(m=>m.before?.cardState);
    if(!root?.before?.cardState) throw new WorkflowFault(409,'dependency_conflict','这条历史决定缺少恢复快照，请在当前内容上修正');
    const currentMemberRefs=ledger.members.filter(m=>m.card_id===card.id).map(m=>({claimId:m.claim_id,claimVersionId:m.claim_version_id}));
    const memberSet=(refs:typeof currentMemberRefs)=>JSON.stringify(refs.toSorted((a,b)=>a.claimId<b.claimId?-1:a.claimId>b.claimId?1:0).map(r=>[r.claimId,r.claimVersionId]));
    const expectedMemberRefs=root.before.cardState.memberRefs.map(ref=>({claimId:ref.claimId,claimVersionId:members.find(m=>m.claim?.id===ref.claimId)?.after?.versionId ?? ref.claimVersionId}));
    if(memberSet(currentMemberRefs)!==memberSet(expectedMemberRefs))throw new WorkflowFault(409,'dependency_conflict','这组内容已有变化，请在当前记录上修正');
    if(root.before.cardState.sameIntent) {
      const prior=root.before.cardState.sameIntent,current=projectWorkspace(ledger,input.eventId,ctx.timestamp,'revert-check').reviewCards.find(c=>c.id===card.id)?.sameIntent;
      if(!current || current.recordRef.claimId!==prior.recordRef.claimId || current.actionRef.claimId!==prior.actionRef.claimId)throw new WorkflowFault(409,'dependency_conflict','这组内容已有变化，请在当前记录上修正');
    }
    if(root.before.cardState.actionOverlap) {
      const prior=root.before.cardState.actionOverlap,current=frozenActionOverlapRefs(card.group_key ?? null);
      if(card.kind!=='action' || !current || current.manualRef.claimId!==prior.manualRef.claimId || current.manualRef.claimVersionId!==prior.manualRef.claimVersionId
        || current.modelRef.claimId!==prior.modelRef.claimId || current.modelRef.claimVersionId!==prior.modelRef.claimVersionId)throw new WorkflowFault(409,'dependency_conflict','这组行动已有变化，请在当前记录上修正');
    }
    const relationPairs=new Map<string,{before:LedgerRelation|null;after:LedgerRelation}>();
    for(const m of members) {
      const before=m.before?.relationStates ?? [],after=m.after?.relationStates ?? [];
      if(before.length!==after.length) throw new WorkflowFault(409,'dependency_conflict','这条历史决定的关系快照不完整');
      for(let i=0;i<after.length;i++) {
        if(!after[i]) throw new WorkflowFault(409,'dependency_conflict','这条历史决定的关系快照不完整');
        const pair={before:before[i],after:after[i]!},known=relationPairs.get(pair.after.id);
        if(known && JSON.stringify(known)!==JSON.stringify(pair)) throw new WorkflowFault(409,'dependency_conflict','这条历史决定的关联快照不一致');
        relationPairs.set(pair.after.id,pair);
      }
    }
    const beforeRelations=[...relationPairs.values()].map(p=>p.before),afterRelations=[...relationPairs.values()].map(p=>p.after);
    const changedRelations=afterRelations.filter((r):r is LedgerRelation=>Boolean(r));
    for(const r of changedRelations) {
      const current=ledger.relations.find(x=>x.id===r.id);
      if(!current || current.source_claim_version_id!==r.source_claim_version_id || current.target_claim_version_id!==r.target_claim_version_id || current.type!==r.type || JSON.stringify(relationValues(current))!==JSON.stringify(relationValues(r))) throw new WorkflowFault(409,'dependency_conflict','关联内容已有后续处理，请在当前记录上修正',{relationId:r.id});
    }
    const ids=members.map(m=>m.claim!.id),versions=members.map(m=>m.after!.versionId),managed=changedRelations.map(r=>r.id);
    const preExisting=members.flatMap(m=>m.after?.preExistingRelations ?? []);
    const preserved=ledger.relations.filter(r=>preExisting.some(p=>p.id===r.id && p.type===r.type && p.source_claim_version_id===r.source_claim_version_id && p.target_claim_version_id===r.target_claim_version_id && JSON.stringify(relationValues(p))===JSON.stringify(relationValues(r)))).map(r=>r.id);
    const dependencyExempt=[...new Set([...managed,...preserved])];
    const dependencies=ledger.relations.filter(r=>r.status==='active' && !dependencyExempt.includes(r.id) && (versions.includes(r.source_claim_version_id)||versions.includes(r.target_claim_version_id)))
      .flatMap(r=>{const c=ledger.claims.find(c=>c.current_version_id===r.source_claim_version_id && c.review_status==='verified' && !['withdrawn','superseded'].includes(c.lifecycle_status));return c && !ids.includes(c.id)?[{relationId:r.id,claimId:c.id,text:c.statement}]:[];});
    if(dependencies.length) throw new WorkflowFault(409,'dependency_conflict','这次决定已经被后续内容使用，请在当前记录上修正',{affectedItems:dependencies});
    const statements:D1PreparedStatement[]=[decisionEnvelope(ctx,'revert',input.key),statement(ctx,'UPDATE workflow_decisions SET reversal_of=? WHERE id=? AND workspace_id=?',original.id,ctx.decisionId,scope.workspaceId),statement(ctx,'UPDATE workflow_decisions SET reverted_by=?,revision=revision+1 WHERE id=? AND workspace_id=?',ctx.decisionId,original.id,scope.workspaceId)];
    const guards:MutationPlan['guards']=[{sql:'EXISTS (SELECT 1 FROM workflow_decisions WHERE id=? AND workspace_id=? AND revision=? AND reverted_by IS NULL)',values:[original.id,scope.workspaceId,original.revision]},{sql:'EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND workspace_id=? AND latest_decision_id=? AND revision=?)',values:[card.id,scope.workspaceId,original.id,card.revision]}];
    guards.push({sql:`(SELECT COALESCE(json_group_array(json_array(claim_id,claim_version_id)),'[]') FROM (SELECT claim_id,claim_version_id FROM card_members WHERE card_id=? AND workspace_id=? ORDER BY claim_id))=?`,values:[card.id,scope.workspaceId,memberSet(currentMemberRefs)]});
    const affected:MutationReceipt['changedRefs']=[];
    for(const member of members) {
      const c=member.claim!,before=member.before!;
      guards.push(claimGuard(c,scope),relationGuard(ledger,c,ctx));
      const verdictId=mutationId('vdt'),memberId=mutationId('wdm'),revision=c.workflow_revision+1;
      statements.push(statement(ctx,`INSERT INTO verdicts (id,workspace_id,project_id,claim_id,action,base_version_id,new_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,verdictId,scope.workspaceId,ctx.projectId,c.id,before.reviewStatus==='verified'?'confirm':before.reviewStatus==='rejected'?'reject':'withdraw',c.current_version_id,before.versionId,scope.actorId,ctx.decisionId,memberId,ctx.timestamp));
      statements.push(statement(ctx,`UPDATE claims SET current_version_id=?,review_status=?,lifecycle_status=?,workflow_revision=?,confidence=?,needs_additional_evidence=?,resolved_at=?,updated_at=? WHERE id=? AND workspace_id=?`,before.versionId,before.reviewStatus,before.lifecycleStatus,revision,before.confidence??null,before.needsAdditionalEvidence??0,before.resolvedAt??null,ctx.timestamp,c.id,scope.workspaceId));
      statements.push(statement(ctx,`INSERT INTO decision_members(id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,memberId,scope.workspaceId,ctx.decisionId,c.id,verdictId,c.current_version_id,before.versionId,JSON.stringify(decisionState(c)),JSON.stringify({...before,workflowRevision:revision}),ctx.timestamp));
      if('actionMetadata' in member.after! && c.type==='next_action') guards.push(actionMetadataGuard(c.id,member.after!.actionMetadata as ProjectionLedger['actions'][number]|null,ctx));
      if('actionMetadata' in before && c.type==='next_action') {
        const meta=before.actionMetadata as ProjectionAction|null;
        if(meta) statements.push(statement(ctx,`UPDATE action_metadata SET basis_version_refs_json=?,basis_state=?,cancelled_at=?,owner_hint=?,due_at=?,updated_at=? WHERE claim_id=? AND workspace_id=?`,meta.basis_version_refs_json,meta.basis_state,meta.cancelled_at??null,meta.owner_hint??null,meta.due_at??null,ctx.timestamp,c.id,scope.workspaceId));
        else statements.push(statement(ctx,'DELETE FROM action_metadata WHERE claim_id=? AND workspace_id=?',c.id,scope.workspaceId));
      }
      affected.push({entityType:'claim',id:c.id,revision});
    }
    for(let index=0;index<afterRelations.length;index++) {
      const after=afterRelations[index]!,before=beforeRelations[index];
      statements.push(statement(ctx,`UPDATE claim_relations SET status=?,contradiction_status=?,reason=?,resolved_at=?,resolved_by_verdict_id=?,resolved_by_relation_id=? WHERE id=? AND workspace_id=?`,...(before?relationValues(before):['inactive',after.contradiction_status??null,after.reason??null,after.resolved_at??null,after.resolved_by_verdict_id??null,after.resolved_by_relation_id??null]),after.id,scope.workspaceId));
      statements.push(statement(ctx,`INSERT INTO relation_verdicts(id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,?,?,?,?)`,mutationId('rvdt'),after.id,before?'confirm':'reject',after.status,scope.actorId,ctx.timestamp));
    }
    const prior=root.before.cardState;
    if(prior.sameIntent || prior.actionOverlap)guards.push({sql:'EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND workspace_id=? AND group_key=? AND kind=?)',values:[card.id,scope.workspaceId,card.group_key!,card.kind]});
    // Restoring the group must also preserve members untouched by this decision.
    for(const ref of prior.memberRefs.filter(r=>!ids.includes(r.claimId))) {
      const claim=ledger.claims.find(c=>c.id===ref.claimId);
      if(!claim || claim.current_version_id!==ref.claimVersionId || ['withdrawn','superseded'].includes(claim.lifecycle_status)) throw new WorkflowFault(409,'dependency_conflict','同组内容已有变化，请在当前记录上修正',{affectedItems:[{claimId:ref.claimId,text:claim?.statement ?? '相关内容已不可用'}]});
      guards.push(claimGuard(claim,scope));
    }
    statements.push(statement(ctx,`UPDATE workflow_cards SET revision=revision+1,kind=?,title=?,needs_decision=?,reason_code=?,reason=?,disposition=?,latest_decision_id=NULL,decision_revision=NULL,updated_at=? WHERE id=? AND workspace_id=?`,prior.sameIntent || prior.actionOverlap?'action':prior.kind,prior.title,Number(prior.needsDecision),prior.reasonCode,prior.reason,prior.disposition==='processed'?'processed':'active',ctx.timestamp,card.id,scope.workspaceId));
    statements.push(statement(ctx,'DELETE FROM card_members WHERE card_id=? AND workspace_id=?',card.id,scope.workspaceId));
    for(const ref of prior.memberRefs) statements.push(statement(ctx,`INSERT INTO card_members (id,workspace_id,card_id,claim_id,claim_version_id,role,created_at) VALUES (?,?,?,?,?,'primary',?)`,mutationId('wcm'),scope.workspaceId,card.id,ref.claimId,ref.claimVersionId,ctx.timestamp));
    statements.push(statement(ctx,'DELETE FROM review_deferrals WHERE card_id=? AND workspace_id=?',card.id,scope.workspaceId));
    guards.push({sql:`NOT EXISTS (SELECT 1 FROM claim_relations r JOIN claim_versions v ON v.id=r.source_claim_version_id JOIN claims c ON c.id=v.claim_id WHERE r.workspace_id=? AND r.project_id=? AND r.status='active' AND c.current_version_id=v.id AND c.review_status='verified' AND c.lifecycle_status NOT IN ('withdrawn','superseded') AND c.id NOT IN (SELECT value FROM json_each(?)) AND (r.source_claim_version_id IN (SELECT value FROM json_each(?)) OR r.target_claim_version_id IN (SELECT value FROM json_each(?))) AND r.id NOT IN (SELECT value FROM json_each(?)))`,values:[scope.workspaceId,ctx.projectId,JSON.stringify(ids),JSON.stringify(versions),JSON.stringify(versions),JSON.stringify(dependencyExempt)]});
    // A legacy relation writer may leave the row inactive without changing a claim revision.
    for(const r of changedRelations) guards.push({sql:`EXISTS (SELECT 1 FROM claim_relations WHERE id=? AND workspace_id=? AND status=? AND contradiction_status IS ? AND reason IS ? AND resolved_at IS ? AND resolved_by_verdict_id IS ? AND resolved_by_relation_id IS ?)`,values:[r.id,scope.workspaceId,...relationValues(r)]});
    const basisInvalidatedVersionIds=members.filter(m=>m.before!.versionId!==m.after!.versionId
      || (m.before!.reviewStatus==='rejected')!==(m.after!.reviewStatus==='rejected')
      || ['withdrawn','superseded'].some(status=>(m.before!.lifecycleStatus===status)!==(m.after!.lifecycleStatus===status)))
      .flatMap(m=>[m.before!.versionId,m.after!.versionId]);
    const basisRestore=await restoreBasisAfterUndo(ctx,ledger,members.map(m=>({claim:m.claim!,before:m.before!})),relationPairs);
    statements.push(...basisRestore.statements);guards.push(...basisRestore.guards);
    return {statements,guards,changedRefs:[...affected,...basisRestore.changedRefs,{entityType:'card',id:card.id,revision:card.revision+1},{entityType:'decision',id:original.id,revision:original.revision+1}],invalidatedVersionIds:[...versions,...members.map(m=>m.before!.versionId)],basisInvalidatedVersionIds,restoredBasisActionIds:basisRestore.actionIds,kind:'revert'};
  });
}
/** Undo restores an already accepted version. It can clear the derived warning
 * only when every frozen basis and its source will again be exact and readable. */
async function restoreBasisAfterUndo(ctx:WriteContext,ledger:ProjectionLedger,members:Array<{claim:LedgerClaim;before:DecisionState}>,relations:Map<string,{before:LedgerRelation|null;after:LedgerRelation}>) {
  const statements:D1PreparedStatement[]=[],guards:MutationPlan['guards']=[],actionIds:string[]=[],changedRefs:MutationReceipt['changedRefs']=[];
  const restoredVersions=new Set(members.map(m=>m.before.versionId)),ownActions=new Set(members.filter(m=>m.claim.type==='next_action').map(m=>m.claim.id));
  const candidates=ledger.actions.filter(meta=>meta.basis_state==='needs_review' && !ownActions.has(meta.claim_id)
    && readJson<Array<{claimVersionId:string}>>(meta.basis_version_refs_json,[]).some(b=>restoredVersions.has(b.claimVersionId)));
  if(!candidates.length)return {statements,guards,actionIds,changedRefs};
  const versions=await ctx.db.prepare(`SELECT v.id,v.claim_id,v.statement,v.normalized_value_json,v.source AS version_source,v.workflow_origin
    FROM claim_versions v JOIN claims c ON c.id=v.claim_id WHERE c.workspace_id=? AND c.project_id=? AND v.id IN (SELECT value FROM json_each(?))`)
    .bind(ctx.scope.workspaceId,ctx.projectId,JSON.stringify(members.map(m=>m.before.versionId))).all<Pick<LedgerClaim,'statement'|'normalized_value_json'|'version_source'|'workflow_origin'> & {id:string;claim_id:string}>();
  const restored:ProjectionLedger={...ledger,claims:ledger.claims.map(c=>{
    const m=members.find(m=>m.claim.id===c.id),v=m && versions.results?.find(v=>v.id===m.before.versionId && v.claim_id===c.id);
    return m && v?{...c,statement:v.statement,normalized_value_json:v.normalized_value_json,version_source:v.version_source,workflow_origin:v.workflow_origin,
      current_version_id:m.before.versionId,review_status:m.before.reviewStatus,lifecycle_status:m.before.lifecycleStatus}:c;
  }),relations:ledger.relations.map(r=>{const p=relations.get(r.id);return p?p.before ?? {...r,status:'inactive'}:r;})};
  for(const meta of candidates) {
    const action=ledger.claims.find(c=>c.id===meta.claim_id),basis=action && actionBasisRefs(ledger,action);
    if(!action || ownActions.has(action.id) || action.review_status!=='verified' || ['withdrawn','superseded'].includes(action.lifecycle_status)
      || meta.basis_state!=='needs_review' || !basis?.some(b=>restoredVersions.has(b.claimVersionId)) || claimSourceStatus(action,ledger.evidence)!=='ready')continue;
    const sources=basis.map(b=>resolveActionBasis(restored,b).source);
    if(sources.some((c,i)=>!c || c.id!==basis[i].claimId || c.current_version_id!==basis[i].claimVersionId || claimSourceStatus(c,ledger.evidence)!=='ready'))continue;
    guards.push(actionMetadataGuard(action.id,meta,ctx));
    for(const c of [action,...sources.filter((c):c is LedgerClaim=>Boolean(c))]) {
      const prior=ledger.claims.find(x=>x.id===c.id)!;
      guards.push(claimGuard(prior,ctx.scope),relationGuard(ledger,prior,ctx));
      const refs=ledger.evidence.filter(e=>e.claim_version_id===c.current_version_id && e.evidence_role!=='contextual'),notes=refs.filter(e=>e.kind==='user_note');
      guards.push(...evidenceGuards(ledger,claimOrigin(c)==='user_input' && notes.length?notes.map(e=>e.id):refs.map(e=>e.id),ctx));
    }
    statements.push(statement(ctx,"UPDATE action_metadata SET basis_state='current',updated_at=? WHERE claim_id=? AND workspace_id=?",ctx.timestamp,action.id,ctx.scope.workspaceId));
    actionIds.push(action.id);changedRefs.push({entityType:'action',id:action.id,revision:action.workflow_revision});
  }
  return {statements,guards,actionIds,changedRefs};
}
type ProjectionAction={basis_version_refs_json:string;basis_state:string;cancelled_at?:string|null;owner_hint?:string|null;due_at?:string|null};
