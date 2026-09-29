import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {decideRecord} from '../lib/server/workflow/record-decision.ts';
import {revertDecision} from '../lib/server/workflow/revert-decision.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {recordDisplayBullets} from '../lib/domain/workflow-v2.ts';

async function setup(t,{explicit=true}={}) {
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
 claim(f.sqlite,'agreement','decision','约定向供应商询价');relation(f.sqlite,'agreement-basis','action','agreement','informed_by','proposed');
 insert(f.sqlite,'workflow_cards',{id:'intent',workspace_id:'ws',project_id:'p',event_id:'e',group_key:explicit?'same_intent:agreement':'ordinary-group',revision:1,kind:'action',title:'向供应商询价',needs_decision:1,reason_code:'action_choice',reason:'决定是否加入跟进',disposition:'active',created_at:T,updated_at:T});
 for(const id of ['agreement','action'])insert(f.sqlite,'card_members',{id:`intent_${id}`,workspace_id:'ws',card_id:'intent',claim_id:id,claim_version_id:`${id}_v1`,role:id==='action'?'primary':'context',created_at:T});
 return f;
}
const choose=(id,operation,extra={})=>({claimId:id,claimVersionId:`${id}_v1`,operation,...extra});
const command=(member,{context=0,revision=1,key='intent-choice'}={})=>({projectId:'p',eventId:'e',cardId:'intent',key,request:{expectedContextVersion:context,expectedCardRevision:revision,operation:member.operation,members:[member]}});
const snapshot=db=>readWorkspace(db,SCOPE,'e',{},T);
const group=w=>w.reviewCards.find(c=>c.id==='intent');
async function undo(db,receipt){return revertDecision(db,SCOPE,{projectId:'p',eventId:'e',decisionId:receipt.mutationId,key:'undo-intent',request:{expectedContextVersion:receipt.contextVersion,expectedDecisionRevision:1}});}

test('an explicit same-agreement group exposes exact record and action kinds with one priority item',async t=>{
 const {db}=await setup(t),w=await snapshot(db),c=group(w);
 assert.deepEqual(c.sameIntent,{recordRef:{claimId:'agreement',claimVersionId:'agreement_v1'},actionRef:{claimId:'action',claimVersionId:'action_v1'}});
 assert.deepEqual(c.members.map(m=>[m.claimId,m.kind]),[['action','action'],['agreement','record']]);assert.equal(w.counts.needsDecisionCount,1);assert.equal(w.questions.length,1);
});
test('joining accepts only the stable action and completes this intent choice',async t=>{
 const {db,sqlite}=await setup(t),receipt=await decideRecord(db,SCOPE,command(choose('action','accept_action'))),w=await snapshot(db);
 assert.equal(w.actions.length,1);assert.equal(w.actions[0].id,'action');assert.equal(w.counts.needsDecisionCount,0);assert.equal(group(w).disposition,'active');assert.equal(group(w).members.find(m=>m.claimId==='agreement').reviewState,'draft');assert.equal(w.questions[0].resolutionState,'open');
 assert.equal(sqlite.prepare('SELECT count(*) n FROM action_metadata').get().n,1);assert.deepEqual(await decideRecord(db,SCOPE,command(choose('action','accept_action'))),receipt);
});
test('record-only acceptance leaves the action unfollowed and removes repeated priority work',async t=>{
 const {db}=await setup(t);await decideRecord(db,SCOPE,command(choose('agreement','confirm')));const w=await snapshot(db);
 assert.equal(w.actions.length,0);assert.equal(w.counts.needsDecisionCount,0);assert.equal(group(w).members.find(m=>m.claimId==='action').reviewState,'draft');assert.equal(w.bullets.find(b=>b.id==='agreement').reviewState,'accepted');assert.equal(w.questions[0].resolutionState,'open');
});
test('declining the action keeps the related record as a readable draft',async t=>{
 const {db}=await setup(t);await decideRecord(db,SCOPE,command(choose('action','reject')));const w=await snapshot(db);
 assert.equal(w.actions.length,0);assert.equal(w.counts.needsDecisionCount,0);assert.equal(w.bullets.find(b=>b.id==='agreement').reviewState,'draft');assert.ok(!w.bullets.some(b=>b.id==='action'));
});
test('editing the related record retains grouping and a later action freezes the corrected exact basis',async t=>{
 const {db}=await setup(t);await decideRecord(db,SCOPE,command(choose('agreement','edit',{newText:'约定周五向供应商询价',origin:'user_input',evidenceRefIds:[]})));let w=await snapshot(db);
 assert.equal(w.actions.length,0);assert.equal(w.counts.needsDecisionCount,0);assert.ok(group(w).sameIntent);const ref=group(w).sameIntent.recordRef;
 await decideRecord(db,SCOPE,command(choose('action','accept_action'),{context:1,revision:2,key:'join-later'}));w=await snapshot(db);
 assert.ok(w.actions[0].basisDetails.some(b=>b.acceptedRef.claimVersionId===ref.claimVersionId));assert.equal(w.actions[0].basisState,'current');
});
test('undo of the record-only choice restores the original queue and leaves every draft intact',async t=>{
 const {db}=await setup(t),receipt=await decideRecord(db,SCOPE,command(choose('agreement','confirm')));await undo(db,receipt);const w=await snapshot(db);
 assert.equal(w.counts.needsDecisionCount,1);assert.equal(w.actions.length,0);assert.ok(group(w).sameIntent);assert.ok(group(w).members.every(m=>m.reviewState==='draft'));
});
test('undo of joining restores the action choice without accepting the related record',async t=>{
 const {db}=await setup(t),receipt=await decideRecord(db,SCOPE,command(choose('action','accept_action')));await undo(db,receipt);const w=await snapshot(db);
 assert.equal(w.counts.needsDecisionCount,1);assert.equal(w.actions.length,0);assert.ok(group(w).members.every(m=>m.reviewState==='draft'));
});
test('ordinary mixed groups and identical evidence are not treated as a shared intent',async t=>{
 const {db}=await setup(t,{explicit:false});assert.equal(group(await snapshot(db)).sameIntent,undefined);
});
test('invalid explicit membership or removed basis falls back to independent current cards',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claim_relations SET status='retired' WHERE id='agreement-basis'").run();let w=await snapshot(db);assert.equal(group(w),undefined);assert.ok(w.reviewCards.some(c=>c.id==='wfc_action'));
 sqlite.prepare("UPDATE claim_relations SET status='proposed' WHERE id='agreement-basis'").run();sqlite.prepare("UPDATE claims SET type='budget' WHERE id='agreement'").run();w=await snapshot(db);assert.equal(group(w),undefined);assert.ok(w.reviewCards.some(c=>c.id==='wfc_agreement'));
});
test('a legacy grouping change during the commit cannot approve stale intent meaning',async t=>{
 const {db,sqlite}=await setup(t),batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE workflow_cards SET group_key='ordinary-group' WHERE id='intent'").run();return batch(statements);};
 await assert.rejects(decideRecord(db,SCOPE,command(choose('agreement','confirm'))),e=>e.code==='version_conflict');assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,0);
});
test('a legacy relation change rolls back a record-only choice',async t=>{
 const {db,sqlite}=await setup(t),batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE claim_relations SET status='retired' WHERE id='agreement-basis'").run();return batch(statements);};
 await assert.rejects(decideRecord(db,SCOPE,command(choose('agreement','confirm'))),e=>e.code==='version_conflict');assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,0);
});
test('independent blocking questions stay in the queue after this agreement is handled',async t=>{
 const {db,sqlite}=await setup(t);insert(sqlite,'workflow_cards',{id:'blocking',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'blocking',revision:1,kind:'question',title:'费用是多少？',needs_decision:1,reason_code:'blocking_question',reason:'询价需要确认费用范围',disposition:'active',created_at:T,updated_at:T});insert(sqlite,'card_members',{id:'blocking_q',workspace_id:'ws',card_id:'blocking',claim_id:'question',claim_version_id:'question_v1',role:'primary',created_at:T});
 await decideRecord(db,SCOPE,command(choose('agreement','confirm')));const w=await snapshot(db);assert.equal(w.counts.needsDecisionCount,1);assert.equal(w.reviewCards.find(c=>c.id==='blocking').needsDecision,true);
});


test('reading folds only the explicit pair and does not alter the original export objects',async t=>{
 const {db}=await setup(t);let w=await snapshot(db),rows=recordDisplayBullets(w.bullets,w.reviewCards);
 assert.equal(rows.length,w.bullets.length-1);assert.ok(rows.some(b=>b.id==='action'));assert.ok(!rows.some(b=>b.id==='agreement'));assert.ok(w.bullets.some(b=>b.id==='agreement'));
 await decideRecord(db,SCOPE,command(choose('agreement','confirm')));w=await snapshot(db);rows=recordDisplayBullets(w.bullets,w.reviewCards);assert.ok(rows.some(b=>b.id==='agreement'));assert.ok(!rows.some(b=>b.id==='action'));
});
test('editing the related record after joining keeps one intent card and requires explicit frozen-basis review',async t=>{
 const {db}=await setup(t);await decideRecord(db,SCOPE,command(choose('action','accept_action')));
 await decideRecord(db,SCOPE,command(choose('agreement','edit',{newText:'约定周五询价',origin:'user_input',evidenceRefIds:[]}),{context:1,revision:2,key:'edit-joined-record'}));const w=await snapshot(db);
 assert.ok(group(w).sameIntent);assert.equal(w.counts.needsDecisionCount,1);assert.equal(w.actions[0].basisState,'needs_review');assert.ok(w.actions[0].basisDetails.some(b=>b.acceptedRef.claimVersionId==='agreement_v1' && b.currentRef.claimVersionId!=='agreement_v1'));
});

test('a legacy member kind change during commit cannot approve an outdated grouped choice',async t=>{
 const {db,sqlite}=await setup(t),batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE claims SET type='property_fact' WHERE id='action'").run();return batch(statements);};
 await assert.rejects(decideRecord(db,SCOPE,command(choose('agreement','confirm'))),e=>e.code==='version_conflict');assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,0);
});
test('a later change of the grouping meaning prevents undoing a recorded agreement',async t=>{
 const {db,sqlite}=await setup(t),receipt=await decideRecord(db,SCOPE,command(choose('agreement','confirm')));sqlite.prepare("UPDATE claims SET type='property_fact' WHERE id='action'").run();
 await assert.rejects(undo(db,receipt),e=>e.code==='dependency_conflict');assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='agreement'").get().review_status,'verified');
});
test('a later semantic type change on a decided member prevents reverting its old decision',async t=>{
 const {db,sqlite}=await setup(t),receipt=await decideRecord(db,SCOPE,command(choose('agreement','confirm')));sqlite.prepare("UPDATE claims SET type='requirement' WHERE id='agreement'").run();
 await assert.rejects(undo(db,receipt),e=>e.code==='dependency_conflict');assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='agreement'").get().review_status,'verified');
});

for(const candidateId of ['agreement','action'])for(const mode of ['use_candidate','keep_existing','coexist'])test(`same-intent ${candidateId} conflict ${mode} retains its untouched member and can be undone`,async t=>{
 const {db,sqlite}=await setup(t),prior=candidateId==='action'?'old-action':'old-agreement';
 claim(sqlite,prior,candidateId==='action'?'next_action':'decision','原来的询价安排',{status:'verified'});relation(sqlite,'intent-conflict',candidateId,prior,'contradicts','proposed');
 const before=await snapshot(db);assert.equal(group(before).kind,'conflict');assert.ok(group(before).sameIntent);
 const receipt=await decideRecord(db,SCOPE,command(choose(candidateId,'resolve_conflict',{conflictChoice:{mode,existingRef:{claimId:prior,claimVersionId:`${prior}_v1`},candidateRef:{claimId:candidateId,claimVersionId:`${candidateId}_v1`},...(mode==='coexist'?{applicability:'原安排用于一期，新安排用于二期'}:{})}})));
 let w=await snapshot(db);assert.ok(group(w)?.sameIntent);assert.equal(group(w).members.length,2);assert.equal(group(w).kind,'action');assert.equal(group(w).needsDecision,false);assert.equal(group(w).members.find(m=>m.claimId!==(candidateId)).reviewState,'draft');
 assert.equal(w.actions.some(a=>a.id==='action'),candidateId==='action' && mode!=='keep_existing');
 await undo(db,receipt);w=await snapshot(db);assert.ok(group(w).sameIntent);assert.equal(group(w).kind,'conflict');assert.equal(group(w).needsDecision,true);assert.equal(group(w).members.length,2);assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='intent-conflict'").get().status,'proposed');
});
test('same-intent conflict commit rejects a concurrent change of the untouched member meaning',async t=>{
 const {db,sqlite}=await setup(t);claim(sqlite,'prior','decision','原约定',{status:'verified'});relation(sqlite,'intent-conflict','agreement','prior','contradicts','proposed');
 const original=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE claims SET type='property_fact' WHERE id='action'").run();return original(statements);};
 await assert.rejects(decideRecord(db,SCOPE,command(choose('agreement','resolve_conflict',{conflictChoice:{mode:'use_candidate',existingRef:{claimId:'prior',claimVersionId:'prior_v1'},candidateRef:{claimId:'agreement',claimVersionId:'agreement_v1'}}}))),e=>e.code==='version_conflict');
 assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='agreement'").get().review_status,'pending');assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n,0);
});

test('a grouped conflict renders its affected candidate once while preserving both export objects',async t=>{
 const {db,sqlite}=await setup(t);claim(sqlite,'prior','decision','原约定',{status:'verified'});relation(sqlite,'intent-conflict','agreement','prior','contradicts','proposed');
 const w=await snapshot(db),display=recordDisplayBullets(w.bullets,w.reviewCards);assert.equal(display.some(b=>b.id==='agreement'),true);assert.equal(display.some(b=>b.id==='action'),false);assert.equal(w.bullets.some(b=>b.id==='action'),true);assert.equal(w.bullets.some(b=>b.id==='agreement'),true);
});
