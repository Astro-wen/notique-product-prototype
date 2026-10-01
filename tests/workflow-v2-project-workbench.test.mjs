import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {readProjectOverview} from '../lib/server/workflow/overview-service.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {actionableSuggestion,projectWorkItems} from '../lib/domain/project-workbench.ts';
import {buildRecordText} from '../lib/domain/workflow-v2.ts';

test('project suggestions become todos, completion leaves questions open, and answers flow into project bullets and export',async t=>{
  const {db,sqlite,close}=await workflowDatabase();t.after(close);seed(sqlite);
  const overview=()=>readProjectOverview(db,SCOPE,'p',{},T);
  let snapshot=await overview(),items=projectWorkItems(snapshot);
  assert.deepEqual(items.facts.map(b=>b.id),['budget']);
  assert.deepEqual(items.suggestions.map(b=>b.id),['action']);
  assert.equal(snapshot.openQuestions[0].id,'question');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_outbox').get().n,0);
  let record=await readWorkspace(db,SCOPE,'e',{},T);
  const ref=items.suggestions[0].claimRefs[0],card=actionableSuggestion(record.reviewCards,ref);
  assert.ok(card);
  await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{expectedContextVersion:record.contextVersion,expectedCardRevision:card.revision,operation:'accept_action',members:[{...ref,operation:'accept_action'}]},'project-add');
  snapshot=await overview();assert.equal(snapshot.nextActions.length,1);assert.equal(projectWorkItems(snapshot).suggestions.length,0);
  const action=snapshot.nextActions[0];
  await dispatchWorkflowCommand(db,SCOPE,['actions',action.id,'transitions'],{expectedContextVersion:snapshot.contextVersion,expectedActionRevision:action.revision,operation:'complete'},'project-complete');
  snapshot=await overview();assert.equal(snapshot.nextActions.length,0);assert.equal(projectWorkItems(snapshot).completed.length,1);assert.equal(snapshot.openQuestions.length,1);
  const question=snapshot.openQuestions[0];
  await dispatchWorkflowCommand(db,SCOPE,['questions',question.id,'answers'],{expectedContextVersion:snapshot.contextVersion,expectedQuestionRevision:question.revision,answerText:'报价十二万元',evidenceRefs:[]},'project-answer');
  snapshot=await overview();assert.equal(snapshot.openQuestions.length,0);assert.ok(projectWorkItems(snapshot).facts.some(b=>b.text==='报价十二万元'));
  assert.ok(projectWorkItems(snapshot,true).facts.some(b=>b.text==='报价十二万元'));
  record=await readWorkspace(db,SCOPE,'e',{},T);
  const text=buildRecordText({title:'项目',...record,scope:'accepted',format:'plain_text'});
  assert.match(text,/报价十二万元/);assert.doesNotMatch(text,/费用是多少/);
  assert.equal(sqlite.prepare("SELECT text_raw FROM text_segments WHERE id='seg'").get().text_raw,'预算大约三十万。费用待定。请询价。');
});

test('project quick acceptance refuses changed versions, conflicts, stale sources and overlapping tasks',async t=>{
  const {db,sqlite,close}=await workflowDatabase();t.after(close);seed(sqlite);
  const record=await readWorkspace(db,SCOPE,'e',{},T),ref=record.bullets.find(b=>b.id==='action').claimRefs[0];
  const card=actionableSuggestion(record.reviewCards,ref);assert.ok(card);
  assert.equal(actionableSuggestion(record.reviewCards,{...ref,claimVersionId:'older-version'}),null);
  for(const override of [{kind:'conflict'},{sourceStatus:'stale'},{disposition:'deferred'},{actionOverlap:{manualRef:ref,modelRef:ref}},{members:card.members.map(m=>({...m,supportStatus:'does_not_support'}))}])assert.equal(actionableSuggestion([{...card,...override}],ref),null);
  assert.equal(sqlite.prepare('SELECT review_status FROM claims WHERE id=?').get('action').review_status,'pending');
});
