import { readJson, type LedgerClaim, type LedgerRelation, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import type { DecisionMember, Question } from '../../shared/workflow-v2.ts';
import { relationGuard } from './action-basis.ts';
import { decisionState } from './decision-state.ts';
import { claimGuard, evidenceGuards, statement, resolveRelation, type WriteContext } from './ledger-write.ts';
import { WorkflowFault } from './snapshot-store.ts';
import { mutationId, type MutationPlan } from './transaction.ts';

/** Editing a question carries only explicitly retained answers to its new version.
 * An answer shared with another question remains active for that question. */
export type QuestionChangeBatch={removedRelationIds:Set<string>;keptAnswerVersions:Set<string>;retiredAnswerIds:Set<string>};
export function questionChangePlan(ctx:WriteContext,ledger:ProjectionLedger,current:LedgerClaim,question:Question,member:DecisionMember,nextVersion:string,batch:QuestionChangeBatch) {
  const choices=member.questionChange?.answerChoices ?? [];
  const keys=(refs:Question['answerRefs'])=>JSON.stringify(refs.map(r=>[r.claimId,r.claimVersionId]).sort((a,b)=>a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));
  if(keys(choices)!==keys(question.answerRefs)) throw new WorkflowFault(409,'dependency_conflict','问题已有答案，请逐条核对修改后是否仍然适用',{questionId:current.id,currentAnswerRefs:question.answerRefs});
  const incoming=ledger.relations.filter(r=>r.type==='resolves' && ['active','proposed'].includes(r.status) && r.target_claim_version_id===current.current_version_id);
  const kept=new Set(choices.filter(c=>c.mode==='keep').map(c=>c.claimVersionId));
  const beforeRelations:Array<LedgerRelation|null>=[...incoming];
  const afterRelations:Array<LedgerRelation|null>=incoming.map(r=>({...r,status:'inactive'}));
  const statements:D1PreparedStatement[]=[],guards:MutationPlan['guards']=[];
  const changedRefs:MutationPlan['changedRefs']=[],invalidatedVersionIds:string[]=[];
  for(const r of incoming) {
    statements.push(statement(ctx,"INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'reject',?,?,?)",mutationId('rvdt'),r.id,r.status,ctx.scope.actorId,ctx.timestamp));
    statements.push(statement(ctx,"UPDATE claim_relations SET status='inactive' WHERE id=? AND workspace_id=?",r.id,ctx.scope.workspaceId));
    if(r.status==='active' && kept.has(r.source_claim_version_id)) {
      const raw=readJson<unknown>(r.reason,null);
      const prior=raw && typeof raw==='object' && !Array.isArray(raw)?raw as Record<string,unknown>:{};
      const reason=JSON.stringify({...prior,operation:prior.operation ?? 'question_edit',questionEdit:{decisionId:ctx.decisionId,predecessorRelationId:r.id}});
      const replacement=resolveRelation(ctx,r.source_claim_version_id,nextVersion,reason);
      statements.push(...replacement.statements);beforeRelations.push(null);
      afterRelations.push({id:replacement.id,source_claim_version_id:r.source_claim_version_id,target_claim_version_id:nextVersion,type:'resolves',status:'active',contradiction_status:null,reason});
    }
  }
  for(const answerRef of question.answerRefs) {
    const answer=ledger.claims.find(c=>c.id===answerRef.claimId && c.current_version_id===answerRef.claimVersionId)!;
    guards.push(claimGuard(answer,ctx.scope),relationGuard(ledger,answer,ctx),...evidenceGuards(ledger,ledger.evidence.filter(e=>e.claim_version_id===answer.current_version_id && e.evidence_role!=='contextual' && e.availability==='ready').map(e=>e.id),ctx));
    if(batch.keptAnswerVersions.has(answer.current_version_id) || batch.retiredAnswerIds.has(answer.id) || ledger.relations.some(r=>r.source_claim_version_id===answer.current_version_id && r.type==='resolves' && r.status==='active' && !batch.removedRelationIds.has(r.id))) continue;
    batch.retiredAnswerIds.add(answer.id);
    const before=decisionState(answer),after={...before,lifecycleStatus:'withdrawn',workflowRevision:answer.workflow_revision+1};
    const verdictId=mutationId('vdt'),memberId=mutationId('wdm');
    statements.push(statement(ctx,"UPDATE claims SET lifecycle_status='withdrawn',workflow_revision=workflow_revision+1,updated_at=? WHERE id=? AND workspace_id=?",ctx.timestamp,answer.id,ctx.scope.workspaceId));
    statements.push(statement(ctx,"INSERT INTO verdicts(id,workspace_id,project_id,claim_id,action,base_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,'withdraw',?,?,?,?,?)",verdictId,ctx.scope.workspaceId,ctx.projectId,answer.id,answer.current_version_id,ctx.scope.actorId,ctx.decisionId,memberId,ctx.timestamp));
    statements.push(statement(ctx,'INSERT INTO decision_members(id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',memberId,ctx.scope.workspaceId,ctx.decisionId,answer.id,verdictId,answer.current_version_id,answer.current_version_id,JSON.stringify(before),JSON.stringify(after),ctx.timestamp));
    changedRefs.push({entityType:'claim',id:answer.id,revision:after.workflowRevision});invalidatedVersionIds.push(answer.current_version_id);
  }
  return {statements,guards,changedRefs,invalidatedVersionIds,beforeRelations,afterRelations,lifecycleStatus:kept.size?'resolved':'active',resolvedAt:kept.size?ctx.timestamp:null};
}

export { outcomeRelationIds } from '../../domain/workflow-relations.ts';
