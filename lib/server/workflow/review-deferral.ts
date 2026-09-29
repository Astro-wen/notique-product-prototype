import type { ProjectionLedger } from '../../domain/workflow-projection.ts';
import type { DecisionRequest, ReviewCard } from '../../shared/workflow-v2.ts';
import { WorkflowFault } from './snapshot-store.ts';
import { claimGuard, statement, type WriteContext } from './ledger-write.ts';
import { mutationId, type MutationPlan } from './transaction.ts';

export function reviewDeferralPlan(ctx:WriteContext,ledger:ProjectionLedger,card:ReviewCard,request:DecisionRequest,key:string):MutationPlan {
  ctx = {...ctx, contextVersion:request.expectedContextVersion};
  if(card.disposition==='processed') throw new WorkflowFault(409,'version_conflict','这条事项已经处理');
  const refs=request.members.map(m=>`${m.claimId}:${m.claimVersionId}`).sort();
  if(JSON.stringify(refs)!==JSON.stringify(card.memberRefs.map(m=>`${m.claimId}:${m.claimVersionId}`).sort())) throw new WorkflowFault(409,'version_conflict','事项成员已有变化，请重新读取');
  const statements=[statement(ctx,`INSERT INTO workflow_cards (id,workspace_id,project_id,event_id,group_key,revision,kind,title,needs_decision,reason_code,reason,disposition,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`,
    card.id,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,card.id,card.revision+1,card.kind,card.title,Number(card.needsDecision),card.reasonCode,card.reason,ctx.timestamp,ctx.timestamp)];
  for(const ref of card.memberRefs) statements.push(statement(ctx,`INSERT INTO card_members (id,workspace_id,card_id,claim_id,claim_version_id,role,created_at)
    SELECT ?,?,?,?,?, 'primary',? WHERE NOT EXISTS (SELECT 1 FROM card_members WHERE card_id=? AND workspace_id=? AND claim_id=?)`,mutationId('wcm'),ctx.scope.workspaceId,card.id,ref.claimId,ref.claimVersionId,ctx.timestamp,card.id,ctx.scope.workspaceId,ref.claimId));
  statements.push(statement(ctx,`INSERT INTO workflow_decisions (id,workspace_id,project_id,event_id,card_id,actor_id,operation,idempotency_key,context_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,ctx.decisionId,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,card.id,ctx.scope.actorId,request.operation,key,ctx.contextVersion,ctx.timestamp));
  if(request.operation==='defer') statements.push(statement(ctx,`INSERT INTO review_deferrals (id,workspace_id,card_id,actor_id,until_at,created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(card_id,actor_id) DO UPDATE SET until_at=excluded.until_at,created_at=excluded.created_at`,mutationId('def'),ctx.scope.workspaceId,card.id,ctx.scope.actorId,request.deferUntil??null,ctx.timestamp));
  else statements.push(statement(ctx,'DELETE FROM review_deferrals WHERE card_id=? AND workspace_id=? AND actor_id=?',card.id,ctx.scope.workspaceId,ctx.scope.actorId));
  return {statements,guards:[...card.memberRefs.map(ref=>claimGuard(ledger.claims.find(c=>c.id===ref.claimId)!,ctx.scope)),{sql:'NOT EXISTS (SELECT 1 FROM workflow_cards WHERE id=? AND (workspace_id<>? OR event_id<>? OR revision<>?))',values:[card.id,ctx.scope.workspaceId,ctx.eventId,card.revision]}],changedRefs:[{entityType:'card',id:card.id,revision:card.revision+1}],invalidatedVersionIds:[],basisInvalidatedVersionIds:[],refreshNarrative:false,advanceContext:false,kind:request.operation};
}
