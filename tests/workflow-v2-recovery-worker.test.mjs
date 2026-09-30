import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {Miniflare, Log} from 'miniflare';
import worker, {recover} from '../infra/recovery/worker.mjs';
const privateText = 'SYNTHETIC_PRIVATE_RECOVERY_VALUE';
const env = {WORKFLOW_RECOVERY_TOKEN: privateText};
const payload = () => ({data: {queues: Object.fromEntries(['extraction', 'event_ai_artifacts', 'workflow'].map(name => [name, {state: 'succeeded', result: {text: privateText}}]))}});

test('one cron tick makes one fixed, bounded request and logs only queue counts', async () => {
  const calls = [], logs = [], deadlines = [];
  const body = payload();body.data.queues.extraction.result = {sent: 1, dispatch: {sent: 2}, sweep: {requeuedExpiredRuns: 1}, text: privateText};
  await recover(env, {send: async (...args) => {calls.push(args); return Response.json(body);}, log: (...args) => logs.push(args), timeout: ms => {deadlines.push(ms); return new AbortController().signal;}});
  assert.equal(calls.length, 1);assert.equal(calls[0][0], 'https://notique-evidence-workspace.uclae2e12.chatgpt.site/api/internal/jobs/sweep');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer ' + privateText);assert.equal(calls[0][1].redirect, 'manual');assert.equal(calls[0][1].method, 'POST');assert.equal(calls[0][1].body, '{}');assert.deepEqual(deadlines, [840000]);
  assert.equal(logs[0][1].queues.extraction.sent, 3);assert.equal(logs[0][1].queues.extraction.recovered, 1);assert.equal(logs[0][1].state, 'succeeded');assert.ok(!JSON.stringify(logs).includes(privateText));
});

test('missing credential skips the network and a timed-out request waits for a later tick', async () => {
  let calls = 0;const logs = [], controller = new AbortController();controller.abort();
  await recover({}, {send: async () => {calls++;}, log: (...args) => logs.push(args)});
  await recover(env, {send: async () => {calls++; throw new Error(privateText);}, timeout: () => controller.signal, log: (...args) => logs.push(args)});
  assert.equal(calls, 1);assert.deepEqual(logs.map(x => x[1].state), ['unconfigured', 'pending']);assert.ok(!JSON.stringify(logs).includes(privateText));
});

test('HTTP, invalid JSON, oversized streams and partial queue failures never report success', async () => {
  const broken = payload();broken.data.queues.workflow.state = 'failed';
  const responses = [new Response(privateText, {status: 403}), new Response(privateText), new Response('x'.repeat(262145)), Response.json({data: {}}), Response.json(broken)];
  const logs = [];let calls = 0;
  for (const response of responses) await recover(env, {send: async () => {calls++; return response;}, log: (...args) => logs.push(args), timeout: () => new AbortController().signal});
  assert.equal(calls, 5);assert.deepEqual(logs.map(x => x[1].state), ['http_failed', 'request_failed', 'request_failed', 'invalid_response', 'queue_failed']);assert.ok(!JSON.stringify(logs).includes(privateText));
});

test('the worker has no public maintenance endpoint and scheduled work is retained', async () => {
  assert.equal(worker.fetch().status, 404);
  let pending;worker.scheduled({}, {}, {waitUntil: promise => {pending = promise;}});assert.ok(pending instanceof Promise);await pending;
});

test('the default network call retains the Workers global receiver', async () => {
  const original = globalThis.fetch; const logs = [];
  try {
    globalThis.fetch = async function () {
      assert.equal(this, globalThis);
      return Response.json(payload());
    };
    await recover(env, {log: (...args) => logs.push(args)});
    assert.equal(logs[0][1].state, 'succeeded');
  } finally {globalThis.fetch = original;}
});

test('redirect responses stop after the fixed request without forwarding credentials', async () => {
  let calls = 0; const logs = [];
  await recover(env, {send: async (_url, init) => {
    calls++; assert.equal(init.redirect, 'manual');
    return new Response(null, {status: 307, headers: {Location: 'https://example.com/'}});
  }, log: (...args) => logs.push(args)});
  assert.equal(calls, 1);
  assert.deepEqual(logs, [['notique_recovery', {state: 'http_failed', status: 307}]]);
});

test('the actual Workers runtime accepts the scheduled request and rejects a redirect', async () => {
  const source = await readFile(new URL('../infra/recovery/worker.mjs', import.meta.url), 'utf8');
  const script = source.replace('export default {', 'const recoveryWorker = {') + `
export default {async fetch(_request, env) {
  const logs = [], original = console.log; let pending;
  console.log = (...args) => logs.push(args);
  try {recoveryWorker.scheduled({}, env, {waitUntil(promise) {pending = promise;}}); await pending;}
  finally {console.log = original;}
  return Response.json(logs);
}};`;
  const calls = []; let status = 200;
  const runtime = new Miniflare({modules: true, script,
    // The installed workerd binary supports this date. Production uses 2026-09-29.
    compatibilityDate: '2026-05-22', compatibilityFlags: ['global_fetch_strictly_public'],
    bindings: env, log: new Log(0), outboundService: request => {
      calls.push({url: request.url, method: request.method, redirect: request.redirect, authorization: request.headers.get('Authorization')});
      return status === 200 ? Response.json(payload()) : new Response(null, {status, headers: {Location: 'https://example.com/'}});
    }});
  try {
    const first = await runtime.dispatchFetch('http://localhost/runtime-test');
    assert.equal((await first.json())[0][1].state, 'succeeded');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].authorization, 'Bearer ' + privateText);
    assert.equal(calls[0].url, 'https://notique-evidence-workspace.uclae2e12.chatgpt.site/api/internal/jobs/sweep');
    status = 307;
    const second = await runtime.dispatchFetch('http://localhost/runtime-test');
    assert.deepEqual(await second.json(), [['notique_recovery', {state: 'http_failed', status: 307}]]);
    assert.equal(calls.length, 2);
  } finally {await runtime.dispose();}
});
