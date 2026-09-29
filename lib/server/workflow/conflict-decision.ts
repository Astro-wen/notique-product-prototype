import { claimSourceStatus, isCompletionRecord, type LedgerClaim, type LedgerRelation, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import type { DecisionRequest, ReviewCard } from '../../shared/workflow-v2.ts';
import { acceptActionBasis, actionMetadataGuard, relationGuard } from './action-basis.ts';
import { decisionState } from './decision-state.ts';
import { claimGuard, evidenceGuards, statement, type WriteContext } from './ledger-write.ts';
import { WorkflowFault } from './snapshot-store.ts';
import { mutationId, type MutationPlan } from './transaction.ts';

export function conflictDecisionPlan(ctx:WriteContext,ledger:ProjectionLedger,card:ReviewCard,request:DecisionRequest,key:string):MutationPlan {
  if(request.members.length!==1) throw new WorkflowFault(422,'dependency_conflict','请逐项选择新旧信息的适用方式');
  const member=request.members[0],choice=member.conflictChoice;
  const conflict=card.conflicts?.find(c=>c.candidateRef.claimId===member.claimId && c.candidateRef.claimVersionId===member.claimVersionId && c.existing.claimId===choice?.existingRef.claimId && c.existing.claimVersionId===choice.existingRef.claimVersionId);
  if(!choice || !conflict || choice.candidateRef.claimId!==member.claimId || choice.candidateRef.claimVersionId!==member.claimVersionId) throw new WorkflowFault(409,'version_conflict','双方内容已经变化，请重新核对');
  const candidate=ledger.claims.find(c=>c.id===member.claimId && c.current_version_id===member.claimVersionId)!;
  const existing=ledger.claims.find(c=>c.id===choice.existingRef.claimId && c.current_version_id===choice.existingRef.claimVersionId)!;
  if(!candidate || !existing || candidate.id===existing.id || candidate.event_id!==ctx.eventId) throw new WorkflowFault(409,'version_conflict','新旧信息已变化');
  const actionConflict=candidate.type==='next_action' && existing.type==='next_action';
  if(choice.mode!=='keep_existing' && (candidate.type==='next_action' || existing.type==='next_action') && !actionConflict) throw new WorkflowFault(422,'dependency_conflict','行动需要与行动比较，请重新核对这条建议');
  if(choice.mode!=='keep_existing' && (candidate.type==='open_question' || existing.type==='open_question')) throw new WorkflowFault(422,'dependency_conflict','问题变化请通过调整问题核对现有答案');
  const candidateMember=card.members.find(m=>m.claimId===candidate.id)!;
  if(choice.mode!=='keep_existing' && (claimSourceStatus(candidate,ledger.evidence)!=='ready' || candidateMember.supportStatus!=='fully_supports')) throw new WorkflowFault(422,'dependency_conflict','新信息需要有效出处与内容支持，再决定采用或并存');
  const original=ledger.relations.find(r=>r.id===conflict.relationId)!;
  const basisPlan=actionConflict && choice.mode!=='keep_existing'?acceptActionBasis(ctx,ledger,candidate):null;
  if(basisPlan?.basis.some(b=>b.claimId===existing.id)) throw new WorkflowFault(409,'dependency_conflict','新行动以原行动为依据，请先核对独立的执行依据');
  const relationVerdictId=mutationId('rvdt');
  const updated:LedgerRelation={...original,status:'active',contradiction_status:'resolved',resolved_at:ctx.timestamp,resolved_by_verdict_id:relationVerdictId,
    reason:JSON.stringify({operation:'resolve_conflict',mode:choice.mode,decisionId:ctx.decisionId,...(choice.applicability?{applicability:choice.applicability}:{})})};
  const beforeRelations:Array<LedgerRelation|null>=[original,...(basisPlan?.beforeRelations ?? [])],afterRelations:Array<LedgerRelation|null>=[updated,...(basisPlan?.afterRelations ?? [])];
  const completions=actionConflict?ledger.relations.filter(r=>r.type==='resolves' && r.status==='active' && (r.target_claim_id===existing.id || r.target_claim_version_id===existing.current_version_id) && ledger.claims.some(c=>c.current_version_id===r.source_claim_version_id && isCompletionRecord(c))):[];
  for(const r of completions) {beforeRelations.push(r);afterRelations.push(r);}
  const changes=new Map<string,{claim:LedgerClaim;after:ReturnType<typeof decisionState>}>();
  changes.set(candidate.id,{claim:candidate,after:{...decisionState(candidate),reviewStatus:choice.mode==='keep_existing'?'rejected':'verified',workflowRevision:candidate.workflow_revision+1}});
  changes.set(existing.id,{claim:existing,after:{...decisionState(existing),lifecycleStatus:choice.mode==='use_candidate'?'superseded':existing.lifecycle_status,workflowRevision:existing.workflow_revision+1}});
  const grouped=Boolean(card.sameIntent),storedGroup=grouped?ledger.cards.find(c=>c.id===card.id):undefined;
  const hasRemaining=grouped && card.members.some(m=>(changes.get(m.claimId)?.after.reviewStatus ?? ledger.claims.find(c=>c.id===m.claimId)!.review_status)==='pending');
  const statements:D1PreparedStatement[]=[
    statement(ctx,`INSERT INTO workflow_cards (id,workspace_id,project_id,event_id,group_key,revision,kind,title,needs_decision,reason,disposition,latest_decision_id,decision_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,0,'',?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,kind=excluded.kind,title=excluded.title,needs_decision=0,reason_code=NULL,reason='',disposition=excluded.disposition,latest_decision_id=excluded.latest_decision_id,decision_revision=1,updated_at=excluded.updated_at`,card.id,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,storedGroup?.group_key ?? candidate.id,card.revision+1,grouped?'action':'record',grouped?card.title:candidate.statement,hasRemaining?'active':'processed',ctx.decisionId,ctx.timestamp,ctx.timestamp),
    statement(ctx,`INSERT INTO workflow_decisions (id,workspace_id,project_id,event_id,card_id,actor_id,operation,idempotency_key,context_version,created_at) VALUES (?,?,?,?,?,?,'resolve_conflict',?,?,?)`,ctx.decisionId,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,card.id,ctx.scope.actorId,key,ctx.contextVersion,ctx.timestamp),
    statement(ctx,`INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,winning_claim_version_id,user_id,created_at) VALUES (?,?,'resolve',?,?,?,?)`,relationVerdictId,original.id,original.status,choice.mode==='coexist'?null:choice.mode==='keep_existing'?existing.current_version_id:candidate.current_version_id,ctx.scope.actorId,ctx.timestamp),
    statement(ctx,`UPDATE claim_relations SET status=?,contradiction_status=?,resolved_at=?,resolved_by_verdict_id=?,reason=? WHERE id=? AND workspace_id=?`,updated.status,updated.contradiction_status,updated.resolved_at,updated.resolved_by_verdict_id,updated.reason,original.id,ctx.scope.workspaceId),
  ];
  // Choosing a replacement for an accepted answer updates its exact question
  // links in this same decision. Completion records are never transferred.
  const linkedQuestions=new Set(ledger.relations.filter(r=>r.type==='resolves' && r.status==='active' && r.source_claim_version_id===candidate.current_version_id).map(r=>r.target_claim_version_id));
  if(choice.mode!=='keep_existing' && !actionConflict) for(const r of ledger.relations.filter(r=>r.type==='resolves' && r.status==='active' && r.source_claim_version_id===existing.current_version_id)) {
    const q=ledger.claims.find(c=>c.current_version_id===r.target_claim_version_id && c.type==='open_question' && c.review_status!=='rejected' && !['withdrawn','superseded'].includes(c.lifecycle_status));
    if(!q) continue;
    if(choice.mode==='use_candidate') {
      beforeRelations.push(r);afterRelations.push({...r,status:'inactive'});
      statements.push(statement(ctx,"UPDATE claim_relations SET status='inactive' WHERE id=? AND workspace_id=?",r.id,ctx.scope.workspaceId));
      statements.push(statement(ctx,"INSERT INTO relation_verdicts(id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'reject',?,?,?)",mutationId('rvdt'),r.id,r.status,ctx.scope.actorId,ctx.timestamp));
    }
    changes.set(q.id,{claim:q,after:{...decisionState(q),workflowRevision:q.workflow_revision+1}});
    if(linkedQuestions.has(q.current_version_id)) continue;
    linkedQuestions.add(q.current_version_id);
    const next={...r,id:mutationId('rel'),source_claim_version_id:candidate.current_version_id,source_claim_id:candidate.id,reason:JSON.stringify({operation:choice.mode==='coexist'?'coexist':'conflict_answer_replacement',decisionId:ctx.decisionId,...(choice.applicability?{applicability:choice.applicability}:{})})};
    beforeRelations.push(null);afterRelations.push(next);
    statements.push(statement(ctx,`INSERT INTO claim_relations (id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status,reason,created_at) VALUES (?,?,?,'resolves',?,?,?,'active',?,?)`,next.id,ctx.scope.workspaceId,ctx.projectId,candidate.current_version_id,q.current_version_id,ctx.contextVersion,next.reason,ctx.timestamp));
    statements.push(statement(ctx,"INSERT INTO relation_verdicts(id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'confirm','proposed',?,?)",mutationId('rvdt'),next.id,ctx.scope.actorId,ctx.timestamp));
  }
  for(const {claim,after} of changes.values()) {
    const memberId=mutationId('wdm'),verdictId=mutationId('vdt');
    const priorMeta=ledger.actions.find(a=>a.claim_id===claim.id) ?? null;
    const preExistingRelations=ledger.relations.filter(r=>['active','proposed'].includes(r.status) && (r.source_claim_version_id===claim.current_version_id || r.target_claim_version_id===claim.current_version_id));
    const before={...decisionState(claim),preExistingRelations,...(actionConflict?{actionMetadata:priorMeta}:{}),...(claim.id===candidate.id?{cardState:card,relationStates:beforeRelations}:{})};
    const afterState={...after,preExistingRelations,...(actionConflict?{actionMetadata:claim.id===candidate.id && basisPlan?{...priorMeta,claim_id:claim.id,basis_version_refs_json:JSON.stringify(basisPlan.basis),basis_state:'current'}:priorMeta}:{}),...(claim.id===candidate.id?{relationStates:afterRelations}:{})};
    const verdict=after.reviewStatus==='rejected'?'reject':after.lifecycleStatus==='superseded'?'withdraw':'confirm';
    statements.push(statement(ctx,'INSERT INTO verdicts (id,workspace_id,project_id,claim_id,action,base_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',verdictId,ctx.scope.workspaceId,ctx.projectId,claim.id,verdict,claim.current_version_id,ctx.scope.actorId,ctx.decisionId,memberId,ctx.timestamp));
    statements.push(statement(ctx,`UPDATE claims SET review_status=?,lifecycle_status=?,workflow_revision=?,updated_at=? WHERE id=? AND workspace_id=?`,after.reviewStatus,after.lifecycleStatus,after.workflowRevision,ctx.timestamp,claim.id,ctx.scope.workspaceId));
    statements.push(statement(ctx,`INSERT INTO decision_members (id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,memberId,ctx.scope.workspaceId,ctx.decisionId,claim.id,verdictId,claim.current_version_id,claim.current_version_id,JSON.stringify(before),JSON.stringify(afterState),ctx.timestamp));
  }
  if(basisPlan) statements.push(...basisPlan.statements);
  if(!grouped) {
  statements.push(statement(ctx,'DELETE FROM card_members WHERE card_id=? AND workspace_id=?',card.id,ctx.scope.workspaceId));
  statements.push(statement(ctx,`INSERT INTO card_members (id,workspace_id,card_id,claim_id,claim_version_id,role,created_at) VALUES (?,?,?,?,?,'primary',?)`,mutationId('wcm'),ctx.scope.workspaceId,card.id,candidate.id,candidate.current_version_id,ctx.timestamp));
  }
  statements.push(statement(ctx,'DELETE FROM review_deferrals WHERE card_id=? AND workspace_id=?',card.id,ctx.scope.workspaceId));
  const guards:MutationPlan['guards']=[...changes.values()].flatMap(({claim})=>[claimGuard(claim,ctx.scope),relationGuard(ledger,claim,ctx)]);
  if(grouped) {
    guards.push({sql:'EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND workspace_id=? AND group_key=? AND kind=?)',values:[card.id,ctx.scope.workspaceId,storedGroup!.group_key!,storedGroup!.kind]},
      {sql:'(SELECT COUNT(*) FROM card_members WHERE card_id=? AND workspace_id=?)=?',values:[card.id,ctx.scope.workspaceId,card.memberRefs.length]});
    for(const ref of card.memberRefs)guards.push(claimGuard(ledger.claims.find(c=>c.id===ref.claimId)!,ctx.scope),relationGuard(ledger,ledger.claims.find(c=>c.id===ref.claimId)!,ctx),
      {sql:'EXISTS (SELECT 1 FROM card_members WHERE card_id=? AND workspace_id=? AND claim_id=? AND claim_version_id=?)',values:[card.id,ctx.scope.workspaceId,ref.claimId,ref.claimVersionId]});
  }
  if(actionConflict) for(const {claim} of changes.values()) guards.push(actionMetadataGuard(claim.id,ledger.actions.find(a=>a.claim_id===claim.id) ?? null,ctx));
  if(basisPlan) guards.push(...basisPlan.guards);
  for(const r of completions) guards.push(claimGuard(ledger.claims.find(c=>c.current_version_id===r.source_claim_version_id)!,ctx.scope),{sql:"EXISTS (SELECT 1 FROM claim_relations WHERE id=? AND workspace_id=? AND source_claim_version_id=? AND target_claim_version_id=? AND status='active')",values:[r.id,ctx.scope.workspaceId,r.source_claim_version_id,r.target_claim_version_id]});
  guards.push({sql:'NOT EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND (workspace_id<>? OR event_id<>? OR revision<>?))',values:[card.id,ctx.scope.workspaceId,ctx.eventId,card.revision]});
  if(choice.mode!=='keep_existing') {
    guards.push(...evidenceGuards(ledger,candidateMember.evidenceRefIds,ctx));
    for(const id of candidateMember.evidenceRefIds) guards.push({sql:"EXISTS (SELECT 1 FROM evidence_refs WHERE id=? AND (evidence_role='contextual' OR semantic_support_verdict='fully_supports'))",values:[id]});
  }
  return {statements,guards,changedRefs:[...[...changes.values()].map(({claim,after})=>({entityType:'claim' as const,id:claim.id,revision:after.workflowRevision})),{entityType:'card',id:card.id,revision:card.revision+1},{entityType:'decision',id:ctx.decisionId,revision:1}],invalidatedVersionIds:[candidate.current_version_id,existing.current_version_id],basisInvalidatedVersionIds:choice.mode==='use_candidate'?[existing.current_version_id]:[],kind:'resolve_conflict'};
}
