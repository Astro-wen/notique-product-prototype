import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase, seed, insert, relation, SCOPE, T } from './helpers/workflow-database.mjs';
import { dispatchWorkflowCommand } from '../lib/server/workflow/commands.ts';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { normalizedActionAttributes } from '../lib/domain/action-attributes.ts';

const attributes = { owner: 'Eric', due_at: '2026-10-12' };
const read = db => readWorkspace(db, SCOPE, 'e', {}, T);
const send = (db, path, body, key = crypto.randomUUID()) => dispatchWorkflowCommand(db, SCOPE, path.split('/'), body, key);
const metadata = sqlite => sqlite.prepare("SELECT claim_id,basis_version_refs_json,basis_state,cancelled_at,owner_hint,due_at FROM action_metadata WHERE claim_id='action'").get() ?? null;
async function setup(t, normalized = attributes) {
  const f = await workflowDatabase(); t.after(f.close); seed(f.sqlite);
  relation(f.sqlite, 'budget-basis', 'action', 'budget', 'informed_by', 'proposed');
  f.sqlite.prepare("UPDATE claim_versions SET normalized_value_json=? WHERE id='action_v1'").run(normalized === null ? null : JSON.stringify(normalized));
  return f;
}
async function decide(db, id, operation, extra = {}, key = crypto.randomUUID()) {
  const s = await read(db), card = s.reviewCards.find(c => c.memberRefs.some(r => r.claimId === id));
  const request = { expectedContextVersion: s.contextVersion, expectedCardRevision: card.revision, operation,
    members: [{ ...card.memberRefs.find(r => r.claimId === id), operation, ...extra }] };
  const path = `review-cards/${card.id}/decisions`;
  return { receipt: await send(db, path, request, key), path, request };
}
async function transition(db, operation) {
  const s = await read(db), action = s.actions.find(a => a.id === 'action');
  return send(db, 'actions/action/transitions', { expectedContextVersion: s.contextVersion, expectedActionRevision: action.revision, operation });
}
async function undo(db, saved) {
  const s = await read(db), decision = s.recentDecisions.find(d => d.id === saved.receipt.mutationId);
  return send(db, `decisions/${decision.id}/revert`, { expectedContextVersion: s.contextVersion, expectedDecisionRevision: decision.revision });
}
const edit = { newText: '让李华确认供应商的安装排期', origin: 'user_input', evidenceRefIds: [] };
const changeBasis = db => decide(db, 'budget', 'edit', { ...edit, newText: '预算三十五万元' });
function states(sqlite, saved) {
  const row = sqlite.prepare('SELECT before_state_json,after_state_json FROM decision_members WHERE decision_id=? AND claim_id=?').get(saved.receipt.mutationId, 'action');
  return { before: JSON.parse(row.before_state_json), after: JSON.parse(row.after_state_json) };
}

test('normalized action attributes accept exact full calendar dates and never infer fields from text', () => {
  assert.deepEqual(normalizedActionAttributes(JSON.stringify(attributes)), { ownerHint: 'Eric', dueAt: '2026-10-12' });
  assert.deepEqual(normalizedActionAttributes('{"owner":"  李华  ","due_at":"2028-02-29"}'), { ownerHint: '李华', dueAt: '2028-02-29' });
  for (const date of ['2026-02-29', '2026-04-31', '09-30', '9月30日', '明天', '2026-10-12T00:00:00Z', '2026-1-12', ' 2026-10-12']) {
    assert.deepEqual(normalizedActionAttributes(JSON.stringify({ owner: 'Eric', due_at: date })), { ownerHint: 'Eric', dueAt: null });
  }
  for (const value of [null, 'not json', 'null', '[]', '42', '{"owner":42,"due_at":42}', '{"owner":" ","due_at":null}']) {
    assert.deepEqual(normalizedActionAttributes(value), { ownerHint: null, dueAt: null });
  }
  assert.deepEqual(normalizedActionAttributes('{"statement":"Eric在9月30日前完成"}'), { ownerHint: null, dueAt: null });
});

for (const origin of ['ai', 'manual']) test(`first ${origin} action acceptance persists exact-version fields and complete undo receipts`, async t => {
  const { db, sqlite } = await setup(t);
  if (origin === 'manual') sqlite.prepare("UPDATE claim_versions SET source='human',workflow_origin='user_input' WHERE id='action_v1'").run();
  const saved = await decide(db, 'action', 'accept_action', {}, `accept-${origin}`);
  let s = await read(db), a = s.actions.find(a => a.id === 'action');
  assert.equal(a.ownerHint, 'Eric'); assert.equal(a.dueAt, '2026-10-12'); assert.equal(a.executionState, 'open');
  const receipt = states(sqlite, saved);
  assert.equal(receipt.before.actionMetadata, null);
  assert.deepEqual(receipt.after.actionMetadata, { claim_id: 'action', basis_version_refs_json: metadata(sqlite).basis_version_refs_json,
    basis_state: 'current', cancelled_at: null, owner_hint: 'Eric', due_at: '2026-10-12' });
  assert.deepEqual(await send(db, saved.path, saved.request, `accept-${origin}`), saved.receipt);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM action_metadata').get().n, 1);
  await undo(db, saved); assert.equal(metadata(sqlite), null); assert.equal((await read(db)).actions.length, 0);
  await decide(db, 'action', 'accept_action'); s = await read(db);
  assert.equal(s.actions[0].ownerHint, 'Eric'); assert.equal(s.actions[0].dueAt, '2026-10-12');
});

test('first acceptance takes the current exact version rather than historical normalized action fields', async t => {
  const { db, sqlite } = await setup(t);
  insert(sqlite, 'claim_versions', { id: 'action_v2', claim_id: 'action', version_no: 2, statement: '王华确认价格',
    normalized_value_json: JSON.stringify({ owner: '王华', due_at: '2026-11-02' }), source: 'ai' });
  sqlite.prepare("UPDATE claims SET current_version_id='action_v2' WHERE id='action'").run();
  sqlite.prepare("UPDATE evidence_refs SET claim_version_id='action_v2' WHERE id='action_ev'").run();
  await decide(db, 'action', 'accept_action');
  assert.equal(metadata(sqlite).owner_hint, '王华'); assert.equal(metadata(sqlite).due_at, '2026-11-02');
});

test('yearless date stays in the statement and produces no invented calendar date', async t => {
  const { db, sqlite } = await setup(t, { owner: 'Eric', due_at: '10月12日' });
  sqlite.prepare("UPDATE claim_versions SET statement='Eric在10月12日前确认价格' WHERE id='action_v1'").run();
  await decide(db, 'action', 'accept_action');
  const s = await read(db); assert.equal(s.actions[0].ownerHint, 'Eric'); assert.equal(s.actions[0].dueAt, undefined);
  assert.match(s.bullets.find(b => b.id === 'action').text, /10月12日/); assert.equal(metadata(sqlite).due_at, null);
});

for (const values of [{ owner: '李华', date: '2027-01-03' }, { owner: null, date: null }]) test(`basis reacceptance preserves authoritative metadata including ${values.owner === null ? 'explicit unknowns' : 'explicit corrections'}`, async t => {
  const { db, sqlite } = await setup(t); await decide(db, 'action', 'accept_action');
  sqlite.prepare("UPDATE action_metadata SET owner_hint=?,due_at=? WHERE claim_id='action'").run(values.owner, values.date);
  await changeBasis(db); const before = metadata(sqlite);
  const saved = await decide(db, 'action', 'accept_action');
  const after = metadata(sqlite), receipt = states(sqlite, saved);
  assert.equal(after.owner_hint, values.owner); assert.equal(after.due_at, values.date);
  assert.deepEqual(receipt.before.actionMetadata, { ...before }); assert.deepEqual(receipt.after.actionMetadata, { ...after });
  await undo(db, saved); assert.deepEqual({ ...metadata(sqlite) }, { ...before });
});

for (const execution of ['completed', 'cancelled']) test(`basis refresh keeps ${execution} execution and owner/date unchanged`, async t => {
  const { db, sqlite } = await setup(t); await decide(db, 'action', 'accept_action');
  await transition(db, execution === 'completed' ? 'complete' : 'cancel');
  await changeBasis(db); await decide(db, 'action', 'accept_action');
  const a = (await read(db)).actions[0]; assert.equal(a.executionState, execution);
  assert.equal(a.ownerHint, 'Eric'); assert.equal(a.dueAt, '2026-10-12'); assert.equal(metadata(sqlite).basis_state, 'current');
});

test('deferring and restoring a suggestion does not create an action or alter its normalized fields', async t => {
  const { db, sqlite } = await setup(t); await decide(db, 'action', 'defer', {}, 'defer-action');
  assert.equal(metadata(sqlite), null); assert.equal((await read(db)).actions.length, 0);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT normalized_value_json FROM claim_versions WHERE id='action_v1'").get().normalized_value_json), attributes);
  await decide(db, 'action', 'restore'); await decide(db, 'action', 'accept_action');
  assert.equal(metadata(sqlite).owner_hint, 'Eric'); assert.equal(metadata(sqlite).due_at, '2026-10-12');
});

for (const execution of ['open', 'completed', 'cancelled']) test(`editing an ${execution} action clears prior owner/date and undo restores both exact metadata and execution`, async t => {
  const { db, sqlite } = await setup(t); await decide(db, 'action', 'accept_action');
  if (execution !== 'open') await transition(db, execution === 'completed' ? 'complete' : 'cancel');
  const previous = metadata(sqlite), saved = await decide(db, 'action', 'edit', edit);
  let a = (await read(db)).actions[0]; assert.equal(a.executionState, execution);
  assert.equal(a.ownerHint, undefined); assert.equal(a.dueAt, undefined);
  const receipt = states(sqlite, saved);
  assert.deepEqual(receipt.before.actionMetadata, { ...previous });
  assert.deepEqual(receipt.after.actionMetadata, { ...previous, owner_hint: null, due_at: null });
  const normalized = sqlite.prepare('SELECT normalized_value_json FROM claim_versions WHERE id=?').get(receipt.after.versionId);
  assert.equal(normalized.normalized_value_json, null); assert.equal(metadata(sqlite).owner_hint, null); assert.equal(metadata(sqlite).due_at, null);
  const reversed = await undo(db, saved); a = (await read(db)).actions[0];
  assert.equal(a.executionState, execution); assert.equal(a.ownerHint, 'Eric'); assert.equal(a.dueAt, '2026-10-12');
  assert.deepEqual({ ...metadata(sqlite) }, { ...previous });
  const reverseReceipt = states(sqlite, { receipt: reversed });
  assert.deepEqual(reverseReceipt.before.actionMetadata, { ...previous, owner_hint: null, due_at: null });
  assert.deepEqual(reverseReceipt.after.actionMetadata, { ...previous });
});

test('a corrected action can refresh its basis without bringing back its old owner/date', async t => {
  const { db, sqlite } = await setup(t); await decide(db, 'action', 'accept_action'); await decide(db, 'action', 'edit', edit);
  await changeBasis(db); await decide(db, 'action', 'accept_action');
  assert.equal(metadata(sqlite).owner_hint, null); assert.equal(metadata(sqlite).due_at, null);
  assert.equal((await read(db)).actions[0].ownerHint, undefined); assert.equal((await read(db)).actions[0].dueAt, undefined);
});

test('legacy completion materializes normalized owner/date once and subsequent cancel/reopen preserves them', async t => {
  const { db, sqlite } = await setup(t); sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  await transition(db, 'complete'); assert.equal(metadata(sqlite).owner_hint, 'Eric'); assert.equal(metadata(sqlite).due_at, '2026-10-12');
  await transition(db, 'cancel'); await transition(db, 'reopen');
  assert.equal((await read(db)).actions[0].executionState, 'open'); assert.equal(metadata(sqlite).owner_hint, 'Eric'); assert.equal(metadata(sqlite).due_at, '2026-10-12');
});

test('editing a legacy action before any metadata exists leaves unknown owner/date when execution later materializes metadata', async t => {
  const { db, sqlite } = await setup(t); sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  await decide(db, 'action', 'edit', edit); assert.equal(metadata(sqlite), null);
  await transition(db, 'complete'); assert.equal(metadata(sqlite).owner_hint, null); assert.equal(metadata(sqlite).due_at, null);
});

test('concurrent metadata creation during first acceptance cannot erase another writer fields', async t => {
  const { db, sqlite } = await setup(t), batch = db.batch;
  db.batch = async statements => { insert(sqlite, 'action_metadata', { claim_id: 'action', workspace_id: 'ws', project_id: 'p', event_id: 'e',
    basis_version_refs_json: '[]', basis_state: 'current', owner_hint: '其他用户', due_at: '2027-01-01' }); return batch(statements); };
  await assert.rejects(decide(db, 'action', 'accept_action'), e => e.code === 'version_conflict');
  assert.equal(metadata(sqlite).owner_hint, '其他用户'); assert.equal(metadata(sqlite).due_at, '2027-01-01');
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='action'").get().review_status, 'pending');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n, 0);
});

test('changing normalized fields on the exact version during initial acceptance cannot publish a stale receipt', async t => {
  const { db, sqlite } = await setup(t), batch = db.batch;
  db.batch = async statements => { sqlite.prepare("UPDATE claim_versions SET normalized_value_json=? WHERE id='action_v1'").run('{"owner":"后来修改"}'); return batch(statements); };
  await assert.rejects(decide(db, 'action', 'accept_action'), e => e.code === 'version_conflict');
  assert.equal(metadata(sqlite), null); assert.equal(sqlite.prepare('SELECT count(*) n FROM decision_members').get().n, 0);
});

for (const operation of ['reaccept', 'edit', 'transition', 'undo']) for (const field of ['owner_hint', 'due_at']) test(`a concurrent ${field} change during ${operation} rolls back its whole mutation`, async t => {
  const { db, sqlite } = await setup(t); await decide(db, 'action', 'accept_action');
  if (operation === 'reaccept') await changeBasis(db);
  const saved = operation === 'undo' ? await decide(db, 'action', 'edit', edit) : null;
  const currentVersion = sqlite.prepare("SELECT current_version_id FROM claims WHERE id='action'").get().current_version_id;
  const count = sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n;
  const batch = db.batch, concurrentValue = field === 'owner_hint' ? '并发负责人' : '2027-03-04';
  db.batch = async statements => { sqlite.prepare(`UPDATE action_metadata SET ${field}=? WHERE claim_id='action'`).run(concurrentValue); return batch(statements); };
  const run = operation === 'reaccept' ? () => decide(db, 'action', 'accept_action') : operation === 'edit' ? () => decide(db, 'action', 'edit', edit)
    : operation === 'transition' ? () => transition(db, 'complete') : () => undo(db, saved);
  await assert.rejects(run(), e => e.code === 'version_conflict');
  assert.equal(metadata(sqlite)[field], concurrentValue);
  assert.equal(sqlite.prepare("SELECT current_version_id FROM claims WHERE id='action'").get().current_version_id, currentVersion);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n, count);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n, 0);
});
