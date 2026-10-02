import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { runIndependentTasks } from '../lib/server/jobs/independent-tasks.ts';
import { readingModelSnapshot, readingRouteIdentity, resolveModelConnection, modelBaseUrl } from '../lib/server/ai/model-route.ts';
import { workflowDatabase, seed, insert, SCOPE, T } from './helpers/workflow-database.mjs';
import { readAnalysisRun, retryAnalysis } from '../lib/server/workflow/analysis-service.ts';
import { READING_ARTIFACT_DEFINITIONS } from '../lib/domain/reading-pipeline.ts';
import { EVENT_AI_ARTIFACT_CONTRACTS, EVENT_AI_ARTIFACT_REASONING_EFFORTS } from '../lib/domain/event-ai-artifacts.ts';

// Execute the production functions with bounded fake lanes and the migrated
// SQLite database. No network or real model requests are involved.
async function functionsFrom(file,names,dependencies) {
  const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const selected=ast.statements.filter(node=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map(node=>node.getText(ast)).join('\n');
  assert.equal(selected.length>0,true);
  const compiled=ts.transpileModule(selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export /gm,'');
  return new Function(...Object.keys(dependencies),`${compiled}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const primary={AI_PROVIDER:'openai',AI_MODEL:'primary-test-model',AI_API_KEY:'primary-test-secret',AI_API_BASE_URL:'https://primary.example.test/v1'};

test('analysis wake starts every reading view while extraction remains unresolved',async()=>{
  const pending=[],calls=[];let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const {wakeWorkflowAnalysis}=await functionsFrom('lib/server/jobs/workflow-analysis.ts',['wakeWorkflowAnalysis'],{
    waitUntil:p=>pending.push(p),runIndependentTasks,
    getD1:()=>({prepare:()=>({bind:()=>({first:async()=>({status:'processing'})})})}),
    dispatchExtractionRun:async()=>{calls.push('extraction');await blocked;},
    dispatchEventAiArtifactsForExtraction:async()=>{calls.push('overview','chapters','speakers','key_points');},
    dispatchWorkflowOutbox:async()=>{calls.push('narrative');},
  });
  wakeWorkflowAnalysis('ws',{id:'run',stages:['overview','chapters','speakers','key_points'].map(id=>({id,name:id,state:'queued'}))});
  await tick();
  for(const id of ['overview','chapters','speakers','key_points','extraction'])assert.ok(calls.includes(id));
  let finished=false;pending[0].then(()=>{finished=true;});await tick();assert.equal(finished,false);
  release();await pending[0];
});

test('a failed or synchronously throwing lane leaves sibling publication running',async()=>{
  const failures=[],published=[];
  await runIndependentTasks([
    {name:'extraction',run:()=>{throw new Error('synthetic failure');}},
    ...['overview','chapters','speakers','key_points'].map(name=>({name,run:async()=>{published.push(name);}})),
  ],name=>failures.push(name));
  assert.deepEqual(failures,['extraction']);assert.equal(published.length,4);
});

test('material wake starts reading even while its commissioned extraction is pending',async()=>{
  const pending=[],calls=[];let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const {wakeMaterialAnalysis}=await functionsFrom('lib/server/jobs/material-analysis.ts',['wakeMaterialAnalysis'],{
    waitUntil:p=>pending.push(p),setTimeout:callback=>callback(),runIndependentTasks,
    commissionMaterialAnalysis:async()=>({runIds:[{workspaceId:'ws',runId:'run'}]}),
    dispatchExtractionRun:async()=>{calls.push('extraction');await blocked;},
    dispatchEventAiArtifactsForExtraction:async()=>{calls.push('reading');},
  });
  wakeMaterialAnalysis('ws','event');await tick();assert.deepEqual(calls,['extraction','reading']);
  release();await pending[0];
});

test('scheduled recovery dispatches newly commissioned reading jobs before extraction finishes',async()=>{
  const calls=[];let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const empty={};
  const {recoverAndDispatch}=await functionsFrom('lib/server/jobs/outbox.ts',['stage','recoverAndDispatch'],{
    EMPTY_TRANSCRIPTION_SWEEP:empty,EMPTY_SWEEP:empty,EMPTY_AUTOMATIC:empty,EMPTY_DISPATCH:empty,
    sweepTranscriptionJobs:async()=>empty,sweepJobs:async()=>empty,
    commissionMaterialAnalysis:async()=>{calls.push('commission');return {runIds:[]};},
    dispatchDueOutbox:async()=>{calls.push('extraction');await blocked;return empty;},
    dispatchDueEventAiArtifactRuns:async()=>{calls.push('reading');return empty;},
  });
  const running=recoverAndDispatch();await tick();assert.deepEqual(calls,['commission','extraction','reading']);
  release();await running;
});

test('reading defaults preserve the primary route while a model-only override stays isolated to reading',()=>{
  const route=readingModelSnapshot(primary,{provider:primary.AI_PROVIDER,model:primary.AI_MODEL});
  assert.deepEqual(route,{provider:'openai',model:'primary-test-model',providerProfile:'default',providerBaseUrl:primary.AI_API_BASE_URL});
  const changed={...primary,AI_READING_MODEL:'reading-test-model'};
  const cheap=readingModelSnapshot(changed,{provider:primary.AI_PROVIDER,model:primary.AI_MODEL});
  assert.equal(resolveModelConnection(changed,cheap).model,'reading-test-model');
  assert.equal(resolveModelConnection(changed).model,'primary-test-model');
});

test('an independent provider or endpoint never receives the primary key',()=>{
  for(const override of [
    {AI_READING_PROVIDER:'qwen',AI_READING_API_BASE_URL:'https://reading.example.test/v1'},
    {AI_READING_API_BASE_URL:'https://reading.example.test/v1'},
    {AI_READING_PROVIDER:'openai'},
  ]){
    const configured={...primary,...override,AI_READING_MODEL:'reading-test-model'};
    const route=readingModelSnapshot(configured,{provider:'openai',model:'primary-test-model'});
    assert.equal(resolveModelConnection(configured,route),null);
    const connection=resolveModelConnection({...configured,AI_READING_API_KEY:'reading-test-secret'},route);
    assert.equal(connection.apiKey,'reading-test-secret');
    assert.equal(JSON.stringify(route).includes('secret'),false);
  }
});

test('a frozen reading response cannot be resumed against a changed provider or endpoint',()=>{
  const configured={...primary,AI_READING_PROVIDER:'openai',AI_READING_API_KEY:'reading-test-secret',AI_READING_API_BASE_URL:'https://reading.example.test/v1',AI_READING_MODEL:'reading-test-model'};
  const frozen=readingModelSnapshot(configured,{provider:'openai',model:'primary-test-model'});
  assert.equal(resolveModelConnection({...configured,AI_READING_API_BASE_URL:'https://new.example.test/v1'},frozen),null);
  assert.equal(resolveModelConnection({...configured,AI_READING_PROVIDER:'qwen'},frozen),null);
  assert.equal(resolveModelConnection({...configured,AI_READING_API_KEY:undefined},frozen),null);
  assert.equal(resolveModelConnection({...configured,AI_READING_MODEL:'new-test-model',AI_READING_API_KEY:'rotated-test-secret'},frozen).model,'reading-test-model');
  assert.equal(resolveModelConnection(primary,{provider:'qwen',model:'old'}),null);
  for(const url of ['https://user:password@example.test/v1','https://example.test/v1?key=secret','file:///tmp/provider'])assert.equal(modelBaseUrl('custom',url),null);
  const accountOnly={...primary,AI_READING_API_KEY:'separate-account-secret'};
  const accountRoute=readingModelSnapshot(accountOnly,{provider:'openai',model:'primary-test-model'});
  assert.equal(resolveModelConnection(primary,accountRoute),null);
});

test('four independent persisted reading jobs carry only the frozen reading route',async t=>{
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  const bindings={...primary,AI_READING_PROVIDER:'qwen',AI_READING_MODEL:'reading-test-model',AI_READING_API_BASE_URL:'https://reading.example.test/v1',AI_READING_API_KEY:'reading-test-secret'};
  let n=0;
  const {prepareEventAiArtifactRuns,sourceSegmentsForArtifactRun}=await functionsFrom('lib/server/db/event-ai-artifact-repository.ts',['prepareEventAiArtifactRuns','sourceSegmentsForArtifactRun'],{
    getBindings:()=>bindings,getD1:()=>f.db,readingModelSnapshot,readingRouteIdentity,parseJson:JSON.parse,
    now:()=>T,id:()=>`artifact_${++n}`,hashText:async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex'),
    READING_ARTIFACT_DEFINITIONS,EVENT_AI_ARTIFACT_CONTRACTS,EVENT_AI_ARTIFACT_REASONING_EFFORTS,
    first:async(sql,values)=>f.db.prepare(sql).bind(...values).first(),
    all:async(sql,values)=>(await f.db.prepare(sql).bind(...values).all()).results,
    ARTIFACT_MANIFEST_KINDS:new Set(['transcript','photo','pdf','text']),
    RAW_ARTIFACT_SOURCE_ASSET_PREDICATE:"a.kind IN ('transcript','text')",
  });
  const input={workspaceId:'ws',projectId:'p',eventId:'e',extractionRunId:'run',inputManifestJson:'[{"kind":"text","asset_version_id":"av","sha256":"synthetic","parser_version":null}]',provider:'openai',model:'primary-test-model'};
  const batch=await prepareEventAiArtifactRuns(input);await f.db.batch(batch.statements);
  const rows=f.sqlite.prepare('SELECT * FROM event_ai_artifact_runs').all();assert.equal(rows.length,4);
  for(const row of rows){assert.equal(row.provider,'qwen');assert.equal(row.model,'reading-test-model');assert.equal(row.provider_profile,'reading');assert.equal(row.provider_base_url,bindings.AI_READING_API_BASE_URL);}
  assert.equal(JSON.stringify(rows).includes('test-secret'),false);
  for(const row of rows)assert.equal((await sourceSegmentsForArtifactRun(row.id)).segments.length,1);
  await f.db.batch((await prepareEventAiArtifactRuns(input)).statements);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM event_ai_artifact_runs').get().n,4);
  f.sqlite.prepare("UPDATE event_ai_artifact_runs SET provider_base_url='https://changed.example.test/v1' WHERE id=?").run(rows[0].id);
  await assert.rejects(sourceSegmentsForArtifactRun(rows[0].id),/ARTIFACT_INPUT_HASH_CHANGED/);
});

test('all four reading lanes start and a failed write does not end its running siblings',async()=>{
  const rows=['overview','chapters','speakers','key_points'].map(id=>({id})),calls=[];let release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const {dispatchDueEventAiArtifactRuns}=await functionsFrom('lib/server/jobs/event-ai-artifacts.ts',['dispatchDueEventAiArtifactRuns'],{
    now:()=>T,id:()=>crypto.randomUUID(),TARGET_LEASE_MS:100,CRON_LEASE_MS:100,
    getD1:()=>({prepare:()=>({bind:(...values)=>({all:async()=>{assert.equal(values.at(-1),4);return {results:rows};}})})}),
    leaseRun:async row=>row,
    processLeasedRun:async row=>{calls.push(row.id);if(row.id==='speakers')throw new Error('synthetic write failure');if(row.id==='chapters')await blocked;return 'succeeded';},
    console:{error(){}},
  });
  const dispatch=dispatchDueEventAiArtifactRuns({workspaceId:'ws',extractionRunId:'run'});
  await tick();assert.deepEqual(calls,rows.map(row=>row.id));
  let finished=false;dispatch.then(()=>{finished=true;});await tick();assert.equal(finished,false);
  release();assert.deepEqual(await dispatch,{claimed:4,succeeded:3,pending:0,failed:1});
});

test('deleting a record retains each provider route for cancellation after commit',async t=>{
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  f.sqlite.prepare("UPDATE extraction_runs SET status='processing' WHERE id='run'").run();
  insert(f.sqlite,'extraction_model_stages',{id:'strong',run_id:'run',stage:'inventory',attempt:1,provider:'openai',model:'primary-test-model',reasoning_effort:'high',prompt_version:'test',schema_version:'test',input_hash:'test',status:'processing',provider_request_id:'strong-paid-response',started_at:T,updated_at:T});
  insert(f.sqlite,'event_ai_artifact_runs',{id:'reading',workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',kind:'overview',status:'processing',idempotency_key:'reading',input_hash:'source',input_manifest_json:'[]',provider:'openai',model:'reading-test-model',provider_profile:'reading',provider_base_url:'https://reading.example.test/v1',reasoning_effort:'low',prompt_version:'test',schema_version:'test',next_attempt_at:T,queued_at:T,updated_at:T,provider_request_id:'reading-paid-response'});
  const cancelled=[];
  const configured={...primary,AI_READING_PROVIDER:'openai',AI_READING_MODEL:'reading-test-model',AI_READING_API_BASE_URL:'https://reading.example.test/v1',AI_READING_API_KEY:'reading-test-secret'};
  const {cancelBackgroundResponses,providerBaseUrl}=await functionsFrom('lib/server/ai/model-provider.ts',['cancelBackgroundResponses','providerBaseUrl'],{modelBaseUrl,resolveModelConnection});
  assert.equal(providerBaseUrl(primary),primary.AI_API_BASE_URL);
  const {activeProviderRequestIds,cancelRemoteResponses}=await functionsFrom('lib/server/db/run-cancellation-repository.ts',['activeProviderRequestIds','cancelRemoteResponses'],{
    getBindings:()=>configured,getD1:()=>f.db,cancelBackgroundResponses,
    fetch:async(url,init)=>{cancelled.push({url,authorization:init.headers.authorization});return new Response('{}');},
  });
  const requests=await activeProviderRequestIds('event','e','ws');
  assert.deepEqual(await activeProviderRequestIds('event','e','foreign'),[]);
  await cancelRemoteResponses(requests);
  assert.deepEqual(cancelled,[
    {url:'https://primary.example.test/v1/responses/strong-paid-response/cancel',authorization:'Bearer primary-test-secret'},
    {url:'https://reading.example.test/v1/responses/reading-paid-response/cancel',authorization:'Bearer reading-test-secret'},
  ]);
});

test('artifact retry retains its route and paid response checkpoint',async t=>{
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  insert(f.sqlite,'event_ai_artifact_runs',{id:'reading',workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',kind:'overview',status:'failed',idempotency_key:'reading',input_hash:'source',input_manifest_json:'[]',provider:'openai',model:'reading-test-model',provider_profile:'reading',provider_base_url:'https://reading.example.test/v1',reasoning_effort:'low',prompt_version:'test',schema_version:'test',next_attempt_at:T,queued_at:T,updated_at:T,error_code:'MODEL_PROVIDER_REQUEST_FAILED',provider_request_id:'paid-response'});
  const before=await readAnalysisRun(f.db,SCOPE,'run');
  await retryAnalysis(f.db,SCOPE,'run',{expectedRunRevision:before.revision,stageIds:['reading']},'retry',T);
  const retried=f.sqlite.prepare("SELECT * FROM event_ai_artifact_runs WHERE id<>'reading'").get();
  assert.equal(retried.provider_profile,'reading');assert.equal(retried.provider_base_url,'https://reading.example.test/v1');assert.equal(retried.provider_request_id,'paid-response');
  assert.equal(f.sqlite.prepare("SELECT status FROM extraction_runs WHERE id='run'").get().status,'succeeded');
});
