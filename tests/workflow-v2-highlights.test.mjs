import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {buildRecordText} from '../lib/domain/workflow-v2.ts';
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,body,key=crypto.randomUUID(),scope=SCOPE)=>dispatchWorkflowCommand(db,scope,['events','e','highlights'],body,key);
async function setup(t) {const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
const request=(version=0)=>({expectedContextVersion:version,assetVersionId:'av',ranges:[{segmentId:'seg',startOffset:0,endOffset:8}]});

test('source selection preserves exact text, origin, range, author and source without model calls',async t=>{
 const {db,sqlite}=await setup(t),body=request();const receipt=await send(db,body,'select');
 assert.deepEqual(await send(db,body,'select'),receipt);
 const s=await read(db),b=s.bullets.find(b=>b.origin==='user_selection');assert.equal(b.text,'预算大约三十万。');assert.equal(b.reviewState,'accepted');
 const v=sqlite.prepare('SELECT * FROM claim_versions WHERE id=?').get(b.claimRefs[0].claimVersionId);
 assert.equal(v.created_by,'owner');assert.equal(v.source,'human');assert.deepEqual(JSON.parse(v.normalized_value_json).source_selection,{assetVersionId:'av',ranges:body.ranges});
 const evidence=sqlite.prepare('SELECT * FROM evidence_refs WHERE claim_version_id=?').get(v.id);assert.equal(evidence.quote_raw,b.text);assert.equal(evidence.asset_version_id,'av');assert.equal(evidence.kind,'text');
 assert.match(buildRecordText({...s,title:'记录',scope:'mixed',format:'plain_text'}),/预算大约三十万/);
 assert.equal(sqlite.prepare("SELECT active_run_id FROM events WHERE id='e'").get().active_run_id,'run');
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,1);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM extraction_runs WHERE provider='human'").get().n,1);
});

test('split adjacent ranges deduplicate across actors and requests, without another claim, decision or refresh',async t=>{
 const {db,sqlite}=await setup(t);const first=await send(db,request());
 insert(sqlite,'workspace_members',{id:'second',workspace_id:'ws',actor_id:'second',role:'editor'});
 const body={...request(first.contextVersion),ranges:[{segmentId:'seg',startOffset:4,endOffset:8},{segmentId:'seg',startOffset:0,endOffset:4}]};
 const duplicate=await send(db,body,'different',{...SCOPE,actorId:'second'});
 assert.equal(duplicate.contextVersion,first.contextVersion);assert.deepEqual(duplicate.changedRefs,[first.changedRefs[0]]);
 assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM claim_versions WHERE workflow_origin='user_selection'").get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,1);
});

test('a raw selection works before an AI run and survives later active-run changes',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE events SET active_run_id=NULL WHERE id='e'").run();sqlite.prepare("DELETE FROM extraction_runs WHERE id='run'").run();
 await send(db,request());assert.equal((await read(db)).bullets[0].origin,'user_selection');
 sqlite.prepare("UPDATE events SET active_run_id='later' WHERE id='e'").run();assert.equal((await read(db)).bullets[0].origin,'user_selection');
});

for(const change of ["UPDATE assets SET current_version_id=NULL", "UPDATE assets SET metadata_json='{\"artifact_kind\":\"readable_transcript\"}'", "UPDATE assets SET metadata_json='{\"source_audio_asset_version_id\":\"missing\"}'", "UPDATE text_segments SET event_id='elsewhere'", "UPDATE assets SET metadata_json='{\"transcription_chunk\":1}'"]) test(`unavailable or generated sources cannot be selected: ${change}`,async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare(change).run();await assert.rejects(send(db,request()),e=>e.code==='version_conflict');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
});

test('caller text, foreign segment, split surrogate and out-of-range offsets cannot become accepted content',async t=>{
 const {db,sqlite}=await setup(t);
 await assert.rejects(send(db,{...request(),text:'伪造'}));
 await assert.rejects(send(db,{...request(),ranges:[{segmentId:'foreign',startOffset:0,endOffset:1}]}),e=>e.code==='version_conflict');
 await assert.rejects(send(db,{...request(),ranges:[{segmentId:'seg',startOffset:0,endOffset:300}]}));
 sqlite.prepare("UPDATE text_segments SET text_raw='😀原文' WHERE id='seg'").run();
 await assert.rejects(send(db,{...request(),ranges:[{segmentId:'seg',startOffset:0,endOffset:1}]}));
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
});

test('source changes during saving roll back human content and its run anchor',async t=>{
 const {db,sqlite}=await setup(t);const batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE text_segments SET text_raw='新原文' WHERE id='seg'").run();return batch(statements);};
 await assert.rejects(send(db,request()),e=>e.code==='version_conflict');assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM extraction_runs WHERE provider='human'").get().n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,0);
});

test('viewer and revoked actors cannot save or replay source selections',async t=>{
 const {db,sqlite}=await setup(t);const body=request();await send(db,body,'key');sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
 await assert.rejects(send(db,body,'key'),e=>e.code==='forbidden');await assert.rejects(send(db,request(1)),e=>e.code==='forbidden');
 sqlite.prepare("UPDATE workspace_members SET revoked_at=?").run(T);await assert.rejects(send(db,body,'key'),e=>e.code==='not_found');
});
