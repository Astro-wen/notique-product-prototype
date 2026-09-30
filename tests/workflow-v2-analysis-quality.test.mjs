import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,SCOPE} from './helpers/workflow-database.mjs';
import {readAnalysisRun} from '../lib/server/workflow/analysis-service.ts';
import {parseAnalysisQualityNotes} from '../lib/shared/workflow-v2.ts';

async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();return f;}
function warnings(sqlite){sqlite.prepare("UPDATE extraction_runs SET status='completed_with_warnings',error_details_json=? WHERE id='run'").run(JSON.stringify({warnings:[
  {code:'MODEL_CANDIDATE_OMITTED',inventory_key:'attendance',statement:'第二场培训参加人数尚未确定',type:'open_question',reason:'预算已满',outcome:'lower_priority'},
  {code:'MODEL_SUPPORTED_FOLLOWUP_OMITTED',inventory_keys:['attendance']},
  {code:'MODEL_FINAL_CLAIM_LIMIT_REACHED',limit:64,observed:64},
  {code:'PROVIDER_INTERNAL',statement:'private provider detail'},
]}));}

test('source-range completion and known business omissions are returned separately without writing or commissioning work',async t=>{
  const {db,sqlite}=await setup(t);warnings(sqlite);
  const before=sqlite.prepare('SELECT total_changes() n').get().n;
  const run=await readAnalysisRun(db,SCOPE,'run');
  assert.equal(run.coverage.complete,true);assert.equal(run.state,'succeeded');
  assert.deepEqual(run.qualityNotes,{omittedStatements:['第二场培训参加人数尚未确定'],inventoryLimitReached:false,finalClaimLimitReached:true,followUpOmitted:true});
  assert.equal(JSON.stringify(run).includes('private provider detail'),false);
  assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
});

test('superseded sources and unauthorized readers cannot retrieve prior omitted statement bodies',async t=>{
  const {db,sqlite}=await setup(t);warnings(sqlite);
  await assert.rejects(readAnalysisRun(db,{...SCOPE,workspaceId:'foreign'},'run'),e=>e.code==='not_found');
  sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
  const run=await readAnalysisRun(db,SCOPE,'run');
  assert.equal(run.qualityNotes,undefined);assert.equal(JSON.stringify(run).includes('第二场培训'),false);
});

test('quality-note wire validation rejects unbounded, duplicate or unexpected data',()=>{
  const notes={omittedStatements:['人数未定'],inventoryLimitReached:false,finalClaimLimitReached:false,followUpOmitted:true};
  assert.deepEqual(parseAnalysisQualityNotes(notes),notes);
  for(const malformed of [{...notes,followUpOmitted:1},{...notes,token:'unexpected'},{...notes,omittedStatements:['人数未定','人数未定']},{...notes,omittedStatements:['x'.repeat(8001)]}])assert.throws(()=>parseAnalysisQualityNotes(malformed));
});

test('tracked and legacy runs hide omissions after a source revision changes even if the same asset remains',async t=>{
  for(const params of [{},{workflow_source_revision:0}]){
    const {db,sqlite}=await setup(t);warnings(sqlite);
    sqlite.prepare("UPDATE extraction_runs SET model_params_json=? WHERE id='run'").run(JSON.stringify(params));
    assert.ok((await readAnalysisRun(db,SCOPE,'run')).qualityNotes);
    sqlite.prepare("UPDATE events SET source_revision=1 WHERE id='e'").run();
    const run=await readAnalysisRun(db,SCOPE,'run');
    assert.equal(run.qualityNotes,undefined);assert.equal(JSON.stringify(run).includes('第二场培训'),false);
  }
});

test('an already published legacy record exposes its reached capacity without changing the paid run',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE extraction_runs SET status='succeeded',prompt_version='claim-extraction-prompt.v9.4',model_params_json='{}',error_details_json=NULL,validated_output_json=? WHERE id='run'").run(JSON.stringify({claims:Array.from({length:24},()=>({}))}));
  const before=sqlite.prepare('SELECT total_changes() n').get().n;
  const run=await readAnalysisRun(db,SCOPE,'run');
  assert.deepEqual(run.qualityNotes,{omittedStatements:[],inventoryLimitReached:false,finalClaimLimitReached:true,followUpOmitted:false});
  assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
});

test('an exhausted frozen output budget does not offer a retry with the same budget',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE extraction_runs SET status='failed',error_code='MODEL_OUTPUT_TOKEN_LIMIT' WHERE id='run'").run();
  const run=await readAnalysisRun(db,SCOPE,'run');
  assert.equal(run.state,'failed');assert.equal(run.retryable,false);assert.ok(run.stages.every(s=>!s.retryable));
});
