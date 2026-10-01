import assert from 'node:assert/strict';
import test from 'node:test';
import {validateWorkflowNarrative,WORKFLOW_NARRATIVE_SCHEMA_VERSION} from '../lib/domain/workflow-narrative.ts';
import {workflowDatabase,seed,insert,T} from './helpers/workflow-database.mjs';
import {consumeNarrativeJobs} from '../lib/server/workflow/narrative-jobs.ts';

const point=i=>({text:`Point ${i}: attendance remains optional`,claimRefs:[{claimId:`claim_${i}`,claimVersionId:`version_${i}`}],reviewState:'draft',origin:'source_statement'});
const input={eventId:'e',contextVersion:0,sourceRevision:0,coverage:{totalSegments:64,completedSegments:64,complete:true,unprocessedRanges:[]},bullets:Array.from({length:64},(_,i)=>point(i))};
const output=(value,omit=-1)=>({schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:value.eventId,sentences:value.bullets.filter((_,i)=>i!==omit).map(b=>({text:b.text,claim_refs:b.claimRefs,topic:{key:'training',title:'Training'}}))});

test('64-point coverage failure identifies the precise omitted wording and version without weakening validation',()=>{
 const broken=output(input,37);
 assert.throws(()=>validateWorkflowNarrative(broken,input),error=>{
  assert.equal(error.code,'MODEL_OUTPUT_INVALID');
  assert.equal(error.issues.length,1);
  const [feedback]=error.issues;
  assert.ok(feedback.includes(input.bullets[37].text));
  assert.ok(feedback.includes('"claimId":"claim_37"'));
  assert.ok(feedback.includes('"claimVersionId":"version_37"'));
  assert.ok(!feedback.includes('"claimId":"claim_36"'));
  return true;
 });
 assert.equal(validateWorkflowNarrative(output(input),input).sentences.length,64);
});

test('omission feedback remains bounded while all frozen versions are still required',()=>{
 const large={...input,bullets:input.bullets.map(b=>({...b,text:'x'.repeat(3000)}))};
 assert.throws(()=>validateWorkflowNarrative({...output(large),sentences:[]},large),error=>{
  const feedback=error.issues.find(i=>i.startsWith('Cover all input versions'));
  const missing=JSON.parse(feedback.split('Missing input points: ')[1]);
  assert.equal(missing.length,20);
  assert.ok(missing.every(b=>b.text.length===800));
  return true;
 });
});

test('persisted single repair receives the exact omitted point and publishes every version with both usage records',async t=>{
 const fixture=await workflowDatabase();t.after(fixture.close);seed(fixture.sqlite);
 insert(fixture.sqlite,'workflow_outbox',{id:'coverage_job',workspace_id:'ws',project_id:'p',event_id:'e',kind:'narrative',task_key:'coverage-repair',input_revision:0,payload_json:'{"eventId":"e","contextVersion":0}',available_at:T,created_at:T,updated_at:T});
 let calls=0,omitted;
 const provider={async summarizeWorkflow(value,options){
  calls++;
  if(calls===1){omitted=value.bullets[1];return {output:output(value,1),usage:{inputTokens:10,outputTokens:20,cachedTokens:0,providerRequestId:'first'}};}
  assert.equal(options.resumeProviderResponseId,undefined);
  const feedback=options.qualityFeedback.join('\n');
  assert.ok(feedback.includes(omitted.text));
  assert.ok(feedback.includes(omitted.claimRefs[0].claimVersionId));
  return {output:output(value),usage:{inputTokens:12,outputTokens:22,cachedTokens:0,providerRequestId:'repair'}};
 }};
 const config={provider:'test',model:'test',reasoningEffort:'low',baseUrl:'https://model.invalid',maxOutputTokens:6000};
 const run=clock=>consumeNarrativeJobs(fixture.db,{config,provider:()=>provider,clock:()=>clock,random:()=>0});
 assert.equal((await run(T)).pending,1);
 assert.equal((await run(new Date(Date.parse(T)+3000).toISOString())).succeeded,1);
 const job=fixture.sqlite.prepare("SELECT * FROM workflow_outbox WHERE id='coverage_job'").get(),cp=JSON.parse(job.payload_json).checkpoint;
 assert.equal(job.state,'succeeded');assert.equal(calls,2);assert.equal(cp.repairCount,1);assert.equal(cp.usage.length,2);
 const narrative=fixture.sqlite.prepare('SELECT sentence_refs_json FROM workflow_narratives').get();
 assert.equal(JSON.parse(narrative.sentence_refs_json).length,3);
});
