import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {readProjectOverview} from '../lib/server/workflow/overview-service.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {saveReviewProgress} from '../lib/server/workflow/review-progress.ts';
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
const overview=(db,scope=SCOPE,q={},now=T)=>readProjectOverview(db,scope,'p',q,now);
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
async function edit(db,text,key=crypto.randomUUID()) {
 const s=await read(db),c=s.reviewCards.find(c=>c.id==='wfc_budget');
 return dispatchWorkflowCommand(db,SCOPE,['review-cards',c.id,'decisions'],{expectedContextVersion:s.contextVersion,expectedCardRevision:c.revision,operation:'edit',members:[{...c.memberRefs[0],operation:'edit',newText:text,origin:'user_input',evidenceRefIds:[]}]},key);
}
function secondRecord(sqlite) {
 insert(sqlite,'events',{id:'e2',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'第二次报价沟通',occurred_at:'2026-09-29T10:00:00.000Z',sequence_no:2,active_run_id:'run2'});
 insert(sqlite,'extraction_runs',{id:'run2',workspace_id:'ws',project_id:'p',event_id:'e2',status:'succeeded',idempotency_key:'seed2',input_hash:'seed2',input_snapshot_hash:'seed2',input_manifest_json:'[]',context_version:0,context_snapshot_hash:'seed2',prompt_version:'seed',schema_version:'seed',parser_version:'seed'});
 claim(sqlite,'answer','other','报价十二万元',{status:'verified'});
 sqlite.prepare("UPDATE claims SET event_id='e2',first_event_id='e2',extraction_run_id='run2' WHERE id='answer'").run();
 // An attributed human note can belong to the new communication while answering
 // a question raised in the old one.
 insert(sqlite,'user_notes',{id:'note2',workspace_id:'ws',project_id:'p',claim_id:'answer',body:'报价十二万元',verdict_id:'note-verdict',author_id:'owner'});
 sqlite.prepare("UPDATE evidence_refs SET event_id='e2',kind='user_note',user_note_id='note2',asset_version_id=NULL WHERE claim_version_id='answer_v1'").run();
 relation(sqlite,'answered','answer','question','resolves');
}

test('overview keeps complete drafts without requiring review and reads no model jobs',async t=>{
 const {db,sqlite}=await setup(t),s=await overview(db);assert.equal(s.currentBullets.length,3);assert.equal(s.counts.draftCount,3);assert.equal(s.counts.needsDecisionCount,1);assert.equal(s.openQuestions.length,1);assert.equal(s.nextActions.length,0);
 assert.equal(s.recordSummaries[0].coverage.complete,true);assert.equal(s.access.canEdit,true);assert.deepEqual(s.recentChanges,[]);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,0);
});

test('overview exposes the first real upload date separately from the meeting date',async t=>{
 const {db,sqlite}=await setup(t);
 sqlite.prepare("UPDATE events SET occurred_at='2026-09-23T12:00:00Z',created_at='2026-10-01T12:00:00Z' WHERE id='e'").run();
 sqlite.prepare("UPDATE assets SET created_at='2026-10-06T12:00:00Z' WHERE id='asset'").run();
 insert(sqlite,'assets',{id:'generated-date',workspace_id:'ws',project_id:'p',event_id:'e',kind:'transcript',filename:'generated.txt',metadata_json:JSON.stringify({artifact_kind:'raw_transcript'}),created_at:'2026-10-02T12:00:00Z'});
 insert(sqlite,'assets',{id:'aborted-date',workspace_id:'ws',project_id:'p',event_id:'e',kind:'text',filename:'failed.txt',failure_code:'UPLOAD_ABORTED',created_at:'2026-10-03T12:00:00Z'});
 const record=(await overview(db)).recordSummaries.find(r=>r.eventId==='e');
 assert.equal(record.uploadedAt,'2026-10-06T12:00:00Z');
 assert.equal(record.occurredAt,'2026-09-23T12:00:00Z');
 assert.equal(record.createdAt,'2026-10-01T12:00:00Z');
});

test('answers from a newer communication replace the old question once and retain their source communication',async t=>{
 const {db,sqlite}=await setup(t);secondRecord(sqlite);
 const s=await overview(db);assert.equal(s.currentBullets.filter(b=>b.id==='answer').length,1);assert.equal(s.currentBullets.find(b=>b.id==='answer').eventId,'e2');assert.ok(!s.currentBullets.some(b=>b.id==='question'));assert.equal(s.openQuestions.length,0);assert.equal(s.recordSummaries[0].eventId,'e2');
 sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE id='answered'").run();const next=await overview(db);assert.equal(next.openQuestions[0].id,'question');assert.ok(next.currentBullets.some(b=>b.id==='question'));
});

test('recent changes freeze exact versions and wording while current bullets advance',async t=>{
 const {db}=await setup(t);await edit(db,'预算三十五万');await edit(db,'预算四十万');
 const s=await overview(db);assert.equal(s.currentBullets.find(b=>b.id==='budget').text,'预算四十万');assert.equal(s.recentChanges.length,2);
 const old=s.recentChanges.find(c=>c.text.includes('三十五万')),current=s.recentChanges.find(c=>c.text.includes('四十万'));
 assert.ok(old);assert.ok(current);assert.notEqual(old.claimRefs[0].claimVersionId,current.claimRefs[0].claimVersionId);assert.equal(old.eventId,'e');
});

test('reading progress is personal live metadata and does not expire overview pagination',async t=>{
 const {db,sqlite}=await setup(t);insert(sqlite,'workspace_members',{id:'viewer',workspace_id:'ws',actor_id:'viewer',role:'viewer'});const scope={...SCOPE,actorId:'viewer'};
 await edit(db,'预算三十五万');await edit(db,'预算四十万');const first=await overview(db,scope,{limit:1});assert.ok(first.nextCursor);
 const s=await readWorkspace(db,scope,'e',{},T);await saveReviewProgress(db,scope,'e',{snapshotId:s.snapshotId,lastCardId:'wfc_budget',mode:'finish_session'},'bookmark',T);
 const page=await overview(db,scope,{snapshotId:first.snapshotId,cursor:first.nextCursor,limit:1});assert.equal(page.snapshotId,first.snapshotId);assert.equal(page.recordSummaries[0].reviewProgress.lastCardId,'wfc_budget');assert.equal(page.recordSummaries[0].reviewProgress.finishedAt,T);assert.equal((await overview(db)).recordSummaries[0].reviewProgress.lastCardId,null);
});

test('current source, archive, move and permission state protect cached overview pages',async t=>{
 const {db,sqlite}=await setup(t);await edit(db,'预算三十五万');const first=await overview(db);
 await assert.rejects(overview(db,{...SCOPE,actorId:'stranger'},{snapshotId:first.snapshotId}),e=>e.code==='not_found');await assert.rejects(overview(db,{...SCOPE,workspaceId:'foreign'},{snapshotId:first.snapshotId}),e=>e.code==='not_found');
 sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);await assert.rejects(overview(db,SCOPE,{snapshotId:first.snapshotId}),e=>e.code==='not_found');sqlite.prepare('UPDATE workspace_members SET revoked_at=NULL').run();
 sqlite.prepare("UPDATE events SET material_status='archived' WHERE id='e'").run();await assert.rejects(overview(db,SCOPE,{snapshotId:first.snapshotId}),e=>e.code==='cursor_expired');const empty=await overview(db);assert.equal(empty.currentBullets.length,0);assert.equal(empty.recentChanges.length,0);
 sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();insert(sqlite,'projects',{id:'new',workspace_id:'ws',name:'Other'});sqlite.prepare("UPDATE events SET project_id='new' WHERE id='e'").run();await assert.rejects(overview(db,SCOPE,{snapshotId:first.snapshotId}),e=>e.code==='cursor_expired');
});

test('source invalidation conceals historical text and legacy changes never borrow current wording',async t=>{
 const {db,sqlite}=await setup(t);const s=await read(db),card=s.reviewCards.find(c=>c.id==='wfc_budget');
 await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{operation:'confirm',expectedContextVersion:0,expectedCardRevision:1,members:[{...card.memberRefs[0],operation:'confirm'}]},'confirm');const first=await overview(db);assert.match(first.recentChanges[0].text,/三十万/);
 sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();await assert.rejects(overview(db,SCOPE,{snapshotId:first.snapshotId}),e=>e.code==='cursor_expired');assert.doesNotMatch((await overview(db)).recentChanges[0].text,/三十万/);
 insert(sqlite,'workflow_changes',{id:'legacy',workspace_id:'ws',project_id:'p',event_id:'e',mutation_id:'legacy',context_version:0,actor_id:'owner',kind:'edit',changed_refs_json:'[{"entityType":"claim","id":"budget","revision":1}]',created_at:T});assert.equal((await overview(db)).recentChanges.find(c=>c.id==='legacy').text,'修改了重点');
});

test('overview stable cursors validate actor, expiry, bounds and target context',async t=>{
 const {db}=await setup(t),s=await overview(db);
 for(const cursor of ['-1','1.5','999','x'])await assert.rejects(overview(db,SCOPE,{snapshotId:s.snapshotId,cursor}),e=>e.code==='cursor_expired');
 await assert.rejects(overview(db,SCOPE,{snapshotId:s.snapshotId},'2026-09-28T10:16:00Z'),e=>e.code==='cursor_expired');await assert.rejects(overview(db,SCOPE,{minContextVersion:1}),e=>e.code==='snapshot_busy');
});
