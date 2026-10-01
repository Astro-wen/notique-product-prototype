import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readAnalysisRun,retryAnalysis,startAnalysis} from '../lib/server/workflow/analysis-service.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
const plus=n=>new Date(Date.parse(T)+n).toISOString();
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();return f;}
function failedRun(sql){sql.prepare("UPDATE extraction_runs SET status='failed',error_code='MODEL_PROVIDER_REQUEST_FAILED',updated_at=? WHERE id='run'").run(T);insert(sql,'queue_outbox',{id:'out',run_id:'run',payload_hash:'test',payload_json:'{"run_id":"run"}',status:'sent',attempt:3,next_attempt_at:T});}
function stage(sql,id,name,status,attempt=1){insert(sql,'extraction_model_stages',{id,run_id:'run',stage:name,attempt,provider:'test',model:'test',reasoning_effort:'high',prompt_version:'test',schema_version:'test',input_hash:'test',status,validated_output_json:status==='succeeded'?'{}':null,error_code:status==='failed'?'MODEL_PROVIDER_REQUEST_FAILED':null,provider_request_id:`response_${id}`,started_at:T,updated_at:T});}
function artifact(sql,id,status='failed'){insert(sql,'event_ai_artifact_runs',{id,workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',kind:'summary',status,idempotency_key:id,input_hash:'summary',input_manifest_json:'[{"asset_version_id":"av"}]',provider:'test',model:'test',reasoning_effort:'high',prompt_version:'test',schema_version:'test',next_attempt_at:T,queued_at:T,updated_at:T,error_code:status==='failed'?'MODEL_OUTPUT_INVALID':null});}
const code=value=>e=>e.code===value;
function creator(f){let calls=0;return {get calls(){return calls;},async create(input){calls++;const id=`created_${calls}`;await f.db.batch([
 f.db.prepare(`INSERT INTO mutation_guards (id,guard_value) SELECT ?,CASE WHEN ${input.guard.sql} THEN 1 ELSE 0 END`).bind(`creation_${calls}`,...input.guard.values),
 f.db.prepare(`INSERT INTO extraction_runs (id,workspace_id,project_id,event_id,status,idempotency_key,input_hash,input_snapshot_hash,input_manifest_json,context_version,context_snapshot_hash,prompt_version,schema_version,parser_version,model_params_json,created_at,updated_at) VALUES (?,'ws','p','e','queued',?,'new','new',?,0,'new','new','new','new',?,?,?)`).bind(id,input.key,JSON.stringify(input.assetVersionIds.map(id=>({asset_version_id:id}))),JSON.stringify({workflow_source_revision:input.sourceRevision}),plus(calls),plus(calls)),
 f.db.prepare(`INSERT INTO queue_outbox (id,run_id,payload_hash,payload_json,next_attempt_at) VALUES (?,?,'new','{}',?)`).bind(`out_${calls}`,id,T),
 f.db.prepare("UPDATE events SET active_run_id=? WHERE id='e'").bind(id),input.replay(id),f.db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(`creation_${calls}`)]);return {id};}};}

test('analysis progress is a read-only exact-version adapter with source coverage',async t=>{
 const {db,sqlite}=await setup(t);const before=sqlite.prepare('SELECT total_changes() n').get().n;const first=await readAnalysisRun(db,SCOPE,'run');const next=await readAnalysisRun(db,SCOPE,'run');
 assert.deepEqual(first,next);assert.equal(first.state,'succeeded');assert.equal(first.coverage.complete,true);assert.equal(first.coverage.completedSegments,1);assert.equal(first.retryable,false);assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
 stage(sqlite,'inventory','inventory','succeeded');stage(sqlite,'verify','verify','processing');const changed=await readAnalysisRun(db,SCOPE,'run');assert.notEqual(changed.revision,first.revision);assert.equal(changed.stages[0].name,'提取重点');assert.equal(changed.stages[1].state,'running');
});
test('failed verification retries without erasing successful inventory or its provider ID',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);stage(sqlite,'inventory','inventory','succeeded');stage(sqlite,'verify','verify','failed');
 const paid=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE id='inventory'").get();const before=await readAnalysisRun(db,SCOPE,'run');
 assert.equal(before.stages[0].retryable,false);assert.equal(before.stages[1].retryable,true);
 const body={expectedRunRevision:before.revision,stageIds:['verify']};const after=await retryAnalysis(db,SCOPE,'run',body,'retry',plus(1));
 assert.equal(after.state,'queued');assert.deepEqual(sqlite.prepare("SELECT * FROM extraction_model_stages WHERE id='inventory'").get(),paid);assert.equal(sqlite.prepare("SELECT status FROM queue_outbox").get().status,'pending');assert.equal(sqlite.prepare("SELECT attempt FROM queue_outbox").get().attempt,0);
 const same=await retryAnalysis(db,SCOPE,'run',body,'retry',plus(2));assert.equal(same.id,after.id);assert.equal(sqlite.prepare('SELECT count(*) n FROM extraction_runs').get().n,1);
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{...body,stageIds:['inventory']},'retry'),code('idempotency_conflict'));
});
test('an automatic retry is visible while keeping the paid history and latest stage identity',async t=>{
 const {db,sqlite}=await setup(t);
 sqlite.prepare("UPDATE extraction_runs SET status='processing' WHERE id='run'").run();
 stage(sqlite,'inventory','inventory','succeeded');stage(sqlite,'verify_old','verify','failed');stage(sqlite,'verify_retry','verify','processing',2);
 const before=sqlite.prepare('SELECT total_changes() n').get().n;
 const run=await readAnalysisRun(db,SCOPE,'run');
 assert.equal(run.state,'running');
 assert.equal(run.stages.find(s=>s.id==='verify_retry').name,'核对出处 · 自动重试');
 assert.equal(run.stages.some(s=>s.id==='verify_old'),false);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM extraction_model_stages WHERE stage='verify'").get().n,2);
 assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
 sqlite.prepare("UPDATE extraction_model_stages SET status='succeeded',validated_output_json='{}' WHERE id='verify_retry'").run();
 const complete=await readAnalysisRun(db,SCOPE,'run');
 assert.equal(complete.stages.find(s=>s.id==='verify_retry').name,'核对出处');
});
test('retry rejects stale progress and successful or foreign stage IDs',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);stage(sqlite,'inventory','inventory','succeeded');stage(sqlite,'verify','verify','failed');const before=await readAnalysisRun(db,SCOPE,'run');
 for(const id of ['inventory','other'])await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:before.revision,stageIds:[id]},id),code('dependency_conflict'));
 sqlite.prepare("UPDATE extraction_model_stages SET updated_at=? WHERE id='verify'").run(plus(1));
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:before.revision,stageIds:['verify']},'stale'),code('version_conflict'));
 assert.equal(sqlite.prepare('SELECT status FROM queue_outbox').get().status,'sent');
});
test('source or accepted-context changes require reorganizing instead of reviving old analysis',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);stage(sqlite,'verify','verify','failed');
 sqlite.prepare('UPDATE projects SET context_version=1').run();let r=await readAnalysisRun(db,SCOPE,'run');assert.equal(r.retryable,false);
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:['verify']},'context'),code('dependency_conflict'));
 sqlite.prepare('UPDATE projects SET context_version=0').run();sqlite.prepare('UPDATE assets SET current_version_id=NULL').run();r=await readAnalysisRun(db,SCOPE,'run');assert.equal(r.coverage.complete,false);assert.equal(r.retryable,false);
});
test('authorization applies to reads, retries and replays without leaking stage details',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);const r=await readAnalysisRun(db,SCOPE,'run');
 insert(sqlite,'workspace_members',{id:'viewer',workspace_id:'ws',actor_id:'viewer',role:'viewer'});
 await assert.rejects(retryAnalysis(db,{...SCOPE,actorId:'viewer'},'run',{expectedRunRevision:r.revision,stageIds:[r.stages[0].id]},'view'),code('forbidden'));
 for(const scope of [{...SCOPE,actorId:'stranger'},{...SCOPE,workspaceId:'foreign'}])await assert.rejects(readAnalysisRun(db,scope,'run'),code('not_found'));
 await retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:[r.stages[0].id]},'saved');
 sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T,'owner');
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:[r.stages[0].id]},'saved'),code('not_found'));
});
test('source and permission races roll back the complete retry',async()=>{
 for(const mutate of [sql=>sql.prepare('UPDATE assets SET current_version_id=NULL').run(),sql=>sql.prepare("UPDATE workspace_members SET role='viewer'").run()]){
  const f=await workflowDatabase();try{seed(f.sqlite);failedRun(f.sqlite);const r=await readAnalysisRun(f.db,SCOPE,'run');let once=true;const original=f.db.batch;f.db.batch=async stmts=>{if(once){once=false;mutate(f.sqlite);}return original(stmts);};
  await assert.rejects(retryAnalysis(f.db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:[r.stages[0].id]},'race'),e=>['version_conflict','forbidden'].includes(e.code));assert.equal(f.sqlite.prepare("SELECT status FROM extraction_runs WHERE id='run'").get().status,'failed');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM mutation_replays').get().n,0);
  }finally{f.close();}
 }
});
test('initial analysis reuses exact saved input and never calls the creator on reads or retries',async t=>{
 const f=await setup(t),adapter=creator(f);const r=await startAnalysis(f.db,SCOPE,'e',{sourceRevision:0,mode:'initial'},'initial',adapter.create,T);
 assert.equal(r.id,'run');assert.equal(adapter.calls,0);assert.equal(f.sqlite.prepare('SELECT context_version FROM projects').get().context_version,0);
 await startAnalysis(f.db,SCOPE,'e',{sourceRevision:0,mode:'initial'},'initial',adapter.create,T);assert.equal(adapter.calls,0);
 await assert.rejects(startAnalysis(f.db,SCOPE,'e',{sourceRevision:0,mode:'reorganize'},'initial',adapter.create,T),code('idempotency_conflict'));
});
test('explicit reorganization persists one new run and keeps old drafts readable',async t=>{
 const f=await setup(t),adapter=creator(f),body={sourceRevision:0,mode:'reorganize'};
 const r=await startAnalysis(f.db,SCOPE,'e',body,'reorganize',adapter.create,T);assert.equal(r.id,'created_1');assert.equal(r.state,'queued');assert.equal(adapter.calls,1);
 const same=await startAnalysis(f.db,SCOPE,'e',body,'reorganize',adapter.create,T);assert.equal(same.id,r.id);assert.equal(adapter.calls,1);
 const active=await startAnalysis(f.db,SCOPE,'e',body,'another-key',adapter.create,T);assert.equal(active.id,r.id);assert.equal(adapter.calls,1);
 const workspace=await readWorkspace(f.db,SCOPE,'e',{},T);assert.equal(workspace.bullets.length,3);assert.equal(workspace.coverage.complete,false);
 assert.equal(JSON.parse(f.sqlite.prepare("SELECT response_json FROM mutation_replays WHERE idempotency_key='reorganize'").get().response_json).runId,r.id);
});
test('start checks current revision, material readiness and edit permissions before commissioning',async t=>{
 const f=await setup(t),adapter=creator(f);
 await assert.rejects(startAnalysis(f.db,SCOPE,'e',{sourceRevision:1,mode:'reorganize'},'stale',adapter.create),code('version_conflict'));
 f.sqlite.prepare("UPDATE events SET material_status='draft'").run();await assert.rejects(startAnalysis(f.db,SCOPE,'e',{sourceRevision:0,mode:'reorganize'},'draft',adapter.create),code('dependency_conflict'));
 f.sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();await assert.rejects(startAnalysis(f.db,SCOPE,'e',{sourceRevision:0,mode:'reorganize'},'viewer',adapter.create),code('forbidden'));assert.equal(adapter.calls,0);
});
test('failed summary gets a fresh job while successful source analysis and paid history stay intact',async t=>{
 const {db,sqlite}=await setup(t);artifact(sqlite,'summary');const r=await readAnalysisRun(db,SCOPE,'run');assert.equal(r.state,'partial');assert.equal(r.coverage.complete,true);
 const next=await retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:['summary']},'summary-retry',plus(1));
 assert.equal(next.state,'partial');assert.equal(sqlite.prepare("SELECT status FROM extraction_runs WHERE id='run'").get().status,'succeeded');assert.equal(sqlite.prepare("SELECT status FROM event_ai_artifact_runs WHERE id='summary'").get().status,'failed');
 const fresh=sqlite.prepare("SELECT * FROM event_ai_artifact_runs WHERE id<>'summary'").get();assert.equal(fresh.status,'queued');assert.equal(fresh.provider_request_id,null);assert.equal(fresh.reasoning_effort,'high');assert.equal(fresh.input_hash,'summary');
});
test('failed narrative appends a new job and preserves old audit and recoverable response',async t=>{
 const {db,sqlite}=await setup(t);const payload={eventId:'e',contextVersion:0,auditUsage:[{inputTokens:15}],checkpoint:{providerResponseId:'resp_resume',startedAt:T,attempt:1,transportFailures:3}};
 insert(sqlite,'workflow_outbox',{id:'narrative',workspace_id:'ws',project_id:'p',event_id:'e',kind:'narrative',task_key:'failed',input_revision:0,payload_json:JSON.stringify(payload),state:'failed',available_at:T,created_at:T,updated_at:T,error_code:'NARRATIVE_RETRY_EXHAUSTED'});
 const r=await readAnalysisRun(db,SCOPE,'run');await retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:['narrative']},'narrative-retry',plus(1));
 const old=sqlite.prepare("SELECT * FROM workflow_outbox WHERE id='narrative'").get();assert.equal(old.state,'failed');assert.deepEqual(JSON.parse(old.payload_json),payload);
 const fresh=sqlite.prepare("SELECT * FROM workflow_outbox WHERE id<>'narrative'").get();assert.equal(fresh.state,'queued');assert.equal(JSON.parse(fresh.payload_json).checkpoint.providerResponseId,'resp_resume');assert.equal(JSON.parse(fresh.payload_json).checkpoint.transportFailures,0);
});

test('retry respects the frozen workspace concurrency limit atomically',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);const r=await readAnalysisRun(db,SCOPE,'run');
 insert(sqlite,'events',{id:'other',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'Other',occurred_at:T,sequence_no:2});
 insert(sqlite,'extraction_runs',{id:'busy',workspace_id:'ws',project_id:'p',event_id:'other',status:'queued',idempotency_key:'busy',input_hash:'busy',input_snapshot_hash:'busy',input_manifest_json:'[]',context_version:0,context_snapshot_hash:'busy',prompt_version:'test',schema_version:'test',parser_version:'test'});
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:[r.stages[0].id]},'limited',T,{maxConcurrentRuns:1}),code('run_limit'));
 assert.equal(sqlite.prepare("SELECT status FROM extraction_runs WHERE id='run'").get().status,'failed');assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_replays').get().n,0);
});
test('revoking permission inside commissioning leaves no new run, queue, or receipt',async t=>{
 const f=await setup(t),adapter=creator(f);
 const create=async input=>{f.sqlite.prepare("UPDATE workspace_members SET revoked_at=?").run(T);return adapter.create(input);};
 await assert.rejects(startAnalysis(f.db,SCOPE,'e',{sourceRevision:0,mode:'reorganize'},'revoked',create,T));
 assert.equal(f.sqlite.prepare('SELECT count(*) n FROM extraction_runs').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM queue_outbox').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM mutation_replays').get().n,0);assert.equal(f.sqlite.prepare("SELECT active_run_id FROM events WHERE id='e'").get().active_run_id,'run');
});


test('a tracked source revision change blocks stage retry even with the same asset IDs',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);sqlite.prepare("UPDATE extraction_runs SET model_params_json='{\"workflow_source_revision\":0}'").run();sqlite.prepare('UPDATE events SET source_revision=1').run();
 const r=await readAnalysisRun(db,SCOPE,'run');assert.equal(r.inputRevision,0);assert.equal(r.retryable,false);
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:[r.stages[0].id]},'stale'),code('dependency_conflict'));
});


test('invalid published checkpoints direct the user to reorganize instead of replaying the same bad output',async t=>{
 const {db,sqlite}=await setup(t);failedRun(sqlite);stage(sqlite,'inventory','inventory','succeeded');stage(sqlite,'verify','verify','succeeded');sqlite.prepare("UPDATE extraction_runs SET error_code='EVIDENCE_VALIDATION_FAILED'").run();
 const r=await readAnalysisRun(db,SCOPE,'run');assert.equal(r.retryable,false);assert.ok(r.stages.some(s=>s.state==='failed'));
 await assert.rejects(retryAnalysis(db,SCOPE,'run',{expectedRunRevision:r.revision,stageIds:[r.stages.at(-1).id]},'invalid'),code('dependency_conflict'));
});
