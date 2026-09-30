import { actionBasisRefs, projectWorkspace, type LedgerClaim, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type ActionTransitionRequest, type MutationReceipt } from '../../shared/workflow-v2.ts';
import { loadWorkflowLedger, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { commitWorkflowMutation, type MutationPlan } from './transaction.ts';
import { claimGuard, decisionEnvelope, humanClaim, resolveRelation, statement, type WriteContext } from './ledger-write.ts';
import { normalizedActionAttributes } from '../../domain/action-attributes.ts';
import { actionMetadataGuard } from './action-basis.ts';

export function actionTransitionPlan(ctx:WriteContext,ledger:ProjectionLedger,action:LedgerClaim,operation:ActionTransitionRequest['operation']):MutationPlan {
  const metadata=ledger.actions.find(a=>a.claim_id===action.id) ?? null;
  const attributes=metadata?{ownerHint:metadata.owner_hint,dueAt:metadata.due_at}:normalizedActionAttributes(action.normalized_value_json);
  const state=projectWorkspace(ledger,action.event_id,ctx.timestamp,'').actions.find(a=>a.id===action.id);
  if(!state) throw new WorkflowFault(409,'dependency_conflict','请先将这条建议加入跟进');
  const allowed=operation==='complete'?state.executionState==='open':operation==='reopen'?state.executionState!=='open':state.executionState!=='cancelled';
  if(!allowed) throw new WorkflowFault(409,'version_conflict','行动状态已变化，请重新读取');
  const statements:D1PreparedStatement[]=[];
  const changedRefs:MutationReceipt['changedRefs']=[{entityType:'action',id:action.id,revision:action.workflow_revision+1}];
  if(operation==='complete') {
    const completion=humanClaim(ctx,action,`已完成：${action.statement}`,'completion');
    const relation=resolveRelation(ctx,completion.versionId,action.current_version_id,'用户标记行动完成');
    statements.push(...completion.statements,...relation.statements);
    changedRefs.push({entityType:'claim',id:completion.claimId,revision:1});
  } else {
    // Completion audit records stay immutable. Reopening only withdraws their
    // support for this execution state, never the answers to related questions.
    statements.push(statement(ctx,`INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at)
      SELECT 'rvdt_' || lower(hex(randomblob(16))),id,'reject','active',?,? FROM claim_relations
      WHERE workspace_id=? AND project_id=? AND target_claim_version_id IN (SELECT id FROM claim_versions WHERE claim_id=?) AND type='resolves' AND status='active'`,ctx.scope.actorId,ctx.timestamp,ctx.scope.workspaceId,ctx.projectId,action.id));
    statements.push(statement(ctx,`UPDATE claim_relations SET status='inactive' WHERE workspace_id=? AND project_id=? AND target_claim_version_id IN (SELECT id FROM claim_versions WHERE claim_id=?) AND type='resolves' AND status='active'`,ctx.scope.workspaceId,ctx.projectId,action.id));
  }
  statements.push(statement(ctx,`INSERT INTO action_metadata (claim_id,workspace_id,project_id,event_id,basis_version_refs_json,cancelled_at,owner_hint,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(claim_id) DO UPDATE SET cancelled_at=excluded.cancelled_at,updated_at=excluded.updated_at`,action.id,ctx.scope.workspaceId,ctx.projectId,action.event_id,JSON.stringify(actionBasisRefs(ledger,action)),operation==='cancel'?ctx.timestamp:null,attributes.ownerHint,attributes.dueAt,ctx.timestamp,ctx.timestamp));
  statements.push(statement(ctx,`UPDATE claims SET workflow_revision=workflow_revision+1,lifecycle_status=?,resolved_at=?,updated_at=? WHERE id=? AND workspace_id=?`,operation==='complete'?'resolved':'active',operation==='complete'?ctx.timestamp:null,ctx.timestamp,action.id,ctx.scope.workspaceId));
  const guards:MutationPlan['guards']=[claimGuard(action,ctx.scope),actionMetadataGuard(action.id,metadata,ctx)];
  if(!metadata)guards.push({sql:'EXISTS (SELECT 1 FROM claim_versions WHERE id=? AND claim_id=? AND normalized_value_json IS ?)',values:[action.current_version_id,action.id,action.normalized_value_json]});
  return {statements,guards,changedRefs,invalidatedVersionIds:[action.current_version_id],basisInvalidatedVersionIds:[],kind:operation};
}
export async function transitionAction(db:D1Database,scope:WorkflowScope,input:{projectId:string;eventId:string;actionId:string;key:string;request:ActionTransitionRequest}):Promise<MutationReceipt> {
  const request=parseWorkflowRequest('ActionTransitionRequest',input.request);
  return commitWorkflowMutation(db,scope,{...input,endpoint:`actions/${input.actionId}/transitions`,payload:request,expectedContextVersion:request.expectedContextVersion},async t=>{
    const ledger=await loadWorkflowLedger(db,scope,input.projectId);
    const action=ledger.claims.find(c=>c.id===input.actionId && c.event_id===input.eventId && c.type==='next_action');
    if(!action || action.workflow_revision!==request.expectedActionRevision) throw new WorkflowFault(409,'version_conflict','行动已有变化，请重新打开');
    const ctx:WriteContext={db,scope,projectId:input.projectId,eventId:input.eventId,...t,decisionId:t.mutationId};
    const plan=actionTransitionPlan(ctx,ledger,action,request.operation);
    plan.statements.unshift(decisionEnvelope(ctx,request.operation,input.key));
    return plan;
  });
}
