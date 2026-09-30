import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { workflowDatabase, seed, insert, SCOPE, T } from './helpers/workflow-database.mjs';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { consumeNarrativeJobs } from '../lib/server/workflow/narrative-jobs.ts';
import { WORKFLOW_NARRATIVE_SCHEMA_VERSION } from '../lib/domain/workflow-narrative.ts';
import { CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_SCHEMA_VERSION } from '../lib/domain/model-contract.ts';
import { INVENTORY_SCHEMA_VERSION, VERIFICATION_SCHEMA_VERSION, TWO_STAGE_EXTRACTION_LIMITS, EXTRACTION_RETENTION_POLICY } from '../lib/domain/two-stage-extraction.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dbModule = 'data:text/javascript,' + encodeURIComponent(
  'export const getD1=()=>globalThis.manualBridgeDb; export const getBindings=()=>globalThis.manualBridgeBindings; export const getEvidenceBucket=()=>({get:async()=>null});',
);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/db') return { url: dbModule, shortCircuit: true };
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      target = fileURLToPath(new URL(specifier, context.parentURL));
    }
    if (target?.startsWith(root) && !target.includes('/node_modules/')) {
      for (const path of [target, `${target}.ts`, `${target}/index.ts`]) {
        if (existsSync(path) && !path.endsWith('/db')) return next(pathToFileURL(path).href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/')) {
      return {
        format: 'module',
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform' }),
        shortCircuit: true,
      };
    }
    return next(url, context);
  },
});
const { createManualClaim } = await import('../lib/server/db/ai-draft-repository.ts');
const { processExtractionRun } = await import('../lib/server/jobs/extraction-processor.ts');

const input = { statement: '预算还包括安装费用。', type: 'budget', segment_ids: ['seg'] };
async function fixture(t) {
  const f = await workflowDatabase();
  t.after(() => {
    delete globalThis.manualBridgeDb;
    delete globalThis.manualBridgeBindings;
    f.close();
  });
  seed(f.sqlite);
  globalThis.manualBridgeDb = f.db;
  globalThis.manualBridgeBindings = { APP_ENV: 'local', AUTH_GATEWAY: 'chatgpt', INTERNAL_WORKSPACE_ID: 'ws' };
  return f;
}
function count(sqlite, table) {
  return sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n;
}

test('a native manual claim advances context and invalidates derived V2 state once with an idempotent receipt', async t => {
  const { db, sqlite } = await fixture(t);
  insert(sqlite, 'workflow_narratives', {
    id: 'old-narrative', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    scope_key: 'e', scope_kind: 'mixed', based_on_context_version: 0,
    text: '旧的项目概要', freshness: 'current', input_hash: 'old',
  });
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  insert(sqlite, 'action_metadata', {
    claim_id: 'action', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    basis_version_refs_json: JSON.stringify([{ claimId: 'budget', claimVersionId: 'budget_v1' }]),
    basis_state: 'current',
  });
  const old = await readWorkspace(db, SCOPE, 'e', {}, T);
  const created = await createManualClaim(SCOPE, 'e', input, 'manual-create-once');
  assert.equal(created.type, 'budget');
  assert.equal(created.review_status, 'pending');
  assert.equal(sqlite.prepare('SELECT source,workflow_revision FROM claims WHERE id=?').get(created.id).source, 'human');
  assert.equal(sqlite.prepare('SELECT workflow_revision FROM claims WHERE id=?').get(created.id).workflow_revision, 1);
  assert.deepEqual({ ...sqlite.prepare("SELECT context_version,ledger_version FROM projects WHERE id='p'").get() }, {
    context_version: 1, ledger_version: 1,
  });
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='old-narrative'").get().freshness, 'stale');
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state, 'current');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_outbox WHERE project_id=? AND event_id=? AND input_revision=1').get('p', 'e').n, 1);
  assert.equal(count(sqlite, 'workflow_snapshots'), 0);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
  assert.equal(count(sqlite, 'mutation_replays'), 1);
  assert.equal(count(sqlite, 'claims'), 4);
  assert.equal(count(sqlite, 'evidence_refs'), 4);
  await assert.rejects(readWorkspace(db, SCOPE, 'e', { snapshotId: old.snapshotId }, T), error => error.code === 'cursor_expired');

  const replayed = await createManualClaim(SCOPE, 'e', input, 'manual-create-once');
  assert.equal(replayed.id, created.id);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 1);
  assert.equal(count(sqlite, 'mutation_replays'), 1);
  await assert.rejects(createManualClaim(SCOPE, 'e', { ...input, statement: '另一个事实' }, 'manual-create-once'),
    error => error.status === 409 && error.code === 'IDEMPOTENCY_CONFLICT');
});

test('a late SQL failure rolls back the native ledger, context, snapshot invalidation, and receipt together', async t => {
  const { db, sqlite } = await fixture(t);
  insert(sqlite, 'workflow_narratives', {
    id: 'old-narrative', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    scope_key: 'e', scope_kind: 'mixed', based_on_context_version: 0,
    text: '旧的项目概要', freshness: 'current', input_hash: 'old',
  });
  await readWorkspace(db, SCOPE, 'e', {}, T);
  const before = Object.fromEntries(['claims', 'claim_versions', 'evidence_refs', 'workflow_snapshots'].map(table => [table, count(sqlite, table)]));
  const originalBatch = db.batch;
  db.batch = statements => originalBatch([
    ...statements,
    db.prepare("INSERT INTO mutation_guards (id,guard_value,created_at) VALUES ('forced-failure',0,?)").bind(T),
  ]);
  await assert.rejects(createManualClaim(SCOPE, 'e', input, 'manual-failure'));
  for (const [table, expected] of Object.entries(before)) assert.equal(count(sqlite, table), expected, table);
  assert.deepEqual({ ...sqlite.prepare("SELECT context_version,ledger_version FROM projects WHERE id='p'").get() }, {
    context_version: 0, ledger_version: 0,
  });
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='old-narrative'").get().freshness, 'current');
  assert.equal(count(sqlite, 'workflow_outbox'), 0);
  assert.equal(count(sqlite, 'mutation_replays'), 0);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('a manual claim also flags an accepted action whose frozen basis is no longer current', async t => {
  const { sqlite } = await fixture(t);
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  insert(sqlite, 'action_metadata', {
    claim_id: 'action', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    basis_version_refs_json: JSON.stringify([{ claimId: 'budget', claimVersionId: 'older-budget-version' }]),
    basis_state: 'current',
  });
  await createManualClaim(SCOPE, 'e', input, 'manual-basis-review');
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state, 'needs_review');
});

test('a Summary-backed action is readable immediately without invalidating the running fact extraction', async t => {
  const { db, sqlite } = await fixture(t);
  sqlite.prepare("UPDATE extraction_runs SET status='processing' WHERE id='run'").run();
  insert(sqlite, 'event_ai_artifact_runs', {
    id: 'summary-run', workspace_id: 'ws', project_id: 'p', event_id: 'e', extraction_run_id: 'run',
    kind: 'summary', status: 'succeeded', idempotency_key: 'summary-run', input_hash: 'summary',
    input_manifest_json: '[{"asset_version_id":"av"}]', provider: 'test', model: 'test',
    reasoning_effort: 'low', prompt_version: 'test', schema_version: 'test', next_attempt_at: T, queued_at: T,
  });
  insert(sqlite, 'event_ai_artifacts', {
    id: 'summary-artifact', workspace_id: 'ws', project_id: 'p', event_id: 'e', run_id: 'summary-run',
    kind: 'summary', artifact_version: 1, input_hash: 'summary',
    content_json: JSON.stringify({ sections: [{ items: [{ source_segment_ids: ['seg'] }] }] }),
  });
  insert(sqlite, 'workflow_narratives', {
    id: 'early-narrative', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    scope_key: 'e', scope_kind: 'mixed', based_on_context_version: 0,
    text: '旧的项目概要', freshness: 'current', input_hash: 'old',
  });
  const old = await readWorkspace(db, SCOPE, 'e', {}, T);
  const created = await createManualClaim(SCOPE, 'e', {
    statement: '向供应商确认安装价格', type: 'next_action', segment_ids: ['seg'],
  }, 'manual-early-action');
  assert.equal(created.type, 'next_action');
  assert.deepEqual({ ...sqlite.prepare("SELECT context_version,ledger_version FROM projects WHERE id='p'").get() }, {
    context_version: 0, ledger_version: 1,
  });
  assert.equal(sqlite.prepare("SELECT status,context_version FROM extraction_runs WHERE id='run'").get().context_version, 0);
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='early-narrative'").get().freshness, 'stale');
  await assert.rejects(readWorkspace(db, SCOPE, 'e', { snapshotId: old.snapshotId }, T), error => error.code === 'cursor_expired');
  const current = await readWorkspace(db, SCOPE, 'e', {}, T);
  assert.equal(current.contextVersion, 0);
  assert.equal(current.bullets.find(b => b.id === created.id)?.text, '向供应商确认安装价格');
  assert.equal(current.reviewCards.find(c => c.memberRefs.some(ref => ref.claimId === created.id))?.kind, 'action');
  assert.equal(current.narrative?.freshness, 'updating');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE task_key LIKE 'narrative:manual:%' AND input_revision=0").get().n, 1);
});

test('same-context early actions refresh a previously completed overview with one coalesced model call', async t => {
  const { db, sqlite } = await fixture(t);
  sqlite.prepare("UPDATE extraction_runs SET status='processing' WHERE id='run'").run();
  insert(sqlite, 'event_ai_artifact_runs', {
    id: 'summary-run', workspace_id: 'ws', project_id: 'p', event_id: 'e', extraction_run_id: 'run',
    kind: 'summary', status: 'succeeded', idempotency_key: 'summary-run', input_hash: 'summary',
    input_manifest_json: '[{"asset_version_id":"av"}]', provider: 'test', model: 'test',
    reasoning_effort: 'low', prompt_version: 'test', schema_version: 'test', next_attempt_at: T, queued_at: T,
  });
  insert(sqlite, 'event_ai_artifacts', {
    id: 'summary-artifact', workspace_id: 'ws', project_id: 'p', event_id: 'e', run_id: 'summary-run',
    kind: 'summary', artifact_version: 1, input_hash: 'summary',
    content_json: JSON.stringify({ sections: [{ items: [{ source_segment_ids: ['seg'] }] }] }),
  });
  insert(sqlite, 'workflow_outbox', {
    id: 'already-published', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    kind: 'narrative', task_key: 'narrative:p:e:0', input_revision: 0,
    payload_json: '{"eventId":"e","contextVersion":0}', state: 'succeeded',
    available_at: T, created_at: T, updated_at: T,
  });
  const first = await createManualClaim(SCOPE, 'e', {
    statement: '向供应商确认安装价格', type: 'next_action', segment_ids: ['seg'],
  }, 'manual-early-one');
  const second = await createManualClaim(SCOPE, 'e', {
    statement: '向供应商确认安装周期', type: 'next_action', segment_ids: ['seg'],
  }, 'manual-early-two');
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
  assert.equal(sqlite.prepare("SELECT ledger_version FROM projects WHERE id='p'").get().ledger_version, 2);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE state='queued' AND task_key LIKE 'narrative:manual:%'").get().n, 2);
  let calls = 0;
  const config = { provider: 'test', model: 'test', reasoningEffort: 'low', baseUrl: 'https://model.invalid', maxOutputTokens: 6000 };
  const result = await consumeNarrativeJobs(db, {
    config,
    provider: () => ({ async summarizeWorkflow(source) {
      calls++;
      assert.ok(source.bullets.some(b => b.claimRefs.some(ref => ref.claimId === first.id)));
      assert.ok(source.bullets.some(b => b.claimRefs.some(ref => ref.claimId === second.id)));
      return {
        output: { schema_version: WORKFLOW_NARRATIVE_SCHEMA_VERSION, event_id: source.eventId,
          sentences: source.bullets.map(b => ({ text: b.text, claim_refs: b.claimRefs })) },
        usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0, providerRequestId: 'manual-bridge-test' },
      };
    } }),
    clock: () => new Date(Date.now() + 3_000).toISOString(),
    random: () => 0,
  });
  assert.equal(result.succeeded, 1);
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE error_code='COALESCED'").get().n, 1);
  const overview = await readWorkspace(db, SCOPE, 'e', {});
  assert.equal(overview.narrative?.freshness, 'current');
  assert.ok(overview.narrative.text.includes('向供应商确认安装价格'));
  assert.ok(overview.narrative.text.includes('向供应商确认安装周期'));
});

test('an action written during a paid extraction stage lets facts publish and then refreshes the V2 overview', async t => {
  const { db, sqlite } = await fixture(t);
  sqlite.exec('DELETE FROM claims');
  sqlite.prepare("UPDATE projects SET scenario='general',scenario_status='confirmed'").run();
  sqlite.prepare("UPDATE extraction_runs SET status='queued',prompt_version=?,schema_version=?,provider='openai',model='synthetic-model',input_manifest_json=?,model_params_json=? WHERE id='run'")
    .run(CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_SCHEMA_VERSION,
      JSON.stringify([{ asset_version_id: 'av', sha256: 'synthetic', parser_version: 'test', kind: 'text' }]),
      JSON.stringify({ two_pass_pipeline: true, verification_uses_readable: false,
        inventory_prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION, inventory_schema_version: INVENTORY_SCHEMA_VERSION,
        inventory_candidate_limit: TWO_STAGE_EXTRACTION_LIMITS.inventoryCandidates,
        verification_prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION, verification_schema_version: VERIFICATION_SCHEMA_VERSION,
        final_claim_limit: TWO_STAGE_EXTRACTION_LIMITS.finalClaims, retention_policy: EXTRACTION_RETENTION_POLICY }));
  insert(sqlite, 'event_ai_artifact_runs', {
    id: 'summary-run', workspace_id: 'ws', project_id: 'p', event_id: 'e', extraction_run_id: 'run',
    kind: 'summary', status: 'succeeded', idempotency_key: 'summary-run', input_hash: 'summary',
    input_manifest_json: '[{"asset_version_id":"av"}]', provider: 'test', model: 'test',
    reasoning_effort: 'low', prompt_version: 'test', schema_version: 'test', next_attempt_at: T, queued_at: T,
  });
  insert(sqlite, 'event_ai_artifacts', {
    id: 'summary-artifact', workspace_id: 'ws', project_id: 'p', event_id: 'e', run_id: 'summary-run',
    kind: 'summary', artifact_version: 1, input_hash: 'summary',
    content_json: JSON.stringify({ sections: [{ items: [{ source_segment_ids: ['seg'] }] }] }),
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.manualBridgeBindings = {
    AI_PROVIDER: 'openai', AI_MODEL: 'synthetic-model', AI_API_KEY: 'synthetic-test-key',
    AI_API_BASE_URL: 'https://model.invalid/v1', AI_VERIFICATION_USES_READABLE: '0',
  };
  const evidence = [{ kind: 'text', asset_version_id: 'av', segment_ids: ['seg'],
    quote_hint: '请询价。', evidence_role: 'direct' }];
  const fact = { client_claim_key: 'agreed-budget', disposition: 'new',
    reaffirmed_target_claim_id: null, reaffirmed_target_version_id: null,
    type: 'decision', statement: '预算方案已同意', normalized_value: null,
    materiality: 'high', confidence: 0.98, needs_additional_evidence: false,
    uncertainty: null, evidence, relations: [] };
  let created;
  let modelCalls = 0;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith('https://model.invalid/'));
    const version = JSON.parse(init.body).text.format.schema.properties.schema_version.enum[0];
    modelCalls++;
    if (version === INVENTORY_SCHEMA_VERSION) {
      assert.equal(sqlite.prepare("SELECT status FROM extraction_runs WHERE id='run'").get().status, 'processing');
      created = await createManualClaim(SCOPE, 'e', {
        statement: '向供应商确认安装价格', type: 'next_action', segment_ids: ['seg'],
      }, 'manual-during-paid-extraction');
      assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
    }
    const output = version === INVENTORY_SCHEMA_VERSION
      ? { schema_version: INVENTORY_SCHEMA_VERSION, event_id: 'e', candidates: [{
        inventory_key: 'agreed-budget', type: fact.type, statement: fact.statement,
        normalized_value: null, materiality: 'high', critical: false,
        critical_reason: null, confidence: 0.98, atomicity: 'atomic', evidence,
      }] }
      : { schema_version: version, event_id: 'e', scenario_assessment: null,
        claims: [fact], candidate_dispositions: [{ inventory_key: 'agreed-budget',
          outcome: 'included', final_claim_keys: ['agreed-budget'],
          reason: 'Retained supported atomic proposition.' }],
        draft_link_candidates: [], quality_review: { unresolved_conflict_keys: [],
          compound_claim_keys: [], reaffirmed_issue_claim_keys: [] },
        same_intent_groups: [] };
    return new Response(JSON.stringify({ id: `synthetic_${modelCalls}`, status: 'completed',
      output_text: JSON.stringify(output), usage: { input_tokens: 20, output_tokens: 10,
        input_tokens_details: { cached_tokens: 0 } } }),
    { headers: { 'content-type': 'application/json' } });
  };
  const finished = await processExtractionRun('run');
  assert.equal(finished.status, 'succeeded', JSON.stringify({ finished,
    error: sqlite.prepare("SELECT error_details_json FROM extraction_runs WHERE id='run'").get() }));
  assert.equal(modelCalls, 2);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
  assert.equal(sqlite.prepare("SELECT ledger_version FROM projects WHERE id='p'").get().ledger_version, 1);
  assert.equal(sqlite.prepare("SELECT state FROM workflow_outbox WHERE task_key='narrative-publish:run'").get().state, 'queued');
  const workspace = await readWorkspace(db, SCOPE, 'e', {});
  assert.ok(workspace.bullets.some(b => b.id === created.id && b.text === '向供应商确认安装价格'));
  assert.ok(workspace.bullets.some(b => b.text === '预算方案已同意'));
  let narrativeCalls = 0;
  const narrativeResult = await consumeNarrativeJobs(db, {
    config: { provider: 'test', model: 'test', reasoningEffort: 'low', baseUrl: 'https://model.invalid', maxOutputTokens: 6000 },
    provider: () => ({ async summarizeWorkflow(source) {
      narrativeCalls++;
      return { output: { schema_version: WORKFLOW_NARRATIVE_SCHEMA_VERSION,
        event_id: source.eventId,
        sentences: source.bullets.map(b => ({ text: b.text, claim_refs: b.claimRefs })) },
      usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0, providerRequestId: 'after-extraction' } };
    } }),
    clock: () => new Date(Date.now() + 3_000).toISOString(), random: () => 0,
  });
  assert.equal(narrativeResult.succeeded, 1);
  assert.equal(narrativeCalls, 1);
  const overview = await readWorkspace(db, SCOPE, 'e', {});
  assert.equal(overview.narrative?.freshness, 'current');
  assert.ok(overview.narrative.text.includes('向供应商确认安装价格'));
  assert.ok(overview.narrative.text.includes('预算方案已同意'));
});

test('an early action cannot commit against a Summary superseded after its source check', async t => {
  const { db, sqlite } = await fixture(t);
  sqlite.prepare("UPDATE extraction_runs SET status='processing' WHERE id='run'").run();
  insert(sqlite, 'event_ai_artifact_runs', {
    id: 'summary-run', workspace_id: 'ws', project_id: 'p', event_id: 'e', extraction_run_id: 'run',
    kind: 'summary', status: 'succeeded', idempotency_key: 'summary-run', input_hash: 'summary',
    input_manifest_json: '[{"asset_version_id":"av"}]', provider: 'test', model: 'test',
    reasoning_effort: 'low', prompt_version: 'test', schema_version: 'test', next_attempt_at: T, queued_at: T,
  });
  insert(sqlite, 'event_ai_artifacts', {
    id: 'summary-artifact', workspace_id: 'ws', project_id: 'p', event_id: 'e', run_id: 'summary-run',
    kind: 'summary', artifact_version: 1, input_hash: 'summary',
    content_json: JSON.stringify({ sections: [{ items: [{ source_segment_ids: ['seg'] }] }] }),
  });
  const originalBatch = db.batch;
  db.batch = statements => {
    insert(sqlite, 'event_ai_artifacts', {
      id: 'replacement-summary', workspace_id: 'ws', project_id: 'p', event_id: 'e', run_id: 'summary-run',
      kind: 'summary', artifact_version: 2, input_hash: 'summary-new',
      content_json: JSON.stringify({ sections: [{ items: [{ source_segment_ids: [] }] }] }),
    });
    return originalBatch(statements);
  };
  await assert.rejects(createManualClaim(SCOPE, 'e', {
    statement: '向供应商确认安装价格', type: 'next_action', segment_ids: ['seg'],
  }, 'manual-summary-race'));
  assert.equal(count(sqlite, 'claims'), 3);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
  assert.equal(count(sqlite, 'mutation_replays'), 0);
});

test('revoking edit permission just before the native batch leaves no manual claim or V2 side effect', async t => {
  const { db, sqlite } = await fixture(t);
  const originalBatch = db.batch;
  db.batch = statements => {
    sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T, 'owner');
    return originalBatch(statements);
  };
  await assert.rejects(createManualClaim(SCOPE, 'e', input, 'manual-revoked'),
    error => error.status === 403);
  assert.equal(count(sqlite, 'claims'), 3);
  assert.equal(count(sqlite, 'evidence_refs'), 3);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
  assert.equal(count(sqlite, 'workflow_outbox'), 0);
  assert.equal(count(sqlite, 'mutation_replays'), 0);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('an evidence source that becomes derived before commit cannot create a formal claim', async t => {
  const { db, sqlite } = await fixture(t);
  const originalBatch = db.batch;
  db.batch = statements => {
    sqlite.prepare("UPDATE assets SET metadata_json=? WHERE id='asset'").run('{"artifact_kind":"readable_transcript","analysis_source":false}');
    return originalBatch(statements);
  };
  await assert.rejects(createManualClaim(SCOPE, 'e', input, 'manual-source-race'));
  assert.equal(count(sqlite, 'claims'), 3);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
  assert.equal(count(sqlite, 'mutation_replays'), 0);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});
