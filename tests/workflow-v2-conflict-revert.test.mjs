import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,SCOPE,T} from './helpers/workflow-database.mjs';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {buildRecordText} from '../lib/domain/workflow-v2.ts';
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,path,body,key=crypto.randomUUID(),scope=SCOPE)=>dispatchWorkflowCommand(db,scope,path.split('/'),body,key);
async function setup(t,conflict=true) {const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);if(conflict){f.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();claim(f.sqlite,'new-budget','budget','预算更新为三十五万');relation(f.sqlite,'budget-conflict','new-budget','budget','contradicts','proposed');}return f;}
async function resolve(db,mode,extra={}) {
 const s=await read(db),card=s.reviewCards.find(c=>c.id==='wfc_new-budget');
 const body={expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'resolve_conflict',members:[{claimId:'new-budget',claimVersionId:'new-budget_v1',operation:'resolve_conflict',conflictChoice:{mode,existingRef:{claimId:'budget',claimVersionId:'budget_v1'},candidateRef:{claimId:'new-budget',claimVersionId:'new-budget_v1'},...extra}}]};
 return {receipt:await send(db,'review-cards/wfc_new-budget/decisions',body),body};
}
async function decide(db,id,operation,extra={}) {const s=await read(db),card=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===id));return send(db,`review-cards/${card.id}/decisions`,{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation,members:[{...card.memberRefs.find(r=>r.claimId===id),operation,...extra}]});}
async function revert(db,id,key=crypto.randomUUID()) {const s=await read(db),d=s.recentDecisions.find(d=>d.id===id);const body={expectedContextVersion:s.contextVersion,expectedDecisionRevision:d.revision};return {receipt:await send(db,`decisions/${id}/revert`,body,key),body};}

for(const mode of ['keep_existing','use_candidate','coexist']) test(`conflict ${mode} is explicit, auditable, exportable and reversible`,async t=>{
 const {db,sqlite}=await setup(t);
 const initial=await read(db),card=initial.reviewCards.find(c=>c.id==='wfc_new-budget');
 assert.equal(card.conflicts[0].existing.statement,'预算大约三十万');
 assert.match(buildRecordText({...initial,title:'记录',scope:'mixed',format:'plain_text'}),/新旧信息待选择/);
 const saved=await resolve(db,mode,mode==='coexist'?{applicability:'三十万用于一期，三十五万用于二期'}:{});
 let s=await read(db);
 assert.equal(s.reviewCards.some(c=>c.kind==='conflict' && c.disposition==='active'),false);
 assert.equal(s.bullets.some(b=>b.id==='new-budget'),mode!=='keep_existing');assert.equal(s.bullets.some(b=>b.id==='budget'),mode!=='use_candidate');
 if(mode==='coexist') {assert.match(buildRecordText({...s,title:'记录',scope:'mixed',format:'plain_text'}),/一期/);assert.equal(s.bullets.filter(b=>b.applicability).length,2);assert.match(s.bullets.find(b=>b.id==='budget').applicability,/一期/);}
 const undone=await revert(db,saved.receipt.mutationId,'undo');
 assert.deepEqual(await send(db,`decisions/${saved.receipt.mutationId}/revert`,undone.body,'undo'),undone.receipt);
 s=await read(db);assert.equal(s.reviewCards.find(c=>c.id==='wfc_new-budget').kind,'conflict');assert.equal(s.bullets.find(b=>b.id==='new-budget').reviewState,'draft');assert.equal(s.bullets.find(b=>b.id==='budget').reviewState,'accepted');
 assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='budget-conflict'").get().status,'proposed');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,2);
 assert.equal(s.recentDecisions.find(d=>d.id===saved.receipt.mutationId).reverted,true);
 await resolve(db,'use_candidate');assert.equal((await read(db)).bullets.some(b=>b.id==='budget'),false);
});

test('an unsupported candidate can be declined but cannot be adopted or coexist',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='does_not_support' WHERE id='new-budget_ev'").run();
 await assert.rejects(resolve(db,'use_candidate'),e=>e.code==='dependency_conflict');
 await assert.rejects(resolve(db,'coexist',{applicability:'两个阶段'}),e=>e.code==='dependency_conflict');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
 await resolve(db,'keep_existing');assert.equal((await read(db)).bullets.some(b=>b.id==='new-budget'),false);
});

test('forged conflict versions and new source loss during the commit cannot change either side',async t=>{
 const {db,sqlite}=await setup(t),s=await read(db),card=s.reviewCards.find(c=>c.id==='wfc_new-budget');
 await assert.rejects(send(db,'review-cards/wfc_new-budget/decisions',{expectedContextVersion:0,expectedCardRevision:card.revision,operation:'resolve_conflict',members:[{claimId:'new-budget',claimVersionId:'new-budget_v1',operation:'resolve_conflict',conflictChoice:{mode:'use_candidate',existingRef:{claimId:'question',claimVersionId:'question_v1'},candidateRef:{claimId:'new-budget',claimVersionId:'new-budget_v1'}}}]}),e=>e.code==='version_conflict');
 const batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE assets SET current_version_id=NULL").run();return batch(statements);};
 await assert.rejects(resolve(db,'use_candidate'),e=>e.code==='version_conflict');
 assert.equal(sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='budget'").get().lifecycle_status,'active');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
});

for(const operation of ['confirm','edit','reject']) test(`undo ${operation} restores the prior version/status and a fresh decision can follow`,async t=>{
 const {db,sqlite}=await setup(t,false);
 const saved=await decide(db,'budget',operation,operation==='edit'?{newText:'预算三十五万',origin:'user_input',evidenceRefIds:[]}:{});
 await revert(db,saved.mutationId);
 const c=sqlite.prepare("SELECT * FROM claims WHERE id='budget'").get();assert.equal(c.review_status,'pending');assert.equal(c.current_version_id,'budget_v1');assert.equal(c.workflow_revision,3);
 await decide(db,'budget','confirm');assert.equal((await read(db)).bullets.find(b=>b.id==='budget').reviewState,'accepted');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n,3);
});

test('undoing action acceptance retires its new links, while execution blocks a later undo',async t=>{
 const {db}=await setup(t,false);
 const saved=await decide(db,'action','accept_action');await revert(db,saved.mutationId);assert.equal((await read(db)).actions.length,0);
 const again=await decide(db,'action','accept_action');let s=await read(db);
 await send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation:'complete'});
 await assert.rejects(revert(db,again.mutationId),e=>e.code==='dependency_conflict' && e.details.affectedItems.some(x=>x.claimId==='action'));
 s=await read(db);assert.equal(s.actions[0].executionState,'completed');
});

test('subsequent accepted dependencies block undo and are returned by name',async t=>{
 const {db,sqlite}=await setup(t,false);const saved=await decide(db,'budget','confirm');relation(sqlite,'later-basis','action','budget','informed_by','proposed');await decide(db,'action','accept_action');
 await assert.rejects(revert(db,saved.mutationId),e=>e.code==='dependency_conflict' && e.details.affectedItems.some(x=>x.text==='向供应商询价'));
 assert.equal((await read(db)).bullets.find(b=>b.id==='budget').reviewState,'accepted');
});

test('undo rechecks permissions before serving a duplicate receipt',async t=>{
 const {db,sqlite}=await setup(t,false);const saved=await decide(db,'budget','confirm');const undone=await revert(db,saved.mutationId,'undo');
 sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
 await assert.rejects(send(db,`decisions/${saved.mutationId}/revert`,undone.body,'undo'),e=>e.code==='forbidden');
});


test('replacing an accepted answer updates its question and undo restores the exact old answer link',async t=>{
 const {db,sqlite}=await setup(t);
 relation(sqlite,'old-answer','budget','question','resolves','active');
 sqlite.prepare("UPDATE claims SET lifecycle_status='resolved' WHERE id='question'").run();
 const saved=await resolve(db,'use_candidate');let s=await read(db);
 assert.deepEqual(s.questions[0].answerRefs,[{claimId:'new-budget',claimVersionId:'new-budget_v1'}]);
 assert.equal(s.questions[0].resolutionState,'resolved');
 const text=buildRecordText({...s,title:'记录',scope:'mixed',format:'plain_text'});assert.match(text,/三十五万/);assert.doesNotMatch(text,/三十万[ ·]/);
 await revert(db,saved.receipt.mutationId);s=await read(db);
 assert.deepEqual(s.questions[0].answerRefs,[{claimId:'budget',claimVersionId:'budget_v1'}]);assert.equal(s.questions[0].resolutionState,'resolved');
});

test('a downstream link added during undo cannot be erased by the older decision',async t=>{
 const {db,sqlite}=await setup(t,false);const saved=await decide(db,'budget','confirm');
 const batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();relation(sqlite,'racing-dependency','action','budget','informed_by','active');return batch(statements);};
 await assert.rejects(revert(db,saved.mutationId),e=>e.code==='version_conflict');
 assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'verified');
 assert.equal(sqlite.prepare("SELECT reverted_by FROM workflow_decisions WHERE id=?").get(saved.mutationId).reverted_by,null);
});


test('coexisting conflicting answers both answer the question and undo withdraws only the added support',async t=>{
 const {db,sqlite}=await setup(t);relation(sqlite,'old-answer','budget','question','resolves','active');
 const saved=await resolve(db,'coexist',{applicability:'不同交付范围'});let s=await read(db);
 assert.deepEqual(new Set(s.questions[0].answerRefs.map(r=>r.claimId)),new Set(['budget','new-budget']));
 await revert(db,saved.receipt.mutationId);s=await read(db);assert.deepEqual(s.questions[0].answerRefs,[{claimId:'budget',claimVersionId:'budget_v1'}]);
 assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='old-answer'").get().status,'active');
});
