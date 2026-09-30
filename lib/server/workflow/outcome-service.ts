import { outcomeRelationIds } from './question-change.ts';
import { projectWorkspace, readJson, type LedgerClaim, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type AnswerDecision, type OutcomeContent, type OutcomeRequest, type QuestionAnswerRequest, type OutcomeCorrectionRequest, type MutationReceipt, type VersionRef } from '../../shared/workflow-v2.ts';
import { loadWorkflowLedger, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { commitWorkflowMutation, mutationId, type MutationPlan } from './transaction.ts';
import { claimGuard, decisionEnvelope, evidenceGuards, humanClaim, outcomeResultRelation, resolveRelation, statement, type WriteContext } from './ledger-write.ts';
import { actionTransitionPlan } from './action-service.ts';

type Located = {projectId:string;eventId:string;key:string};
type CurrentOutcome = {id:string;subject_claim_id:string;subject_type:'action'|'question';revision:number;current_version_id:string;text:string;evidence_refs_json:string;answer_claim_version_ids_json:string;relation_ids_json:string;withdrawn_at:string|null};
const validClaim = (c:LedgerClaim)=>!['withdrawn','superseded'].includes(c.lifecycle_status) && c.review_status!=='rejected';
const exactRefs = (refs:VersionRef[])=>JSON.stringify(refs.map(r=>[r.claimId,r.claimVersionId]).sort((a,b)=>a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));

function questionState(ledger:ProjectionLedger,question:LedgerClaim,timestamp:string) {
  const q=projectWorkspace(ledger,question.event_id,timestamp,'').questions.find(q=>q.id===question.id);
  if(!q) throw new WorkflowFault(409,'dependency_conflict','问题已变化，请重新读取');
  return q;
}
function answerChoice(current:VersionRef[],choice:AnswerDecision|undefined,questionId:string) {
  if(current.length===0) {
    if(choice) throw new WorkflowFault(409,'dependency_conflict','原答案已变化，请重新选择',{questionId,currentAnswerRefs:current});
    return;
  }
  if(!choice || exactRefs(current)!==exactRefs(choice.priorAnswerRefs)) throw new WorkflowFault(409,'dependency_conflict','这个问题已有答案，请选择替代或并存',{questionId,currentAnswerRefs:current});
}
function deactivateRelations(ctx:WriteContext,ids:string[]):D1PreparedStatement[] {
  if(!ids.length) return [];
  const slots='SELECT value FROM json_each(?)';
  const encoded=JSON.stringify(ids);
  return [
    statement(ctx,`INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at) SELECT 'rvdt_' || lower(hex(randomblob(16))),id,'reject','active',?,? FROM claim_relations WHERE workspace_id=? AND project_id=? AND id IN (${slots}) AND status='active'`,ctx.scope.actorId,ctx.timestamp,ctx.scope.workspaceId,ctx.projectId,encoded),
    statement(ctx,`UPDATE claim_relations SET status='inactive' WHERE workspace_id=? AND project_id=? AND id IN (${slots}) AND status='active'`,ctx.scope.workspaceId,ctx.projectId,encoded),
  ];
}
function retireUnusedAnswers(ctx:WriteContext,versionIds:string[],status:'withdrawn'|'superseded'):D1PreparedStatement[] {
  return [...new Set(versionIds)].map(version=>statement(ctx,`UPDATE claims SET lifecycle_status=?,workflow_revision=workflow_revision+1,updated_at=? WHERE workspace_id=? AND project_id=? AND current_version_id=?
    AND NOT EXISTS (SELECT 1 FROM claim_relations r WHERE r.source_claim_version_id=claims.current_version_id AND r.type='resolves' AND r.status='active')`,status,ctx.timestamp,ctx.scope.workspaceId,ctx.projectId,version));
}
function questionRefresh(ctx:WriteContext,question:LedgerClaim):D1PreparedStatement {
  return statement(ctx,`UPDATE claims SET workflow_revision=workflow_revision+1,lifecycle_status=CASE WHEN EXISTS (
    SELECT 1 FROM claim_relations r JOIN claim_versions cv ON cv.id=r.source_claim_version_id JOIN claims a ON a.id=cv.claim_id
    WHERE r.target_claim_version_id=claims.current_version_id AND r.type='resolves' AND r.status='active'
    AND r.workspace_id=claims.workspace_id AND r.project_id=claims.project_id AND a.current_version_id=cv.id AND a.review_status='verified' AND a.lifecycle_status NOT IN ('withdrawn','superseded')
  ) THEN 'resolved' ELSE 'active' END,updated_at=? WHERE id=? AND workspace_id=?`,ctx.timestamp,question.id,ctx.scope.workspaceId);
}

function buildOutcome(ctx:WriteContext,ledger:ProjectionLedger,subject:LedgerClaim,subjectType:'action'|'question',content:OutcomeContent,old?:CurrentOutcome):MutationPlan {
  const plan:MutationPlan={statements:[],guards:[claimGuard(subject,ctx.scope),...evidenceGuards(ledger,content.evidenceRefs,ctx)],changedRefs:[],invalidatedVersionIds:[],kind:old?'replace_outcome':'save_outcome'};
  const oldRelationIds=outcomeRelationIds(ledger,readJson<string[]>(old?.relation_ids_json,[]));
  const resultRoots=new Set(ledger.outcomes.filter(o=>subjectType==='action' && o.subject_claim_id===subject.id).flatMap(o=>readJson<string[]>(o.relation_ids_json,[])));
  const previousResultRelations=ledger.relations.filter(r=>resultRoots.has(r.id) && r.type==='informed_by' && r.status==='active' && readJson<{workflowOutcomeResult?:boolean}>(r.reason,{}).workflowOutcomeResult===true);
  const oldAnswerVersions=[...new Set([...readJson<string[]>(old?.answer_claim_version_ids_json,[]),...ledger.relations.filter(r=>oldRelationIds.includes(r.id)).map(r=>r.source_claim_version_id),...previousResultRelations.map(r=>r.source_claim_version_id)])];
  const newAnswerVersions:string[]=[],newRelationIds:string[]=[],replacedVersions:string[]=[];
  const touched=new Map<string,LedgerClaim>();
  plan.statements.push(...deactivateRelations(ctx,previousResultRelations.filter(r=>!oldRelationIds.includes(r.id)).map(r=>r.id)));
  if(old) {
    plan.statements.push(...deactivateRelations(ctx,oldRelationIds));
    for(const r of ledger.relations.filter(r=>oldRelationIds.includes(r.id))) {
      const q=ledger.claims.find(c=>c.current_version_id===r.target_claim_version_id && c.type==='open_question');
      if(q) touched.set(q.id,q);
    }
  }
  const historicalCorrection=Boolean(old && subjectType==='action' && subject.type==='next_action' && subject.review_status==='verified' && subject.lifecycle_status==='superseded');
  const permitted=historicalCorrection?[...new Set(ledger.relations.filter(r=>oldRelationIds.includes(r.id)).flatMap(r=>{const q=ledger.claims.find(c=>c.type==='open_question' && (c.id===r.target_claim_id || c.current_version_id===r.target_claim_version_id));return q?[q.id]:[];}))]:subjectType==='action'?projectWorkspace(ledger,subject.event_id,ctx.timestamp,'').actions.find(a=>a.id===subject.id)?.questionRefs.map(r=>r.claimId):[subject.id];
  if(!permitted) throw new WorkflowFault(409,'dependency_conflict','请先将建议加入跟进');
  // An execution note contributes current information independently of explicit
  // question answers. The same text used as an answer is represented only once.
  if(subjectType==='action' && content.text.trim() && !content.resolveQuestions.some(q=>q.answerText.trim()===content.text.trim())) {
    const result=humanClaim(ctx,subject,content.text.trim(),'result',content.evidenceRefs);
    const relation=outcomeResultRelation(ctx,result.versionId,subject.current_version_id);
    plan.statements.push(...result.statements,...relation.statements);
    newRelationIds.push(relation.id);
    plan.changedRefs.push({entityType:'claim',id:result.claimId,revision:1});
  }
  for(const target of content.resolveQuestions) {
    if(!permitted.includes(target.questionId)) throw new WorkflowFault(422,'dependency_conflict','答案需要对应这次跟进的问题',{questionId:target.questionId});
    const q=ledger.claims.find(c=>c.id===target.questionId && c.type==='open_question' && validClaim(c));
    if(!q || q.workflow_revision!==target.revision) throw new WorkflowFault(409,'version_conflict','问题已有新变化，请核对后保存',{questionId:target.questionId});
    const snapshot=questionState(ledger,q,ctx.timestamp);
    const current=snapshot.answerRefs.filter(ref=>ledger.relations.some(r=>r.source_claim_version_id===ref.claimVersionId && r.target_claim_version_id===q.current_version_id && r.type==='resolves' && r.status==='active' && !oldRelationIds.includes(r.id)));
    const choice=content.answerDecisions?.find(d=>d.questionId===q.id);
    answerChoice(current,choice,q.id);
    if(choice?.mode==='replace') {
      const versions=new Set(current.map(r=>r.claimVersionId));
      const replaced=ledger.relations.filter(r=>r.type==='resolves' && r.status==='active' && r.target_claim_version_id===q.current_version_id && versions.has(r.source_claim_version_id));
      plan.statements.push(...deactivateRelations(ctx,replaced.map(r=>r.id)));
      replacedVersions.push(...current.map(r=>r.claimVersionId));
    }
    // A separate claim per explicit answer prevents a multi-target note from
    // accidentally claiming that one vague sentence answers every question.
    const answer=humanClaim(ctx,subject,target.answerText,'answer',content.evidenceRefs);
    const relation=resolveRelation(ctx,answer.versionId,q.current_version_id,choice?.mode==='coexist'?JSON.stringify({operation:'coexist',applicability:choice.applicability}):'用户补充问题答案');
    plan.statements.push(...answer.statements,...relation.statements);
    newAnswerVersions.push(answer.versionId);newRelationIds.push(relation.id);
    plan.changedRefs.push({entityType:'claim',id:answer.claimId,revision:1});
    touched.set(q.id,q);
  }
  if(subjectType==='question' && (content.resolveQuestions.length!==1 || content.resolveQuestions[0].questionId!==subject.id)) throw new WorkflowFault(422,'dependency_conflict','请为这个问题保存一条对应答案');
  plan.statements.push(...retireUnusedAnswers(ctx,[...oldAnswerVersions,...replacedVersions],old?'withdrawn':'superseded'));
  for(const q of touched.values()) {
    plan.guards.push(claimGuard(q,ctx.scope));
    plan.statements.push(questionRefresh(ctx,q));
    plan.changedRefs.push({entityType:'question',id:q.id,revision:q.workflow_revision+1});
    plan.invalidatedVersionIds.push(q.current_version_id);
  }
  // Relation guards cover legacy relation updates whose claim revision has not
  // yet been advanced by a V1 adapter. The context guard covers concurrent writes.
  for(const r of ledger.relations.filter(r=>r.type==='resolves' && touched.has(ledger.claims.find(c=>c.current_version_id===r.target_claim_version_id)?.id ?? '') && r.status==='active')) {
    plan.guards.push({sql:'EXISTS (SELECT 1 FROM claim_relations WHERE id=? AND workspace_id=? AND source_claim_version_id=? AND target_claim_version_id=? AND status=?)',values:[r.id,ctx.scope.workspaceId,r.source_claim_version_id,r.target_claim_version_id,r.status]});
  }
  const outcomeId=old?.id ?? mutationId('outcome'),versionId=mutationId('outv'),revision=(old?.revision ?? 0)+1;
  if(!old) plan.statements.push(statement(ctx,`INSERT INTO workflow_outcomes (id,workspace_id,project_id,event_id,subject_type,subject_claim_id,revision,current_version_id,author_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,outcomeId,ctx.scope.workspaceId,ctx.projectId,ctx.eventId,subjectType,subject.id,revision,versionId,ctx.scope.actorId,ctx.timestamp,ctx.timestamp));
  plan.statements.push(statement(ctx,`INSERT INTO outcome_versions (id,workspace_id,outcome_id,revision,text,evidence_refs_json,answer_claim_version_ids_json,relation_ids_json,supersedes_version_id,author_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,versionId,ctx.scope.workspaceId,outcomeId,revision,content.text,JSON.stringify(content.evidenceRefs),JSON.stringify(newAnswerVersions),JSON.stringify(newRelationIds),old?.current_version_id ?? null,ctx.scope.actorId,ctx.timestamp));
  if(old) plan.statements.push(statement(ctx,'UPDATE workflow_outcomes SET revision=?,current_version_id=?,updated_at=? WHERE id=? AND workspace_id=?',revision,versionId,ctx.timestamp,outcomeId,ctx.scope.workspaceId));
  if(subjectType==='action') {
    plan.statements.push(statement(ctx,'UPDATE claims SET workflow_revision=workflow_revision+1,updated_at=? WHERE id=? AND workspace_id=?',ctx.timestamp,subject.id,ctx.scope.workspaceId));
    plan.changedRefs.push({entityType:'action',id:subject.id,revision:subject.workflow_revision+1});
  }
  plan.changedRefs.push({entityType:'outcome',id:outcomeId,revision});
  plan.invalidatedVersionIds.push(...oldAnswerVersions,...replacedVersions);
  plan.basisInvalidatedVersionIds = [...oldAnswerVersions,...replacedVersions];
  return plan;
}

export async function answerQuestion(db:D1Database,scope:WorkflowScope,input:Located & {questionId:string;request:QuestionAnswerRequest}):Promise<MutationReceipt> {
  const request=parseWorkflowRequest('QuestionAnswerRequest',input.request);
  return commitWorkflowMutation(db,scope,{...input,endpoint:`questions/${input.questionId}/answers`,payload:request,expectedContextVersion:request.expectedContextVersion},async t=>{
    const ledger=await loadWorkflowLedger(db,scope,input.projectId);
    const subject=ledger.claims.find(c=>c.id===input.questionId && c.event_id===input.eventId && c.type==='open_question' && validClaim(c));
    if(!subject || subject.workflow_revision!==request.expectedQuestionRevision) throw new WorkflowFault(409,'version_conflict','问题已有变化，请重新读取');
    const ctx:WriteContext={db,scope,...input,...t,decisionId:t.mutationId};
    const plan=buildOutcome(ctx,ledger,subject,'question',{text:request.answerText,evidenceRefs:request.evidenceRefs,resolveQuestions:[{questionId:subject.id,revision:subject.workflow_revision,answerText:request.answerText}],...(request.answerDecision?{answerDecisions:[{...request.answerDecision,questionId:subject.id}]}:{})});
    plan.statements.unshift(decisionEnvelope(ctx,'answer_question',input.key));
    return plan;
  });
}
export async function saveOutcome(db:D1Database,scope:WorkflowScope,input:Located & {actionId:string;request:OutcomeRequest}):Promise<MutationReceipt> {
  const request=parseWorkflowRequest('OutcomeRequest',input.request);
  return commitWorkflowMutation(db,scope,{...input,endpoint:`actions/${input.actionId}/outcomes`,payload:request,expectedContextVersion:request.expectedContextVersion},async t=>{
    const ledger=await loadWorkflowLedger(db,scope,input.projectId);
    const subject=ledger.claims.find(c=>c.id===input.actionId && c.event_id===input.eventId && c.type==='next_action' && validClaim(c));
    if(!subject || subject.workflow_revision!==request.expectedActionRevision) throw new WorkflowFault(409,'version_conflict','行动已有变化，请重新读取');
    const ctx:WriteContext={db,scope,...input,...t,decisionId:t.mutationId};
    const plan=buildOutcome(ctx,ledger,subject,'action',request);
    if(request.completeAction) {
      const state=projectWorkspace(ledger,subject.event_id,t.timestamp,'').actions.find(a=>a.id===subject.id);
      if(state?.executionState!=='completed') {
        const completion=actionTransitionPlan(ctx,ledger,subject,'complete');
        plan.statements.push(...completion.statements);plan.guards.push(...completion.guards);
        plan.changedRefs=plan.changedRefs.filter(r=>r.entityType!=='action');
        plan.changedRefs.push(...completion.changedRefs.map(r=>r.entityType==='action'?{...r,revision:subject.workflow_revision+2}:r));
        plan.invalidatedVersionIds.push(...completion.invalidatedVersionIds);
      }
    }
    plan.statements.unshift(decisionEnvelope(ctx,'save_outcome',input.key));
    return plan;
  });
}
export async function correctOutcome(db:D1Database,scope:WorkflowScope,input:Located & {outcomeId:string;request:OutcomeCorrectionRequest}):Promise<MutationReceipt> {
  const request=parseWorkflowRequest('OutcomeCorrectionRequest',input.request);
  return commitWorkflowMutation(db,scope,{...input,endpoint:`outcomes/${input.outcomeId}/corrections`,payload:request,expectedContextVersion:request.expectedContextVersion},async t=>{
    const ledger=await loadWorkflowLedger(db,scope,input.projectId);
    const old=await db.prepare(`SELECT o.*,v.text,v.evidence_refs_json,v.answer_claim_version_ids_json,v.relation_ids_json,v.withdrawn_at FROM workflow_outcomes o JOIN outcome_versions v ON v.id=o.current_version_id AND v.outcome_id=o.id AND v.workspace_id=o.workspace_id WHERE o.id=? AND o.workspace_id=? AND o.project_id=? AND o.event_id=?`).bind(input.outcomeId,scope.workspaceId,input.projectId,input.eventId).first<CurrentOutcome>();
    if(!old || old.revision!==request.expectedOutcomeRevision || old.withdrawn_at) throw new WorkflowFault(409,'version_conflict','结果已有变化，请重新读取');
    const subject=ledger.claims.find(c=>c.id===old.subject_claim_id && c.event_id===input.eventId && (validClaim(c) || old.subject_type==='action' && c.type==='next_action' && c.review_status==='verified' && c.lifecycle_status==='superseded'));
    if(!subject) throw new WorkflowFault(409,'dependency_conflict','结果对应的事项已变化，请重新打开');
    const ctx:WriteContext={db,scope,...input,...t,decisionId:t.mutationId};
    let plan:MutationPlan;
    if(request.operation==='replace') plan=buildOutcome(ctx,ledger,subject,old.subject_type,request.replacement,old);
    else {
      const relationIds=outcomeRelationIds(ledger,readJson<string[]>(old.relation_ids_json,[])),answerIds=[...new Set([...readJson<string[]>(old.answer_claim_version_ids_json,[]),...ledger.relations.filter(r=>relationIds.includes(r.id)).map(r=>r.source_claim_version_id)])];
      const questions=ledger.claims.filter(c=>c.type==='open_question' && ledger.relations.some(r=>relationIds.includes(r.id) && r.target_claim_version_id===c.current_version_id));
      const versionId=mutationId('outv');
      plan={statements:[...deactivateRelations(ctx,relationIds),...retireUnusedAnswers(ctx,answerIds,'withdrawn'),...questions.map(q=>questionRefresh(ctx,q)),
        statement(ctx,`INSERT INTO outcome_versions (id,workspace_id,outcome_id,revision,text,evidence_refs_json,answer_claim_version_ids_json,relation_ids_json,supersedes_version_id,withdrawn_at,author_id,created_at) VALUES (?,?,?,?,?,'[]','[]','[]',?,?,?,?)`,versionId,scope.workspaceId,old.id,old.revision+1,old.text,old.current_version_id,t.timestamp,scope.actorId,t.timestamp),
        statement(ctx,'UPDATE workflow_outcomes SET revision=revision+1,current_version_id=?,updated_at=? WHERE id=? AND workspace_id=?',versionId,t.timestamp,old.id,scope.workspaceId),
      ],guards:[claimGuard(subject,scope),...questions.map(q=>claimGuard(q,scope))],changedRefs:[{entityType:'outcome',id:old.id,revision:old.revision+1},...questions.map(q=>({entityType:'question' as const,id:q.id,revision:q.workflow_revision+1}))],invalidatedVersionIds:[...answerIds,...questions.map(q=>q.current_version_id)],basisInvalidatedVersionIds:answerIds,kind:'withdraw_outcome'};
      if(old.subject_type==='action') {
        plan.statements.push(statement(ctx,'UPDATE claims SET workflow_revision=workflow_revision+1,updated_at=? WHERE id=? AND workspace_id=?',t.timestamp,subject.id,scope.workspaceId));
        plan.changedRefs.push({entityType:'action',id:subject.id,revision:subject.workflow_revision+1});
      }
    }
    plan.guards.push({sql:'EXISTS (SELECT 1 FROM workflow_outcomes WHERE id=? AND workspace_id=? AND revision=? AND current_version_id=?)',values:[old.id,scope.workspaceId,old.revision,old.current_version_id]});
    plan.statements.unshift(decisionEnvelope(ctx,request.operation+'_outcome',input.key));
    return plan;
  });
}
