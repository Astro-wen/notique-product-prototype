import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {commitWorkflowMutation} from '../lib/server/workflow/transaction.ts';
import {consumeNarrativeJobs,leaseNarrativeJob} from '../lib/server/workflow/narrative-jobs.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {WORKFLOW_NARRATIVE_SCHEMA_VERSION,validateWorkflowNarrative,workflowNarrativeSentences,WorkflowNarrativeInvalidError} from '../lib/domain/workflow-narrative.ts';

const config={provider:'test',model:'test',reasoningEffort:'low',baseUrl:'https://model.invalid',maxOutputTokens:6000};
const plus=ms=>new Date(Date.parse(T)+ms).toISOString();
const output=input=>({schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:input.eventId,sentences:input.bullets.map(b=>({text:b.text,claim_refs:b.claimRefs}))});
const usage={inputTokens:25,outputTokens:10,cachedTokens:0,providerRequestId:'resp_test'};
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
async function edit(db,expected=0,text='预算三十五万元',time=T){return commitWorkflowMutation(db,SCOPE,{projectId:'p',eventId:'e',endpoint:'test',key:crypto.randomUUID(),payload:{text},expectedContextVersion:expected},async()=>({statements:[db.prepare("UPDATE claims SET review_status='verified',workflow_revision=workflow_revision+1 WHERE id='budget'")],guards:[],changedRefs:[{entityType:'claim',id:'budget',revision:2}],invalidatedVersionIds:['budget_v1'],kind:'confirm'}),time);}
const run=(db,provider,clock=()=>plus(3000),extra={})=>consumeNarrativeJobs(db,{config,provider:()=>provider,clock,random:()=>0,...extra});
const job=sql=>sql.prepare('SELECT * FROM workflow_outbox ORDER BY created_at DESC,input_revision DESC LIMIT 1').get();

// These exercise real SQLite statements, atomic guards and persisted recovery,
// using a fake provider so engineering QA performs no paid requests.
test('saved mutation is consumed without a browser and publishes exact mixed versions',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let calls=0;
 const result=await run(db,{async summarizeWorkflow(input){calls++;return {output:output(input),usage};}});
 assert.equal(result.succeeded,1);assert.equal(calls,1);assert.equal(job(sqlite).state,'succeeded');
 const s=await readWorkspace(db,SCOPE,'e',{},plus(3500));assert.equal(s.narrative.freshness,'current');assert.equal(s.narrative.scope,'mixed');assert.equal(s.narrative.sentenceRefs.length,3);assert.equal(s.narrative.sentenceRefs.find(s=>s.claimRefs[0].claimId==='budget').reviewState,'accepted');assert.equal(s.narrative.sentenceRefs.filter(s=>s.reviewState==='draft').length,2);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM derived_dependencies').get().n,3);assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,1);
 assert.equal(JSON.parse(job(sqlite).payload_json).checkpoint.usage[0].inputTokens,25);
});

test('quiet-window coalescing keeps only latest input and does not duplicate model calls',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);await edit(db,1,'latest',plus(1000));let calls=0;
 assert.equal((await run(db,{async summarizeWorkflow(input){calls++;return {output:output(input),usage};}},()=>plus(2000))).claimed,0);
 const r=await run(db,{async summarizeWorkflow(input){calls++;assert.equal(input.contextVersion,2);return {output:output(input),usage};}},()=>plus(3500));
 assert.equal(r.succeeded,1);assert.equal(calls,1);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM workflow_outbox WHERE error_code='COALESCED'").get().n,1);
});

test('continuous editing reaches ten-second maximum wait without bypassing provider backoff',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);
 for(let i=1;i<=11;i++)await edit(db,i,'latest',plus(i*900));
 let calls=0;const provider={async summarizeWorkflow(){calls++;throw Object.assign(new Error('pending'),{code:'MODEL_BACKGROUND_PENDING',providerResponseId:'resp_pending'});}};
 const r=await run(db,provider,()=>plus(10000));assert.equal(r.pending,1);assert.equal(calls,1);
 assert.equal((await run(db,provider,()=>plus(11000))).claimed,0);assert.equal(calls,1);
 assert.equal(JSON.parse(job(sqlite).payload_json).checkpoint.attempt,1);
});

test('two concurrent consumers lease once and publish once',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let calls=0;
 const provider={async summarizeWorkflow(input){calls++;await new Promise(r=>setTimeout(r,20));return {output:output(input),usage};}};
 const results=await Promise.all([run(db,provider),run(db,provider)]);assert.equal(results.reduce((n,r)=>n+r.succeeded,0),1);assert.equal(calls,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_narratives').get().n,1);
});

test('background response resumes the same request and polling does not spend attempt budget',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let n=0;
 const provider={async summarizeWorkflow(input,options){n++;if(n===1){assert.equal(options.resumeProviderResponseId,undefined);await options.onProviderResponse({id:'resp_saved',status:'queued'});throw Object.assign(new Error('pending'),{code:'MODEL_BACKGROUND_PENDING',providerResponseId:'resp_saved'});}assert.equal(options.resumeProviderResponseId,'resp_saved');return {output:output(input),usage};}};
 assert.equal((await run(db,provider)).pending,1);assert.equal((await run(db,provider,()=>plus(9000))).succeeded,1);assert.equal(job(sqlite).attempt,1);assert.equal(job(sqlite).fencing_token,2);
});

test('expired execution is reclaimed and a late owner cannot publish',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let finish,firstKey,secondKey;
 let now=plus(3000);const pending=run(db,{summarizeWorkflow(input,options){firstKey=options.idempotencyKey;return new Promise(resolve=>{finish=()=>resolve({output:output(input),usage:{...usage,providerRequestId:'resp_late'}});});}},()=>now,{leaseMs:100});
 while(!finish)await new Promise(r=>setTimeout(r,1));now=plus(3200);
 const next=await run(db,{async summarizeWorkflow(input,options){secondKey=options.idempotencyKey;return {output:output(input),usage};}},()=>now);assert.equal(next.succeeded,1);finish();assert.equal((await pending).lostLease,1);assert.equal(firstKey,secondKey);assert.equal(JSON.parse(job(sqlite).payload_json).auditUsage.length,2);assert.equal(job(sqlite).fencing_token,2);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_narratives').get().n,1);
});

test('a new user write during generation preserves paid audit but rejects old publication',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);const r=await run(db,{async summarizeWorkflow(input){await edit(db,1,'new',plus(3100));return {output:output(input),usage};}},()=>plus(3500));
 assert.equal(r.obsolete,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_narratives').get().n,0);
 const old=sqlite.prepare("SELECT * FROM workflow_outbox WHERE input_revision=1").get();assert.equal(old.state,'cancelled');assert.equal(JSON.parse(old.payload_json).checkpoint.usage.length,1);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM workflow_outbox WHERE state='queued' AND input_revision=2").get().n,1);
});

test('legacy relation changes with unchanged context fence old output and enqueue fresh input',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);
 const r=await run(db,{async summarizeWorkflow(input){sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE id='basis'").run();return {output:output(input),usage};}});
 assert.equal(r.obsolete,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_narratives').get().n,0);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM workflow_outbox WHERE state='queued'").get().n,1);
});

test('source replacement, archive and move during provider work reject publication',async()=>{
 for(const mutate of [sql=>sql.prepare("UPDATE assets SET current_version_id=NULL").run(),sql=>sql.prepare("UPDATE events SET material_status='archived'").run(),sql=>{insert(sql,'projects',{id:'other',workspace_id:'ws',name:'Other'});sql.prepare("UPDATE events SET project_id='other'").run();}]){
 const f=await workflowDatabase();seed(f.sqlite);await edit(f.db);let r;try{r=await run(f.db,{async summarizeWorkflow(input){mutate(f.sqlite);return {output:output(input),usage};}});assert.equal(r.obsolete,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workflow_narratives').get().n,0);}finally{f.close();}
 }
});

test('transport retries use backoff, stop at three and remain separate from successful reads',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let n=0;
 const provider={async summarizeWorkflow(){n++;throw Object.assign(new Error('429'),{code:'MODEL_PROVIDER_REQUEST_FAILED',status:429});}};
 assert.equal((await run(db,provider)).pending,1);assert.equal((await run(db,provider,()=>plus(4000))).claimed,0);
 assert.equal((await run(db,provider,()=>plus(6000))).pending,1);assert.equal((await run(db,provider,()=>plus(11000))).failed,1);assert.equal(n,3);assert.equal(job(sqlite).state,'failed');assert.equal(job(sqlite).attempt,3);
 await readWorkspace(db,SCOPE,'e',{},plus(12000));assert.equal(n,3);
});

test('invalid schema or references get one targeted repair, retaining usage for both calls',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let n=0;
 const provider={async summarizeWorkflow(input,options){n++;if(n===1)return {output:{...output(input),event_id:'wrong'},usage};assert.ok(options.qualityFeedback.some(f=>f.includes('event_id')));return {output:output(input),usage};}};
 assert.equal((await run(db,provider)).pending,1);assert.equal((await run(db,provider,()=>plus(6000))).succeeded,1);assert.equal(job(sqlite).attempt,2);assert.equal(JSON.parse(job(sqlite).payload_json).checkpoint.usage.length,2);
});

test('repeated invalid output stops after the single repair and never publishes',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);const provider={async summarizeWorkflow(input){return {output:{...output(input),sentences:[]},usage};}};
 assert.equal((await run(db,provider)).pending,1);assert.equal((await run(db,provider,()=>plus(6000))).failed,1);assert.equal(job(sqlite).attempt,2);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workflow_narratives').get().n,0);
});

test('server derives mixed sentence labels and refuses invented or missing exact versions',()=>{
 const input={eventId:'e',contextVersion:1,sourceRevision:0,bullets:[{text:'a',claimRefs:[{claimId:'a',claimVersionId:'av'}],reviewState:'accepted',origin:'source_statement'},{text:'b',claimRefs:[{claimId:'b',claimVersionId:'bv'}],reviewState:'draft',origin:'source_statement'}]};
 const value={schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:'e',sentences:[{text:'a and b',claim_refs:input.bullets.flatMap(b=>b.claimRefs)}]};
 assert.equal(workflowNarrativeSentences(validateWorkflowNarrative(value,input),input)[0].reviewState,'draft');
 assert.throws(()=>validateWorkflowNarrative({...value,sentences:[{text:'a',claim_refs:input.bullets[0].claimRefs}]},input),WorkflowNarrativeInvalidError);
 assert.throws(()=>validateWorkflowNarrative({...value,sentences:[{text:'x',claim_refs:[{claimId:'x',claimVersionId:'xv'}]}]},input),WorkflowNarrativeInvalidError);
 assert.throws(()=>validateWorkflowNarrative({...value,reviewState:'accepted'},input),WorkflowNarrativeInvalidError);
});

test('coalescing does not cancel a different communication in the same project',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);insert(sqlite,'events',{id:'e2',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'Other',occurred_at:T,sequence_no:2});
 insert(sqlite,'workflow_outbox',{id:'job2',workspace_id:'ws',project_id:'p',event_id:'e2',kind:'narrative',task_key:'other',input_revision:1,payload_json:'{"eventId":"e2","contextVersion":1}',available_at:plus(2000),created_at:T,updated_at:T});
 const candidate=sqlite.prepare("SELECT * FROM workflow_outbox WHERE event_id='e'").get();assert.ok(await leaseNarrativeJob(db,candidate,plus(3000),'test'));assert.equal(sqlite.prepare("SELECT state FROM workflow_outbox WHERE id='job2'").get().state,'queued');
});


test('age budget stops provider polling and cancels a persisted request after terminal fencing',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let calls=0,cancelled=[];
 const provider={async summarizeWorkflow(){calls++;throw Object.assign(new Error('pending'),{code:'MODEL_BACKGROUND_PENDING',providerResponseId:'resp_long'});}};
 assert.equal((await run(db,provider)).pending,1);
 const r=await run(db,provider,()=>plus(31*60000),{cancelProvider:async(config,id)=>{cancelled.push(id);assert.equal(job(sqlite).state,'failed');}});
 assert.equal(r.failed,1);assert.equal(calls,1);assert.deepEqual(cancelled,['resp_long']);assert.equal(job(sqlite).error_code,'NARRATIVE_RETRY_EXHAUSTED');
});

test('historical narrative checks its original sources after a human replacement',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);await run(db,{async summarizeWorkflow(input){return {output:output(input),usage};}});
 const old=await readWorkspace(db,SCOPE,'e',{},plus(3500));assert.ok(old.narrative.text);
 // Today's claim is independently attributed, but that cannot authorize an
 // older model sentence whose original material has disappeared.
 insert(sqlite,'claim_versions',{id:'budget_v2',claim_id:'budget',version_no:2,statement:'新预算四十万元',source:'human',workflow_origin:'user_input'});
 insert(sqlite,'user_notes',{id:'note',workspace_id:'ws',project_id:'p',claim_id:'budget',body:'新预算四十万元',verdict_id:'test',author_id:'owner'});
 insert(sqlite,'evidence_refs',{id:'note_ref',workspace_id:'ws',project_id:'p',event_id:'e',claim_version_id:'budget_v2',kind:'user_note',user_note_id:'note',evidence_role:'direct',provenance_grade:'secondary',structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
 sqlite.prepare("UPDATE claims SET current_version_id='budget_v2' WHERE id='budget'").run();sqlite.prepare("UPDATE assets SET current_version_id=NULL").run();
 const next=await readWorkspace(db,SCOPE,'e',{},plus(4000));assert.equal(next.narrative.freshness,'stale');assert.equal(next.narrative.text,'');assert.deepEqual(next.narrative.sentenceRefs,[]);
});

test('a sentence spanning draft and accepted versions remains current with a draft label',async t=>{
 const {db}=await setup(t);await edit(db);
 await run(db,{async summarizeWorkflow(input){return {output:{schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:input.eventId,sentences:[{text:'预算大约三十万，费用待定，接下来询价。',claim_refs:input.bullets.flatMap(b=>b.claimRefs)}]},usage};}});
 const s=await readWorkspace(db,SCOPE,'e',{},plus(4000));assert.equal(s.narrative.freshness,'current');assert.equal(s.narrative.sentenceRefs[0].reviewState,'draft');
});


test('failed polls of one provider response also stop after three transport failures',async t=>{
 const {db,sqlite}=await setup(t);await edit(db);let calls=0;
 const provider={async summarizeWorkflow(input,options){calls++;if(calls===1)throw Object.assign(new Error('pending'),{code:'MODEL_BACKGROUND_PENDING',providerResponseId:'resp_existing'});assert.equal(options.resumeProviderResponseId,'resp_existing');throw Object.assign(new Error('503'),{code:'MODEL_PROVIDER_REQUEST_FAILED',status:503});}};
 assert.equal((await run(db,provider)).pending,1);
 assert.equal((await run(db,provider,()=>plus(9000))).pending,1);
 assert.equal((await run(db,provider,()=>plus(12000))).pending,1);
 assert.equal((await run(db,provider,()=>plus(15000))).failed,1);
 assert.equal(job(sqlite).attempt,1);assert.equal(JSON.parse(job(sqlite).payload_json).checkpoint.transportFailures,3);assert.equal(calls,4);
});
