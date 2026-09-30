import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { workflowDatabase, seed, claim, insert, SCOPE, T } from './helpers/workflow-database.mjs';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { selectEarlyActionOverlaps } from '../lib/server/jobs/early-action-overlap.ts';
import { frozenActionOverlapRefs } from '../lib/domain/workflow-projection.ts';
import { CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_SCHEMA_VERSION } from '../lib/domain/model-contract.ts';
import { INVENTORY_SCHEMA_VERSION, VERIFICATION_SCHEMA_VERSION, TWO_STAGE_EXTRACTION_LIMITS, EXTRACTION_RETENTION_POLICY } from '../lib/domain/two-stage-extraction.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dbModule = 'data:text/javascript,' + encodeURIComponent(
  'export const getD1=()=>globalThis.overlapTest.db; export const getBindings=()=>globalThis.overlapTest.bindings; export const getEvidenceBucket=()=>({get:async()=>null});',
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/db') return { url: dbModule, shortCircuit: true };
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) target = fileURLToPath(new URL(specifier, context.parentURL));
    if (target?.startsWith(root) && !target.includes('/node_modules/')) {
      for (const path of [target, `${target}.ts`, `${target}/index.ts`]) {
        if (existsSync(path) && !path.endsWith('/db')) return next(pathToFileURL(path).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/')) {
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }), shortCircuit: true };
    }
    return next(url, context);
  },
});
const { createManualClaim } = await import('../lib/server/db/ai-draft-repository.ts');
const { processExtractionRun } = await import('../lib/server/jobs/extraction-processor.ts');
const { decideRecord } = await import('../lib/server/workflow/record-decision.ts');
const { revertDecision } = await import('../lib/server/workflow/revert-decision.ts');

const evidence = [{ kind: 'text', asset_version_id: 'av', segment_ids: ['seg'], quote_hint: '请询价。', evidence_role: 'direct' }];
const modelAction = (statement = '向供应商核实安装价格') => ({ client_claim_key: 'model-action', disposition: 'new',
  reaffirmed_target_claim_id: null, reaffirmed_target_version_id: null, type: 'next_action',
  statement, normalized_value: null, materiality: 'high', confidence: 0.98,
  needs_additional_evidence: false, uncertainty: null, evidence, relations: [] });
const inventory = statement => ({ schema_version: INVENTORY_SCHEMA_VERSION, event_id: 'e', candidates: [{
  inventory_key: 'model-action', type: 'next_action', statement, normalized_value: null,
  materiality: 'high', critical: false, critical_reason: null, confidence: 0.98,
  atomicity: 'atomic', evidence,
}] });
const verification = statement => ({ schema_version: VERIFICATION_SCHEMA_VERSION, event_id: 'e',
  scenario_assessment: null, claims: [modelAction(statement)], candidate_dispositions: [{ inventory_key: 'model-action',
    outcome: 'included', final_claim_keys: ['model-action'], reason: 'Supported atomic action.' }],
  draft_link_candidates: [], same_intent_groups: [], quality_review: {
    unresolved_conflict_keys: [], compound_claim_keys: [], reaffirmed_issue_claim_keys: [],
  } });
const response = (body, n) => new Response(JSON.stringify({ id: `synthetic_${n}`, status: 'completed',
  output_text: JSON.stringify(body), usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } }),
{ headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const f = await workflowDatabase();
  t.after(() => { f.close(); delete globalThis.overlapTest; });
  seed(f.sqlite);
  f.sqlite.exec('DELETE FROM claims');
  f.sqlite.prepare("UPDATE projects SET scenario='general',scenario_status='confirmed'").run();
  f.sqlite.prepare("UPDATE extraction_runs SET status='queued',prompt_version=?,schema_version=?,provider='openai',model='synthetic-model',input_manifest_json=?,model_params_json=? WHERE id='run'")
    .run(CLAIM_EXTRACTION_PROMPT_VERSION,CLAIM_EXTRACTION_SCHEMA_VERSION,
      JSON.stringify([{ asset_version_id: 'av', sha256: 'synthetic', parser_version: 'test', kind: 'text' }]),
      JSON.stringify({ two_pass_pipeline: true, verification_uses_readable: false,
        inventory_prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION, inventory_schema_version: INVENTORY_SCHEMA_VERSION,
        inventory_candidate_limit: TWO_STAGE_EXTRACTION_LIMITS.inventoryCandidates,
        verification_prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION, verification_schema_version: VERIFICATION_SCHEMA_VERSION,
        final_claim_limit: TWO_STAGE_EXTRACTION_LIMITS.finalClaims, retention_policy: EXTRACTION_RETENTION_POLICY }));
  insert(f.sqlite,'event_ai_artifact_runs',{ id:'summary-run',workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',
    kind:'summary',status:'succeeded',idempotency_key:'summary-run',input_hash:'summary',input_manifest_json:'[{"asset_version_id":"av"}]',
    provider:'test',model:'test',reasoning_effort:'low',prompt_version:'test',schema_version:'test',next_attempt_at:T,queued_at:T });
  insert(f.sqlite,'event_ai_artifacts',{ id:'summary-artifact',workspace_id:'ws',project_id:'p',event_id:'e',run_id:'summary-run',
    kind:'summary',artifact_version:1,input_hash:'summary',content_json:JSON.stringify({sections:[{items:[{source_segment_ids:['seg']}]}]}) });
  globalThis.overlapTest={db:f.db,bindings:{AI_PROVIDER:'openai',AI_MODEL:'synthetic-model',AI_API_KEY:'synthetic-test-key',
    AI_API_BASE_URL:'https://model.invalid/v1',AI_VERIFICATION_USES_READABLE:'0'}};
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  return f;
}
function modelResponses(statement, onRequest = async () => {}) {
  let count=0;
  globalThis.fetch=async (url,init)=>{
    assert.ok(String(url).startsWith('https://model.invalid/'));
    const version=JSON.parse(init.body).text.format.schema.properties.schema_version.enum[0];
    count++;await onRequest(version);
    return response(version===INVENTORY_SCHEMA_VERSION?inventory(statement):verification(statement),count);
  };
  return ()=>count;
}
const addManual = (key,statement='向供应商确认安装价格') => createManualClaim(SCOPE,'e',
  {statement,type:'next_action',segment_ids:['seg']},key);

async function publishedOverlap(t) {
  const f=await fixture(t);
  let manual;
  modelResponses('向供应商核实安装价格',async version=>{
    if(version===INVENTORY_SCHEMA_VERSION)manual=await addManual('paired-manual');
  });
  assert.equal((await processExtractionRun('run')).status,'succeeded');
  const snapshot=await readWorkspace(f.db,SCOPE,'e',{});
  const card=snapshot.reviewCards.find(c=>c.actionOverlap);
  assert.ok(card);
  return {...f,manual,snapshot,card};
}
const overlapCommand=(snapshot,card,members,key)=>({projectId:'p',eventId:'e',cardId:card.id,key,request:{
  operation:'review_members',expectedContextVersion:snapshot.contextVersion,expectedCardRevision:card.revision,members,
}});
const choose=(ref,operation)=>({...ref,operation});
async function acceptManual(f) {
  return decideRecord(f.db,SCOPE,overlapCommand(f.snapshot,f.card,
    [choose(f.card.actionOverlap.manualRef,'accept_action')],'accept-manual-for-revert'));
}
const undoCommand=(receipt,context,key)=>({projectId:'p',eventId:'e',decisionId:receipt.mutationId,key,request:{
  expectedContextVersion:context,expectedDecisionRevision:1,
}});

test('matching requires one exact source set and a narrow, unambiguous action meaning',()=>{
  const source=[{assetVersionId:'av',segmentIdsJson:'["seg"]'}];
  const human={claimId:'manual',versionId:'manual-v1',statement:'向供应商确认安装价格',evidence:source};
  const ai={claimId:'ai',versionId:'ai-v1',clientClaimKey:'ai',statement:'向供应商核实安装价格',confidence:0.98,evidence:source};
  assert.equal(selectEarlyActionOverlaps([human],[ai])[0].confidence,0.9);
  assert.equal(selectEarlyActionOverlaps([human],[{...ai,statement:'向供应商确认安装周期'}]).length,0);
  assert.equal(selectEarlyActionOverlaps([human],[{...ai,evidence:[{assetVersionId:'av',segmentIdsJson:'["other"]'}]}]).length,0);
  assert.equal(selectEarlyActionOverlaps([human],[{...ai,confidence:0.84}]).length,0);
  for(const confidence of [NaN,Infinity,1.01])assert.equal(selectEarlyActionOverlaps([human],[{...ai,confidence}]).length,0);
  assert.equal(selectEarlyActionOverlaps([human,{...human,claimId:'manual-two'}],[ai]).length,0);
  assert.equal(selectEarlyActionOverlaps([human],[ai,{...ai,claimId:'ai-two'}]).length,0);
});

test('matching preserves amounts, currency, operators, ranges and word boundaries',()=>{
  const source=[{assetVersionId:'av',segmentIdsJson:'["seg"]'}];
  const human={claimId:'manual',versionId:'manual-v1',statement:'',evidence:source};
  const ai={claimId:'ai',versionId:'ai-v1',clientClaimKey:'ai',statement:'',confidence:0.98,evidence:source};
  for(const [left,right] of [
    ['向供应商确认安装价格为$1000','向供应商核实安装价格为€1000'],
    ['向供应商确认安装单价为10.5元','向供应商核实安装单价为105元'],
    ['向供应商确认安装数量>5','向供应商核实安装数量<5'],
    ['向供应商确认安装日期为10/12','向供应商核实安装日期为1012'],
    ['向供应商确认安装误差±5%','向供应商核实安装误差5%'],
    ['Confirm the supplier can re sign the contract','Confirm the supplier can resign the contract'],
  ]) assert.equal(selectEarlyActionOverlaps([{...human,statement:left}],[{...ai,statement:right}]).length,0,`${left} must differ from ${right}`);
  assert.equal(selectEarlyActionOverlaps([{...human,statement:'  向供应商确认安装价格。 '}],[{...ai,statement:'向供应商核实安装价格'}]).length,1);
});

test('frozen overlap keys validate exact refs and preserve client keys with delimiters',()=>{
  const manualRef={claimId:'manual',claimVersionId:'manual-v1'},modelRef={claimId:'model',claimVersionId:'model-v1'};
  const payload={v:1,runId:'run',clientClaimKey:'model:with|delimiters/中文',manualRef,modelRef};
  const key=value=>`action_overlap:${encodeURIComponent(JSON.stringify(value))}`;
  assert.deepEqual(frozenActionOverlapRefs(key(payload)),{manualRef,modelRef});
  for(const invalid of [null,'ordinary-group','action_overlap:legacy-run:legacy-key','action_overlap:%zz',
    key(null),key([]),key({...payload,v:2}),key({...payload,runId:''}),key({...payload,clientClaimKey:''}),
    key({...payload,manualRef:'manual'}),key({...payload,manualRef:{claimId:'manual',claimVersionId:''}}),
    key({...payload,modelRef:manualRef}),key({...payload,modelRef:{claimId:'model',claimVersionId:'manual-v1'}}),
  ])assert.equal(frozenActionOverlapRefs(invalid),undefined);
});

test('Summary-time human and model actions become one review entry with two intact claims',async t=>{
  const {db,sqlite}=await fixture(t);
  let manual;
  const calls=modelResponses('向供应商核实安装价格',async version=>{
    if(version===INVENTORY_SCHEMA_VERSION) manual=await addManual('human-during-model');
  });
  const result=await processExtractionRun('run');
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.equal(calls(),2);
  const snapshot=await readWorkspace(db,SCOPE,'e',{});
  const card=snapshot.reviewCards.find(c=>c.actionOverlap);
  assert.ok(card);
  assert.equal(card.suggestedOperation,'review_members');
  assert.equal(card.actionOverlap.manualRef.claimId,manual.id);
  assert.equal(card.members.length,2);
  assert.deepEqual(card.members.map(m=>m.origin),['user_input','ai_suggestion']);
  assert.deepEqual(card.members.map(m=>m.reviewState),['draft','draft']);
  assert.equal(snapshot.counts.needsDecisionCount,1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM claims').get().n,2);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM card_members WHERE card_id=?').get(card.id).n,2);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_cards WHERE group_key LIKE 'action_overlap:%'").get().n,1);
  const decision=await decideRecord(db,SCOPE,{projectId:'p',eventId:'e',cardId:card.id,key:'accept-manual',request:{
    operation:'review_members',expectedContextVersion:snapshot.contextVersion,expectedCardRevision:card.revision,
    members:[{claimId:manual.id,claimVersionId:card.actionOverlap.manualRef.claimVersionId,operation:'accept_action'}],
  }});
  assert.ok(decision);
  const partial=await readWorkspace(db,SCOPE,'e',{});
  const pending=partial.reviewCards.find(c=>c.id===card.id);
  assert.equal(pending.disposition,'active');
  assert.deepEqual(pending.members.map(m=>m.reviewState),['accepted','draft']);
  assert.equal(partial.counts.needsDecisionCount,1);
  assert.equal(partial.actions.length,1);
  const decisionRow=sqlite.prepare("SELECT id,revision FROM workflow_decisions WHERE idempotency_key='accept-manual'").get();
  await revertDecision(db,SCOPE,{projectId:'p',eventId:'e',decisionId:decisionRow.id,key:'undo-manual',request:{
    expectedContextVersion:partial.contextVersion,expectedDecisionRevision:decisionRow.revision,
  }});
  const restored=await readWorkspace(db,SCOPE,'e',{});
  assert.deepEqual(restored.reviewCards.find(c=>c.id===card.id).members.map(m=>m.reviewState),['draft','draft']);
  assert.equal(restored.actions.length,0);
  const restoredCard=restored.reviewCards.find(c=>c.id===card.id);
  await decideRecord(db,SCOPE,{projectId:'p',eventId:'e',cardId:card.id,key:'reject-model',request:{
    operation:'review_members',expectedContextVersion:restored.contextVersion,expectedCardRevision:restoredCard.revision,
    members:[{claimId:card.actionOverlap.modelRef.claimId,claimVersionId:card.actionOverlap.modelRef.claimVersionId,operation:'reject'}],
  }});
  const afterReject=await readWorkspace(db,SCOPE,'e',{});
  const stillOpen=afterReject.reviewCards.find(c=>c.id===card.id);
  assert.equal(stillOpen.disposition,'active');
  assert.deepEqual(stillOpen.members.map(m=>m.reviewState),['draft','rejected']);
  assert.equal(afterReject.counts.needsDecisionCount,1);
  await decideRecord(db,SCOPE,{projectId:'p',eventId:'e',cardId:card.id,key:'accept-human-final',request:{
    operation:'review_members',expectedContextVersion:afterReject.contextVersion,expectedCardRevision:stillOpen.revision,
    members:[{claimId:manual.id,claimVersionId:card.actionOverlap.manualRef.claimVersionId,operation:'accept_action'}],
  }});
  const processed=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(processed.reviewCards.find(c=>c.id===card.id).disposition,'processed');
  assert.equal(processed.counts.needsDecisionCount,0);
  assert.equal(processed.actions.length,1);
});

test('same passage with a different task stays as two independent draft entries',async t=>{
  const {db,sqlite}=await fixture(t);
  modelResponses('向供应商确认安装周期',async version=>{
    if(version===INVENTORY_SCHEMA_VERSION) await addManual('different-task');
  });
  assert.equal((await processExtractionRun('run')).status,'succeeded');
  const snapshot=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(snapshot.reviewCards.filter(c=>c.kind==='action').length,2,JSON.stringify(snapshot.reviewCards));
  assert.equal(snapshot.reviewCards.some(c=>c.actionOverlap),false);
  assert.equal(snapshot.counts.draftCount,2);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM claims').get().n,2);
});

test('manual action inserted at the publish boundary is paired by local retry without another paid stage',async t=>{
  const {db,sqlite}=await fixture(t);
  const calls=modelResponses('向供应商核实安装价格');
  const originalBatch=db.batch;
  let inserted=false,manual;
  db.batch=async statements=>{
    if(!inserted && statements.some(s=>s.sql.includes('INSERT INTO claims') && s.sql.includes("'ai'"))){
      inserted=true;
      manual=await addManual('publish-boundary-human');
    }
    return originalBatch(statements);
  };
  const result=await processExtractionRun('run');
  assert.equal(result.status,'succeeded',JSON.stringify(result));
  assert.equal(calls(),2);
  assert.equal(inserted,true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM claims').get().n,2);
  const snapshot=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(snapshot.reviewCards.find(c=>c.actionOverlap)?.actionOverlap.manualRef.claimId,manual.id);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,0);
});

test('choosing the human action and rejecting the model saves one atomic, replayable decision',async t=>{
  const f=await publishedOverlap(t),{db,sqlite,card,snapshot}=f;
  const command=overlapCommand(snapshot,card,[choose(card.actionOverlap.manualRef,'accept_action'),
    choose(card.actionOverlap.modelRef,'reject')],'choose-human');
  const receipt=await decideRecord(db,SCOPE,command);
  assert.deepEqual(await decideRecord(db,SCOPE,command),receipt);
  const after=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(after.actions.length,1);
  assert.equal(after.actions[0].id,card.actionOverlap.manualRef.claimId);
  assert.equal(after.reviewCards.find(c=>c.id===card.id).disposition,'processed');
  assert.equal(after.counts.needsDecisionCount,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,2);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n,1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM decision_members').get().n,2);
  await revertDecision(db,SCOPE,undoCommand(receipt,after.contextVersion,'undo-both-members'));
  const restored=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(restored.actions.length,0);
  assert.deepEqual(restored.reviewCards.find(c=>c.id===card.id).members.map(m=>m.reviewState),['draft','draft']);
  assert.equal(restored.counts.needsDecisionCount,1);
});

test('a grouping key change at commit rolls back both action choices',async t=>{
  const {db,sqlite,card,snapshot}=await publishedOverlap(t),batch=db.batch;
  db.batch=async statements=>{
    sqlite.prepare("UPDATE workflow_cards SET group_key='ordinary-actions' WHERE id=?").run(card.id);
    return batch(statements);
  };
  await assert.rejects(decideRecord(db,SCOPE,overlapCommand(snapshot,card,[choose(card.actionOverlap.manualRef,'accept_action'),
    choose(card.actionOverlap.modelRef,'reject')],'changed-group')),e=>e.code==='version_conflict');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM action_metadata').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n,0);
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,snapshot.contextVersion);
});

for(const timing of ['before-prepare','at-commit'])for(const change of ['remove','add'])test(`undo protects the full overlap membership when ${change} occurs ${timing}`,async t=>{
  const f=await publishedOverlap(t),{db,sqlite,card}=f,receipt=await acceptManual(f);
  const after=await readWorkspace(db,SCOPE,'e',{});
  const model=card.actionOverlap.modelRef;
  const changeMembers=()=>{
    if(change==='remove')sqlite.prepare('DELETE FROM card_members WHERE card_id=? AND claim_id=?').run(card.id,model.claimId);
    else {
      claim(sqlite,'added-action','next_action','后续新增的行动');
      insert(sqlite,'card_members',{id:'extra-member',workspace_id:'ws',card_id:card.id,claim_id:'added-action',
        claim_version_id:'added-action_v1',role:'context',created_at:T});
    }
  };
  if(timing==='before-prepare')changeMembers();
  else {const batch=db.batch;db.batch=async statements=>{changeMembers();return batch(statements);};}
  await assert.rejects(revertDecision(db,SCOPE,undoCommand(receipt,after.contextVersion,`undo-${timing}-${change}`)),
    e=>['dependency_conflict','version_conflict'].includes(e.code));
  assert.equal(sqlite.prepare('SELECT review_status FROM claims WHERE id=?').get(card.actionOverlap.manualRef.claimId).review_status,'verified');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n,1);
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,after.contextVersion);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,0);
});

test('a later exact-version drift falls back to independent writable cards and blocks old undo',async t=>{
  const f=await publishedOverlap(t),{db,sqlite,card}=f,receipt=await acceptManual(f);
  const before=await readWorkspace(db,SCOPE,'e',{}),model=card.actionOverlap.modelRef;
  insert(sqlite,'claim_versions',{id:'model-v2',claim_id:model.claimId,version_no:2,statement:'向供应商确认安装周期',source:'ai'});
  insert(sqlite,'evidence_refs',{id:'model-v2-evidence',workspace_id:'ws',project_id:'p',event_id:'e',claim_version_id:'model-v2',
    kind:'text',asset_version_id:'av',segment_ids_json:'["seg"]',quote_raw:'请询价。',evidence_role:'direct',provenance_grade:'primary',
    structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
  sqlite.prepare("UPDATE claims SET current_version_id='model-v2',workflow_revision=workflow_revision+1 WHERE id=?").run(model.claimId);
  const drifted=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(drifted.reviewCards.some(c=>c.actionOverlap),false);
  const solo=drifted.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===model.claimId));
  assert.ok(solo);
  assert.notEqual(solo.id,card.id);
  assert.equal(solo.memberRefs.length,1);
  await assert.rejects(revertDecision(db,SCOPE,undoCommand(receipt,before.contextVersion,'undo-drifted')),
    e=>e.code==='dependency_conflict');
  await decideRecord(db,SCOPE,overlapCommand(drifted,solo,[choose(solo.memberRefs[0],'accept_action')],'accept-new-solo'));
  assert.equal((await readWorkspace(db,SCOPE,'e',{})).actions.length,2);
  assert.equal(sqlite.prepare('SELECT group_key FROM workflow_cards WHERE id=?').get(card.id).group_key.startsWith('action_overlap:'),true);
});

test('editing the accepted manual task retires the old overlap even when card_members is updated',async t=>{
  const f=await publishedOverlap(t),{db,card}=f;
  await acceptManual(f);
  const before=await readWorkspace(db,SCOPE,'e',{}),current=before.reviewCards.find(c=>c.id===card.id);
  const edited=await decideRecord(db,SCOPE,overlapCommand(before,current,[{...choose(current.actionOverlap.manualRef,'edit'),
    newText:'向供应商确认安装周期',origin:'user_input',evidenceRefIds:[]}],'edit-human-task'));
  const after=await readWorkspace(db,SCOPE,'e',{});
  assert.equal(after.reviewCards.some(c=>c.actionOverlap),false);
  assert.ok(after.reviewCards.some(c=>c.memberRefs.length===1 && c.memberRefs[0].claimId===card.actionOverlap.modelRef.claimId));
  assert.ok(after.bullets.some(b=>b.text==='向供应商确认安装周期'));
  assert.ok(after.bullets.some(b=>b.text==='向供应商核实安装价格'));
  await revertDecision(db,SCOPE,undoCommand(edited,after.contextVersion,'undo-task-edit'));
  const restored=await readWorkspace(db,SCOPE,'e',{}),restoredCard=restored.reviewCards.find(c=>c.id===card.id);
  assert.deepEqual(restoredCard.actionOverlap,card.actionOverlap);
  assert.deepEqual(restoredCard.members.map(m=>m.reviewState),['accepted','draft']);
  assert.equal(restored.counts.needsDecisionCount,1);
  assert.ok(restored.bullets.some(b=>b.text==='向供应商确认安装价格'));
});
