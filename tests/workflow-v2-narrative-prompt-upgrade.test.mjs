import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase, seed, insert, SCOPE, T } from './helpers/workflow-database.mjs';
import { consumeNarrativeJobs } from '../lib/server/workflow/narrative-jobs.ts';
import { readAnalysisRun, retryAnalysis } from '../lib/server/workflow/analysis-service.ts';
import { digestValue, loadWorkflowLedger, readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { projectWorkspace } from '../lib/domain/workflow-projection.ts';
import { WORKFLOW_NARRATIVE_LEGACY_PROMPT_VERSION as LEGACY, WORKFLOW_NARRATIVE_PREVIOUS_PROMPT_VERSION as PREVIOUS, WORKFLOW_NARRATIVE_TOPIC_LAYOUT_PROMPT_VERSION as TOPIC_LAYOUT, WORKFLOW_NARRATIVE_PROMPT_VERSION as CURRENT, WORKFLOW_NARRATIVE_SCHEMA_VERSION as SCHEMA, workflowNarrativePrompt, workflowNarrativeSentences, validateWorkflowNarrative } from '../lib/domain/workflow-narrative.ts';

// Providers below are synthetic. These tests prove prompt selection, exact
// references and paid-checkpoint recovery, not a real model's writing quality.
const config = { provider: 'test', model: 'test', reasoningEffort: 'low', baseUrl: 'https://model.invalid', maxOutputTokens: 6000 };
const usage = { inputTokens: 12, outputTokens: 6, cachedTokens: 0, providerRequestId: 'resp_synthetic' };
const plus = n => new Date(Date.parse(T) + n).toISOString();
const output = input => ({ schema_version: SCHEMA, event_id: input.eventId, sentences: input.bullets.map(b => ({ text: b.text, claim_refs: b.claimRefs })) });
const run = (db, provider, now = 9000) => consumeNarrativeJobs(db, { config, provider: () => provider, clock: () => plus(now), random: () => 0 });
const row = (sqlite, id = 'legacy') => sqlite.prepare('SELECT * FROM workflow_outbox WHERE id=?').get(id);
const payload = (sqlite, id = 'legacy') => JSON.parse(row(sqlite, id).payload_json);
const pending = options => { throw Object.assign(new Error('synthetic pending'), { code: 'MODEL_BACKGROUND_PENDING', providerResponseId: options?.resumeProviderResponseId ?? 'resp_legacy' }); };

async function setup(t) {
  const f = await workflowDatabase(); t.after(f.close); seed(f.sqlite);
  f.sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
  f.sqlite.prepare("UPDATE claim_versions SET statement='小林负责在10月10日前提交草图' WHERE id='action_v1'").run();
  return f;
}
async function oldCheckpoint(f, { savedOutput = false } = {}) {
  insert(f.sqlite, 'workflow_outbox', { id: 'legacy', workspace_id: 'ws', project_id: 'p', event_id: 'e', kind: 'narrative', task_key: 'old-paid', input_revision: 0, payload_json: '{"eventId":"e","contextVersion":0}', available_at: T, created_at: T, updated_at: T });
  assert.equal((await run(f.db, { async summarizeWorkflow(input, options) { await options.onProviderResponse({ id: 'resp_legacy', status: 'queued' }); pending(options); } }, 3000)).pending, 1);
  const saved = payload(f.sqlite);
  saved.checkpoint.promptVersion = LEGACY;
  saved.checkpoint.inputHash = await digestValue({ input: saved.checkpoint.input, config, schemaVersion: SCHEMA, promptVersion: LEGACY });
  saved.checkpoint.usage = [{ ...usage, providerRequestId: 'resp_legacy_paid', attempt: 1 }];
  saved.auditUsage = [{ ...usage, providerRequestId: 'resp_legacy_paid', attempt: 1, inputHash: saved.checkpoint.inputHash }];
  if (savedOutput) saved.checkpoint.output = output(saved.checkpoint.input);
  f.sqlite.prepare('UPDATE workflow_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(saved), 'legacy');
  return saved;
}
async function publishOld(f) {
  await oldCheckpoint(f, { savedOutput: true });
  assert.equal((await run(f.db, { async summarizeWorkflow() { assert.fail('a saved paid output must publish without another provider request'); } })).succeeded, 1);
  // Simulate a row published before the application prompt upgrade.
  f.sqlite.prepare("UPDATE workflow_narratives SET freshness='current'").run();
  return row(f.sqlite);
}

test('v2 separates platform review metadata from source modality while the exact v1 prompt remains available', () => {
  const input = { eventId: 'e', contextVersion: 0, sourceRevision: 0, coverage: { complete: true, totalSegments: 1, completedSegments: 1, unprocessedRanges: [] }, bullets: [
    { text: '小林负责在10月10日前提交草图', claimRefs: [{ claimId: 'assigned', claimVersionId: 'assigned_v1' }], origin: 'ai_suggestion', reviewState: 'draft' },
    { text: '建议小陈整理报价，如果预算允许再采购', claimRefs: [{ claimId: 'proposal', claimVersionId: 'proposal_v1' }], origin: 'ai_suggestion', reviewState: 'accepted' },
  ] };
  assert.equal(SCHEMA, 'workflow-narrative.v1');
  assert.equal(CURRENT, 'workflow-narrative-prompt.v6');
  const before = structuredClone(input);
  const prompt = workflowNarrativePrompt(input);
  assert.match(prompt, /ai_suggestion means an AI-extracted candidate action/);
  assert.match(prompt, /metadata do not change the speaker's certainty/);
  assert.match(prompt, /Preserve a genuine 建议, 可能 or 如果 condition, including after user acceptance/);
  const old = workflowNarrativePrompt(input, ['exact version'], LEGACY);
  assert.match(old, /A proposed action remains a suggestion\. A draft remains unconfirmed\./);
  assert.doesNotMatch(old, /AI-extracted candidate action/);
  assert.deepEqual(input, before);
  const sentences = workflowNarrativeSentences(validateWorkflowNarrative(output(input), input), input);
  assert.equal(sentences[0].text, input.bullets[0].text);
  assert.equal(sentences[0].reviewState, 'draft');
  assert.equal(sentences[1].text, input.bullets[1].text);
  assert.equal(sentences[1].reviewState, 'accepted');
  assert.throws(() => workflowNarrativePrompt(input, [], 'unknown'), /Unsupported/);
});

test('already-paid v1 response resumes the same frozen request and publishes as previous text', async t => {
  const f = await setup(t), saved = await oldCheckpoint(f);
  let calls = 0;
  const result = await run(f.db, { async summarizeWorkflow(input, options) {
    calls++;
    assert.equal(options.workflowNarrativePromptVersion, LEGACY);
    assert.equal(options.resumeProviderResponseId, 'resp_legacy');
    assert.equal(options.idempotencyKey, `notique:legacy:${saved.checkpoint.inputHash}:0`);
    assert.deepEqual(input, saved.checkpoint.input);
    assert.match(workflowNarrativePrompt(input, options.qualityFeedback, options.workflowNarrativePromptVersion), /A draft remains unconfirmed/);
    return { output: output(input), usage };
  } });
  assert.equal(result.succeeded, 1); assert.equal(calls, 1);
  const cp = payload(f.sqlite).checkpoint;
  assert.equal(cp.attempt, 1); assert.equal(cp.promptVersion, LEGACY); assert.equal(cp.inputHash, saved.checkpoint.inputHash);
  assert.equal(payload(f.sqlite).auditUsage[0].providerRequestId, 'resp_legacy_paid');
  const snapshot = await readWorkspace(f.db, SCOPE, 'e', {}, plus(9500));
  assert.equal(snapshot.narrative.freshness, 'stale');
  assert.match(snapshot.narrative.text, /小林负责在10月10日前提交草图/);
  assert.equal(snapshot.narrative.sentenceRefs.find(s => s.claimRefs[0].claimId === 'action').reviewState, 'draft');
});

test('a paid v2 response keeps its frozen prompt and request when v3 adds topic layout', async t => {
  const f=await setup(t);await oldCheckpoint(f);
  const saved=payload(f.sqlite);saved.checkpoint.promptVersion=PREVIOUS;
  saved.checkpoint.inputHash=await digestValue({input:saved.checkpoint.input,config,schemaVersion:SCHEMA,promptVersion:PREVIOUS});
  f.sqlite.prepare('UPDATE workflow_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(saved),'legacy');
  let calls=0;
  const result=await run(f.db,{async summarizeWorkflow(input,options){
    calls++;assert.equal(options.workflowNarrativePromptVersion,PREVIOUS);assert.equal(options.resumeProviderResponseId,'resp_legacy');
    assert.equal(options.idempotencyKey,`notique:legacy:${saved.checkpoint.inputHash}:0`);
    assert.doesNotMatch(workflowNarrativePrompt(input,[],PREVIOUS),/Every sentence has topic/);
    return {output:output(input),usage};
  }});
  assert.equal(result.succeeded,1);assert.equal(calls,1);
  assert.equal(payload(f.sqlite).checkpoint.promptVersion,PREVIOUS);
  assert.equal((await readWorkspace(f.db,SCOPE,'e',{},plus(9500))).narrative.freshness,'stale');
});

test('a paid v3 response resumes its original topic prompt and request after v4 changes grouping', async t => {
  const f=await setup(t);await oldCheckpoint(f);
  const saved=payload(f.sqlite);saved.checkpoint.promptVersion=TOPIC_LAYOUT;
  saved.checkpoint.inputHash=await digestValue({input:saved.checkpoint.input,config,schemaVersion:SCHEMA,promptVersion:TOPIC_LAYOUT});
  f.sqlite.prepare('UPDATE workflow_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(saved),'legacy');
  let calls=0;
  const result=await run(f.db,{async summarizeWorkflow(input,options){
    calls++;assert.equal(options.workflowNarrativePromptVersion,TOPIC_LAYOUT);assert.equal(options.resumeProviderResponseId,'resp_legacy');
    assert.equal(options.idempotencyKey,`notique:legacy:${saved.checkpoint.inputHash}:0`);
    assert.match(workflowNarrativePrompt(input,[],options.workflowNarrativePromptVersion),/Separate unrelated properties, people, suppliers and tasks/);
    const frozenOutput=output(input);
    frozenOutput.sentences=frozenOutput.sentences.map(s=>({...s,topic:{key:'original',title:'原有主题'}}));
    return {output:frozenOutput,usage};
  }});
  assert.equal(result.succeeded,1);assert.equal(calls,1);
  const cp=payload(f.sqlite).checkpoint;
  assert.equal(cp.promptVersion,TOPIC_LAYOUT);assert.equal(cp.inputHash,saved.checkpoint.inputHash);assert.equal(cp.attempt,1);
  assert.equal(payload(f.sqlite).auditUsage[0].providerRequestId,'resp_legacy_paid');
  const snapshot=await readWorkspace(f.db,SCOPE,'e',{},plus(9500));
  assert.equal(snapshot.narrative.freshness,'stale');
  assert.deepEqual(new Set(snapshot.narrative.sentenceRefs.flatMap(s=>s.claimRefs.map(r=>r.claimVersionId))),new Set(saved.checkpoint.input.bullets.flatMap(b=>b.claimRefs.map(r=>r.claimVersionId))));
});

test('a paid v4 response resumes its exact matter prompt after v5 changes training grouping', async t => {
  const f=await setup(t);await oldCheckpoint(f);
  const saved=payload(f.sqlite);saved.checkpoint.promptVersion='workflow-narrative-prompt.v4';
  saved.checkpoint.inputHash=await digestValue({input:saved.checkpoint.input,config,schemaVersion:SCHEMA,promptVersion:saved.checkpoint.promptVersion});
  f.sqlite.prepare('UPDATE workflow_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(saved),'legacy');
  let calls=0;
  const result=await run(f.db,{async summarizeWorkflow(input,options){
    calls++;assert.equal(options.workflowNarrativePromptVersion,'workflow-narrative-prompt.v4');
    assert.equal(options.resumeProviderResponseId,'resp_legacy');
    assert.equal(options.idempotencyKey,`notique:legacy:${saved.checkpoint.inputHash}:0`);
    assert.doesNotMatch(workflowNarrativePrompt(input,[],options.workflowNarrativePromptVersion),/For one employee training program/);
    return {output:{...output(input),sentences:input.bullets.map(b=>({text:b.text,claim_refs:b.claimRefs,topic:{key:'existing',title:'原有事项'}}))},usage};
  }});
  assert.equal(result.succeeded,1);assert.equal(calls,1);
  assert.equal(payload(f.sqlite).checkpoint.promptVersion,saved.checkpoint.promptVersion);
  assert.equal(payload(f.sqlite).checkpoint.inputHash,saved.checkpoint.inputHash);
  assert.equal(payload(f.sqlite).auditUsage[0].providerRequestId,'resp_legacy_paid');
  const before=f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n;
  assert.equal((await readWorkspace(f.db,SCOPE,'e',{},plus(9500))).narrative.freshness,'stale');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,before);
});

test('a stored paid v3 output publishes unchanged and reading it creates no current job', async t => {
  const f=await setup(t);await oldCheckpoint(f,{savedOutput:true});
  const saved=payload(f.sqlite);saved.checkpoint.promptVersion=TOPIC_LAYOUT;
  saved.checkpoint.inputHash=await digestValue({input:saved.checkpoint.input,config,schemaVersion:SCHEMA,promptVersion:TOPIC_LAYOUT});
  saved.checkpoint.output.sentences=saved.checkpoint.output.sentences.map(s=>({...s,topic:{key:'original',title:'原有主题'}}));
  f.sqlite.prepare('UPDATE workflow_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(saved),'legacy');
  const result=await run(f.db,{async summarizeWorkflow(){assert.fail('saved paid v3 output commissions no provider request');}});
  assert.equal(result.succeeded,1);
  assert.deepEqual(payload(f.sqlite).checkpoint.output,saved.checkpoint.output);
  const before=row(f.sqlite);
  const first=await readWorkspace(f.db,SCOPE,'e',{},plus(10000));
  const second=await readWorkspace(f.db,SCOPE,'e',{},plus(11000));
  assert.equal(first.narrative.freshness,'stale');assert.deepEqual(first,second);
  assert.deepEqual(row(f.sqlite),before);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,1);
});

test('a stored valid v1 output publishes without making another paid provider call', async t => {
  const f = await setup(t); await publishOld(f);
  const before = f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n;
  const first = await readWorkspace(f.db, SCOPE, 'e', {}, plus(10000));
  const next = await readWorkspace(f.db, SCOPE, 'e', {}, plus(11000));
  assert.equal(first.narrative.freshness, 'stale'); assert.deepEqual(next.narrative, first.narrative);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n, before, 'reading an outdated narrative commissions nothing');
});

test('v1 targeted repair keeps its frozen prompt, generation and paid usage', async t => {
  const f = await setup(t); await oldCheckpoint(f); let calls = 0;
  const provider = { async summarizeWorkflow(input, options) {
    calls++; assert.equal(options.workflowNarrativePromptVersion, LEGACY);
    if (calls === 1) { assert.equal(options.resumeProviderResponseId, 'resp_legacy'); return { output: { ...output(input), event_id: 'wrong' }, usage }; }
    assert.equal(options.resumeProviderResponseId, undefined);
    assert.ok(options.qualityFeedback.some(x => x.includes('event_id')));
    assert.match(options.idempotencyKey, /:1$/);
    return { output: output(input), usage: { ...usage, providerRequestId: 'resp_repair' } };
  } };
  assert.equal((await run(f.db, provider)).pending, 1);
  assert.equal((await run(f.db, provider, 13000)).succeeded, 1);
  const cp = payload(f.sqlite).checkpoint;
  assert.equal(calls, 2); assert.equal(cp.promptVersion, LEGACY); assert.equal(cp.attempt, 2); assert.equal(cp.repairCount, 1);
  assert.equal(cp.usage.length, 3); assert.equal(payload(f.sqlite).auditUsage.length, 3);
});

test('a succeeded old narrative remains succeeded and readable until the user explicitly requests v2', async t => {
  const f = await setup(t), old = await publishOld(f);
  const readChanges = f.sqlite.prepare('SELECT total_changes() n').get().n;
  const progress = await readAnalysisRun(f.db, SCOPE, 'run');
  assert.equal(progress.state, 'succeeded');
  const stage = progress.stages.find(s => s.id === 'legacy');
  assert.equal(stage.state, 'succeeded'); assert.equal(stage.retryable, true); assert.equal(stage.errorCode, 'NARRATIVE_PROMPT_OUTDATED');
  assert.equal(f.sqlite.prepare('SELECT total_changes() n').get().n, readChanges);
  assert.deepEqual(await readAnalysisRun(f.db, SCOPE, 'run'), progress);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n, 1);
  const body = { expectedRunRevision: progress.revision, stageIds: ['legacy'] };
  const updated = await retryAnalysis(f.db, SCOPE, 'run', body, 'refresh', plus(10000));
  assert.equal(updated.state, 'partial');
  assert.equal(updated.stages.filter(s => s.state === 'queued').length, 1);
  assert.deepEqual(row(f.sqlite), old, 'the succeeded job and its paid audit are immutable');
  const fresh = f.sqlite.prepare("SELECT * FROM workflow_outbox WHERE id<>'legacy'").get();
  assert.equal(JSON.parse(fresh.payload_json).checkpoint, undefined);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM extraction_runs').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM queue_outbox').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT context_version FROM projects').get().context_version, 0);
  await retryAnalysis(f.db, SCOPE, 'run', body, 'refresh', plus(10500));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n, 2);
  assert.equal((await run(f.db, { async summarizeWorkflow(input, options) {
    assert.equal(options.workflowNarrativePromptVersion, CURRENT); assert.equal(options.resumeProviderResponseId, undefined);
    return { output: output(input), usage: { ...usage, providerRequestId: 'resp_v2' } };
  } }, 12000)).succeeded, 1);
  const cp = payload(f.sqlite, fresh.id).checkpoint;
  assert.equal(cp.promptVersion, CURRENT); assert.notEqual(cp.inputHash, JSON.parse(old.payload_json).checkpoint.inputHash);
  const current = await readWorkspace(f.db, SCOPE, 'e', {}, plus(12500));
  assert.equal(current.narrative.freshness, 'current');
  const finished = await readAnalysisRun(f.db, SCOPE, 'run');
  assert.equal(finished.state, 'succeeded'); assert.equal(finished.retryable, false);
  assert.equal(finished.stages.find(s => s.id === fresh.id).errorCode, null);
});

test('explicit retry of a failed v1 checkpoint creates current input while keeping old audit', async t => {
  const f = await setup(t); await oldCheckpoint(f);
  f.sqlite.prepare("UPDATE workflow_outbox SET state='failed',error_code='NARRATIVE_RETRY_EXHAUSTED' WHERE id='legacy'").run();
  const old = row(f.sqlite), progress = await readAnalysisRun(f.db, SCOPE, 'run');
  await retryAnalysis(f.db, SCOPE, 'run', { expectedRunRevision: progress.revision, stageIds: ['legacy'] }, 'retry-old', plus(10000));
  assert.deepEqual(row(f.sqlite), old);
  const fresh = f.sqlite.prepare("SELECT * FROM workflow_outbox WHERE id<>'legacy'").get();
  assert.equal(JSON.parse(fresh.payload_json).checkpoint, undefined);
  assert.equal((await run(f.db, { async summarizeWorkflow(input, options) {
    assert.equal(options.workflowNarrativePromptVersion, CURRENT); assert.equal(options.resumeProviderResponseId, undefined);
    return { output: output(input), usage };
  } }, 12000)).succeeded, 1);
  assert.equal(payload(f.sqlite, fresh.id).checkpoint.promptVersion, CURRENT);
});

test('outdated narrative refresh keeps existing permission and compare-and-swap protection', async t => {
  const f = await setup(t); await publishOld(f); const progress = await readAnalysisRun(f.db, SCOPE, 'run');
  insert(f.sqlite, 'workspace_members', { id: 'viewer', workspace_id: 'ws', actor_id: 'viewer', role: 'viewer' });
  const body = { expectedRunRevision: progress.revision, stageIds: ['legacy'] };
  await assert.rejects(retryAnalysis(f.db, { ...SCOPE, actorId: 'viewer' }, 'run', body, 'viewer'), e => e.code === 'forbidden');
  const original = f.db.batch; let race = true;
  f.db.batch = async statements => {
    if (race) { race = false; f.sqlite.prepare("UPDATE workflow_outbox SET updated_at=? WHERE id='legacy'").run(plus(15000)); }
    return original(statements);
  };
  await assert.rejects(retryAnalysis(f.db, SCOPE, 'run', body, 'raced'), e => e.code === 'version_conflict');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM mutation_replays').get().n, 0);
});

test('a narrative is current only when its exact successful job and input hash identify the current prompt', async t => {
  const f = await setup(t); await publishOld(f);
  const old = JSON.parse(row(f.sqlite).payload_json);
  insert(f.sqlite, 'workflow_outbox', { id: 'unrelated-v2', workspace_id: 'ws', project_id: 'p', event_id: 'e', kind: 'narrative', task_key: 'unrelated-v2', input_revision: 0, state: 'succeeded', payload_json: JSON.stringify({ checkpoint: { promptVersion: CURRENT, inputHash: 'different' } }), available_at: T, created_at: plus(10000), updated_at: plus(10000) });
  assert.equal((await readWorkspace(f.db, SCOPE, 'e', {}, plus(11000))).narrative.freshness, 'stale');
  const legacy = row(f.sqlite);
  f.sqlite.prepare("UPDATE workflow_outbox SET payload_json=? WHERE id='unrelated-v2'").run(JSON.stringify({ checkpoint: { promptVersion: CURRENT, inputHash: old.checkpoint.inputHash } }));
  assert.equal((await readWorkspace(f.db, SCOPE, 'e', {}, plus(12000))).narrative.freshness, 'current');
  f.sqlite.prepare("UPDATE workflow_outbox SET state='failed' WHERE id='unrelated-v2'").run();
  assert.equal((await loadWorkflowLedger(f.db, SCOPE, 'p')).narratives[0].prompt_version, LEGACY);
  f.sqlite.prepare("DELETE FROM workflow_outbox WHERE id='legacy'").run();
  const loaded = await loadWorkflowLedger(f.db, SCOPE, 'p');
  assert.equal(loaded.narratives[0].prompt_version, null);
  assert.equal(projectWorkspace(loaded, 'e', plus(13000), '').narrative.freshness, 'failed');
  assert.equal(JSON.parse(legacy.payload_json).checkpoint.promptVersion, LEGACY);
});

test('a late paid v1 publication cannot replace an already-current v2 narrative', async t => {
  const f = await setup(t); await oldCheckpoint(f, { savedOutput: true });
  f.sqlite.prepare("UPDATE workflow_outbox SET state='running',lease_owner='old-owner',lease_expires_at=?,available_at=? WHERE id='legacy'").run(plus(20000), T);
  insert(f.sqlite, 'workflow_outbox', { id: 'current', workspace_id: 'ws', project_id: 'p', event_id: 'e', kind: 'narrative', task_key: 'current', input_revision: 0, payload_json: '{"eventId":"e","contextVersion":0}', available_at: plus(10000), created_at: plus(10000), updated_at: plus(10000) });
  assert.equal((await run(f.db, { async summarizeWorkflow(input, options) {
    assert.equal(options.workflowNarrativePromptVersion, CURRENT);
    const result = output(input); result.sentences[0].text = '新版：' + result.sentences[0].text;
    return { output: result, usage };
  } }, 15000)).succeeded, 1);
  const before = f.sqlite.prepare('SELECT text,input_hash FROM workflow_narratives').get();
  assert.equal((await run(f.db, { async summarizeWorkflow() { assert.fail('v1 output was already paid and saved'); } }, 21000)).succeeded, 1);
  assert.deepEqual(f.sqlite.prepare('SELECT text,input_hash FROM workflow_narratives').get(), before);
  const snapshot = await readWorkspace(f.db, SCOPE, 'e', {}, plus(22000));
  assert.equal(snapshot.narrative.freshness, 'current'); assert.match(snapshot.narrative.text, /新版：/);
  const progress = await readAnalysisRun(f.db, SCOPE, 'run');
  assert.equal(progress.state, 'succeeded'); assert.equal(progress.retryable, false);
});

test('old cached projection versions cannot restore a current label after the prompt upgrade', async t => {
  const f = await setup(t);
  const snapshot = await readWorkspace(f.db, SCOPE, 'e', {}, plus(10000));
  assert.equal((await readWorkspace(f.db, SCOPE, 'e', { snapshotId: snapshot.snapshotId }, plus(11000))).snapshotId, snapshot.snapshotId);
  const old = JSON.parse(f.sqlite.prepare('SELECT payload_json FROM workflow_snapshots WHERE id=?').get(snapshot.snapshotId).payload_json);
  delete old.projectionVersion;
  f.sqlite.prepare('UPDATE workflow_snapshots SET payload_json=? WHERE id=?').run(JSON.stringify(old), snapshot.snapshotId);
  await assert.rejects(readWorkspace(f.db, SCOPE, 'e', { snapshotId: snapshot.snapshotId }, plus(12000)), e => e.code === 'cursor_expired');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n, 0);
});


test('paid v5 formatting retains its original IDs and prompt after the compact v6 upgrade', async t => {
  const f=await setup(t);await oldCheckpoint(f);
  const saved=payload(f.sqlite);saved.checkpoint.promptVersion='workflow-narrative-prompt.v5';
  saved.checkpoint.inputHash=await digestValue({input:saved.checkpoint.input,config,schemaVersion:SCHEMA,promptVersion:saved.checkpoint.promptVersion});
  f.sqlite.prepare('UPDATE workflow_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(saved),'legacy');
  let calls=0;
  const result=await run(f.db,{async summarizeWorkflow(input,options){
    calls++;assert.equal(options.workflowNarrativePromptVersion,'workflow-narrative-prompt.v5');
    assert.equal(options.resumeProviderResponseId,'resp_legacy');
    assert.deepEqual(input,saved.checkpoint.input);
    assert.match(workflowNarrativePrompt(input,[],options.workflowNarrativePromptVersion),/smallest set of independent user outcomes/);
    return {output:{...output(input),sentences:input.bullets.map(b=>({text:b.text,claim_refs:b.claimRefs,topic:{key:'existing',title:'原有事项'}}))},usage};
  }});
  assert.equal(result.succeeded,1);assert.equal(calls,1);
  assert.equal(payload(f.sqlite).checkpoint.inputHash,saved.checkpoint.inputHash);
});
