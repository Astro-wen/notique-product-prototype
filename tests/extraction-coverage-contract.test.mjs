import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,insert,SCOPE} from './helpers/workflow-database.mjs';
import {CLAIM_EXTRACTION_PROMPT_VERSION,CLAIM_EXTRACTION_SCHEMA_VERSION} from '../lib/domain/model-contract.ts';
import {INVENTORY_SCHEMA_VERSION,LEGACY_INVENTORY_SCHEMA_VERSION,VERIFICATION_SCHEMA_VERSION,ATOMIC_VERIFICATION_SCHEMA_VERSION,LEGACY_VERIFICATION_SCHEMA_VERSION,inventoryContractForRun,verificationContractForRun,validateInventoryOutput,assessVerificationEscalation,verificationCoverageWarnings} from '../lib/domain/two-stage-extraction.ts';
import {extractionCoverageSummary} from '../lib/domain/extraction-coverage.ts';

// Replace only the deployment's bindings. The actual model adapter, stage
// persistence, extraction processor and final SQL transaction run unchanged.
const root=fileURLToPath(new URL('../',import.meta.url));
const dbModule='data:text/javascript,'+encodeURIComponent('export const getD1=()=>globalThis.notiqueCoverageTest.db; export const getBindings=()=>globalThis.notiqueCoverageTest.bindings; export const getEvidenceBucket=()=>({get:async()=>null});');
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
const {extractionRunRecord}=await import('../lib/server/db/records.ts');
const {createExtractionRun}=await import('../lib/server/db/core-repository.ts');
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const usage={input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:0}};
const evidence=[{kind:'text',asset_version_id:'av',segment_ids:['seg'],quote_hint:'请询价。',evidence_role:'direct'}];
const atom=(key,type)=>({client_claim_key:key,disposition:'new',reaffirmed_target_claim_id:null,reaffirmed_target_version_id:null,type,statement:type==='decision'?'约定向供应商询价':'向供应商询价',normalized_value:null,materiality:'high',confidence:0.98,needs_additional_evidence:false,uncertainty:null,evidence,relations:[]});
function inventory(version=INVENTORY_SCHEMA_VERSION){return {schema_version:version,event_id:'e',candidates:[['agreement','decision'],['action','next_action']].map(([key,type])=>({inventory_key:key,type,statement:atom(key,type).statement,normalized_value:null,materiality:'high',critical:false,critical_reason:null,confidence:0.98,atomicity:'atomic',evidence}))};}
function verification(version,groups){return {schema_version:version,event_id:'e',scenario_assessment:null,claims:[atom('agreement','decision'),atom('action','next_action')],candidate_dispositions:['agreement','action'].map(key=>({inventory_key:key,outcome:'included',final_claim_keys:[key],reason:'Retained supported atomic proposition.'})),draft_link_candidates:[],quality_review:{unresolved_conflict_keys:[],compound_claim_keys:[],reaffirmed_issue_claim_keys:[]},...(version!==LEGACY_VERIFICATION_SCHEMA_VERSION?{same_intent_groups:groups}: {})};}
async function setup(t,{legacy=false}={}){
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.exec('DELETE FROM claims');
 f.sqlite.prepare("UPDATE projects SET scenario='general',scenario_status='confirmed'").run();
 f.sqlite.prepare("UPDATE extraction_runs SET status='queued',prompt_version=?,schema_version=?,provider='openai',model='synthetic-model',input_manifest_json=?,model_params_json=? WHERE id='run'").run(legacy?'claim-extraction-prompt.v9.2':CLAIM_EXTRACTION_PROMPT_VERSION,CLAIM_EXTRACTION_SCHEMA_VERSION,JSON.stringify([{asset_version_id:'av',sha256:'synthetic',parser_version:'test',kind:'text'}]),JSON.stringify({two_pass_pipeline:true,verification_uses_readable:false,...(legacy?{}:{inventory_prompt_version:CLAIM_EXTRACTION_PROMPT_VERSION,verification_schema_version:VERIFICATION_SCHEMA_VERSION})}));
 globalThis.notiqueCoverageTest={db:f.db,bindings:{AI_PROVIDER:'openai',AI_MODEL:'synthetic-model',AI_API_KEY:'synthetic-test-key',AI_API_BASE_URL:'https://model.invalid/v1',AI_VERIFICATION_USES_READABLE:'0'}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;delete globalThis.notiqueCoverageTest;});return f;
}


const oldConfigs=[
 {name:'v9.2',top:'claim-extraction-prompt.v9.2',params:{},verify:LEGACY_VERIFICATION_SCHEMA_VERSION,prompt:['f6a1bbb3171f2a7dc9f18e9249ded4bd1a8a4bb041e54e78cf9bd3457f03d58c','5317144ae0dbfd0079d457531beb7cde89fd72d2ccee3f00010d81cbd7abb1d9'],schema:['3752566aa5aa30970abe9ef423b6205ab46273ea5e70bb2b88763fba8cbc5f5c','d048b56eff63b016f6face93e1daaf56ee526956285577b3627637dca5243740']},
 {name:'v9.3',top:'claim-extraction-prompt.v9.2',params:{verification_schema_version:ATOMIC_VERIFICATION_SCHEMA_VERSION,verification_prompt_version:'claim-extraction-prompt.v9.3'},verify:ATOMIC_VERIFICATION_SCHEMA_VERSION,prompt:['f6a1bbb3171f2a7dc9f18e9249ded4bd1a8a4bb041e54e78cf9bd3457f03d58c','490e4e42ff2851802d10d3dcc2167bb8fa558c3b282fe3421a03a31cfdbfc4ab'],schema:['3752566aa5aa30970abe9ef423b6205ab46273ea5e70bb2b88763fba8cbc5f5c','7c8515833d3772dd664807f0083855326a98596ed8c717c69e2d35188766c335']},
 {name:'v9.4',top:'claim-extraction-prompt.v9.4',params:{inventory_prompt_version:'claim-extraction-prompt.v9.4',verification_schema_version:ATOMIC_VERIFICATION_SCHEMA_VERSION,verification_prompt_version:'claim-extraction-prompt.v9.4'},verify:ATOMIC_VERIFICATION_SCHEMA_VERSION,prompt:['2da8c20186fc500e1bd33888ce6dac85d1b2bc5200bd97367bd0d6d0cc4ffb39','c672a6903b790e72a62a64c99a1be29070e5a205c07d6b4d00a6ac0dc01337ab'],schema:['3752566aa5aa30970abe9ef423b6205ab46273ea5e70bb2b88763fba8cbc5f5c','7c8515833d3772dd664807f0083855326a98596ed8c717c69e2d35188766c335']},
];
const sha=value=>createHash('sha256').update(value).digest('hex');
for(const config of oldConfigs) test(`${config.name} paid contracts keep byte-identical prompts, schemas, limits and GET recovery`,async t=>{
 const {sqlite}=await setup(t,{legacy:true}),requests=[];
 sqlite.prepare("UPDATE extraction_runs SET prompt_version=?,model_params_json=? WHERE id='run'").run(config.top,JSON.stringify({two_pass_pipeline:true,verification_uses_readable:false,...config.params}));
 globalThis.fetch=async(url,init)=>{
  assert.ok(String(url).startsWith('https://model.invalid/'));
  if(init.method==='GET'){requests.push({method:'GET'});return json({id:'synthetic_verify',status:'completed',output_text:JSON.stringify(verification(config.verify,[])),usage});}
  const body=JSON.parse(init.body);requests.push({method:'POST',body});const v=body.text.format.schema.properties.schema_version.enum[0];
  return v===LEGACY_INVENTORY_SCHEMA_VERSION?json({id:'synthetic_inventory',status:'completed',output_text:JSON.stringify(inventory(v)),usage}):json({id:'synthetic_verify',status:'queued'});
 };
 assert.equal((await processExtractionRun('run')).status,'background_pending');
 const paidInventory=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get(),paidVerify=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();
 for(let i=0;i<2;i++){
  const body=requests[i].body;
  assert.equal(sha(body.input[0].content[0].text),config.prompt[i],`${config.name} stage ${i} prompt`);
  assert.equal(sha(JSON.stringify(body.text.format.schema)),config.schema[i],`${config.name} stage ${i} schema`);
  assert.equal(body.max_output_tokens,24000);assert.equal(body.reasoning.effort,'high');
  assert.equal((i===0?body.text.format.schema.properties.candidates:body.text.format.schema.properties.claims).maxItems,24);
 }
 assert.equal((await processExtractionRun('run')).status,'succeeded');assert.deepEqual(requests.map(r=>r.method),['POST','POST','GET']);
 assert.deepEqual(sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get(),paidInventory);
 const finished=sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();
 for(const field of ['attempt','input_hash','schema_version','prompt_version','provider_request_id'])assert.equal(finished[field],paidVerify[field]);
 assert.equal(finished.status,'succeeded');assert.equal(sqlite.prepare("SELECT sum(input_tokens) n FROM extraction_model_stages").get().n,40);
});

test('new frozen contracts select 64 while every legacy version selects 24 and rejects incompatible frozen limits',()=>{
 assert.equal(inventoryContractForRun({}).candidateLimit,24);assert.equal(verificationContractForRun({}).claimLimit,24);
 assert.equal(inventoryContractForRun({inventory_prompt_version:CLAIM_EXTRACTION_PROMPT_VERSION}).candidateLimit,64);
 assert.equal(verificationContractForRun({verification_schema_version:VERIFICATION_SCHEMA_VERSION}).claimLimit,64);
 assert.throws(()=>inventoryContractForRun({inventory_prompt_version:'claim-extraction-prompt.v9.4',inventory_candidate_limit:64}));
 assert.throws(()=>verificationContractForRun({verification_schema_version:VERIFICATION_SCHEMA_VERSION,final_claim_limit:24}));
 assert.throws(()=>verificationContractForRun({verification_schema_version:ATOMIC_VERIFICATION_SCHEMA_VERSION,verification_prompt_version:CLAIM_EXTRACTION_PROMPT_VERSION}));
 const many=Array.from({length:65},(_,i)=>({...inventory().candidates[0],inventory_key:`i${i}`}));
 assert.equal(validateInventoryOutput({...inventory(),candidates:many.slice(0,64)}).valid,true);
 assert.equal(validateInventoryOutput({...inventory(),candidates:many}).valid,false);
 assert.equal(validateInventoryOutput({...inventory(LEGACY_INVENTORY_SCHEMA_VERSION),candidates:many.slice(0,25)}).valid,false);
});

function manyFacts(sqlite,count=64){
 sqlite.exec('DELETE FROM text_segments');
 const candidates=Array.from({length:count},(_,i)=>{
  const statement=`Synthetic equipment item ${i+1} requires 16 GB of memory.`;
  insert(sqlite,'text_segments',{id:`seg${i}`,workspace_id:'ws',project_id:'p',event_id:'e',asset_id:'asset',asset_version_id:'av',ordinal:i,parser_version:'test',text_raw:statement,text_normalized:statement});
  return {...inventory().candidates[0],inventory_key:`fact${i}`,type:'requirement',statement,evidence:[{...evidence[0],segment_ids:[`seg${i}`],quote_hint:statement}]};
 });
 const inv={...inventory(),candidates};
 const out={...verification(VERIFICATION_SCHEMA_VERSION,[]),claims:candidates.map(c=>({...atom(c.inventory_key,c.type),statement:c.statement,evidence:c.evidence})),candidate_dispositions:candidates.map(c=>({inventory_key:c.inventory_key,outcome:'included',final_claim_keys:[c.inventory_key],reason:'Retained source-supported fact.'}))};
 return {inv,out};
}

test('real two-stage extraction persists 64 independent supported claims and explicit capacity notes without another paid stage',async t=>{
 const {sqlite}=await setup(t),{inv,out}=manyFacts(sqlite),requests=[];
 globalThis.fetch=async(url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));const body=JSON.parse(init.body);requests.push(body);return json({id:`synthetic_${requests.length}`,status:'completed',output_text:JSON.stringify(requests.length===1?inv:out),usage});};
 const r=await processExtractionRun('run');assert.equal(r.status,'completed_with_warnings',JSON.stringify(r));assert.equal(r.persistedClaims,64);assert.equal(requests.length,2);
 assert.equal(requests[0].text.format.schema.properties.candidates.maxItems,64);assert.equal(requests[1].text.format.schema.properties.claims.maxItems,64);
 assert.ok(requests[0].input[0].content[0].text.includes('attendance counts'));assert.ok(requests[0].input[0].content[0].text.includes('training reserve'));assert.ok(!requests[0].input[0].content[0].text.includes('at most 10 critical'));
 assert.equal(sqlite.prepare('SELECT count(*) n FROM claims').get().n,64);
 const row=sqlite.prepare("SELECT * FROM extraction_runs WHERE id='run'").get(),notes=extractionCoverageSummary(JSON.parse(row.error_details_json));
 assert.deepEqual(notes,{omittedStatements:[],inventoryLimitReached:true,finalClaimLimitReached:true,followUpOmitted:false});
 assert.equal(extractionRunRecord(row).omitted_statements.length,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM extraction_model_stages').get().n,2);
});

test('new output budget exhaustion records paid usage and fails after two calls without a hidden escalation',async t=>{
 const {sqlite}=await setup(t);let calls=0;
 globalThis.fetch=async(url,init)=>{assert.ok(String(url).startsWith('https://model.invalid/'));assert.equal(JSON.parse(init.body).max_output_tokens,24000);calls++;return calls===1?json({id:'synthetic_inventory',status:'completed',output_text:JSON.stringify(inventory()),usage}):json({id:'synthetic_truncated',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:'{"claims":',usage:{input_tokens:50,output_tokens:24000}});};
 const r=await processExtractionRun('run');assert.equal(r.status,'failed');assert.equal(calls,2);
 const row=sqlite.prepare("SELECT * FROM extraction_runs WHERE id='run'").get();assert.equal(row.error_code,'MODEL_OUTPUT_TOKEN_LIMIT');assert.equal(row.output_tokens,24010);assert.equal(row.input_tokens,70);
 assert.equal(sqlite.prepare('SELECT count(*) n FROM claims').get().n,0);assert.equal(sqlite.prepare("SELECT count(*) n FROM extraction_model_stages WHERE stage='verify_escalated'").get().n,0);
 assert.equal(sqlite.prepare("SELECT status FROM extraction_model_stages WHERE stage='verify'").get().status,'failed');
});

test('source-supported noncritical questions and owner actions trigger the new quality gate and every omitted candidate stays visible',()=>{
 const inv=inventory();inv.candidates[0].type='open_question';inv.candidates[0].statement='Second training session attendance is unresolved.';
 const out=verification(VERIFICATION_SCHEMA_VERSION,[]);out.claims=[];out.candidate_dispositions=inv.candidates.map(c=>({inventory_key:c.inventory_key,outcome:'lower_priority',final_claim_keys:[],reason:'Limited review budget.'}));
 const assessment=assessVerificationEscalation(inv,out);assert.equal(assessment.required,true);assert.ok(assessment.reasons.includes('supported_followup_dropped'));assert.deepEqual(assessment.droppedFollowUpInventoryKeys,['agreement','action']);
 const warnings=verificationCoverageWarnings(inv,out),notes=extractionCoverageSummary({warnings});assert.equal(notes.followUpOmitted,true);assert.deepEqual(notes.omittedStatements,inv.candidates.map(c=>c.statement));
 assert.equal(extractionRunRecord({error_details_json:JSON.stringify({warnings})}).omitted_statements.length,2);
 const oldInv={...inv,schema_version:LEGACY_INVENTORY_SCHEMA_VERSION},oldOut={...out,schema_version:ATOMIC_VERIFICATION_SCHEMA_VERSION};assert.equal(assessVerificationEscalation(oldInv,oldOut).required,false);
 assert.equal(extractionCoverageSummary({warnings:verificationCoverageWarnings(oldInv,oldOut)}).omittedStatements.length,2);
});

test('coverage notes sanitize unknown errors, invalid flags, duplicate statements and excessive detail',()=>{
 assert.deepEqual(extractionCoverageSummary({warnings:[{code:'UNKNOWN',statement:'provider secret',omitted_statements:['secret'],reason:'secret'},{code:'MODEL_INVENTORY_LIMIT_REACHED'},{code:'MODEL_FINAL_CLAIM_LIMIT_REACHED',limit:64,observed:63},{code:'MODEL_SUPPORTED_FOLLOWUP_OMITTED',inventory_keys:[null]}]}),{omittedStatements:[],inventoryLimitReached:false,finalClaimLimitReached:false,followUpOmitted:false});
 const notes=extractionCoverageSummary({warnings:[{code:'MODEL_CANDIDATE_OMITTED',statement:'  unresolved count  ',reason:'private-error'},{code:'MODEL_QUALITY_GATE_UNRESOLVED',omitted_statements:['unresolved count','x'.repeat(9000)]},...Array.from({length:300},(_,i)=>({code:'MODEL_CANDIDATE_OMITTED',statement:`fact ${i}`}))]});
 assert.equal(notes.omittedStatements.length,200);assert.equal(notes.omittedStatements[0],'unresolved count');assert.equal(notes.omittedStatements[1].length,8000);assert.ok(!JSON.stringify(notes).includes('private-error'));
});

test('new run freezes inventory v4, verification v6, both 64 limits and configured token budget without provider work',async t=>{
 const {sqlite}=await setup(t);globalThis.fetch=async()=>{throw Error('Run creation must not invoke a model.');};
 for(const budget of [24000,64000]){
  sqlite.prepare("UPDATE extraction_runs SET status='succeeded'").run();sqlite.prepare("UPDATE events SET material_status='ready',active_run_id=NULL WHERE id='e'").run();
  Object.assign(globalThis.notiqueCoverageTest.bindings,{AI_TWO_PASS_PIPELINE:'1',AI_MAX_OUTPUT_TOKENS:String(budget),WORKSPACE_MONTHLY_TOKEN_BUDGET:'1000000'});
  const created=await createExtractionRun(SCOPE,'e',`new-contract-${budget}`,['av']);assert.equal(created.created,true);
  const row=sqlite.prepare('SELECT * FROM extraction_runs WHERE id=?').get(created.run.id),params=JSON.parse(row.model_params_json);
  assert.equal(row.prompt_version,CLAIM_EXTRACTION_PROMPT_VERSION);assert.equal(params.inventory_schema_version,INVENTORY_SCHEMA_VERSION);assert.equal(params.verification_schema_version,VERIFICATION_SCHEMA_VERSION);
  assert.equal(params.inventory_candidate_limit,64);assert.equal(params.final_claim_limit,64);assert.equal(params.retention_policy,'explicit-followups.v1');assert.equal(params.max_output_tokens,budget);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM extraction_model_stages').get().n,0);
 }
});
