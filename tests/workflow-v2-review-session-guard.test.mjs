import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { workflowDatabase, seed, insert, SCOPE, T } from './helpers/workflow-database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dbModule = 'data:text/javascript,' + encodeURIComponent(
  'export const getD1=()=>globalThis.reviewGuardDb; export const getBindings=()=>globalThis.reviewGuardBindings;',
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
const { startReviewSession, completeReviewSession } = await import('../lib/server/db/review-session-repository.ts');
const { findMutationReplay } = await import('../lib/server/db/mutation-replay.ts');

async function fixture(t) {
  const f = await workflowDatabase();
  t.after(() => {
    delete globalThis.reviewGuardDb;
    delete globalThis.reviewGuardBindings;
    f.close();
  });
  seed(f.sqlite);
  globalThis.reviewGuardDb = f.db;
  globalThis.reviewGuardBindings = { APP_ENV: 'local', AUTH_GATEWAY: 'chatgpt', INTERNAL_WORKSPACE_ID: 'ws' };
  return f;
}
const count = (sqlite, table) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const clearPending = sqlite => sqlite.prepare("UPDATE claims SET review_status='verified' WHERE project_id='p'").run();

test('start, attach, and complete receipts remain idempotent without changing business context', async t => {
  const { sqlite } = await fixture(t);
  const started = await startReviewSession(SCOPE, 'p', 'start-1');
  assert.equal(started.status, 'active');
  assert.equal((await startReviewSession(SCOPE, 'p', 'start-1')).id, started.id);
  assert.equal((await startReviewSession(SCOPE, 'p', 'start-2')).id, started.id);
  assert.equal(count(sqlite, 'review_sessions'), 1);
  assert.equal(count(sqlite, 'mutation_replays'), 2);
  clearPending(sqlite);
  const completed = await completeReviewSession(SCOPE, started.id, 'complete-1');
  assert.equal(completed.status, 'completed');
  assert.equal((await completeReviewSession(SCOPE, started.id, 'complete-1')).id, started.id);
  assert.equal((await completeReviewSession(SCOPE, started.id, 'complete-2')).id, started.id);
  assert.equal(count(sqlite, 'mutation_replays'), 4);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
  assert.equal(count(sqlite, 'workflow_outbox'), 0);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
});

test('revocation just before start rolls back the session and receipt', async t => {
  const { db, sqlite } = await fixture(t);
  const originalBatch = db.batch;
  db.batch = statements => {
    sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T, 'owner');
    return originalBatch(statements);
  };
  await assert.rejects(startReviewSession(SCOPE, 'p', 'start-revoked'), error => error.status === 403);
  assert.equal(count(sqlite, 'review_sessions'), 0);
  assert.equal(count(sqlite, 'mutation_replays'), 0);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('revocation blocks a receipt added to an already active session', async t => {
  const { db, sqlite } = await fixture(t);
  const started = await startReviewSession(SCOPE, 'p', 'start-1');
  const originalBatch = db.batch;
  db.batch = statements => {
    sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T, 'owner');
    return originalBatch(statements);
  };
  await assert.rejects(startReviewSession(SCOPE, 'p', 'start-new-key'), error => error.status === 403);
  assert.equal(sqlite.prepare('SELECT status FROM review_sessions WHERE id=?').get(started.id).status, 'active');
  assert.equal(count(sqlite, 'mutation_replays'), 1);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('revocation just before completion rolls back the status and receipt', async t => {
  const { db, sqlite } = await fixture(t);
  const started = await startReviewSession(SCOPE, 'p', 'start-1');
  clearPending(sqlite);
  const originalBatch = db.batch;
  db.batch = statements => {
    sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T, 'owner');
    return originalBatch(statements);
  };
  await assert.rejects(completeReviewSession(SCOPE, started.id, 'complete-revoked'), error => error.status === 403);
  assert.equal(sqlite.prepare('SELECT status FROM review_sessions WHERE id=?').get(started.id).status, 'active');
  assert.equal(count(sqlite, 'mutation_replays'), 1);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('revocation also blocks a new receipt on an already completed session', async t => {
  const { db, sqlite } = await fixture(t);
  const started = await startReviewSession(SCOPE, 'p', 'start-1');
  clearPending(sqlite);
  await completeReviewSession(SCOPE, started.id, 'complete-1');
  const originalBatch = db.batch;
  db.batch = statements => {
    sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T, 'owner');
    return originalBatch(statements);
  };
  await assert.rejects(completeReviewSession(SCOPE, started.id, 'complete-new-key'), error => error.status === 403);
  assert.equal(sqlite.prepare('SELECT status FROM review_sessions WHERE id=?').get(started.id).status, 'completed');
  assert.equal(count(sqlite, 'mutation_replays'), 2);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('a competing completion returns the completed session and saves one receipt', async t => {
  const { db, sqlite } = await fixture(t);
  const started = await startReviewSession(SCOPE, 'p', 'start-1');
  clearPending(sqlite);
  const originalBatch = db.batch;
  let once = true;
  db.batch = statements => {
    if (once) {
      once = false;
      sqlite.prepare("UPDATE review_sessions SET status='completed',completed_at=?,duration_ms=0 WHERE id=?").run(T, started.id);
    }
    return originalBatch(statements);
  };
  const completed = await completeReviewSession(SCOPE, started.id, 'complete-race');
  assert.equal(completed.status, 'completed');
  assert.equal(count(sqlite, 'review_sessions'), 1);
  assert.equal(count(sqlite, 'mutation_replays'), 2);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});

test('an existing-session receipt race returns the exact session recorded by the winning request', async t => {
  const { db, sqlite } = await fixture(t);
  const active = await startReviewSession(SCOPE, 'p', 'start-first');
  insert(sqlite, 'review_sessions', {
    id: 'earlier-completed', workspace_id: 'ws', project_id: 'p', actor_id: 'owner',
    status: 'completed', started_at: T, completed_at: T, duration_ms: 0,
    initial_pending_claim_count: 1, initial_pending_occurrence_count: 0,
    remaining_pending_claim_count: 0, remaining_pending_occurrence_count: 0,
    created_at: T, updated_at: T,
  });
  const endpoint = 'projects/p/review-sessions';
  const requestHash = (await findMutationReplay(SCOPE, endpoint, 'start-race', {})).requestHash;
  const originalBatch = db.batch;
  let injected = false;
  db.batch = statements => {
    if (!injected) {
      injected = true;
      insert(sqlite, 'mutation_replays', {
        id: 'winning-receipt', workspace_id: 'ws', actor_id: 'owner',
        endpoint_scope: endpoint, idempotency_key: 'start-race', request_hash: requestHash,
        response_json: JSON.stringify({ reviewSessionId: 'earlier-completed' }), created_at: T,
      });
    }
    return originalBatch(statements);
  };
  const replayed = await startReviewSession(SCOPE, 'p', 'start-race');
  assert.equal(replayed.id, 'earlier-completed');
  assert.equal(replayed.status, 'completed');
  assert.equal(sqlite.prepare('SELECT status FROM review_sessions WHERE id=?').get(active.id).status, 'active');
  assert.equal(count(sqlite, 'mutation_replays'), 2);
  assert.equal(count(sqlite, 'mutation_guards'), 0);
});
