import { decideMention } from './mention-decision.ts';
import { addSourceHighlight } from './source-highlight.ts';
import { revertDecision } from './revert-decision.ts';
import { parseWorkflowRequest, type MutationReceipt } from '../../shared/workflow-v2.ts';
import { transitionAction } from './action-service.ts';
import { answerQuestion, correctOutcome, saveOutcome } from './outcome-service.ts';
import { decideRecord } from './record-decision.ts';
import { WorkflowFault, type WorkflowScope, findWorkflowEvent } from './snapshot-store.ts';

type ResourceKind = 'card' | 'action' | 'question' | 'outcome' | 'decision' | 'mention';
type Location = { projectId: string; eventId: string };

/** Resolve ownership from persisted resources, never from caller-supplied IDs. */
async function locateResource(
  db: D1Database, scope: WorkflowScope, kind: ResourceKind, id: string,
): Promise<Location> {
  const sources = {
    mention: {sql: 'SELECT event_id,project_id,workspace_id FROM claim_occurrence_candidates WHERE id=?', values:[id]},
    card: {
      sql: `SELECT event_id,project_id,workspace_id FROM workflow_cards WHERE id=?
        UNION ALL SELECT event_id,project_id,workspace_id FROM claims
        WHERE id=? AND NOT EXISTS (SELECT 1 FROM workflow_cards WHERE id=?)`,
      values: [id, id.startsWith('wfc_') ? id.slice(4) : '', id],
    },
    action: { sql: "SELECT event_id,project_id,workspace_id FROM claims WHERE id=? AND type='next_action'", values: [id] },
    question: { sql: "SELECT event_id,project_id,workspace_id FROM claims WHERE id=? AND type='open_question'", values: [id] },
    decision: {sql:'SELECT event_id,project_id,workspace_id FROM workflow_decisions WHERE id=?',values:[id]},
    outcome: { sql: 'SELECT event_id,project_id,workspace_id FROM workflow_outcomes WHERE id=?', values: [id] },
  };
  const source = sources[kind];
  const row = await db.prepare(`SELECT x.project_id,x.event_id FROM (${source.sql}) x
    JOIN events e ON e.id=x.event_id AND e.project_id=x.project_id AND e.workspace_id=x.workspace_id
    JOIN projects p ON p.id=e.project_id AND p.workspace_id=e.workspace_id
    WHERE x.workspace_id=? AND e.material_status<>'archived' AND p.deleted_at IS NULL
    AND (?=1 OR EXISTS (SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id=x.workspace_id AND wm.actor_id=? AND wm.revoked_at IS NULL))`)
    .bind(...source.values, scope.workspaceId, scope.access === 'demo' ? 1 : 0, scope.actorId)
    .first<{ project_id: string; event_id: string }>();
  if (!row) throw new WorkflowFault(404, 'not_found', '内容不存在或当前账号无法访问');
  return { projectId: row.project_id, eventId: row.event_id };
}

export async function dispatchWorkflowCommand(
  db: D1Database, scope: WorkflowScope, segments: string[], body: unknown, key: string,
): Promise<MutationReceipt> {
  if (segments.length !== 3) throw new WorkflowFault(404, 'not_found', '没有找到这个工作流入口');
  const [collection, id, command] = segments;
  const endpoint = `${collection}/${command}`;
  if(endpoint==='events/highlights') {
    const projectId=await findWorkflowEvent(db,scope,id);
    return addSourceHighlight(db,scope,{projectId,eventId:id,key,request:parseWorkflowRequest('SourceHighlightRequest',body)});
  }
  const kinds: Record<string, ResourceKind> = {
    'review-cards/decisions': 'card',
    'decisions/revert': 'decision',
    'reaffirmed-mentions/decisions': 'mention',
    'actions/transitions': 'action',
    'actions/outcomes': 'action',
    'questions/answers': 'question',
    'outcomes/corrections': 'outcome',
  };
  const kind = kinds[endpoint];
  if (!kind) throw new WorkflowFault(404, 'not_found', '没有找到这个工作流入口');
  const location = await locateResource(db, scope, kind, id);
  const input = { ...location, key };
  switch (endpoint) {
    case 'reaffirmed-mentions/decisions':
      return decideMention(db,scope,{...input,mentionId:id,request:parseWorkflowRequest('MentionDecisionRequest',body)});
    case 'decisions/revert':
      return revertDecision(db,scope,{...input,decisionId:id,request:parseWorkflowRequest('RevertDecisionRequest',body)});
    case 'review-cards/decisions':
      return decideRecord(db, scope, { ...input, cardId: id, request: parseWorkflowRequest('DecisionRequest', body) });
    case 'actions/transitions':
      return transitionAction(db, scope, { ...input, actionId: id, request: parseWorkflowRequest('ActionTransitionRequest', body) });
    case 'actions/outcomes':
      return saveOutcome(db, scope, { ...input, actionId: id, request: parseWorkflowRequest('OutcomeRequest', body) });
    case 'questions/answers':
      return answerQuestion(db, scope, { ...input, questionId: id, request: parseWorkflowRequest('QuestionAnswerRequest', body) });
    case 'outcomes/corrections':
      return correctOutcome(db, scope, { ...input, outcomeId: id, request: parseWorkflowRequest('OutcomeCorrectionRequest', body) });
    default:
      throw new WorkflowFault(404, 'not_found', '没有找到这个工作流入口');
  }
}
