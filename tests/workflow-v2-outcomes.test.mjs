import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {decideRecord} from '../lib/server/workflow/record-decision.ts';
import {transitionAction} from '../lib/server/workflow/action-service.ts';
import {answerQuestion,saveOutcome,correctOutcome} from '../lib/server/workflow/outcome-service.ts';
const code=c=>e=>e.code===c;
async function setup(t) {const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
const located={projectId:'p',eventId:'e'};
const accept={...located,cardId:'wfc_action',key:'accept',request:{operation:'accept_action',expectedCardRevision:1,expectedContextVersion:0,members:[{claimId:'action',claimVersionId:'action_v1',operation:'accept_action'}]}};
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
async function answer(db,text='报价十二万',extra={}) {
  const s=await read(db),q=s.questions.find(q=>q.id==='question');
  return answerQuestion(db,SCOPE,{...located,questionId:'question',key:crypto.randomUUID(),request:{expectedContextVersion:s.contextVersion,expectedQuestionRevision:q.revision,answerText:text,evidenceRefs:[],...extra}});
}
async function transition(db,operation) {
  const s=await read(db),a=s.actions[0];
  return transitionAction(db,SCOPE,{...located,actionId:'action',key:crypto.randomUUID(),request:{expectedContextVersion:s.contextVersion,expectedActionRevision:a.revision,operation}});
}

test('accepting a suggestion creates one action and completion never creates an extra task or answer',async t=>{
  const {db,sqlite}=await setup(t);
  const first=await decideRecord(db,SCOPE,accept);assert.deepEqual(await decideRecord(db,SCOPE,accept),first);
  assert.equal((await read(db)).actions.length,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM action_metadata').get().n,1);
  await transition(db,'complete');
  const s=await read(db);
  assert.equal(s.actions.length,1);assert.equal(s.actions[0].executionState,'completed');
  assert.equal(s.questions[0].resolutionState,'open');
  assert.equal(s.bullets.some(b=>b.text.startsWith('已完成：')),false);
  const n=sqlite.prepare('SELECT COUNT(*) AS n FROM claims').get().n;
  await transition(db,'reopen');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM claims').get().n,n,'reopening retains completion audit');
  assert.equal((await read(db)).actions[0].executionState,'open');
  await transition(db,'complete');assert.equal((await read(db)).actions.length,1);
});

test('direct answers require no action and subsequent answers require explicit exact prior refs',async t=>{
  const {db,sqlite}=await setup(t);
  await answer(db);
  let s=await read(db);assert.equal(s.actions.length,0);assert.equal(s.questions[0].resolutionState,'resolved');
  const original=s.questions[0].answerRefs;
  await assert.rejects(answer(db,'报价十三万'),code('dependency_conflict'));
  await assert.rejects(answer(db,'报价十三万',{answerDecision:{mode:'replace',priorAnswerRefs:[{claimId:'wrong',claimVersionId:'wrong'}]}}),code('dependency_conflict'));
  await answer(db,'报价十三万',{answerDecision:{mode:'replace',priorAnswerRefs:original}});
  s=await read(db);assert.equal(s.questions[0].answerRefs.length,1);
  assert.equal(s.bullets.some(b=>b.text==='报价十二万'),false);
  assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(original[0].claimId).lifecycle_status,'superseded');
});

test('coexisting answers survive withdrawal until the last active answer is withdrawn',async t=>{
  const {db}=await setup(t);
  await answer(db);
  let s=await read(db),first=s.questions[0].latestOutcome;
  await answer(db,'加急方案十五万',{answerDecision:{mode:'coexist',priorAnswerRefs:s.questions[0].answerRefs,applicability:'加急交付报价'}});
  s=await read(db);const second=s.questions[0].latestOutcome;
  assert.equal(s.questions[0].answerRefs.length,2);
  await correctOutcome(db,SCOPE,{...located,outcomeId:first.id,key:'withdraw-first',request:{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:first.revision,operation:'withdraw'}});
  s=await read(db);assert.equal(s.questions[0].resolutionState,'resolved');assert.equal(s.questions[0].answerRefs.length,1);
  await correctOutcome(db,SCOPE,{...located,outcomeId:second.id,key:'withdraw-second',request:{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:second.revision,operation:'withdraw'}});
  s=await read(db);assert.equal(s.questions[0].resolutionState,'open');assert.equal(s.questions[0].answerRefs.length,0);
});

test('action outcome can complete execution and answer together, and withdrawing its answers retains completion',async t=>{
  const {db,sqlite}=await setup(t);await decideRecord(db,SCOPE,accept);
  let s=await read(db);
  const saved=await saveOutcome(db,SCOPE,{...located,actionId:'action',key:'result',request:{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:true,text:'已取得报价',evidenceRefs:[],resolveQuestions:[{questionId:'question',revision:s.questions[0].revision,answerText:'报价十二万'}]}});
  s=await read(db);assert.equal(s.actions.length,1);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.questions[0].resolutionState,'resolved');
  assert.equal(s.actions[0].revision,saved.changedRefs.find(r=>r.entityType==='action').revision);
  assert.equal(s.questions[0].latestOutcome.id,s.actions[0].latestOutcome.id);
  const result=s.actions[0].latestOutcome;
  await correctOutcome(db,SCOPE,{...located,outcomeId:result.id,key:'withdraw-result',request:{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:result.revision,operation:'withdraw'}});
  s=await read(db);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.questions[0].resolutionState,'open');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM outcome_versions').get().n,2);
});

test('execution notes do not answer questions and unrelated question targets are rejected atomically',async t=>{
  const {db,sqlite}=await setup(t);await decideRecord(db,SCOPE,accept);
  let s=await read(db);
  await saveOutcome(db,SCOPE,{...located,actionId:'action',key:'note',request:{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:false,text:'已发邮件，等待回复',evidenceRefs:[],resolveQuestions:[]}});
  s=await read(db);assert.equal(s.questions[0].resolutionState,'open');assert.equal(s.actions[0].executionState,'open');
  claim(sqlite,'unrelated','open_question','何时搬入？');
  const before=sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outcomes').get().n;
  await assert.rejects(saveOutcome(db,SCOPE,{...located,actionId:'action',key:'unrelated',request:{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:false,text:'回复',evidenceRefs:[],resolveQuestions:[{questionId:'unrelated',revision:1,answerText:'明年'}]}}),code('dependency_conflict'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outcomes').get().n,before);
});

test('correcting a multi-question result preserves exact per-question answers and immutable prior versions',async t=>{
  const {db,sqlite}=await setup(t);claim(sqlite,'time','open_question','交货多久？');relation(sqlite,'basis-time','action','time','informed_by','proposed');
  await decideRecord(db,SCOPE,accept);let s=await read(db);
  await saveOutcome(db,SCOPE,{...located,actionId:'action',key:'two',request:{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:false,text:'供应商答复',evidenceRefs:[],resolveQuestions:s.questions.map(q=>({questionId:q.id,revision:q.revision,answerText:q.id==='time'?'两周':'十二万'}))}});
  s=await read(db);const prior=s.actions[0].latestOutcome;
  assert.equal(s.questions.filter(q=>q.resolutionState==='resolved').length,2);
  await correctOutcome(db,SCOPE,{...located,outcomeId:prior.id,key:'correct',request:{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:prior.revision,operation:'replace',replacement:{text:'更新报价和交期',evidenceRefs:[],resolveQuestions:s.questions.map(q=>({questionId:q.id,revision:q.revision,answerText:q.id==='time'?'三周':'十三万'}))}}});
  s=await read(db);assert.equal(s.actions[0].latestOutcome.revision,2);
  assert.ok(s.bullets.some(b=>b.text==='十三万'));assert.ok(s.bullets.some(b=>b.text==='三周'));
  assert.equal(s.bullets.some(b=>b.text==='两周'||b.text==='十二万'),false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM outcome_versions WHERE outcome_id=?').get(prior.id).n,2);
  await assert.rejects(correctOutcome(db,SCOPE,{...located,outcomeId:prior.id,key:'stale-correction',request:{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:1,operation:'withdraw'}}),code('version_conflict'));
});

test('cancel and reopen do not withdraw answers obtained through separate question entry',async t=>{
  const {db}=await setup(t);await decideRecord(db,SCOPE,accept);await answer(db);
  await transition(db,'cancel');assert.equal((await read(db)).actions[0].executionState,'cancelled');
  await transition(db,'reopen');const s=await read(db);assert.equal(s.actions[0].executionState,'open');assert.equal(s.questions[0].resolutionState,'resolved');
});

test('one explicitly selected result links a previously unlinked current question and answers it atomically',async t=>{
  const {db,sqlite}=await setup(t);await decideRecord(db,SCOPE,accept);
  claim(sqlite,'showtime','open_question','三套房几点开始看？');
  let s=await read(db);const q=s.questions.find(q=>q.id==='showtime');
  assert.equal(s.actions[0].questionRefs.some(r=>r.claimId===q.id),false);
  const body={expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:true,text:'15:00，按A、B、C顺序看房',evidenceRefs:[],resolveQuestions:[{questionId:q.id,revision:q.revision,answerText:'15:00，按A、B、C顺序看房'}],linkQuestionRefs:[q.claimRef]};
  const receipt=await saveOutcome(db,SCOPE,{...located,actionId:'action',key:'shared-answer',request:body});
  assert.deepEqual(await saveOutcome(db,SCOPE,{...located,actionId:'action',key:'shared-answer',request:body}),receipt);
  s=await read(db);const a=s.actions[0],answered=s.questions.find(q=>q.id==='showtime');
  assert.equal(a.executionState,'completed');assert.equal(answered.resolutionState,'resolved');
  assert.equal(a.latestOutcome.id,answered.latestOutcome.id);
  assert.ok(a.questionRefs.some(r=>r.claimVersionId===q.claimRef.claimVersionId));
  assert.equal(s.bullets.filter(b=>b.text===body.text).length,1,'shared input is not also stored as a duplicate result note');
  assert.equal(s.questions.find(q=>q.id==='question').resolutionState,'open');
  await correctOutcome(db,SCOPE,{...located,outcomeId:a.latestOutcome.id,key:'withdraw-shared',request:{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:a.latestOutcome.revision,operation:'withdraw'}});
  s=await read(db);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.questions.find(q=>q.id==='showtime').resolutionState,'open');
});

test('explicit result links reject stale or other-event questions without partial writes',async t=>{
  const {db,sqlite}=await setup(t);await decideRecord(db,SCOPE,accept);claim(sqlite,'newq','open_question','交付时间？');
  const s=await read(db),q=s.questions.find(q=>q.id==='newq');
  const body={expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:true,text:'下周',evidenceRefs:[],resolveQuestions:[{questionId:q.id,revision:q.revision,answerText:'下周'}],linkQuestionRefs:[{...q.claimRef,claimVersionId:'stale'}]};
  const before=sqlite.prepare('SELECT COUNT(*) n FROM workflow_outcomes').get().n;
  await assert.rejects(saveOutcome(db,SCOPE,{...located,actionId:'action',key:'stale-link',request:body}),code('dependency_conflict'));
  sqlite.prepare("INSERT INTO events (id,workspace_id,project_id,event_type,title,occurred_at,sequence_no) VALUES ('other','ws','p','meeting','其他沟通',?,2)").run(T);
  sqlite.prepare("UPDATE claims SET event_id='other' WHERE id='newq'").run();
  await assert.rejects(saveOutcome(db,SCOPE,{...located,actionId:'action',key:'cross-event-link',request:{...body,linkQuestionRefs:[q.claimRef]}}),code('dependency_conflict'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_outcomes').get().n,before);
  assert.equal((await read(db)).actions[0].executionState,'open');
});
