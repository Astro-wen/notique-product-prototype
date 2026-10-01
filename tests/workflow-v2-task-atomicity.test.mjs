import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { workflowDatabase, seed, SCOPE, T } from './helpers/workflow-database.mjs';
import { CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_PROMPT_VERSION, ATOMIC_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_SCHEMA_VERSION } from '../lib/domain/model-contract.ts';
import { INVENTORY_SCHEMA_VERSION, LEGACY_INVENTORY_SCHEMA_VERSION, VERIFICATION_SCHEMA_VERSION, ATOMIC_VERIFICATION_SCHEMA_VERSION, LEGACY_VERIFICATION_SCHEMA_VERSION, LEGACY_VERIFICATION_PROMPT_VERSION, inventoryContractForRun, verificationContractForRun, validateVerificationOutput, assessVerificationEscalation } from '../lib/domain/two-stage-extraction.ts';
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

const source = '小陈负责在2026年10月8日前整理两家供应商的报价。预算上限人民币三万元。采购须店长审批。小林负责在2026年10月10日前提交草图。';
const evidence = [{ kind: 'text', asset_version_id: 'av', segment_ids: ['seg'], quote_hint: source, evidence_role: 'direct' }];
const usage = { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } };
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const normalized = value => value === null ? null : { entries: Object.entries(value).map(([key, value]) => ({ key, value })) };
const claim = (key, type, statement, value = null) => ({ client_claim_key: key, disposition: 'new', reaffirmed_target_claim_id: null, reaffirmed_target_version_id: null, type, statement, normalized_value: normalized(value), materiality: 'high', confidence: 0.98, needs_additional_evidence: false, uncertainty: null, evidence, relations: [] });
const finalClaims = () => [
  claim('quote', 'next_action', '小陈负责在2026年10月8日前整理两家供应商的报价。', { owner: '小陈', due_at: '2026-10-08' }),
  claim('budget', 'budget', '预算上限人民币三万元。', { amount: 30000, currency: 'CNY' }),
  claim('approval', 'requirement', '采购须店长审批。'),
  claim('sketch', 'next_action', '小林负责在2026年10月10日前提交草图。', { owner: '小林', due_at: '2026-10-10' }),
];
function inventory(version = INVENTORY_SCHEMA_VERSION) {
  const specs = [['quote-work', 'requirement', '需要整理两家供应商的报价。'], ['quote-owner', 'person_role', '小陈负责整理两家供应商的报价。'], ['quote-date', 'timing', '两家供应商报价须在2026年10月8日前整理完成。'], ['budget', 'budget', '预算上限人民币三万元。'], ['approval', 'requirement', '采购须店长审批。'], ['sketch', 'next_action', '小林负责在2026年10月10日前提交草图。']];
  return { schema_version: version, event_id: 'e', candidates: specs.map(([key, type, statement]) => ({ inventory_key: key, type, statement, normalized_value: null, materiality: 'high', critical: true, critical_reason: 'Supported material task or independent constraint.', confidence: 0.98, atomicity: 'atomic', evidence })) };
}
function verification(version = VERIFICATION_SCHEMA_VERSION) {
  return { schema_version: version, event_id: 'e', scenario_assessment: null, claims: finalClaims(), candidate_dispositions: inventory().candidates.map(c => ({ inventory_key: c.inventory_key, outcome: c.inventory_key.startsWith('quote-') ? 'merged' : 'included', final_claim_keys: [c.inventory_key.startsWith('quote-') ? 'quote' : c.inventory_key], reason: 'Task attributes retained together; independent facts retained separately.' })), draft_link_candidates: [], quality_review: { unresolved_conflict_keys: [], compound_claim_keys: [], reaffirmed_issue_claim_keys: [] }, ...(version !== LEGACY_VERIFICATION_SCHEMA_VERSION ? { same_intent_groups: [] } : {}) };
}
function decodedVerification(version) {
  const value = verification(version);
  return { ...value, claims: value.claims.map(c => ({ ...c, normalized_value: c.normalized_value === null ? null : Object.fromEntries(c.normalized_value.entries.map(e => [e.key, e.value])) })) };
}
async function setup(t) {
  const f = await workflowDatabase(); t.after(f.close); seed(f.sqlite);
  f.sqlite.exec('DELETE FROM claims');
  f.sqlite.prepare("UPDATE projects SET scenario='general',scenario_status='confirmed'").run();
  f.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
  f.sqlite.prepare("UPDATE text_segments SET text_raw=?,text_normalized=? WHERE id='seg'").run(source, source);
  globalThis.notiqueTaskTest = { db: f.db, bindings: { AI_PROVIDER: 'openai', AI_MODEL: 'synthetic-model', AI_API_KEY: 'synthetic-test-key', AI_API_BASE_URL: 'https://model.invalid/v1', AI_VERIFICATION_USES_READABLE: '0', AI_EVENT_SUMMARY: '0', AI_READABLE_TRANSCRIPT: '0', AI_DRAFT_CONTEXT: '0', AI_TWO_PASS_PIPELINE: '1' } };
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; delete globalThis.notiqueTaskTest; });
  return f;
}
function queue(sqlite, { runPrompt = CLAIM_EXTRACTION_PROMPT_VERSION, schema = VERIFICATION_SCHEMA_VERSION, frozen = true, pipeline = true } = {}) {
  sqlite.prepare("UPDATE extraction_runs SET status='queued',prompt_version=?,schema_version=?,provider='openai',model='synthetic-model',input_manifest_json=?,model_params_json=? WHERE id='run'").run(runPrompt, CLAIM_EXTRACTION_SCHEMA_VERSION, JSON.stringify([{ asset_version_id: 'av', sha256: 'synthetic', parser_version: 'test', kind: 'text' }]), JSON.stringify({ two_pass_pipeline: pipeline, verification_uses_readable: false, ...(schema ? { verification_schema_version: schema } : {}), ...(frozen ? { inventory_prompt_version: runPrompt, verification_prompt_version: runPrompt } : {}) }));
}
function model(t, answer) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    assert.ok(String(url).startsWith('https://model.invalid/'), 'All model calls remain offline');
    const request = { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null };
    requests.push(request); return json(await answer(request, requests.length));
  };
  return requests;
}
const promptOf = request => request.body?.input?.[0]?.content?.[0]?.text;

test('three task attribute inventory keys merge without losing critical coverage or independent propositions', () => {
  const output = decodedVerification();
  assert.equal(validateVerificationOutput(output, inventory()).valid, true);
  const assessment = assessVerificationEscalation(inventory(), output);
  assert.equal(assessment.required, false); assert.deepEqual(assessment.droppedCriticalInventoryKeys, []); assert.deepEqual(assessment.unmappedInventoryKeys, []);
  assert.deepEqual(output.claims.map(c => c.type), ['next_action', 'budget', 'requirement', 'next_action']);
  assert.equal(output.claims[0].normalized_value.owner, '小陈'); assert.equal(output.claims[0].normalized_value.due_at, '2026-10-08');
});

test('run builder freezes new prompt versions, and the processor publishes four complete draft entries in two stages', async t => {
  const { db, sqlite } = await setup(t);
  const created = await createExtractionRun(SCOPE, 'e', 'task-v94', ['av']);
  const frozen = JSON.parse(sqlite.prepare('SELECT model_params_json FROM extraction_runs WHERE id=?').get(created.run.id).model_params_json);
  assert.equal(created.run.prompt_version, CLAIM_EXTRACTION_PROMPT_VERSION); assert.equal(frozen.inventory_prompt_version, CLAIM_EXTRACTION_PROMPT_VERSION); assert.equal(frozen.verification_prompt_version, CLAIM_EXTRACTION_PROMPT_VERSION); assert.equal(frozen.verification_schema_version, VERIFICATION_SCHEMA_VERSION);
  const replay = await createExtractionRun(SCOPE, 'e', 'task-v94', ['av']); assert.equal(replay.created, false); assert.equal(replay.run.input_hash, created.run.input_hash);
  const requests = model(t, (r, n) => ({ id: `synthetic_${n}`, status: 'completed', output_text: JSON.stringify(r.body.text.format.schema.properties.schema_version.enum[0] === INVENTORY_SCHEMA_VERSION ? inventory() : verification()), usage }));
  const result = await processExtractionRun(created.run.id); assert.equal(result.status, 'succeeded', JSON.stringify({ result, error: sqlite.prepare('SELECT error_details_json FROM extraction_runs WHERE id=?').get(created.run.id) })); assert.equal(requests.length, 2); assert.equal(result.persistedClaims, 4);
  for (const request of requests) { assert.match(promptOf(request), /One concrete task is one atomic next_action/); assert.match(promptOf(request), /Never infer a year from the current clock/); }
  assert.match(promptOf(requests[1]), /outcome=merged with the same single final next_action/);
  const w = await readWorkspace(db, SCOPE, 'e', {}, T); assert.equal(w.bullets.length, 4); assert.equal(w.reviewCards.length, 4); assert.equal(w.actions.length, 0); assert.ok(w.bullets.every(b => b.reviewState === 'draft'));
  const tasks = sqlite.prepare("SELECT c.type,v.statement,v.normalized_value_json FROM claims c JOIN claim_versions v ON v.id=c.current_version_id WHERE c.type='next_action' ORDER BY c.client_claim_key").all();
  assert.equal(tasks.length, 2); assert.deepEqual(tasks.map(c => JSON.parse(c.normalized_value_json).owner), ['小陈', '小林']);
  assert.ok(sqlite.prepare('SELECT prompt_version FROM extraction_model_stages').all().every(s => s.prompt_version.startsWith(`${CLAIM_EXTRACTION_PROMPT_VERSION}:`)));
});

for (const [schema, runPrompt, frozen] of [[LEGACY_VERIFICATION_SCHEMA_VERSION, LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION, false], [ATOMIC_VERIFICATION_SCHEMA_VERSION, LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION, false], [ATOMIC_VERIFICATION_SCHEMA_VERSION, ATOMIC_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, true], [VERIFICATION_SCHEMA_VERSION, CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, true], [VERIFICATION_SCHEMA_VERSION, CLAIM_EXTRACTION_PROMPT_VERSION, true]]) test(`paid ${runPrompt}/${schema} checkpoint resumes without another POST`, async t => {
  const { sqlite } = await setup(t); queue(sqlite, { runPrompt, schema, frozen });
  const requests = model(t, (r, n) => {
    if (r.method === 'GET') return { id: 'synthetic_paid_verify', status: 'completed', output_text: JSON.stringify(verification(schema)), usage };
    const inventoryVersion = r.body.text.format.schema.properties.schema_version.enum[0];
    return String(inventoryVersion).startsWith('claim-inventory.') ? { id: `synthetic_inventory_${n}`, status: 'completed', output_text: JSON.stringify(inventory(inventoryVersion)), usage } : { id: 'synthetic_paid_verify', status: 'queued' };
  });
  assert.equal((await processExtractionRun('run')).status, 'background_pending');
  const paidInventory = sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get();
  const paidVerify = sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();
  assert.equal(paidInventory.prompt_version, `${frozen ? runPrompt : LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION}:inventory`);
  assert.equal(paidVerify.prompt_version, `${frozen ? runPrompt : schema === LEGACY_VERIFICATION_SCHEMA_VERSION ? LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION : LEGACY_VERIFICATION_PROMPT_VERSION}:verify`);
  for (const request of requests) {
    if (frozen) assert.match(promptOf(request), /One concrete task is one atomic next_action/);
    else assert.doesNotMatch(promptOf(request), /One concrete task is one atomic next_action/);
  }
  assert.equal((await processExtractionRun('run')).status, 'succeeded'); assert.deepEqual(requests.map(r => r.method), ['POST', 'POST', 'GET']);
  assert.deepEqual(sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get(), paidInventory);
  const resumed = sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='verify'").get();
  for (const field of ['attempt', 'input_hash', 'prompt_version', 'schema_version', 'provider_request_id']) assert.equal(resumed[field], paidVerify[field]);
});

test('paid old inventory resumes with GET before the old v5 verifier is invoked', async t => {
  const { sqlite } = await setup(t); queue(sqlite, { runPrompt: LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION, schema: ATOMIC_VERIFICATION_SCHEMA_VERSION, frozen: false });
  const requests = model(t, (r, n) => {
    if (r.method === 'GET') return { id: 'synthetic_paid_inventory', status: 'completed', output_text: JSON.stringify(inventory(LEGACY_INVENTORY_SCHEMA_VERSION)), usage };
    if (r.body.text.format.schema.properties.schema_version.enum[0] === LEGACY_INVENTORY_SCHEMA_VERSION) return { id: 'synthetic_paid_inventory', status: 'queued' };
    return { id: `synthetic_verify_${n}`, status: 'completed', output_text: JSON.stringify(verification(ATOMIC_VERIFICATION_SCHEMA_VERSION)), usage };
  });
  assert.equal((await processExtractionRun('run')).status, 'background_pending');
  const before = sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get();
  assert.equal(before.prompt_version, `${LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION}:inventory`);
  assert.equal((await processExtractionRun('run')).status, 'succeeded'); assert.deepEqual(requests.map(r => r.method), ['POST', 'GET', 'POST']);
  const after = sqlite.prepare("SELECT * FROM extraction_model_stages WHERE stage='inventory'").get();
  for (const field of ['attempt', 'input_hash', 'prompt_version', 'schema_version', 'provider_request_id']) assert.equal(after[field], before[field]);
  assert.equal(sqlite.prepare("SELECT prompt_version FROM extraction_model_stages WHERE stage='verify'").get().prompt_version, `${LEGACY_VERIFICATION_PROMPT_VERSION}:verify`);
  assert.doesNotMatch(promptOf(requests.at(-1)), /One concrete task is one atomic next_action/);
});

for (const version of [LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_PROMPT_VERSION]) test(`singlepass ${version} sends its actual frozen task rule`, async t => {
  const { sqlite } = await setup(t); queue(sqlite, { runPrompt: version, frozen: false, pipeline: false, schema: null });
  const requests = model(t, (_r, n) => ({ id: `synthetic_single_${n}`, status: 'completed', output_text: JSON.stringify({ schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION, event_id: 'e', scenario_assessment: null, claims: finalClaims() }), usage }));
  assert.equal((await processExtractionRun('run')).status, 'succeeded'); assert.equal(requests.length, 1);
  if (version === LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION) { assert.match(promptOf(requests[0]), /Split a sentence when it contains separate dates, assignments/); assert.doesNotMatch(promptOf(requests[0]), /One concrete task is one atomic next_action/); }
  else { assert.match(promptOf(requests[0]), /One concrete task is one atomic next_action/); assert.match(promptOf(requests[0]), /leave due_at absent/); assert.match(promptOf(requests[0]), /Keep independent budgets, approval rules/); }
});

test('unknown frozen versions fail before provider payment; implicit old contracts remain unchanged', async t => {
  assert.equal(inventoryContractForRun({}).promptVersion, LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION);
  assert.equal(verificationContractForRun({}).promptVersion, LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION);
  assert.equal(verificationContractForRun({ verification_schema_version: ATOMIC_VERIFICATION_SCHEMA_VERSION }).promptVersion, LEGACY_VERIFICATION_PROMPT_VERSION);
  assert.throws(() => inventoryContractForRun({ inventory_prompt_version: 'invented' }));
  assert.throws(() => verificationContractForRun({ verification_schema_version: LEGACY_VERIFICATION_SCHEMA_VERSION, verification_prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION }));
  const { sqlite } = await setup(t); queue(sqlite); const params = JSON.parse(sqlite.prepare("SELECT model_params_json FROM extraction_runs WHERE id='run'").get().model_params_json); params.inventory_prompt_version = 'invented'; sqlite.prepare("UPDATE extraction_runs SET model_params_json=? WHERE id='run'").run(JSON.stringify(params));
  const requests = model(t, () => { throw new Error('No paid provider call is allowed'); }); const result = await processExtractionRun('run'); assert.equal(result.status, 'failed'); assert.equal(requests.length, 0);
});
