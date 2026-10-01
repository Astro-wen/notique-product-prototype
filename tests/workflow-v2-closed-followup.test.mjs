import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { workflowDatabase, seed, SCOPE, T } from './helpers/workflow-database.mjs';

import { HANDLED_VERIFICATION_SCHEMA_VERSION, INVENTORY_SCHEMA_VERSION, VERIFICATION_SCHEMA_VERSION, validateVerificationOutput, assessVerificationEscalation } from '../lib/domain/two-stage-extraction.ts';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';

// Real adapter, processor, run builder and transaction; all provider responses
// are offline fixtures. These checks establish engineering behavior only.
const root = fileURLToPath(new URL('../', import.meta.url));
const bindingsModule = 'data:text/javascript,' + encodeURIComponent('export const getD1=()=>globalThis.notiqueTaskTest.db; export const getBindings=()=>globalThis.notiqueTaskTest.bindings; export const getEvidenceBucket=()=>({get:async()=>null});');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/db') return { url: bindingsModule, shortCircuit: true };
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) target = fileURLToPath(new URL(specifier, context.parentURL));
    if (target?.startsWith(root) && !target.includes('/node_modules/')) for (const path of [target, `${target}.ts`, `${target}/index.ts`]) if (existsSync(path) && !path.endsWith('/db')) return next(pathToFileURL(path).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    return next(url, context);
  },
});
const { processExtractionRun } = await import('../lib/server/jobs/extraction-processor.ts');
const { createExtractionRun } = await import('../lib/server/db/core-repository.ts');

const {getWorkflowSnapshot}=await import('../lib/server/db/workflow-repository.ts');
const {dispatchWorkflowCommand}=await import('../lib/server/workflow/commands.ts');
const {loadWorkflowLedger}=await import('../lib/server/workflow/snapshot-store.ts');
const {loadProjectLedger}=await import('../lib/server/db/ledger-repository.ts');
const {buildContextPack}=await import('../lib/domain/context-pack.ts');
const {closedFollowupContext,validHandledFollowup}=await import('../lib/domain/closed-followup-context.ts');
const {extractionTransport}=await import('../lib/domain/extraction-transport.ts');
const read=db=>readWorkspace(db,SCOPE,'e',{limit:50},T);
const send=(db,path,body)=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,crypto.randomUUID());
const source='预算大约三十万。费用待定。请询价。';
const segments=[{id:'seg',workspaceId:'ws',projectId:'p',eventId:'e',assetId:'asset',assetVersionId:'av',ordinal:0,parserVersion:'test',textRaw:source,textNormalized:source,startMs:null,endMs:null,speaker:null}];
const usage={input_tokens:20,output_tokens:10,input_tokens_details:{cached_tokens:0}};
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
async function setup(t,{complete=true}={}) {
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
 f.sqlite.prepare("UPDATE projects SET scenario='general',scenario_status='confirmed'").run();
 f.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
 f.sqlite.prepare("UPDATE evidence_refs SET quote_raw='费用待定。' WHERE id='question_ev'").run();
 f.sqlite.prepare("UPDATE evidence_refs SET quote_raw='请询价。' WHERE id='action_ev'").run();
 globalThis.notiqueTaskTest={db:f.db,bindings:{AI_PROVIDER:'openai',AI_MODEL:'synthetic-model',AI_API_KEY:'synthetic-test-key',AI_API_BASE_URL:'https://model.invalid/v1',AI_VERIFICATION_USES_READABLE:'0',AI_EVENT_SUMMARY:'0',AI_READABLE_TRANSCRIPT:'0',AI_DRAFT_CONTEXT:'0',AI_TWO_PASS_PIPELINE:'1'}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;delete globalThis.notiqueTaskTest;});
 if(complete){
  let s=await read(f.db);const card=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId==='action'));
  await send(f.db,`review-cards/${card.id}/decisions`,{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'accept_action',members:[{...card.memberRefs.find(r=>r.claimId==='action'),operation:'accept_action'}]});
  s=await read(f.db);
  await send(f.db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,text:'已收到供应商报价',evidenceRefs:[],resolveQuestions:[{questionId:'question',revision:s.questions[0].revision,answerText:'费用十二万元'}],completeAction:true});
 }
 return f;
}
async function context(db) {
 const ledger=await loadProjectLedger(SCOPE,'p'),workflow=await loadWorkflowLedger(db,SCOPE,'p');
 const pack=buildContextPack({ledger,contextVersion:workflow.contextVersion,eventId:'e',transcriptSegments:segments});
 pack.verified_context.closed_followups=closedFollowupContext(workflow,ledger,'e',segments);return pack;
}
function inventory() {
 return {schema_version:INVENTORY_SCHEMA_VERSION,event_id:'e',candidates:[['question','open_question','费用是多少？','费用待定。'],['action','next_action','向供应商询价','请询价。']].map(([inventory_key,type,statement,quote_hint])=>({inventory_key,type,statement,normalized_value:null,materiality:'high',critical:true,critical_reason:'Explicit follow-up',confidence:0.98,atomicity:'atomic',evidence:[{kind:'text',asset_version_id:'av',segment_ids:['seg'],quote_hint,evidence_role:'direct'}]}))};
}
function proof(target){return {claim_id:target.claimId,claim_version_id:target.claimVersionId,closure_version_ids:target.closureRefs.map(r=>r.claimVersionId),confidence:0.98};}
function verification(pack) {
 return {schema_version:HANDLED_VERIFICATION_SCHEMA_VERSION,event_id:'e',scenario_assessment:null,claims:[],candidate_dispositions:inventory().candidates.map(c=>({inventory_key:c.inventory_key,outcome:'already_handled',final_claim_keys:[],reason:'Same source item has a current confirmed result.',handled_ref:proof(pack.verified_context.closed_followups.find(f=>f.type===c.type))})),same_intent_groups:[],draft_link_candidates:[],quality_review:{unresolved_conflict_keys:[],compound_claim_keys:[],reaffirmed_issue_claim_keys:[]}};
}

test('confirmed answers and completed actions provide exact original-source closures',async t=>{
 const {db}=await setup(t),pack=await context(db);
 assert.equal(pack.verified_context.closed_followups.length,2);
 const q=pack.verified_context.closed_followups.find(c=>c.type==='open_question');
 const a=pack.verified_context.closed_followups.find(c=>c.type==='next_action');
 assert.equal(q.state,'answered');assert.equal(a.state,'completed');assert.equal(q.claimVersionId,'question_v1');assert.equal(a.claimVersionId,'action_v1');
 assert.equal(q.closureRefs[0].statement,'费用十二万元');assert.equal(a.closureRefs.length,1);
 assert.deepEqual(q.sourceEvidence,[{assetVersionId:'av',segmentIds:['seg'],quoteRaw:'费用待定。'}]);
 const output=verification(pack);
 assert.equal(validateVerificationOutput(output,inventory(),pack).valid,true);
 assert.equal(assessVerificationEscalation(inventory(),output,pack).required,false);
 const transport=extractionTransport(pack),wire=transport.encode(output);
 assert.notEqual(wire.candidate_dispositions[0].handled_ref.closure_version_ids[0],output.candidate_dispositions[0].handled_ref.closure_version_ids[0]);
 assert.deepEqual(transport.decode(wire),output);
});

for(const [name,mutate] of [
 ['stale item version',(c,p)=>p.claim_version_id='question_v0'],
 ['missing closure',(c,p)=>p.closure_version_ids=[]],
 ['wrong closure',(c,p)=>p.closure_version_ids=['wrong']],
 ['duplicate closure',(c,p)=>p.closure_version_ids.push(p.closure_version_ids[0])],
 ['low confidence',(c,p)=>p.confidence=0.89],
 ['different item type',c=>c.type='next_action'],
 ['new asset version',c=>c.evidence[0].asset_version_id='av2'],
 ['uncited segment',c=>c.evidence[0].segment_ids.push('new-segment')],
 ['different quotation',c=>c.evidence[0].quote_hint='新的费用待定。'],
 ['context-only citation',c=>c.evidence[0].evidence_role='context_only'],
 ['mixed old and new evidence',c=>c.evidence.push({...c.evidence[0],asset_version_id:'av2'})],
 ['wrong event',(c,p,pack)=>pack.new_event.event_id='another'],
 ['unknown proof field',(c,p)=>p.extra=true],
 ])test(`closed coverage rejects ${name} and still escalates critical omission`,async t=>{
 const {db}=await setup(t),pack=await context(db),i=inventory(),output=verification(pack),candidate=i.candidates[0],p=output.candidate_dispositions[0].handled_ref;
 mutate(candidate,p,pack);
 assert.equal(validHandledFollowup(candidate,p,pack),false);
 assert.equal(validateVerificationOutput(output,i,pack).valid,false);
 assert.equal(assessVerificationEscalation(i,output,pack).required,true);
});

test('unanswered questions and changed source are absent from closed coverage',async t=>{
 const {db,sqlite}=await setup(t,{complete:false});assert.deepEqual((await context(db)).verified_context.closed_followups,[]);
 // A result-free completion does not answer its prerequisite question.
 let s=await read(db),card=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId==='action'));
 await send(db,`review-cards/${card.id}/decisions`,{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'accept_action',members:[{...card.memberRefs.find(r=>r.claimId==='action'),operation:'accept_action'}]});
 s=await read(db);
 await send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation:'complete'});
 s=await read(db);assert.equal(s.questions[0].resolutionState,'open');assert.equal((await context(db)).verified_context.closed_followups.some(c=>c.type==='open_question'),false);
 const pack=await context(db);assert.equal(pack.verified_context.closed_followups.length,1);
 sqlite.prepare("UPDATE evidence_refs SET asset_version_id=NULL WHERE id='action_ev'").run();
 assert.equal((await context(db)).verified_context.closed_followups.length,0);
});

for(const paid of [false,true])test(`real processor retains answered/completed ledger without reopening or extra verification, paid recovery=${paid}`,async t=>{
 const {db,sqlite}=await setup(t),before=await read(db),pack=await context(db),transport=extractionTransport(pack),requests=[];
 const created=await createExtractionRun(SCOPE,'e',`closed-${paid}`,['av']);
 const frozen=JSON.parse(sqlite.prepare('SELECT model_params_json FROM extraction_runs WHERE id=?').get(created.run.id).model_params_json);
 assert.equal(frozen.closed_followup_policy,'same-source-current-closure.v1');
 globalThis.fetch=async(url,init={})=>{
  assert.ok(String(url).startsWith('https://model.invalid/'));
  const r={url:String(url),method:init.method,body:init.body?JSON.parse(init.body):null};requests.push(r);
  if(r.method==='GET')return json({id:'paid_closed_verify',status:'completed',output_text:JSON.stringify(transport.encode(verification(pack))),usage});
  const schema=r.body.text.format.schema.properties.schema_version.enum[0];
  if(schema===INVENTORY_SCHEMA_VERSION)return json({id:'paid_inventory',status:'completed',output_text:JSON.stringify(transport.encode(inventory())),usage});
  const prompt=r.body.input[0].content[0].text;assert.match(prompt,/already_handled/);assert.match(prompt,/closed_followups/);
  assert.ok(r.body.text.format.schema.properties.candidate_dispositions.items.required.includes('handled_ref'));
  return json(paid?{id:'paid_closed_verify',status:'queued'}:{id:'paid_closed_verify',status:'completed',output_text:JSON.stringify(transport.encode(verification(pack))),usage});
 };
 let result=await processExtractionRun(created.run.id);
 if(paid){assert.equal(result.status,'background_pending',JSON.stringify(result));result=await processExtractionRun(created.run.id);}
 assert.equal(result.status,'succeeded',JSON.stringify({result,error:sqlite.prepare('SELECT error_details_json FROM extraction_runs WHERE id=?').get(created.run.id)}));
 assert.equal(result.persistedClaims,0);
 const workflow=await getWorkflowSnapshot(SCOPE,'p');assert.equal(workflow.events[0].candidate_count,2);assert.equal(workflow.events[0].display_status,'complete');
 assert.deepEqual(requests.map(r=>r.method),paid?['POST','POST','GET']:['POST','POST']);
 const after=await read(db);assert.deepEqual(after.questions.find(q=>q.id==='question').answerRefs,before.questions.find(q=>q.id==='question').answerRefs);
 assert.equal(after.questions.find(q=>q.id==='question').resolutionState,'resolved');assert.equal(after.actions.find(a=>a.id==='action').executionState,'completed');assert.equal(after.actions.find(a=>a.id==='action').basisState,'current');
 assert.equal(sqlite.prepare("SELECT count(*) AS n FROM extraction_model_stages WHERE run_id=? AND stage='verify_escalated'").get(created.run.id).n,0);
 const stage=sqlite.prepare("SELECT validated_output_json FROM extraction_model_stages WHERE run_id=? AND stage='verify'").get(created.run.id);
 assert.equal(JSON.parse(stage.validated_output_json).candidate_dispositions[0].handled_ref.claim_version_id,'question_v1');
});

test('legacy verification rejects the new handled disposition',async t=>{
 const {db}=await setup(t),pack=await context(db),v=verification(pack);v.schema_version=VERIFICATION_SCHEMA_VERSION;
 assert.equal(validateVerificationOutput(v,inventory(),pack).valid,false);assert.equal(assessVerificationEscalation(inventory(),v,pack).required,true);
});


test('reopening a completed task removes its closure while preserving the answered question',async t=>{
 const {db}=await setup(t);let s=await read(db);
 await send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation:'reopen'});
 s=await read(db);assert.equal(s.actions[0].executionState,'open');assert.equal(s.questions[0].resolutionState,'resolved');
 const closed=(await context(db)).verified_context.closed_followups;assert.equal(closed.length,1);assert.equal(closed[0].type,'open_question');
});

test('withdrawn answer or stale original material removes handled coverage',async t=>{
 const {db,sqlite}=await setup(t),pack=await context(db),q=pack.verified_context.closed_followups.find(c=>c.type==='open_question');
 sqlite.prepare("UPDATE claims SET lifecycle_status='withdrawn' WHERE id=?").run(q.closureRefs[0].claimId);
 assert.equal((await context(db)).verified_context.closed_followups.some(c=>c.type==='open_question'),false);
 const workflow=await loadWorkflowLedger(db,SCOPE,'p'),sourceLedger=await loadProjectLedger(SCOPE,'p');
 workflow.evidence=workflow.evidence.map(e=>e.claim_version_id==='action_v1'?{...e,availability:'stale'}:e);
 assert.deepEqual(closedFollowupContext(workflow,sourceLedger,'e',segments),[]);
 assert.deepEqual(closedFollowupContext(await loadWorkflowLedger(db,SCOPE,'p'),sourceLedger,'e',segments.map(s=>({...s,assetVersionId:'new-version'}))),[]);
});
