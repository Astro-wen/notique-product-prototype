import test from 'node:test';
import assert from 'node:assert/strict';
import { materialAnalysisStatements, consumeMaterialAnalysisJobs } from '../lib/server/workflow/material-analysis.ts';
import { workflowDatabase, seed, insert, T, SCOPE } from './helpers/workflow-database.mjs';
const at = ms => new Date(Date.parse(T)+ms).toISOString();
async function setup(t,{existing=false}={}) {
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
 f.sqlite.prepare("UPDATE events SET material_status='ready'").run();
 if(!existing) {f.sqlite.exec("DELETE FROM claims; DELETE FROM extraction_runs; UPDATE events SET active_run_id=NULL");}
 return f;
}
async function submit(f,asset='asset',version='av',time=T) {
 await f.db.batch(materialAnalysisStatements(f.db,SCOPE,'e',asset,version,time));
}
const job=f=>f.sqlite.prepare("SELECT * FROM workflow_outbox WHERE kind='initial_analysis' ORDER BY input_revision DESC LIMIT 1").get();
function adapter(f,clock=()=>at(3000)) {
 let calls=0;
 return {get calls(){return calls},clock,create:async input=>{
  calls++;const id=`new_${calls}`;const g=`guard_${calls}`;
  await f.db.batch([
   f.db.prepare(`INSERT INTO mutation_guards (id,guard_value,created_at) SELECT ?,CASE WHEN ${input.guard.sql} THEN 1 ELSE 0 END,?`).bind(g,...input.guard.values,clock()),
   f.db.prepare(`INSERT INTO extraction_runs (id,workspace_id,project_id,event_id,status,idempotency_key,input_hash,input_snapshot_hash,input_manifest_json,context_version,context_snapshot_hash,prompt_version,schema_version,parser_version,model_params_json) VALUES (?,'ws','p','e','queued',?,'test','test',?,0,'test','test','test','test',?)`).bind(id,input.key,JSON.stringify(input.assetVersionIds.map(asset_version_id=>({asset_version_id}))),JSON.stringify({workflow_source_revision:input.sourceRevision,event_summary:false})),
   f.db.prepare("INSERT INTO queue_outbox (id,run_id,payload_hash,payload_json,next_attempt_at) VALUES (?,?,'test','{}',?)").bind(`out_${calls}`,id,clock()),
   f.db.prepare("UPDATE events SET active_run_id=? WHERE id='e'").bind(id),input.replay(id),
   f.db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(g),
  ]);return {id};
 }};
}
function extraAsset(f,{id='extra',kind='text',status='ready',metadata={}}={}) {
 insert(f.sqlite,'assets',{id,workspace_id:'ws',project_id:'p',event_id:'e',kind,filename:`${id}.txt`,current_version_id:status==='ready'?`${id}_av`:null,processing_status:status,metadata_json:JSON.stringify(metadata)});
 if(status==='ready')insert(f.sqlite,'asset_versions',{id:`${id}_av`,asset_id:id,version_no:1,content_sha256:id,mime_type:'text/plain',size_bytes:30,r2_original_key:`synthetic/${id}`,finalized_at:T});
}

test('material finalization and its intent commit with revision and invalidation atomically',async t=>{
 const f=await setup(t);
 insert(f.sqlite,'workflow_narratives',{id:'n',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',scope_kind:'draft',based_on_context_version:0,freshness:'current',input_hash:'test'});
 insert(f.sqlite,'workflow_snapshots',{id:'s',workspace_id:'ws',project_id:'p',event_id:'e',actor_id:'owner',context_version:0,source_revision:0,payload_json:'{}',expires_at:at(10000)});
 await assert.rejects(f.db.batch([...materialAnalysisStatements(f.db,SCOPE,'e','asset','av',T),f.db.prepare("INSERT INTO mutation_guards VALUES ('bad',0,?)").bind(T)]));
 assert.equal(f.sqlite.prepare('SELECT source_revision FROM events').get().source_revision,0);
 assert.equal(f.sqlite.prepare('SELECT freshness FROM workflow_narratives').get().freshness,'current');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,0);
 await submit(f);assert.equal(job(f).input_revision,1);assert.equal(job(f).state,'queued');assert.equal(f.sqlite.prepare('SELECT freshness FROM workflow_narratives').get().freshness,'stale');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_snapshots').get().n,0);
});
test('saved submission runs with no browser and native queue and receipt commit together',async t=>{
 const f=await setup(t);await submit(f);const runner=adapter(f);const r=await consumeMaterialAnalysisJobs(f.db,runner);
 assert.equal(r.commissioned,1);assert.equal(runner.calls,1);assert.equal(job(f).state,'succeeded');assert.equal(JSON.parse(job(f).payload_json).analysisRunId,'new_1');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM queue_outbox').get().n,1);
 await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,1);
});
test('a browser fast path already covering the submission is reused including terminal failure or stop',async t=>{
 for(const status of ['succeeded','queued','failed','cancelled']){
  const f=await setup(t,{existing:true});f.sqlite.prepare('UPDATE extraction_runs SET status=?').run(status);await submit(f);
  const runner=adapter(f);const r=await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(r.reused,1);assert.equal(runner.calls,0);assert.equal(JSON.parse(job(f).payload_json).analysisRunId,'run');
 }
});
test('closely submitted materials coalesce into one exact latest manifest',async t=>{
 const f=await setup(t);await submit(f);extraAsset(f);await submit(f,'extra','extra_av',at(200));const runner=adapter(f);
 assert.equal(f.sqlite.prepare("SELECT state FROM workflow_outbox WHERE input_revision=1").get().state,'cancelled');
 await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,1);assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT input_manifest_json FROM extraction_runs').get().input_manifest_json).map(a=>a.asset_version_id),['av','extra_av']);
});
test('uploads still in progress defer without transport attempts and resume once ready',async t=>{
 const f=await setup(t);await submit(f);extraAsset(f,{status:'uploading'});const runner=adapter(f);
 await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,0);assert.equal(job(f).state,'queued');assert.equal(job(f).attempt,0);
 f.sqlite.prepare("UPDATE assets SET processing_status='ready',current_version_id='extra_av' WHERE id='extra'").run();insert(f.sqlite,'asset_versions',{id:'extra_av',asset_id:'extra',version_no:1,content_sha256:'extra',mime_type:'text/plain',size_bytes:20,r2_original_key:'synthetic/extra',finalized_at:T});
 await consumeMaterialAnalysisJobs(f.db,adapter(f,()=>at(9000)));assert.equal(job(f).state,'succeeded');
});
test('audio waits for its current derived transcript while internal chunks create no intents',async t=>{
 const f=await setup(t);extraAsset(f,{id:'audio',kind:'audio'});extraAsset(f,{id:'chunk',kind:'audio',metadata:{analysis_source:false,transcription_chunk:true}});
 await submit(f,'audio','audio_av');await submit(f,'chunk','chunk_av');assert.equal(f.sqlite.prepare('SELECT source_revision FROM events').get().source_revision,1);
 const runner=adapter(f);await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,0);
 extraAsset(f,{id:'transcript',kind:'transcript',metadata:{source_audio_asset_version_id:'audio_av'}});await submit(f,'transcript','transcript_av');assert.equal(f.sqlite.prepare('SELECT source_revision FROM events').get().source_revision,1);
 await consumeMaterialAnalysisJobs(f.db,adapter(f,()=>at(9000)));assert.equal(job(f).state,'succeeded');assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT input_manifest_json FROM extraction_runs').get().input_manifest_json).map(a=>a.asset_version_id),['av','transcript_av']);
});
test('archive, deletion or movement cancels the saved submission instead of commissioning',async t=>{
 for(const sql of ["UPDATE events SET material_status='archived'","UPDATE projects SET deleted_at='deleted'","INSERT INTO projects (id,workspace_id,name) VALUES ('p2','ws','Other'); UPDATE events SET project_id='p2'"]){
  const f=await setup(t);await submit(f);f.sqlite.exec(sql);const runner=adapter(f);await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,0);assert.equal(job(f).state,'cancelled');
 }
});
test('source changes during handoff roll back the run and queue without losing the successor intent',async t=>{
 const f=await setup(t);await submit(f);const runner=adapter(f);const native=runner.create;runner.create=async input=>{extraAsset(f);await submit(f,'extra','extra_av',at(3100));return native(input);};
 await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM extraction_runs').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM queue_outbox').get().n,0);
 assert.equal(job(f).input_revision,2);assert.equal(job(f).state,'queued');
 await consumeMaterialAnalysisJobs(f.db,adapter(f,()=>at(9000)));assert.equal(job(f).state,'succeeded');
});
test('expired leases can be reclaimed and the displaced worker cannot acknowledge or create a run',async t=>{
 const f=await setup(t);await submit(f);const old=adapter(f);const native=old.create;let replacement;
 old.create=async input=>{replacement=adapter(f,()=>at(44000));await consumeMaterialAnalysisJobs(f.db,replacement);return native(input);};
 await consumeMaterialAnalysisJobs(f.db,old);assert.equal(replacement.calls,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM extraction_runs').get().n,1);assert.equal(job(f).state,'succeeded');assert.equal(job(f).fencing_token,2);
});
test('creation acknowledgement survives a lost response without paying or queueing twice',async t=>{
 const f=await setup(t);await submit(f);const runner=adapter(f);const native=runner.create;runner.create=async input=>{await native(input);throw new Error('response lost');};
 await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(job(f).state,'succeeded');await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM queue_outbox').get().n,1);
});
test('unrelated reading creates no intent and scoped recovery cannot commission another communication',async t=>{
 const f=await setup(t);const runner=adapter(f);await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(runner.calls,0);
 await submit(f);await consumeMaterialAnalysisJobs(f.db,runner,{workspaceId:'other'});await consumeMaterialAnalysisJobs(f.db,runner,{workspaceId:'ws',eventId:'other'});assert.equal(runner.calls,0);assert.equal(job(f).state,'queued');
});
test('temporary handoff failures are bounded while workspace capacity does not spend an attempt',async t=>{
 const f=await setup(t);await submit(f);let clock=at(3000);const runner={clock:()=>clock,create:async()=>{throw Object.assign(new Error('busy'),{code:'WORKSPACE_RUN_LIMIT'});}};
 await consumeMaterialAnalysisJobs(f.db,runner);assert.equal(job(f).attempt,0);assert.equal(job(f).state,'queued');
 runner.create=async()=>{throw new Error('unavailable')};for(const time of [9000,40000,90000]){clock=at(time);await consumeMaterialAnalysisJobs(f.db,runner);}assert.equal(job(f).attempt,3);assert.equal(job(f).state,'failed');
});
