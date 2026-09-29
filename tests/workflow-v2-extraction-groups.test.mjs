import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,SCOPE,T} from './helpers/workflow-database.mjs';
import {CLAIM_EXTRACTION_PROMPT_VERSION,CLAIM_EXTRACTION_SCHEMA_VERSION} from '../lib/domain/model-contract.ts';
import {INVENTORY_SCHEMA_VERSION,VERIFICATION_SCHEMA_VERSION,LEGACY_VERIFICATION_SCHEMA_VERSION} from '../lib/domain/two-stage-extraction.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';

// Replace only the deployment's bindings. The actual model adapter, stage
// persistence, extraction processor and final SQL transaction run unchanged.
const root=fileURLToPath(new URL('../',import.meta.url));
const dbModule='data:text/javascript,'+encodeURIComponent('export const getD1=()=>globalThis.notiqueGroupTest.db; export const getBindings=()=>globalThis.notiqueGroupTest.bindings; export const getEvidenceBucket=()=>({get:async()=>null});');
registerHooks({
 resolve(specifier,context,next){
  if(specifier==='@/db')return {url:dbModule,shortCircuit:true};
  let target;
  if(specifier.startsWith('@/'))target=resolve(root,specifier.slice(2));
  else if(specifier.startsWith('.') && context.parentURL?.startsWith('file:'))target=fileURLToPath(new URL(specifier,context.parentURL));
  if(target?.startsWith(root) && !target.includes('/node_modules/'))for(const path of [target,`${target}.ts`,`${target}/index.ts`])if(existsSync(path) && !path.endsWith('/db'))return next(pathToFileURL(path).href,context);
  return next(specifier,context);
 },
 load(url,context,next){if(url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);},
});
const {processExtractionRun}=await import('../lib/server/jobs/extraction-processor.ts');
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const usage={input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:0}};
const evidence=[{kind:'text',asset_version_id:'av',segment_ids:['seg'],quote_hint:'请询价。',evidence_role:'direct'}];
const atom=(key,type)=>({client_claim_key:key,disposition:'new',reaffirmed_target_claim_id:null,reaffirmed_target_version_id:null,type,statement:type==='decision'?'约定向供应商询价':'向供应商询价',normalized_value:null,materiality:'high',confidence:0.98,needs_additional_evidence:false,uncertainty:null,evidence,relations:[]});
function inventory(){return {schema_version:INVENTORY_SCHEMA_VERSION,event_id:'e',candidates:[['agreement','decision'],['action','next_action']].map(([key,type])=>({inventory_key:key,type,statement:atom(key,type).statement,normalized_value:null,materiality:'high',critical:false,critical_reason:null,confidence:0.98,atomicity:'atomic',evidence}))};}
function verification(version,groups){return {schema_version:version,event_id:'e',scenario_assessment:null,claims:[atom('agreement','decision'),atom('action','next_action')],candidate_dispositions:['agreement','action'].map(key=>({inventory_key:key,outcome:'included',final_claim_keys:[key],reason:'Retained supported atomic proposition.'})),draft_link_candidates:[],quality_review:{unresolved_conflict_keys:[],compound_claim_keys:[],reaffirmed_issue_claim_keys:[]},...(version===VERIFICATION_SCHEMA_VERSION?{same_intent_groups:groups}: {})};}
const groups=[{group_key:'quote',record_claim_key:'agreement',action_claim_key:'action',reason:'The same explicitly stated agreement.',confidence:0.98}];
async function setup(t,{legacy=false}={}){
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.exec('DELETE FROM claims');
 f.sqlite.prepare("UPDATE projects SET scenario='general',scenario_status='confirmed'").run();
 f.sqlite.prepare("UPDATE extraction_runs SET status='queued',prompt_version=?,schema_version=?,provider='openai',model='synthetic-model',input_manifest_json=?,model_params_json=? WHERE id='run'").run(CLAIM_EXTRACTION_PROMPT_VERSION,CLAIM_EXTRACTION_SCHEMA_VERSION,JSON.stringify([{asset_version_id:'av',sha256:'synthetic',parser_version:'test',kind:'text'}]),JSON.stringify({two_pass_pipeline:true,verification_uses_readable:false,...(legacy?{}:{verification_schema_version:VERIFICATION_SCHEMA_VERSION})}));
 globalThis.notiqueGroupTest={db:f.db,bindings:{AI_PROVIDER:'openai',AI_MODEL:'synthetic-model',AI_API_KEY:'synthetic-test-key',AI_API_BASE_URL:'https://model.invalid/v1',AI_VERIFICATION_USES_READABLE:'0'}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;delete globalThis.notiqueGroupTest;});return f;
}

test('real extraction publishes a proposed pair in the existing two paid-stage slots',async t=>{
 const {db,sqlite}=await setup(t),requests=[];
 globalThis.fetch=async (url,init)=>{
  assert.ok(String(url).startsWith('https://model.invalid/'));const body=JSON.parse(init.body);requests.push(body);
  const version=body.text.format.schema.properties.schema_version.enum[0];
  return json({id:`synthetic_${requests.length}`,status:'completed',output_text:JSON.stringify(version===INVENTORY_SCHEMA_VERSION?inventory():verification(version,groups)),usage});
 };
 const r=await processExtractionRun('run');assert.equal(r.status,'succeeded',JSON.stringify({result:r,error:sqlite.prepare("SELECT error_details_json FROM extraction_runs WHERE id='run'").get()}));assert.equal(requests.length,2);assert.equal(r.persistedClaims,2);
 assert.equal(requests[1].text.format.schema.properties.same_intent_groups.maxItems,12);assert.ok(requests[1].text.format.schema.required.includes('same_intent_groups'));
 const w=await readWorkspace(db,SCOPE,'e',{},T),c=w.reviewCards.find(c=>c.sameIntent);assert.ok(c);assert.equal(w.actions.length,0);assert.equal(c.members.every(m=>m.reviewState==='draft'),true);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_cards').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM card_members').get().n,2);assert.equal(sqlite.prepare("SELECT count(*) n FROM extraction_model_stages WHERE stage='verify_escalated'").get().n,0);
 assert.equal(JSON.parse(sqlite.prepare("SELECT validated_output_json FROM extraction_model_stages WHERE stage='verify'").get().validated_output_json).same_intent_groups.length,1);
 assert.equal((await processExtractionRun('run')).status,'already_terminal');assert.equal(requests.length,2);
});

test('invalid semantic group keeps successful claims and an audited warning without an extra model pass',async t=>{
 const {db,sqlite}=await setup(t);let calls=0;
 globalThis.fetch=async (url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));const v=JSON.parse(init.body).text.format.schema.properties.schema_version.enum[0];calls++;return json({id:`synthetic_${calls}`,status:'completed',output_text:JSON.stringify(v===INVENTORY_SCHEMA_VERSION?inventory():verification(v,[{...groups[0],action_claim_key:'missing'}])),usage});};
 const r=await processExtractionRun('run');assert.equal(r.status,'completed_with_warnings',JSON.stringify({result:r,error:sqlite.prepare("SELECT error_details_json FROM extraction_runs WHERE id='run'").get()}));assert.equal(calls,2);assert.equal(r.persistedClaims,2);assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_cards').get().n,0);
 assert.equal(JSON.parse(sqlite.prepare("SELECT error_details_json FROM extraction_runs WHERE id='run'").get().error_details_json).warnings[0].code,'SAME_INTENT_GROUP_NOT_PERSISTED');assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).bullets.length,2);
});

test('legacy queued run still receives the original schema and keeps its existing model contract',async t=>{
 const {sqlite}=await setup(t,{legacy:true}),requests=[];
 globalThis.fetch=async (url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));const body=JSON.parse(init.body);requests.push(body);const v=body.text.format.schema.properties.schema_version.enum[0];return json({id:`synthetic_${requests.length}`,status:'completed',output_text:JSON.stringify(v===INVENTORY_SCHEMA_VERSION?inventory():verification(v,[])),usage});};
 const r=await processExtractionRun('run');assert.equal(r.status,'succeeded',JSON.stringify({result:r,error:sqlite.prepare("SELECT error_details_json FROM extraction_runs WHERE id='run'").get()}));assert.equal(requests.length,2);assert.equal(requests[1].text.format.schema.properties.schema_version.enum[0],LEGACY_VERIFICATION_SCHEMA_VERSION);assert.ok(!requests[1].text.format.schema.required.includes('same_intent_groups'));
 const stage=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();assert.equal(stage.schema_version,LEGACY_VERIFICATION_SCHEMA_VERSION);assert.equal(stage.prompt_version,'claim-extraction-prompt.v9.2:verify');assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_cards').get().n,0);
});

test('already paid legacy verification resumes with GET and reuses the exact successful inventory',async t=>{
 const {sqlite}=await setup(t,{legacy:true}),requests=[];
 globalThis.fetch=async (url,init)=>{
  assert.ok(String(url).startsWith('https://model.invalid/'));requests.push({url:String(url),method:init.method});
  if(init.method==='GET')return json({id:'synthetic_legacy_verify',status:'completed',output_text:JSON.stringify(verification(LEGACY_VERIFICATION_SCHEMA_VERSION,[])),usage});
  const v=JSON.parse(init.body).text.format.schema.properties.schema_version.enum[0];
  return v===INVENTORY_SCHEMA_VERSION?json({id:'synthetic_inventory',status:'completed',output_text:JSON.stringify(inventory()),usage}):json({id:'synthetic_legacy_verify',status:'queued'});
 };
 const first=await processExtractionRun('run');assert.equal(first.status,'background_pending');const paidInventory=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get(),oldVerify=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();
 assert.equal(oldVerify.schema_version,LEGACY_VERIFICATION_SCHEMA_VERSION);assert.equal(oldVerify.provider_request_id,'synthetic_legacy_verify');
 const next=await processExtractionRun('run');assert.equal(next.status,'succeeded',JSON.stringify(next));assert.deepEqual(requests.map(r=>r.method),['POST','POST','GET']);assert.equal(requests.at(-1).url,'https://model.invalid/v1/responses/synthetic_legacy_verify');
 assert.deepEqual(sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get(),paidInventory);const finished=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();assert.equal(finished.attempt,oldVerify.attempt);assert.equal(finished.input_hash,oldVerify.input_hash);assert.equal(finished.prompt_version,oldVerify.prompt_version);assert.equal(finished.schema_version,oldVerify.schema_version);assert.equal(finished.status,'succeeded');
});


test('source drift before publication rolls back claims, groups and relations while preserving paid stages',async t=>{
 const {sqlite}=await setup(t);let calls=0;const relationCount=sqlite.prepare('SELECT count(*) n FROM claim_relations').get().n;
 globalThis.fetch=async(url,init)=>{
  assert.ok(String(url).startsWith('https://model.invalid/'));const v=JSON.parse(init.body).text.format.schema.properties.schema_version.enum[0];calls++;
  if(v===VERIFICATION_SCHEMA_VERSION)sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
  return json({id:`synthetic_${calls}`,status:'completed',output_text:JSON.stringify(v===INVENTORY_SCHEMA_VERSION?inventory():verification(v,groups)),usage});
 };
 const result=await processExtractionRun('run');assert.notEqual(result.status,'succeeded');assert.notEqual(result.status,'completed_with_warnings');assert.equal(calls,2);
 for(const table of ['claims','claim_versions','workflow_cards','card_members','mutation_guards'])assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM claim_relations').get().n,relationCount);
 assert.equal(sqlite.prepare("SELECT count(*) n FROM extraction_model_stages WHERE status='succeeded'").get().n,2);
});
