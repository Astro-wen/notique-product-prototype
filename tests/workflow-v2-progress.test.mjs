import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {saveReviewProgress} from '../lib/server/workflow/review-progress.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
const read=(db,scope=SCOPE,q={})=>readWorkspace(db,scope,'e',q,T);
const send=(db,body,key=crypto.randomUUID(),scope=SCOPE,time=T)=>saveReviewProgress(db,scope,'e',body,key,time);
const body=(s,lastCardId='wfc_budget',mode='bookmark')=>({snapshotId:s.snapshotId,lastCardId,mode});

test('personal reading progress persists without changing the record, acceptance, context or generation',async t=>{
 const {db,sqlite}=await setup(t),before=await read(db);
 const saved=await send(db,body(before),'bookmark');assert.equal(saved.lastCardId,'wfc_budget');assert.equal(saved.finishedAt,null);assert.equal(saved.remainingCount,1);
 assert.deepEqual(await send(db,body(before),'bookmark'),saved);
 const after=await read(db);assert.equal(after.snapshotId,before.snapshotId);assert.deepEqual(after.reviewProgress,saved);
 const {reviewProgress:beforeProgress,...recordBefore}=before,{reviewProgress:afterProgress,...recordAfter}=after;assert.deepEqual(recordAfter,recordBefore);assert.ok(beforeProgress);assert.ok(afterProgress);
 assert.equal(sqlite.prepare("SELECT context_version,ledger_version FROM projects WHERE id='p'").get().context_version,0);
 assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'pending');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,0);
 const cached=await read(db,SCOPE,{snapshotId:before.snapshotId});assert.deepEqual(cached.reviewProgress,saved);
});

test('readers can finish with pending work and each actor resumes an independent position',async t=>{
 const {db,sqlite}=await setup(t);insert(sqlite,'workspace_members',{id:'reader',workspace_id:'ws',actor_id:'reader',role:'viewer'});const viewer={...SCOPE,actorId:'reader'};
 const a=await read(db),v=await read(db,viewer);await send(db,body(a,'wfc_budget'));
 const finished=await send(db,body(v,'wfc_action','finish_session'),'finish',viewer);assert.equal(finished.remainingCount,1);assert.equal(finished.finishedAt,T);
 assert.equal((await read(db)).reviewProgress.lastCardId,'wfc_budget');assert.equal((await read(db,viewer)).reviewProgress.lastCardId,'wfc_action');
 const reopened=await send(db,body(await read(db,viewer),'wfc_question'),'resume',viewer);assert.equal(reopened.finishedAt,null);
 assert.equal((await read(db)).reviewProgress.finishedAt,null);
});

test('foreign, expired, source-changed and obsolete snapshots cannot move a bookmark',async t=>{
 const {db,sqlite}=await setup(t),s=await read(db);await send(db,body(s));
 await assert.rejects(send(db,body(s,'foreign')),e=>e.code==='cursor_expired');
 await assert.rejects(send(db,{...body(s),snapshotId:'foreign'}),e=>e.code==='cursor_expired');
 await assert.rejects(send(db,body(s),'expired',SCOPE,'2026-09-28T11:00:00.000Z'),e=>e.code==='cursor_expired');
 sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();await assert.rejects(send(db,body(s)),e=>e.code==='cursor_expired');
 assert.equal((await read(db)).reviewProgress.lastCardId,'wfc_budget');
});

test('progress validates membership before replay and rechecks revocation within its write',async t=>{
 const {db,sqlite}=await setup(t),s=await read(db);await send(db,body(s),'key');
 sqlite.prepare("UPDATE workspace_members SET revoked_at=?").run(T);await assert.rejects(send(db,body(s),'key'),e=>e.code==='not_found');
 sqlite.prepare("UPDATE workspace_members SET revoked_at=NULL").run();const batch=db.batch;db.batch=async statements=>{sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);return batch(statements);};
 await assert.rejects(send(db,body(s,'wfc_question')),e=>e.code==='not_found');
 assert.equal(sqlite.prepare('SELECT last_card_id FROM review_progress').get().last_card_id,'wfc_budget');
});

test('progress handles snapshot invalidation during saving and cannot partially materialize a card',async t=>{
 const {db,sqlite}=await setup(t),s=await read(db);const batch=db.batch;db.batch=async statements=>{sqlite.prepare('DELETE FROM workflow_snapshots').run();return batch(statements);};
 await assert.rejects(send(db,body(s)),e=>e.code==='cursor_expired');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM review_progress').get().n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_cards').get().n,0);
});

test('a correction preserves the logical reading position and remaining work is recomputed',async t=>{
 const {db}=await setup(t),s=await read(db);await send(db,body(s));
 const card=s.reviewCards.find(c=>c.id==='wfc_budget');
 await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{operation:'edit',expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,members:[{...card.memberRefs[0],operation:'edit',newText:'预算四十万',origin:'user_input',evidenceRefIds:[]}]},'edit');
 const current=await read(db);assert.equal(current.reviewProgress.lastCardId,'wfc_budget');assert.equal(current.bullets.find(b=>b.id==='budget').text,'预算四十万');
 await assert.rejects(send(db,body(s)),e=>e.code==='cursor_expired');
});
