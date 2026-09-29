import {factAnswerTargets,claimSourceStatus,readJson,type LedgerClaim,type LedgerRelation,type ProjectionLedger} from '../../domain/workflow-projection.ts';
import type {DecisionMember} from '../../shared/workflow-v2.ts';
import {actionMetadataGuard,relationGuard} from './action-basis.ts';
import {decisionState} from './decision-state.ts';
import {claimGuard,statement,type WriteContext} from './ledger-write.ts';
import {WorkflowFault} from './snapshot-store.ts';
import {mutationId,type MutationPlan} from './transaction.ts';

export type FactChangeBatch={nextVersions:Map<string,string>;members:DecisionMember[];relations:Set<string>;questions:Set<string>};
const available=(c:LedgerClaim)=>c.review_status!=='rejected' && !['withdrawn','superseded'].includes(c.lifecycle_status);
const exact=(refs:Array<{claimId:string;claimVersionId:string}>)=>JSON.stringify(refs.map(r=>[r.claimId,r.claimVersionId]).sort((a,b)=>a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));

/** A correction changes wording on the same stable information. Approved
 * replacement/coexistence choices stay explicit, while answers are rechecked. */
export function factChangePlan(ctx:WriteContext,ledger:ProjectionLedger,current:LedgerClaim,member:DecisionMember,batch:FactChangeBatch) {
  const targets=factAnswerTargets(ledger,current),choices=member.factChange?.questionChoices ?? [];
  if(exact(choices)!==exact(targets.map(t=>t.questionRef)))throw new WorkflowFault(409,'dependency_conflict','这条信息已用于回答问题，请核对修改后是否仍可回答',{currentQuestionRefs:targets.map(t=>t.questionRef)});
  const related=ledger.relations.filter(r=>['active','proposed'].includes(r.status) && (r.source_claim_version_id===current.current_version_id || r.target_claim_version_id===current.current_version_id));
  const managed=related.filter(r=>!batch.relations.has(r.id) && (r.type!=='informed_by' || ledger.claims.some(c=>c.current_version_id===r.source_claim_version_id && c.type==='next_action' && c.review_status==='pending' && available(c) && !ledger.actions.some(a=>a.claim_id===c.id))));
  const statements:D1PreparedStatement[]=[],guards:MutationPlan['guards']=[],changedRefs:MutationPlan['changedRefs']=[],invalidatedVersionIds:string[]=[];
  const beforeRelations:Array<LedgerRelation|null>=[],afterRelations:Array<LedgerRelation|null>=[];
  const touched=new Map<string,LedgerClaim>();
  for(const r of managed) {
    const targetClaim=ledger.claims.find(q=>q.id===r.target_claim_id || q.current_version_id===r.target_claim_version_id);
    const question=targetClaim?.type==='open_question' && targetClaim.current_version_id===r.target_claim_version_id && available(targetClaim)?targetClaim:undefined;
    if(r.type==='resolves' && (r.source_claim_version_id!==current.current_version_id || targetClaim?.type!=='open_question'))throw new WorkflowFault(409,'dependency_conflict','请通过这次结果对应的问题修正关联内容',{relationIds:[r.id]});
    if(question && batch.nextVersions.has(question.current_version_id))throw new WorkflowFault(409,'dependency_conflict','请先保存问题修改，再核对这条答案',{affectedItems:[{claimId:question.id,text:question.statement}]});
    batch.relations.add(r.id);
    beforeRelations.push(r);afterRelations.push({...r,status:'inactive'});
    statements.push(statement(ctx,"INSERT INTO relation_verdicts(id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'reject',?,?,?)",mutationId('rvdt'),r.id,r.status,ctx.scope.actorId,ctx.timestamp),statement(ctx,"UPDATE claim_relations SET status='inactive' WHERE id=? AND workspace_id=?",r.id,ctx.scope.workspaceId));
    const counterpart=ledger.claims.find(c=>c.current_version_id===(r.source_claim_version_id===current.current_version_id?r.target_claim_version_id:r.source_claim_version_id));
    if(counterpart)guards.push(claimGuard(counterpart,ctx.scope),relationGuard(ledger,counterpart,ctx));
    if(r.type==='informed_by' && counterpart)guards.push(actionMetadataGuard(counterpart.id,null,ctx));
    if(r.type==='resolves' && !counterpart && targetClaim)guards.push(claimGuard(targetClaim,ctx.scope),relationGuard(ledger,targetClaim,ctx));
    if(question)touched.set(question.id,question);
    const retain=r.type!=='resolves' || question !== undefined && r.status==='active' && choices.some(c=>c.claimId===question.id && c.mode==='keep');
    if(!retain)continue;
    const raw=readJson<unknown>(r.reason,null),prior=raw && typeof raw==='object' && !Array.isArray(raw)?raw as Record<string,unknown>:{};
    const reason=JSON.stringify({...prior,factEdit:{decisionId:ctx.decisionId,predecessorRelationId:r.id}});
    const id=mutationId('rel'),source=batch.nextVersions.get(r.source_claim_version_id) ?? r.source_claim_version_id,target=batch.nextVersions.get(r.target_claim_version_id) ?? r.target_claim_version_id;
    const after={...r,id,source_claim_version_id:source,target_claim_version_id:target,reason};
    beforeRelations.push(null);afterRelations.push(after);
    statements.push(statement(ctx,`INSERT INTO claim_relations(id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status,contradiction_status,reason,resolved_at,resolved_by_verdict_id,resolved_by_relation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id,ctx.scope.workspaceId,ctx.projectId,r.type,source,target,ctx.contextVersion,r.status,r.contradiction_status,reason,r.resolved_at??null,r.resolved_by_verdict_id??null,r.resolved_by_relation_id??null,ctx.timestamp),statement(ctx,"INSERT INTO relation_verdicts(id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'confirm','proposed',?,?)",mutationId('rvdt'),id,ctx.scope.actorId,ctx.timestamp));
  }
  for(const q of touched.values()) {
    if(batch.questions.has(q.id))continue;
    batch.questions.add(q.id);
    guards.push(claimGuard(q,ctx.scope),relationGuard(ledger,q,ctx));
    const remaining=ledger.relations.some(r=>{
      if(r.type!=='resolves' || r.status!=='active' || r.target_claim_version_id!==q.current_version_id)return false;
      const editing=batch.members.find(m=>m.operation==='edit' && m.claimVersionId===r.source_claim_version_id);
      if(editing)return editing.factChange?.questionChoices.some(c=>c.claimId===q.id && c.claimVersionId===q.current_version_id && c.mode==='keep') ?? false;
      const a=ledger.claims.find(c=>c.current_version_id===r.source_claim_version_id);
      return Boolean(a && a.review_status==='verified' && available(a) && claimSourceStatus(a,ledger.evidence)==='ready');
    });
    const before={...decisionState(q),preExistingRelations:ledger.relations.filter(r=>['active','proposed'].includes(r.status) && (r.source_claim_version_id===q.current_version_id || r.target_claim_version_id===q.current_version_id))},after={...before,lifecycleStatus:remaining?'resolved':'active',resolvedAt:remaining?ctx.timestamp:null,workflowRevision:q.workflow_revision+1};
    const verdictId=mutationId('vdt'),memberId=mutationId('wdm');
    statements.push(statement(ctx,'UPDATE claims SET lifecycle_status=?,resolved_at=?,workflow_revision=?,updated_at=? WHERE id=? AND workspace_id=?',after.lifecycleStatus,after.resolvedAt,after.workflowRevision,ctx.timestamp,q.id,ctx.scope.workspaceId),statement(ctx,"INSERT INTO verdicts(id,workspace_id,project_id,claim_id,action,base_version_id,user_id,workflow_decision_id,workflow_member_id,created_at) VALUES (?,?,?,?,'confirm',?,?,?,?,?)",verdictId,ctx.scope.workspaceId,ctx.projectId,q.id,q.current_version_id,ctx.scope.actorId,ctx.decisionId,memberId,ctx.timestamp),statement(ctx,'INSERT INTO decision_members(id,workspace_id,decision_id,claim_id,verdict_id,before_version_id,after_version_id,before_state_json,after_state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',memberId,ctx.scope.workspaceId,ctx.decisionId,q.id,verdictId,q.current_version_id,q.current_version_id,JSON.stringify(before),JSON.stringify(after),ctx.timestamp));
    changedRefs.push({entityType:'question',id:q.id,revision:after.workflowRevision});invalidatedVersionIds.push(q.current_version_id);
  }
  return {statements,guards,changedRefs,invalidatedVersionIds,beforeRelations,afterRelations};
}
