import { questionChangePlan, type QuestionChangeBatch } from './question-change.ts';
import { factChangePlan, type FactChangeBatch } from './fact-change.ts';
import { conflictDecisionPlan } from './conflict-decision.ts';
import { decisionState } from './decision-state.ts';
import { acceptActionBasis, actionMetadataGuard, relationGuard } from './action-basis.ts';
import { claimGuard, type WriteContext } from './ledger-write.ts';
import { reviewDeferralPlan } from './review-deferral.ts';
import { claimSourceStatus, projectWorkspace, actionBasisRefs, resolveActionBasis, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type DecisionMember, type DecisionRequest, type MutationReceipt, type ReviewCard, type WorkspaceSnapshot } from '../../shared/workflow-v2.ts';
import { loadWorkflowLedger, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { commitWorkflowMutation, mutationId, type MutationPlan } from './transaction.ts';

/** Record decisions share the immutable V1 ledger. Conflict and action commands
 * are dispatched by their own services, with their additional relation rules. */
export async function decideRecord(
  db: D1Database, scope: WorkflowScope, input: { projectId: string; eventId: string; cardId: string; key: string; request: DecisionRequest },
): Promise<MutationReceipt> {
  const request = parseWorkflowRequest('DecisionRequest',input.request);
  return commitWorkflowMutation(db,scope,{projectId:input.projectId,eventId:input.eventId,endpoint:`review-cards/${input.cardId}/decisions`,key:input.key,payload:request,expectedContextVersion:request.expectedContextVersion},async ({mutationId:decisionId,timestamp,contextVersion}) => {
    const ledger = await loadWorkflowLedger(db,scope,input.projectId);
    const workspace = projectWorkspace(ledger,input.eventId,timestamp,'');
    const card = workspace.reviewCards.find(c=>c.id===input.cardId);
    if (!card || card.revision !== request.expectedCardRevision) throw new WorkflowFault(409,'version_conflict','这条记录已变化，请重新打开');
    if (request.operation==='defer' || request.operation==='restore') return reviewDeferralPlan({db,scope,projectId:input.projectId,eventId:input.eventId,timestamp,contextVersion,decisionId},ledger,card,request,input.key);
    if(request.operation==='resolve_conflict') return conflictDecisionPlan({db,scope,projectId:input.projectId,eventId:input.eventId,timestamp,contextVersion,decisionId},ledger,card,request,input.key);
    if (!['record','action','question'].includes(card.kind) || !['confirm','edit','reject','accept_action','review_members'].includes(request.operation)) throw new WorkflowFault(409,'dependency_conflict','该决定需要通过对应的行动或冲突处理入口保存');
    const ctx:WriteContext={db,scope,projectId:input.projectId,eventId:input.eventId,timestamp,contextVersion,decisionId};
    const questionMembers=request.members.filter(m=>m.operation==='edit' && ledger.claims.some(c=>c.id===m.claimId && c.type==='open_question'));
    const questionVersions=new Set(questionMembers.map(m=>m.claimVersionId));
    const questionBatch:QuestionChangeBatch={removedRelationIds:new Set(ledger.relations.filter(r=>r.type==='resolves' && ['active','proposed'].includes(r.status) && questionVersions.has(r.target_claim_version_id)).map(r=>r.id)),keptAnswerVersions:new Set(questionMembers.flatMap(m=>m.questionChange?.answerChoices.filter(a=>a.mode==='keep').map(a=>a.claimVersionId) ?? [])),retiredAnswerIds:new Set()};
    const factBatch:FactChangeBatch={nextVersions:new Map(request.members.filter(m=>m.operation==='edit').map(m=>[m.claimVersionId,mutationId('cv')])),members:request.members,relations:new Set(),questions:new Set()};
    const plans=request.members.map(member=>{
      try { return memberDecisionPlan(ctx,ledger,workspace,card,member,questionBatch,factBatch); }
      catch(error) { if(error instanceof WorkflowFault) error.details={...error.details,affectedItems:[{claimId:member.claimId,text:card.members.find(m=>m.claimId===member.claimId)?.statement ?? '这条内容已变化'}]};throw error; }
    });
    const basisEdits=new Set(request.members.filter(m=>m.operation==='edit'||m.operation==='reject').map(m=>m.claimId));
    for(const m of request.members.filter(m=>m.operation==='accept_action')) {
      const action=ledger.claims.find(c=>c.id===m.claimId)!;
      const changed=actionBasisRefs(ledger,action).map(b=>resolveActionBasis(ledger,b).source).filter(c=>c && basisEdits.has(c.id)).map(c=>({claimId:c!.id}));
      if(changed.length) throw new WorkflowFault(409,'dependency_conflict','这次决定也会修改行动依据，请先保存依据，再核对行动',{affectedItems:changed.map(b=>({claimId:b.claimId,text:ledger.claims.find(c=>c.id===b.claimId)?.statement}))});
    }
    const decided=new Set(request.members.map(m=>m.claimId));
    const hasRemaining=card.members.some(m=>!decided.has(m.claimId) && m.reviewState==='draft');
    const intentHandled=Boolean(card.sameIntent) && request.members.length>0;
    const bind=(sql:string,...values:unknown[])=>db.prepare(sql).bind(...values);
    const title=card.members.length===1?(request.members[0].newText ?? card.title):card.title;
    const statements:D1PreparedStatement[]=[
      bind(`INSERT INTO workflow_cards (id,workspace_id,project_id,event_id,group_key,revision,kind,title,needs_decision,reason_code,reason,disposition,latest_decision_id,decision_revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,title=excluded.title,disposition=excluded.disposition,needs_decision=excluded.needs_decision,reason_code=excluded.reason_code,reason=excluded.reason,latest_decision_id=excluded.latest_decision_id,decision_revision=1,updated_at=excluded.updated_at`,
        card.id,scope.workspaceId,input.projectId,input.eventId,card.id,card.revision+1,card.kind,title,Number(hasRemaining && card.needsDecision && !intentHandled),hasRemaining && !intentHandled?card.reasonCode:null,hasRemaining && !intentHandled?card.reason:'',hasRemaining?'active':'processed',decisionId,timestamp,timestamp),
      bind(`INSERT INTO workflow_decisions (id,workspace_id,project_id,event_id,card_id,actor_id,operation,idempotency_key,context_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,decisionId,scope.workspaceId,input.projectId,input.eventId,card.id,scope.actorId,request.operation,input.key,contextVersion,timestamp),
      ...plans.flatMap(p=>p.statements),
      bind('DELETE FROM review_deferrals WHERE card_id=? AND workspace_id=?',card.id,scope.workspaceId),
    ];
    // Materialize untouched members too when the card was a virtual projection.
    for(const ref of card.memberRefs.filter(r=>!decided.has(r.claimId))) statements.push(bind(`INSERT INTO card_members (id,workspace_id,card_id,claim_id,claim_version_id,role,created_at)
      SELECT ?,?,?,?,?, 'primary',? WHERE NOT EXISTS (SELECT 1 FROM card_members WHERE card_id=? AND workspace_id=? AND claim_id=?)`,mutationId('wcm'),scope.workspaceId,card.id,ref.claimId,ref.claimVersionId,timestamp,card.id,scope.workspaceId,ref.claimId));
    const guards:MutationPlan['guards']=[...card.memberRefs.map(ref=>claimGuard(ledger.claims.find(c=>c.id===ref.claimId)!,scope)),
      {sql:'NOT EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND (workspace_id<>? OR event_id<>? OR revision<>?))',values:[card.id,scope.workspaceId,input.eventId,card.revision]},...plans.flatMap(p=>p.guards)];
    if(card.sameIntent || card.actionOverlap) {
      const stored=ledger.cards.find(c=>c.id===card.id)!;
      guards.push({sql:'EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND workspace_id=? AND group_key=? AND kind=?)',values:[card.id,scope.workspaceId,stored.group_key!,stored.kind]},...card.memberRefs.map(ref=>relationGuard(ledger,ledger.claims.find(c=>c.id===ref.claimId)!,ctx)));
    }
    if(ledger.cards.some(c=>c.id===card.id)) guards.push({sql:`(SELECT COALESCE(json_group_array(json_array(claim_id,claim_version_id)),'[]') FROM (SELECT claim_id,claim_version_id FROM card_members WHERE card_id=? AND workspace_id=? ORDER BY claim_id))=?`,values:[card.id,scope.workspaceId,JSON.stringify(card.memberRefs.toSorted((a,b)=>a.claimId<b.claimId?-1:a.claimId>b.claimId?1:0).map(r=>[r.claimId,r.claimVersionId]))]});
    return {statements,guards,changedRefs:[...plans.flatMap(p=>p.changedRefs),{entityType:'card',id:card.id,revision:card.revision+1},{entityType:'decision',id:decisionId,revision:1}],invalidatedVersionIds:plans.flatMap(p=>p.invalidatedVersionIds),basisInvalidatedVersionIds:plans.flatMap(p=>p.basisInvalidatedVersionIds ?? []),kind:request.operation};
  });
}

function memberDecisionPlan(ctx:WriteContext,ledger:ProjectionLedger,workspace:WorkspaceSnapshot,card:ReviewCard,member:DecisionMember,questionBatch:QuestionChangeBatch,factBatch:FactChangeBatch):MutationPlan {
    const {db,scope,projectId,eventId,timestamp,decisionId}=ctx;
    const operation=member.operation;
    const current = ledger.claims.find(c=>c.id===member.claimId && c.event_id===eventId && c.current_version_id===member.claimVersionId);
    if (!current || !card.memberRefs.some(r=>r.claimId===current.id && r.claimVersionId===current.current_version_id)) throw new WorkflowFault(409,'version_conflict','内容已有新版本，请重新核对');
    if(current.review_status==='rejected' || ['withdrawn','superseded'].includes(current.lifecycle_status)) throw new WorkflowFault(409,'version_conflict','这条内容已经移出当前记录');
    const targetMember=card.members.find(m=>m.claimId===current.id)!;
    if(member.questionChange && (current.type!=='open_question' || operation!=='edit')) throw new WorkflowFault(422,'dependency_conflict','答案适用选择需要对应问题修改');
    if(current.type==='open_question' && operation!=='edit') throw new WorkflowFault(422,'dependency_conflict','请通过补答案或调整问题处理');
    const editingQuestion=operation==='edit' && current.type==='open_question';
    const editingFact=operation==='edit' && !['open_question','next_action'].includes(current.type);
    if(member.factChange && !editingFact)throw new WorkflowFault(422,'dependency_conflict','信息关联选择需要对应信息修改');
    const editingAction=operation==='edit' && current.type==='next_action' && current.review_status==='verified';
    const reviewingBasis=operation==='accept_action' && workspace.actions.some(a=>a.id===current.id && a.basisState==='needs_review');
    if ((operation==='accept_action') !== (current.type==='next_action') && operation!=='reject' && !editingAction) throw new WorkflowFault(422,'dependency_conflict','行动建议需要通过加入跟进采纳');
    if(operation==='accept_action' && (claimSourceStatus(current,ledger.evidence)!=='ready' || targetMember.supportStatus==='does_not_support')) throw new WorkflowFault(422,'dependency_conflict','请先核对这条行动的依据');
    if (operation !== 'edit' && !reviewingBasis && current.review_status !== 'pending') throw new WorkflowFault(409,'version_conflict','这条记录已经处理');
    if (operation === 'confirm' && (targetMember.supportStatus !== 'fully_supports' || claimSourceStatus(current,ledger.evidence) !== 'ready')) throw new WorkflowFault(422,'dependency_conflict','请先核对依据，或按你的新信息修改这条记录');
    const related = ledger.relations.filter(r=>['active','proposed'].includes(r.status) && (r.source_claim_version_id===current.current_version_id || r.target_claim_version_id===current.current_version_id));
    const unsupportedRelations=related.filter(r=>r.type!=='informed_by' && !(editingQuestion && r.type==='resolves' && r.target_claim_version_id===current.current_version_id) && !(editingAction && r.type==='resolves' && r.target_claim_version_id===current.current_version_id));
    if (unsupportedRelations.length && operation === 'edit' && !editingFact) throw new WorkflowFault(409,'dependency_conflict','这次修改会影响关联信息，需要一并核对',{relationIds:unsupportedRelations.map(r=>r.id)});
    const selected = operation === 'edit' ? (member.evidenceRefIds ?? []) : targetMember.evidenceRefIds;
    for (const id of selected) {
      const e = ledger.evidence.find(e=>e.id===id);
      if (!e || e.claim_version_id!==current.current_version_id || e.availability!=='ready' || e.structural_validation_status!=='valid') throw new WorkflowFault(422,'dependency_conflict','选中的依据已变化，请重新选择');
    }
    if (operation === 'edit' && member.origin === 'source_statement' && !selected.some(id=>{const e=ledger.evidence.find(e=>e.id===id);return e && e.evidence_role!=='contextual' && e.kind!=='user_note';})) throw new WorkflowFault(422,'dependency_conflict','按原话修正需要直接或补充依据');
    const bind = (sql: string,...values: unknown[])=>db.prepare(sql).bind(...values);
    const basisPlan=operation==='accept_action'?acceptActionBasis(ctx,ledger,current):null;
    const nextVersion = operation === 'edit' ? factBatch.nextVersions.get(current.current_version_id)! : current.current_version_id;
    const questionPlan=editingQuestion?questionChangePlan(ctx,ledger,current,workspace.questions.find(q=>q.id===current.id)!,member,nextVersion,questionBatch):null;
    const factPlan=editingFact?factChangePlan(ctx,ledger,current,member,factBatch):null;
    const before = {...decisionState(current),preExistingRelations:related,cardState:card,relationStates:questionPlan?.beforeRelations ?? factPlan?.beforeRelations ?? basisPlan?.beforeRelations ?? [],actionMetadata:ledger.actions.find(a=>a.claim_id===current.id) ?? null,versionId:current.current_version_id,reviewStatus:current.review_status,lifecycleStatus:current.lifecycle_status,workflowRevision:current.workflow_revision};
    const editedActionMetadata=editingAction && before.actionMetadata?{...before.actionMetadata,owner_hint:null,due_at:null}:null;
    const nextRevision = current.workflow_revision+1;
    const nextStatus = operation === 'reject' ? 'rejected' : 'verified';
    const verdictId = mutationId('vdt'), memberId = mutationId('wdm');
    const statements: D1PreparedStatement[] = [];
    if (operation === 'edit') {
      statements.push(bind(`INSERT INTO claim_versions (id,claim_id,version_no,statement,normalized_value_json,uncertainty_json,source,created_by,workflow_origin,created_at)
        SELECT ?,?,COALESCE(MAX(version_no),0)+1,?,NULL,NULL,'human',?,?,? FROM claim_versions WHERE claim_id=?`,nextVersion,current.id,member.newText!,scope.actorId,member.origin!,timestamp,current.id));
      for (const evidenceId of selected) statements.push(bind(`INSERT INTO evidence_refs (id,workspace_id,project_id,event_id,claim_version_id,kind,asset_version_id,user_note_id,segment_ids_json,quote_raw,start_ms,end_ms,page_number,bbox_json,observation,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict,created_at)
        SELECT ?,workspace_id,project_id,event_id,?,kind,asset_version_id,user_note_id,segment_ids_json,quote_raw,start_ms,end_ms,page_number,bbox_json,observation,evidence_role,provenance_grade,'valid',CASE WHEN evidence_role='contextual' THEN 'unreviewed' ELSE 'fully_supports' END,? FROM evidence_refs WHERE id=? AND workspace_id=?`,mutationId('evr'),nextVersion,timestamp,evidenceId,scope.workspaceId));
      if (member.origin === 'user_input') {
        const noteId = mutationId('unote');
        statements.push(bind('INSERT INTO user_notes (id,workspace_id,project_id,claim_id,verdict_id,author_id,body,created_at) VALUES (?,?,?,?,?,?,?,?)',noteId,scope.workspaceId,projectId,current.id,verdictId,scope.actorId,member.newText!,timestamp));
        statements.push(bind(`INSERT INTO evidence_refs (id,workspace_id,project_id,event_id,claim_version_id,kind,user_note_id,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict,created_at) VALUES (?,?,?,?,?,'user_note',?,'direct','secondary','valid','fully_supports',?)`,mutationId('evr'),scope.workspaceId,projectId,eventId,nextVersion,noteId,timestamp));
      }
      if(editedActionMetadata)statements.push(bind('UPDATE action_metadata SET owner_hint=NULL,due_at=NULL,updated_at=? WHERE claim_id=? AND workspace_id=?',timestamp,current.id,scope.workspaceId));
    }
    statements.push(
      bind('INSERT INTO verdicts (id,workspace_id,project_id,claim_id,action,base_version_id,new_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',verdictId,scope.workspaceId,projectId,current.id,operation==='accept_action'?'confirm':operation,current.current_version_id,operation==='edit'?nextVersion:null,scope.actorId,decisionId,memberId,timestamp),
      bind(`UPDATE claims SET current_version_id=?,review_status=?,workflow_revision=?,confidence=CASE WHEN ?='edit' THEN NULL ELSE confidence END,needs_additional_evidence=CASE WHEN ?='edit' THEN 0 ELSE needs_additional_evidence END,updated_at=? WHERE id=? AND workspace_id=?`,nextVersion,nextStatus,nextRevision,operation,operation,timestamp,current.id,scope.workspaceId),
      bind('DELETE FROM card_members WHERE card_id=? AND workspace_id=? AND claim_id=?',card.id,scope.workspaceId,current.id),
      bind('INSERT INTO card_members (id,workspace_id,card_id,claim_id,claim_version_id,role,created_at) VALUES (?,?,?,?,?,\'primary\',?)',mutationId('wcm'),scope.workspaceId,card.id,current.id,nextVersion,timestamp),
      bind('INSERT INTO decision_members (id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',memberId,scope.workspaceId,decisionId,current.id,verdictId,current.current_version_id,nextVersion,JSON.stringify(before),JSON.stringify({...before,versionId:nextVersion,reviewStatus:nextStatus,workflowRevision:nextRevision,relationStates:questionPlan?.afterRelations ?? factPlan?.afterRelations ?? basisPlan?.afterRelations ?? [],...(questionPlan?{lifecycleStatus:questionPlan.lifecycleStatus,resolvedAt:questionPlan.resolvedAt}:{}),...(basisPlan?{actionMetadata:basisPlan.actionMetadata}:{}),...(editingAction?{actionMetadata:editedActionMetadata}:{})}),timestamp),
    );
    if(basisPlan) statements.push(...basisPlan.statements);
    if(factPlan)statements.push(...factPlan.statements);
    if(questionPlan) {
      statements.push(...questionPlan.statements,bind('UPDATE claims SET lifecycle_status=?,resolved_at=? WHERE id=? AND workspace_id=?',questionPlan.lifecycleStatus,questionPlan.resolvedAt,current.id,scope.workspaceId));
    }
    const guards: MutationPlan['guards'] = [{sql:`EXISTS (SELECT 1 FROM claims WHERE id=? AND workspace_id=? AND project_id=? AND event_id=? AND current_version_id=? AND workflow_revision=? AND review_status=? AND lifecycle_status=?)`,values:[current.id,scope.workspaceId,projectId,eventId,current.current_version_id,current.workflow_revision,current.review_status,current.lifecycle_status]},
      {sql:'NOT EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND (workspace_id<>? OR event_id<>? OR revision<>?))',values:[card.id,scope.workspaceId,eventId,card.revision]}];
    for (const evidenceId of selected) guards.push({sql:`EXISTS (SELECT 1 FROM evidence_refs er LEFT JOIN asset_versions av ON av.id=er.asset_version_id LEFT JOIN assets a ON a.id=av.asset_id WHERE er.id=? AND er.workspace_id=? AND er.claim_version_id=? AND er.structural_validation_status='valid'
      AND (er.kind='user_note' AND EXISTS (SELECT 1 FROM user_notes n WHERE n.id=er.user_note_id AND n.workspace_id=er.workspace_id AND n.project_id=er.project_id AND n.claim_id=?) OR a.workspace_id=er.workspace_id AND a.project_id=er.project_id AND a.event_id=er.event_id AND a.current_version_id=er.asset_version_id AND a.processing_status='ready')
      AND (?<>'confirm' OR er.evidence_role='contextual' OR er.semantic_support_verdict='fully_supports'))`,values:[evidenceId,scope.workspaceId,current.current_version_id,current.id,operation]});
    if (operation==='edit') guards.push(relationGuard(ledger,current,ctx));
    if(editingAction)guards.push(actionMetadataGuard(current.id,before.actionMetadata,ctx));
    if(basisPlan) guards.push(...basisPlan.guards);
    if(questionPlan) guards.push(...questionPlan.guards);
    if(factPlan)guards.push(...factPlan.guards);
    return {statements,guards,changedRefs:[{entityType:'claim',id:current.id,revision:nextRevision},...(current.type==='next_action'?[{entityType:'action' as const,id:current.id,revision:nextRevision}]:[]),...(questionPlan?[{entityType:'question' as const,id:current.id,revision:nextRevision},...questionPlan.changedRefs]:[]),...(factPlan?.changedRefs ?? [])],invalidatedVersionIds:[current.current_version_id,...(questionPlan?.invalidatedVersionIds ?? []),...(factPlan?.invalidatedVersionIds ?? [])],basisInvalidatedVersionIds:operation==='edit'||operation==='reject'?[current.current_version_id,...(questionPlan?.invalidatedVersionIds ?? [])]:[],kind:operation};
}
