import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stub = source => 'data:text/javascript,' + encodeURIComponent(source);
const stubs = new Map([
  ['@/db', stub('export const getBindings=()=>globalThis.maintenanceFixture.bindings;')],
  ['@/lib/server/jobs/outbox', stub('export const sweepAndDispatch=options=>globalThis.maintenanceFixture.dispatch.extraction(options);export const dispatchAllDueOutbox=()=>{globalThis.maintenanceFixture.nativeDispatches++;return {dispatched:true};};')],
  ['@/lib/server/jobs/event-ai-artifacts', stub('export const sweepAndDispatchEventAiArtifacts=()=>globalThis.maintenanceFixture.dispatch.event_ai_artifacts();')],
  ['@/lib/server/jobs/workflow-outbox', stub('export const dispatchWorkflowOutbox=()=>globalThis.maintenanceFixture.dispatch.workflow();')],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) target = fileURLToPath(new URL(specifier, context.parentURL));
    if (target?.startsWith(root) && !target.includes('/node_modules/')) {
      for (const path of [target, `${target}.ts`, `${target}/index.ts`]) {
        if (existsSync(path)) return next(pathToFileURL(path).href, context);
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
const { POST } = await import('../app/api/internal/jobs/sweep/route.ts');
const { POST: dispatchPost } = await import('../app/api/internal/jobs/dispatch/route.ts');
const names = ['extraction', 'event_ai_artifacts', 'workflow'];
const SECRET = 'synthetic-maintenance-token';
const RECOVERY_SECRET = 'synthetic-recovery-token';
function fixture(t) {
  const calls = Object.fromEntries(names.map(name => [name, 0]));
  const results = { extraction: { sweep: { recovered: 1 }, dispatch: { sent: 1 }, transcription_sweep: { recovered: 1 }, transcription_dispatch: { sent: 1 }, automatic_extraction: { created: 0 } }, event_ai_artifacts: { recovered: 1, dispatch: { sent: 1 } }, workflow: { claimed: 1, succeeded: 1, pending: 0, failed: 0, obsolete: 0, lostLease: 0 } };
  const dispatch = Object.fromEntries(names.map(name => [name, () => { calls[name]++; return results[name]; }]));
  globalThis.maintenanceFixture = { bindings: { APP_ENV: 'production', INTERNAL_JOB_TOKEN: SECRET }, dispatch, nativeDispatches: 0 };
  t.after(() => { delete globalThis.maintenanceFixture; });
  return { calls, results, dispatch, bindings: globalThis.maintenanceFixture.bindings, state: globalThis.maintenanceFixture };
}
function request(token = SECRET, extra = {}) {
  return new Request('https://synthetic.example/api/internal/jobs/sweep', { method: 'POST', headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'x-request-id': 'sweep-test', ...extra } });
}

test('maintenance sweep preserves native recovery fields and consumes all three queues', async t => {
  const f = fixture(t);
  const response = await POST(request());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-request-id'), 'sweep-test');
  assert.equal(body.request_id, 'sweep-test');
  for (const [key, value] of Object.entries(f.results.extraction)) assert.deepEqual(body.data[key], value);
  assert.deepEqual(body.data.event_ai_artifacts, f.results.event_ai_artifacts);
  assert.deepEqual(body.data.workflow, f.results.workflow);
  assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
  for (const name of names) assert.equal(body.data.queues[name].state, 'succeeded');
});

test('recovery token is scoped to sweep and suppresses commissioning across the workspace', async t => {
  const f = fixture(t);
  f.bindings.WORKFLOW_RECOVERY_TOKEN = RECOVERY_SECRET;
  let options;
  f.dispatch.extraction = input => { f.calls.extraction++; options = input; return f.results.extraction; };
  const response = await POST(request(RECOVERY_SECRET));
  assert.equal(response.status, 200);
  assert.equal(options.commission, false);
  assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
  assert.ok(!JSON.stringify(await response.json()).includes(RECOVERY_SECRET));
  const denied = await dispatchPost(request(RECOVERY_SECRET));
  assert.equal(denied.status, 401);
  assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
});

test('original internal token keeps its workspace maintenance authority', async t => {
  const f = fixture(t);
  f.bindings.WORKFLOW_RECOVERY_TOKEN = RECOVERY_SECRET;
  let options;
  f.dispatch.extraction = input => { f.calls.extraction++; options = input; return f.results.extraction; };
  assert.equal((await POST(request())).status, 200);
  assert.equal(options.commission, undefined);
  assert.equal((await dispatchPost(request())).status, 200);
  assert.equal(f.state.nativeDispatches, 1);
});

test('sweep recovery remains available with only its independent secret configured', async t => {
  const f = fixture(t);
  delete f.bindings.INTERNAL_JOB_TOKEN;
  f.bindings.WORKFLOW_RECOVERY_TOKEN = RECOVERY_SECRET;
  assert.equal((await POST(request(RECOVERY_SECRET))).status, 200);
  assert.equal((await dispatchPost(request(RECOVERY_SECRET))).status, 503);
});

for (const [label, token] of [['missing', null], ['invalid', 'wrong']]) {
  test(`${label} maintenance token rejects before any queue work`, async t => {
    const f = fixture(t);
    const response = await POST(request(token, { 'oai-authenticated-user-email': 'synthetic@example.com' }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
    assert.deepEqual(f.calls, { extraction: 0, event_ai_artifacts: 0, workflow: 0 });
  });
}

test('an unconfigured maintenance secret returns an actionable failure without dispatching', async t => {
  const f = fixture(t);
  delete f.bindings.INTERNAL_JOB_TOKEN;
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'QUEUE_NOT_CONFIGURED');
  assert.deepEqual(f.calls, { extraction: 0, event_ai_artifacts: 0, workflow: 0 });
});

for (const failing of names) {
  test(`${failing} queue failure reports 503 while the other queues finish`, async t => {
    const f = fixture(t);
    f.dispatch[failing] = async () => { f.calls[failing]++; throw new Error('synthetic-provider-private-detail'); };
    const response = await POST(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '30');
    const body = await response.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.details.queues[failing].state, 'failed');
    assert.equal(body.error.details.queues[failing].code, 'QUEUE_SWEEP_FAILED');
    assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
    for (const name of names.filter(name => name !== failing)) {
      assert.equal(body.error.details.queues[name].state, 'succeeded');
      assert.deepEqual(body.error.details.queues[name].result, f.results[name]);
    }
    assert.ok(!JSON.stringify(body).includes('synthetic-provider-private-detail'));
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });
}

test('a synchronous queue failure cannot prevent the other two queue invocations', async t => {
  const f = fixture(t);
  f.dispatch.extraction = () => { f.calls.extraction++; throw new Error('synchronous synthetic failure'); };
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
  assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
});

test('native stage fallback is reported as failed even when recovery returns its remaining statistics', async t => {
  const f = fixture(t);
  f.dispatch.extraction = options => {
    f.calls.extraction++;
    options.onStageFailure({ stage: 'transcription_sweep', code: 'RECOVERY_STAGE_FAILED' });
    return f.results.extraction;
  };
  const response = await POST(request());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body.error.details.queues.extraction.stages, [{ stage: 'transcription_sweep', code: 'RECOVERY_STAGE_FAILED' }]);
  assert.deepEqual(body.error.details.queues.extraction.result, f.results.extraction);
  assert.equal(body.error.details.queues.event_ai_artifacts.state, 'succeeded');
  assert.equal(body.error.details.queues.workflow.state, 'succeeded');
  assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
});

test('maintenance response waits for all queue results after a failure', async t => {
  const f = fixture(t);
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  f.dispatch.workflow = async () => { f.calls.workflow++; started(); await pending; return f.results.workflow; };
  f.dispatch.event_ai_artifacts = async () => { f.calls.event_ai_artifacts++; throw new Error('synthetic failure'); };
  let finished = false;
  const processing = POST(request()).then(response => { finished = true; return response; });
  await startedPromise;
  assert.equal(finished, false);
  assert.deepEqual(f.calls, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
  release();
  const response = await processing;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.details.queues.workflow.state, 'succeeded');
});

test('a scheduler retry can recover a failed queue while completed queues remain idempotent', async t => {
  const f = fixture(t);
  const pending = new Set(names);
  let first = true;
  const commits = Object.fromEntries(names.map(name => [name, 0]));
  for (const name of names) f.dispatch[name] = async () => {
    f.calls[name]++;
    if (name === 'workflow' && first) throw new Error('synthetic interruption');
    if (pending.delete(name)) commits[name]++;
    return { processed: commits[name], remaining: pending.has(name) ? 1 : 0 };
  };
  assert.equal((await POST(request())).status, 503);
  assert.deepEqual(commits, { extraction: 1, event_ai_artifacts: 1, workflow: 0 });
  first = false;
  assert.equal((await POST(request())).status, 200);
  assert.deepEqual(commits, { extraction: 1, event_ai_artifacts: 1, workflow: 1 });
  assert.equal(pending.size, 0);
  assert.deepEqual(f.calls, { extraction: 2, event_ai_artifacts: 2, workflow: 2 });
});
