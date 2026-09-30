import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase, seed, claim, relation, insert, SCOPE, T } from './helpers/workflow-database.mjs';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { dispatchWorkflowCommand } from '../lib/server/workflow/commands.ts';
import { priorityCards } from '../lib/domain/workflow-v2.ts';

const read = (db, now = T) => readWorkspace(db, SCOPE, 'e', {}, now);
const cardOf = (snapshot, id = 'action') => snapshot.reviewCards.find(c => c.memberRefs.some(m => m.claimId === id));
function storedCard(sqlite, id, ids, { kind = 'action', groupKey = id, priority = false, disposition = 'active' } = {}) {
  // Use the real migration defaults for the newly published card's zero flag.
  insert(sqlite, 'workflow_cards', { id, workspace_id: 'ws', project_id: 'p', event_id: 'e', group_key: groupKey,
    kind, title: '本次行动', disposition, created_at: T, updated_at: T,
    ...(priority ? { needs_decision: 1, reason_code: 'action_choice', reason: '决定是否加入跟进' } : {}) });
  for (const memberId of ids) insert(sqlite, 'card_members', { id: `${id}_${memberId}`, workspace_id: 'ws', card_id: id,
    claim_id: memberId, claim_version_id: `${memberId}_v1`, role: 'primary', created_at: T });
}
async function setup(t, { persisted = true } = {}) {
  const f = await workflowDatabase(); t.after(f.close); seed(f.sqlite);
  f.sqlite.prepare("DELETE FROM claim_relations WHERE id='basis'").run();
  if (persisted) storedCard(f.sqlite, 'wfc_action', ['action']);
  return f;
}
async function decide(db, id, operation, extra = {}) {
  const snapshot = await read(db), card = cardOf(snapshot, id);
  const request = { expectedContextVersion: snapshot.contextVersion, expectedCardRevision: card.revision, operation,
    members: [{ ...card.memberRefs.find(m => m.claimId === id), operation, ...extra }] };
  return dispatchWorkflowCommand(db, SCOPE, ['review-cards', card.id, 'decisions'], request, crypto.randomUUID());
}
async function transition(db, operation) {
  const snapshot = await read(db), action = snapshot.actions.find(a => a.id === 'action');
  return dispatchWorkflowCommand(db, SCOPE, ['actions', 'action', 'transitions'],
    { expectedContextVersion: snapshot.contextVersion, expectedActionRevision: action.revision, operation }, crypto.randomUUID());
}

for (const persisted of [true, false]) test(`${persisted ? 'stored zero-default' : 'virtual'} published AI task appears once as an action choice without a question relation`, async t => {
  const { db, sqlite } = await setup(t, { persisted });
  const before = sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n;
  const snapshot = await read(db), card = cardOf(snapshot);
  assert.equal(card.sourceStatus, 'ready'); assert.equal(card.members[0].origin, 'ai_suggestion');
  assert.equal(card.needsDecision, true); assert.equal(card.reasonCode, 'action_choice'); assert.equal(card.reason, '决定是否加入跟进');
  assert.equal(snapshot.counts.needsDecisionCount, 1); assert.equal(snapshot.actions.length, 0);
  assert.deepEqual(priorityCards(snapshot.reviewCards).map(c => c.id), [card.id]);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n, before, 'reading commissions no work');
  if (persisted) assert.equal(sqlite.prepare("SELECT needs_decision FROM workflow_cards WHERE id='wfc_action'").get().needs_decision, 0, 'projection preserves historical flags');
});

test('first acceptance clears the choice while keeping one stable action and leaving ordinary drafts readable', async t => {
  const { db } = await setup(t); await decide(db, 'action', 'accept_action');
  const snapshot = await read(db), card = cardOf(snapshot);
  assert.equal(card.needsDecision, false); assert.equal(card.reasonCode, null); assert.equal(card.disposition, 'processed');
  assert.equal(snapshot.counts.needsDecisionCount, 0); assert.equal(snapshot.actions.length, 1);
  assert.equal(snapshot.actions[0].id, 'action'); assert.equal(snapshot.counts.draftCount, 2);
});

for (const state of ['complete', 'cancel', 'reopen']) test(`an accepted action after ${state} is not returned as an action choice`, async t => {
  const { db } = await setup(t); await decide(db, 'action', 'accept_action');
  if (state === 'reopen') await transition(db, 'complete');
  await transition(db, state);
  const snapshot = await read(db);
  assert.equal(snapshot.counts.needsDecisionCount, 0); assert.equal(cardOf(snapshot).reasonCode, null);
});

for (const origin of ['user_input', 'user_selection']) test(`an independent ${origin} action is not promoted to model action choice`, async t => {
  const { db, sqlite } = await setup(t);
  sqlite.prepare("UPDATE claim_versions SET workflow_origin=?,source='human' WHERE id='action_v1'").run(origin);
  sqlite.prepare("UPDATE claims SET source='human' WHERE id='action'").run();
  const snapshot = await read(db);
  assert.equal(snapshot.counts.needsDecisionCount, 0); assert.equal(cardOf(snapshot).needsDecision, false);
});

for (const processing of ['failed', 'uploading']) test(`a ${processing} task source removes a stale persisted action-choice flag`, async t => {
  const { db, sqlite } = await setup(t);
  sqlite.prepare("UPDATE workflow_cards SET needs_decision=1,reason_code='action_choice',reason='是否跟进' WHERE id='wfc_action'").run();
  sqlite.prepare("UPDATE assets SET processing_status=? WHERE id='asset'").run(processing);
  const snapshot = await read(db), card = cardOf(snapshot);
  assert.equal(card.sourceStatus, 'stale'); assert.equal(card.needsDecision, false); assert.equal(card.reasonCode, null);
  assert.equal(snapshot.counts.needsDecisionCount, 0);
});

test('missing evidence does not create a task choice', async t => {
  const { db, sqlite } = await setup(t); sqlite.prepare("DELETE FROM evidence_refs WHERE id='action_ev'").run();
  const snapshot = await read(db);
  assert.equal(cardOf(snapshot).sourceStatus, 'missing'); assert.equal(snapshot.counts.needsDecisionCount, 0);
});

test('a rejected task stays rejected and its remaining ordinary draft is not a task choice', async t => {
  const { db } = await setup(t); await decide(db, 'action', 'reject');
  const snapshot = await read(db);
  assert.equal(snapshot.counts.needsDecisionCount, 0); assert.equal(snapshot.actions.length, 0);
  assert.equal(cardOf(snapshot).members[0].reviewState, 'rejected');
});

test('personal deferral keeps the choice out of the active queue until its date expires or it is restored', async t => {
  const { db } = await setup(t);
  const until = '2026-09-28T11:00:00.000Z'; await decide(db, 'action', 'defer');
  let snapshot = await read(db); assert.equal(cardOf(snapshot).disposition, 'deferred'); assert.equal(snapshot.counts.needsDecisionCount, 0);
  await decide(db, 'action', 'restore'); snapshot = await read(db); assert.equal(snapshot.counts.needsDecisionCount, 1);
  const card = cardOf(snapshot);
  await dispatchWorkflowCommand(db, SCOPE, ['review-cards', card.id, 'decisions'], { expectedContextVersion: snapshot.contextVersion,
    expectedCardRevision: card.revision, operation: 'defer', deferUntil: until,
    members: card.memberRefs.map(m => ({ ...m, operation: 'defer' })) }, crypto.randomUUID());
  assert.equal((await read(db)).counts.needsDecisionCount, 0);
  assert.equal((await read(db, '2026-09-28T11:00:01.000Z')).counts.needsDecisionCount, 1);
});

test('a mixed group retains one pending task choice after one of two actions is accepted', async t => {
  const { db, sqlite } = await setup(t, { persisted: false });
  claim(sqlite, 'sketch', 'next_action', '小林在10月10日前提交草图');
  storedCard(sqlite, 'group', ['budget', 'action', 'sketch'], { kind: 'record' });
  let snapshot = await read(db); assert.equal(snapshot.counts.needsDecisionCount, 1); assert.equal(snapshot.reviewCards.length, 2);
  await decide(db, 'action', 'accept_action'); snapshot = await read(db);
  assert.equal(snapshot.counts.needsDecisionCount, 1); assert.equal(cardOf(snapshot, 'sketch').disposition, 'active');
  assert.equal(cardOf(snapshot, 'sketch').reasonCode, 'action_choice'); assert.equal(snapshot.actions.length, 1);
  await decide(db, 'sketch', 'accept_action'); snapshot = await read(db);
  assert.equal(snapshot.counts.needsDecisionCount, 0); assert.equal(snapshot.actions.length, 2);
  assert.equal(cardOf(snapshot, 'budget').members.find(m => m.claimId === 'budget').reviewState, 'draft');
});

test('confirming an unrelated fact in an ordinary mixed group does not hide its pending action', async t => {
  const { db, sqlite } = await setup(t, { persisted: false }); storedCard(sqlite, 'mixed', ['budget', 'action'], { kind: 'record' });
  await decide(db, 'budget', 'confirm'); const snapshot = await read(db);
  assert.equal(snapshot.counts.needsDecisionCount, 1); assert.equal(cardOf(snapshot).members.find(m => m.claimId === 'action').reviewState, 'draft');
});

test('an already-processed mixed card is not reactivated by an untouched task member', async t => {
  const { db, sqlite } = await setup(t, { persisted: false });
  storedCard(sqlite, 'mixed', ['budget', 'action'], { kind: 'record', disposition: 'processed' });
  assert.equal((await read(db)).counts.needsDecisionCount, 0);
});

for (const id of ['budget', 'action']) test(`a same-intent zero-default group is handled once when ${id} is accepted`, async t => {
  const { db, sqlite } = await setup(t, { persisted: false });
  sqlite.prepare("UPDATE claims SET type='decision' WHERE id='budget'").run();
  relation(sqlite, 'agreement', 'action', 'budget', 'informed_by', 'proposed');
  storedCard(sqlite, 'intent', ['budget', 'action'], { groupKey: 'same_intent:quote' });
  const before = await read(db); assert.equal(before.counts.needsDecisionCount, 1); assert.ok(cardOf(before).sameIntent);
  await decide(db, id, id === 'action' ? 'accept_action' : 'confirm');
  const after = await read(db); assert.equal(after.counts.needsDecisionCount, 0); assert.equal(cardOf(after).needsDecision, false);
});

test('accepted action basis changes remain a higher-priority check after completion', async t => {
  const { db, sqlite } = await setup(t); relation(sqlite, 'budget-basis', 'action', 'budget', 'informed_by', 'proposed');
  await decide(db, 'action', 'accept_action'); await transition(db, 'complete');
  await decide(db, 'budget', 'edit', { newText: '预算三十五万元', origin: 'user_input', evidenceRefIds: [] });
  const snapshot = await read(db), card = cardOf(snapshot);
  assert.equal(snapshot.actions[0].executionState, 'completed'); assert.equal(snapshot.actions[0].basisState, 'needs_review');
  assert.equal(card.reasonCode, 'accepted_change'); assert.equal(card.needsDecision, true); assert.equal(snapshot.counts.needsDecisionCount, 1);
});
