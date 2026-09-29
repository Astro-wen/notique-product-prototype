import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,path,body)=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,crypto.randomUUID());
async function actionOutcome(db){let s=await read(db),card=s.reviewCards.find(c=>c.id==='wfc_action');await send(db,'review-cards/wfc_action/decisions',{operation:'accept_action',expectedContextVersion:0,expectedCardRevision:1,members:[{...card.memberRefs[0],operation:'accept_action'}]});s=await read(db);await send(db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,text:'报价十二万元',evidenceRefs:[],resolveQuestions:[{questionId:'question',revision:s.questions[0].revision,answerText:'报价十二万元'}],completeAction:true});return read(db);}

test('a new direct answer updates current information while retaining the old action result as history',async t=>{
 const {db}=await setup(t),before=await actionOutcome(db);assert.equal(before.actions[0].latestOutcome.freshness,'current');const old=before.actions[0].latestOutcome;
 await send(db,'questions/question/answers',{expectedContextVersion:before.contextVersion,expectedQuestionRevision:before.questions[0].revision,answerText:'报价十三万元',evidenceRefs:[],answerDecision:{mode:'replace',priorAnswerRefs:before.questions[0].answerRefs}});
 const after=await read(db);assert.equal(after.actions[0].executionState,'completed');assert.equal(after.actions[0].latestOutcome.id,old.id);assert.equal(after.actions[0].latestOutcome.text,'报价十二万元');assert.equal(after.actions[0].latestOutcome.freshness,'stale');assert.deepEqual(after.actions[0].latestOutcome.answerRefs,[]);assert.equal(after.questions[0].latestOutcome.text,'报价十三万元');assert.equal(after.questions[0].latestOutcome.freshness,'current');
});

test('retiring an answer link makes the original result historical without changing execution',async t=>{
 const {db,sqlite}=await setup(t),before=await actionOutcome(db),answer=before.questions[0].answerRefs[0];sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE type='resolves' AND source_claim_version_id=?").run(answer.claimVersionId);
 const after=await read(db);assert.equal(after.actions[0].latestOutcome.freshness,'stale');assert.equal(after.questions[0].resolutionState,'open');assert.equal(after.actions[0].executionState,'completed');
});

test('inaccessible original answer evidence removes its old body from the result projection',async t=>{
 const {db,sqlite}=await setup(t),before=await actionOutcome(db);const ref=before.questions[0].answerRefs[0];sqlite.prepare('DELETE FROM user_notes WHERE claim_id=?').run(ref.claimId);
 const after=await read(db);assert.equal(after.actions[0].latestOutcome.text,'');assert.equal(after.actions[0].latestOutcome.freshness,'stale');assert.equal(after.questions[0].resolutionState,'open');
});
