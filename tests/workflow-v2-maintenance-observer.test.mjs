import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workflowDatabase, seed } from './helpers/workflow-database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataModule = source => 'data:text/javascript,' + encodeURIComponent(source);
const callSource = `const call=(name,result)=>{const f=globalThis.maintenanceObserverFixture;f.calls.push(name);if(f.failures.has(name))throw new Error('synthetic-private-error-body');return result;};`;
const stubs = new Map([
  ['@/db', dataModule('export const getD1=()=>globalThis.maintenanceObserverFixture.db; export const getBindings=()=>({APP_ENV:"local"});')],
  ['@/lib/server/db/core-repository', dataModule(callSource + 'export const sweepStaleAssetUploadsForWorkspaces=async()=>call("asset_upload_sweep",0);export const expireStaleAssetUploads=async()=>call("asset_upload_sweep",0);')],
  ['@/lib/server/jobs/extraction-processor', dataModule('export const failExpiredProcessingRuns=async()=>0;export const processExtractionRun=async()=>({});export const recoverExpiredTargetedExtractionRun=async()=>false;')],
  ['@/lib/server/jobs/transcription-outbox', dataModule(callSource + 'export const sweepTranscriptionJobs=async()=>call("transcription_sweep",{recoveredOutbox:0});export const dispatchDueTranscriptionOutbox=async()=>call("transcription_dispatch",{claimed:0,sent:0,deferred:0,items:[]});')],
  ['@/lib/server/jobs/automatic-extraction', dataModule(callSource + 'export const ensureAutomaticExtractionRuns=async()=>call("automatic_extraction",{scanned:0,created:0,reused:0,covered:0,deferred:0,items:[]});')],
]);
const material = dataModule(callSource + 'export const commissionMaterialAnalysis=async()=>call("material_analysis",{claimed:0,commissioned:0,reused:0,deferred:0,runIds:[]});');
registerHooks({
  resolve(specifier, context, next) {
    if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
    let target;
    if (specifier.startsWith('@/')) target = resolve(root, specifier.slice(2));
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) target = fileURLToPath(new URL(specifier, context.parentURL));
    if (target === resolve(root, 'lib/server/jobs/material-analysis') || target === resolve(root, 'lib/server/jobs/material-analysis.ts')) return { url: material, shortCircuit: true };
    if (target?.startsWith(root) && !target.includes('/node_modules/')) {
      for (const path of [target, `${target}.ts`, `${target}/index.ts`]) if (existsSync(path)) return next(pathToFileURL(path).href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/')) return { format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform'}),shortCircuit:true };
    return next(url, context);
  },
});
const { sweepAndDispatch, recoverAndDispatch } = await import('../lib/server/jobs/outbox.ts');

async function fixture(t, failures = []) {
  const f = await workflowDatabase();
  seed(f.sqlite);
  const state = { db: f.db, calls: [], failures: new Set(failures) };
  globalThis.maintenanceObserverFixture = state;
  t.after(() => { delete globalThis.maintenanceObserverFixture; f.close(); });
  return { ...f, state };
}

test('ordinary heartbeat still returns fallback statistics and runs later stages after a failure', async t => {
  const f = await fixture(t, ['transcription_sweep']);
  const result = await recoverAndDispatch();
  assert.equal(result.transcription_sweep.recoveredOutbox, 0);
  assert.deepEqual(result.dispatch, { claimed: 0, sent: 0, deferred: 0, items: [] });
  assert.ok(f.state.calls.includes('material_analysis'));
  assert.ok(!f.state.calls.includes('automatic_extraction'));
  assert.ok(!f.state.calls.includes('transcription_dispatch'));
});

test('recovery-only maintenance consumes saved material intents without scanning unrelated legacy sources', async t => {
  const f = await fixture(t);
  const result = await sweepAndDispatch({ commission: false });
  assert.ok(f.state.calls.includes('material_analysis'));
  assert.ok(f.state.calls.includes('transcription_dispatch'));
  assert.ok(!f.state.calls.includes('automatic_extraction'));
  assert.equal(result.automatic_extraction.created, 0);
  assert.equal(result.dispatch.claimed, 0);
});

for (const failing of ['asset_upload_sweep', 'transcription_sweep', 'material_analysis', 'automatic_extraction', 'transcription_dispatch']) {
  test(`maintenance observes ${failing} failure while preserving the other recovery stages`, async t => {
    const f = await fixture(t, [failing]);
    const failures = [];
    const result = await sweepAndDispatch({ onStageFailure: failure => failures.push(failure) });
    assert.deepEqual(failures, [{ stage: failing, code: 'RECOVERY_STAGE_FAILED' }]);
    assert.deepEqual(f.state.calls, ['asset_upload_sweep', 'transcription_sweep', 'material_analysis', 'automatic_extraction', 'transcription_dispatch']);
    assert.equal(result.dispatch.claimed, 0);
    assert.equal(result.transcription_dispatch.claimed, 0);
    assert.ok(!JSON.stringify(failures).includes('synthetic-private-error-body'));
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  });
}

test('actual SQLite extraction errors report both failed sub-stages without stopping the remaining queues', async t => {
  const f = await fixture(t);
  f.sqlite.exec('DROP TABLE queue_outbox');
  const failures = [];
  const result = await sweepAndDispatch({ onStageFailure: failure => failures.push(failure) });
  assert.deepEqual(failures.map(f => f.stage), ['extraction_sweep', 'extraction_dispatch']);
  assert.ok(failures.every(f => f.code === 'RECOVERY_STAGE_FAILED'));
  assert.equal(result.dispatch.claimed, 0);
  assert.ok(f.state.calls.includes('material_analysis'));
  assert.ok(f.state.calls.includes('automatic_extraction'));
  assert.ok(f.state.calls.includes('transcription_dispatch'));
  assert.ok(!JSON.stringify(failures).includes('no such table'));
});
