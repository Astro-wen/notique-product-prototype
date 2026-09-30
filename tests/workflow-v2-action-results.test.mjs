import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {buildRecordText} from '../lib/domain/workflow-v2.ts';
import {recordTopics} from '../lib/domain/record-topics.ts';

const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,path,body,key=crypto.randomUUID())=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,key);
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.prepare("DELETE FROM claim_relations WHERE id='basis'").run();await send(f.db,'review-cards/wfc_action/decisions',{expectedContextVersion:0,expectedCardRevision:1,operation:'accept_action',members:[{claimId:'action',claimVersionId:'action_v1',operation:'accept_action'}]});return f;}
const copy=s=>buildRecordText({title:'记录',...s,scope:'accepted',format:'plain_text'});
const save=async(db,text,key=crypto.randomUUID())=>{const s=await read(db);return send(db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,text,evidenceRefs:[],resolveQuestions:[],completeAction:true},key);};

test('an independent execution result is accepted information, stays in its topic and never resolves an unrelated question',async t=>{
 const {db,sqlite}=await setup(t);const initial=await read(db),request={expectedContextVersion:initial.contextVersion,expectedActionRevision:initial.actions[0].revision,text:'两家供应商的报价单已收到。',evidenceRefs:[],resolveQuestions:[],completeAction:true};
 const first=await send(db,'actions/action/outcomes',request,'note');
 let s=await read(db),result=s.actions[0].latestOutcome,resultRef=result.resultRefs[0];
 assert.equal(s.actions[0].executionState,'completed');assert.equal(s.questions[0].resolutionState,'open');assert.deepEqual(result.answerRefs,[]);
 assert.equal(s.bullets.find(b=>b.id===resultRef.claimId).origin,'user_input');assert.match(copy(s),/两家供应商的报价单已收到/);
 assert.match(copy(s),/向供应商询价.*已完成/);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM claim_relations WHERE type='resolves' AND target_claim_version_id='question_v1'").get().n,0);
 const before=sqlite.prepare('SELECT COUNT(*) AS n FROM outcome_versions').get().n;
 assert.deepEqual(await send(db,'actions/action/outcomes',request,'note'),first);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM outcome_versions').get().n,before);
 s.narrative={sentenceRefs:[{text:'询价',claimRefs:[s.actions[0].claimRef],topic:{key:'quotes',title:'供应商报价'}}]};
 assert.ok(recordTopics(s,s.bullets).find(g=>g.key==='quotes').bullets.some(b=>b.id===resultRef.claimId));
 const card=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===resultRef.claimId));
 await assert.rejects(send(db,`review-cards/${card.id}/decisions`,{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'edit',members:[{...resultRef,operation:'edit',newText:'绕过结果历史',origin:'user_input',evidenceRefIds:[]}]}),e=>e.code==='dependency_conflict');
});

test('correcting and withdrawing independent results replaces current content while preserving completed execution and immutable history',async t=>{
 const {db,sqlite}=await setup(t);await save(db,'两家报价单已收到。');let s=await read(db),old=s.actions[0].latestOutcome,oldRef=old.resultRefs[0];
 await send(db,`outcomes/${old.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:old.revision,operation:'replace',replacement:{text:'三家报价单已收到。',evidenceRefs:[],resolveQuestions:[]}});
 s=await read(db);assert.match(copy(s),/三家报价单已收到/);assert.doesNotMatch(copy(s),/两家报价单已收到/);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.questions[0].resolutionState,'open');assert.equal(s.actions[0].latestOutcome.revision,2);
 assert.equal(sqlite.prepare('SELECT statement FROM claim_versions WHERE id=?').get(oldRef.claimVersionId).statement,'两家报价单已收到。');
 const next=s.actions[0].latestOutcome;
 await send(db,`outcomes/${next.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:next.revision,operation:'withdraw'});
 s=await read(db);assert.doesNotMatch(copy(s),/报价单已收到/);assert.equal(s.actions[0].latestOutcome,null);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.questions[0].resolutionState,'open');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM outcome_versions WHERE outcome_id=?').get(old.id).n,3);
});

test('only the latest current independent result is copied, and a missing note source hides its body',async t=>{
 const {db,sqlite}=await setup(t);await save(db,'已发出询价。');const prior=(await read(db)).actions[0].latestOutcome.resultRefs[0];await save(db,'已有两家回复。');let s=await read(db);
 assert.match(copy(s),/已有两家回复/);assert.doesNotMatch(copy(s),/已发出询价/);
 assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(prior.claimId).lifecycle_status,'superseded');
 const result=s.actions[0].latestOutcome;sqlite.prepare('DELETE FROM user_notes WHERE claim_id=?').run(result.resultRefs[0].claimId);
 s=await read(db);assert.equal(s.actions[0].latestOutcome.text,'');assert.equal(s.actions[0].latestOutcome.freshness,'stale');assert.doesNotMatch(copy(s),/已有两家回复/);assert.equal(s.questions[0].resolutionState,'open');
});

test('a result equal to its explicit answer appears once, and later replacement never copies the old answer as a note',async t=>{
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);const {db}=f;
 await send(db,'review-cards/wfc_action/decisions',{expectedContextVersion:0,expectedCardRevision:1,operation:'accept_action',members:[{claimId:'action',claimVersionId:'action_v1',operation:'accept_action'}]});
 let s=await read(db);await send(db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,text:'报价十二万元。',evidenceRefs:[],resolveQuestions:[{questionId:'question',revision:s.questions[0].revision,answerText:'报价十二万元。'}],completeAction:true});
 s=await read(db);assert.equal(s.actions[0].latestOutcome.resultRefs,undefined);assert.equal(s.bullets.filter(b=>b.text==='报价十二万元。').length,1);
 await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'报价十三万元。',evidenceRefs:[],answerDecision:{mode:'replace',priorAnswerRefs:s.questions[0].answerRefs}});
 s=await read(db);assert.match(copy(s),/报价十三万元/);assert.doesNotMatch(copy(s),/报价十二万元/);assert.equal(s.actions[0].latestOutcome.freshness,'stale');assert.equal(s.actions[0].executionState,'completed');
});
