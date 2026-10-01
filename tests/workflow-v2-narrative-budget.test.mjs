import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,insert,T} from './helpers/workflow-database.mjs';
import {workflowNarrativeModelConfig} from '../lib/domain/workflow-narrative-config.ts';
import {consumeNarrativeJobs} from '../lib/server/workflow/narrative-jobs.ts';
import {WORKFLOW_NARRATIVE_SCHEMA_VERSION} from '../lib/domain/workflow-narrative.ts';

// Actual dispatcher, model adapter and persisted job lifecycle, with an
// isolated SQLite database, fake token and local response fixtures only.
const root=fileURLToPath(new URL('../',import.meta.url));
const bindingsModule='data:text/javascript,'+encodeURIComponent('export const getD1=()=>globalThis.notiqueNarrativeBudget.db;export const getBindings=()=>globalThis.notiqueNarrativeBudget.bindings;export const getEvidenceBucket=()=>({get:async()=>null});');
const workersModule='data:text/javascript,'+encodeURIComponent('export const waitUntil=()=>{};');
registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@/db')return {url:bindingsModule,shortCircuit:true};
  if(specifier==='cloudflare:workers')return {url:workersModule,shortCircuit:true};
  let target;if(specifier.startsWith('@/'))target=resolve(root,specifier.slice(2));
  else if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:'))target=fileURLToPath(new URL(specifier,context.parentURL));
  if(target?.startsWith(root)&&!target.includes('/node_modules/'))for(const path of [target,`${target}.ts`,`${target}/index.ts`])if(existsSync(path)&&!path.endsWith('/db'))return next(pathToFileURL(path).href,context);
  return next(specifier,context);
 },
 load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.ts')&&fileURLToPath(url).startsWith(root)&&!url.includes('/node_modules/'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);},
});
const {dispatchWorkflowOutbox}=await import('../lib/server/jobs/workflow-outbox.ts');
const {createModelProvider}=await import('../lib/server/ai/model-provider.ts');
const runtime={AI_PROVIDER:'openai',AI_MODEL:'synthetic-model',AI_API_KEY:'synthetic-test-key',AI_API_BASE_URL:'https://model.invalid/v1',AI_REASONING_EFFORT:'high',AI_VERIFIER_REASONING_EFFORT:'high',AI_MAX_OUTPUT_TOKENS:'64000'};
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const usage={input_tokens:62,output_tokens:6000,input_tokens_details:{cached_tokens:4}};
const output=input=>({schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:input.eventId,sentences:input.bullets.map(b=>({text:b.text,claim_refs:b.claimRefs,topic:{key:'synthetic_matter',title:'Synthetic matter'}}))});
async function setup(t){
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
 insert(f.sqlite,'workflow_outbox',{id:'synthetic_job',workspace_id:'ws',project_id:'p',event_id:'e',kind:'narrative',task_key:'synthetic-budget',input_revision:0,payload_json:'{"eventId":"e","contextVersion":0}',available_at:T,created_at:T,updated_at:T});
 globalThis.notiqueNarrativeBudget={db:f.db,bindings:{...runtime}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;delete globalThis.notiqueNarrativeBudget;});return f;
}
const job=sqlite=>sqlite.prepare("SELECT * FROM workflow_outbox WHERE id='synthetic_job'").get();

test('new formatter config keeps low reasoning and 6000 cap while extraction runtime remains high/64000',()=>{
 const config=workflowNarrativeModelConfig(runtime);assert.equal(config.reasoningEffort,'low');assert.equal(config.maxOutputTokens,6000);assert.equal(config.baseUrl,'https://model.invalid/v1');
 assert.equal(runtime.AI_REASONING_EFFORT,'high');assert.equal(runtime.AI_VERIFIER_REASONING_EFFORT,'high');assert.equal(runtime.AI_MAX_OUTPUT_TOKENS,'64000');
 assert.equal(workflowNarrativeModelConfig({AI_PROVIDER:'openai'}).maxOutputTokens,6000);assert.equal(workflowNarrativeModelConfig({AI_MAX_OUTPUT_TOKENS:'3000'}).maxOutputTokens,3000);
});

test('actual dispatcher creates a low/6000 formatter request and publishes exact refs in one model call',async t=>{
 const {sqlite}=await setup(t),requests=[];
 globalThis.fetch=async(url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));const body=JSON.parse(init.body);requests.push(body);const input=JSON.parse(body.input[0].content[0].text.split('\n').at(-1));return json({id:'synthetic_success',status:'completed',output_text:JSON.stringify(output(input)),usage});};
 assert.equal((await dispatchWorkflowOutbox()).succeeded,1);assert.equal(requests.length,1);assert.equal(requests[0].reasoning.effort,'low');assert.equal(requests[0].max_output_tokens,6000);
 const cp=JSON.parse(job(sqlite).payload_json).checkpoint;assert.equal(cp.config.reasoningEffort,'low');assert.equal(cp.config.maxOutputTokens,6000);assert.equal(cp.repairCount,0);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_narratives').get().n,1);
});

test('actual narrative provider classifies incomplete token budget and keeps usage',async t=>{
 await setup(t);let calls=0;
 globalThis.fetch=async(url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));const body=JSON.parse(init.body);assert.equal(body.max_output_tokens,6000);calls++;return json({id:'synthetic_incomplete',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'{"sentences":',usage});};
 const config=workflowNarrativeModelConfig(runtime),provider=createModelProvider(runtime,{...config,timeoutMs:25000});
 await assert.rejects(provider.summarizeWorkflow({eventId:'e',contextVersion:0,sourceRevision:0,coverage:{processed:1,total:1,status:'complete'},bullets:[]}),e=>{
  assert.equal(e.code,'MODEL_OUTPUT_TOKEN_LIMIT');assert.equal(e.usage.outputTokens,6000);assert.equal(e.usage.inputTokens,62);assert.equal(e.usage.cachedTokens,4);assert.equal(e.usage.providerRequestId,'synthetic_incomplete');return true;
 });assert.equal(calls,1);
});

test('budget failure is terminal, audited and does not commission a hidden narrative repair',async t=>{
 const {sqlite}=await setup(t);let calls=0;
 globalThis.fetch=async(url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));assert.equal(JSON.parse(init.body).reasoning.effort,'low');calls++;return json({id:'synthetic_budget_failure',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'{"sentences":',usage});};
 assert.equal((await dispatchWorkflowOutbox()).failed,1);assert.equal(job(sqlite).state,'failed');assert.equal(job(sqlite).error_code,'MODEL_OUTPUT_TOKEN_LIMIT');
 const payload=JSON.parse(job(sqlite).payload_json);assert.equal(payload.checkpoint.attempt,1);assert.equal(payload.checkpoint.repairCount,0);assert.equal(payload.checkpoint.usage[0].outputTokens,6000);assert.equal(payload.auditUsage[0].providerRequestId,'synthetic_budget_failure');
 assert.equal((await dispatchWorkflowOutbox()).claimed,0);assert.equal(calls,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_narratives').get().n,0);
});

test('already paid high-effort checkpoint resumes its frozen configuration with GET despite the new low default',async t=>{
 const {db,sqlite}=await setup(t),frozen={...workflowNarrativeModelConfig(runtime),reasoningEffort:'high'};
 const first=await consumeNarrativeJobs(db,{config:frozen,provider:()=>({async summarizeWorkflow(input,options){await options.onProviderResponse({id:'synthetic_paid',status:'queued'});throw Object.assign(new Error('synthetic pending'),{code:'MODEL_BACKGROUND_PENDING',providerResponseId:'synthetic_paid'});}})});
 assert.equal(first.pending,1);const before=JSON.parse(job(sqlite).payload_json).checkpoint;sqlite.prepare("UPDATE workflow_outbox SET available_at=? WHERE id='synthetic_job'").run(T);
 const requests=[];globalThis.fetch=async(url,init)=>{assert.equal(init.method,'GET');assert.equal(String(url),'https://model.invalid/v1/responses/synthetic_paid');requests.push(init.method);return json({id:'synthetic_paid',status:'completed',output_text:JSON.stringify(output(before.input)),usage});};
 assert.equal((await dispatchWorkflowOutbox()).succeeded,1);assert.deepEqual(requests,['GET']);const after=JSON.parse(job(sqlite).payload_json).checkpoint;
 assert.deepEqual(after.config,before.config);assert.equal(after.config.reasoningEffort,'high');assert.equal(after.inputHash,before.inputHash);assert.equal(after.attempt,before.attempt);assert.equal(after.generation,before.generation);assert.equal(after.providerResponseId,'synthetic_paid');
});

test('actual inventory adapter sends prior validation guidance and still rejects conflicting keys without a hidden repair',async t=>{
 await setup(t);const requests=[];
 globalThis.fetch=async(url,init)=>{
  assert.ok(String(url).startsWith('https://model.invalid/'));const body=JSON.parse(init.body);requests.push(body);
  return json({id:'duplicate_inventory',status:'completed',output_text:JSON.stringify({schema_version:'claim-inventory.v4',event_id:'e',candidates:[{normalized_value:{entries:[{key:'forecast',value:'rising'},{key:'forecast',value:'falling'}]}}]}),usage});
 };
 const provider=createModelProvider(runtime,{reasoningEffort:'high',maxOutputTokens:64000,timeoutMs:25000});
 const context={project:{id:'p',scenario:null,locale:'en',context_version:0},verified_context:{active_claims:[],recent_history:[],open_questions:[],active_risks:[],glossary:[]},draft_context:{enabled:false,claims:[]},new_event:{event_id:'e',transcript_segments:[],photos:[],documents:[]}};
 await assert.rejects(provider.inventoryClaims(context,{qualityFeedback:['$.claims[9].normalized_value.entries[1].key: Normalized value keys must be unique.']}),error=>{
  assert.equal(error.code,'MODEL_OUTPUT_INVALID');assert.ok(error.issues.some(i=>/unique/.test(i.message)));assert.equal(error.usage.providerRequestId,'duplicate_inventory');return true;
 });
 assert.equal(requests.length,1);assert.equal(requests[0].reasoning.effort,'high');assert.equal(requests[0].max_output_tokens,64000);
 const prompt=requests[0].input[0].content[0].text;
 assert.ok(prompt.includes('$.claims[9].normalized_value.entries[1].key'));assert.ok(prompt.includes('distinct descriptive keys or separate atomic candidates'));
});
