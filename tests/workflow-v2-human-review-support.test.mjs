import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase, seed, claim, insert, relation, SCOPE, T } from './helpers/workflow-database.mjs';
import { dispatchWorkflowCommand } from '../lib/server/workflow/commands.ts';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { userMayAcceptSupport, USER_ACCEPTABLE_SUPPORT_STATUSES } from '../lib/domain/review-support.ts';

const read = db => readWorkspace(db, SCOPE, 'e', {}, T);
const send = (db, path, body, key = crypto.randomUUID()) => dispatchWorkflowCommand(db, SCOPE, path.split('/'), body, key);
async function setup(t) {
  const fixture = await workflowDatabase(); t.after(fixture.close); seed(fixture.sqlite);
  fixture.sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='unreviewed'").run();
  return fixture;
}
async function decide(db, claimId, operation, extra = {}, key = crypto.randomUUID()) {
  const s = await read(db), card = s.reviewCards.find(card => card.memberRefs.some(ref => ref.claimId === claimId));
  const path = `review-cards/${card.id}/decisions`, body = { operation, expectedContextVersion: s.contextVersion,
    expectedCardRevision: card.revision, members: [{ ...card.memberRefs.find(ref => ref.claimId === claimId), operation, ...extra }] };
  return { receipt: await send(db, path, body, key), path, body };
}
async function undo(db, saved) {
  const s = await read(db), decision = s.recentDecisions.find(decision => decision.id === saved.receipt.mutationId);
  return send(db, `decisions/${decision.id}/revert`, { expectedContextVersion: s.contextVersion, expectedDecisionRevision: decision.revision });
}
const mutationCounts = sql => Object.fromEntries(['workflow_decisions', 'decision_members', 'verdicts', 'workflow_changes', 'workflow_outbox', 'mutation_replays']
  .map(table => [table, sql.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
async function conflictSetup(t, type = 'budget') {
  const f = await setup(t);
  if (type === 'next_action') {
    f.sqlite.prepare("UPDATE claim_versions SET normalized_value_json=? WHERE id='action_v1'").run(JSON.stringify({ owner: '小陈', due_at: '2026-10-08' }));
    await decide(f.db, 'action', 'accept_action');
  } else f.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();
  const oldId = type === 'next_action' ? 'action' : 'budget', newId = 'candidate';
  claim(f.sqlite, newId, type, type === 'next_action' ? '小林提交新的阅读区方案' : '预算大约三十五万元');
  f.sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='unreviewed' WHERE id='candidate_ev'").run();
  relation(f.sqlite, 'candidate-conflict', newId, oldId, 'contradicts', 'proposed');
  if (type === 'next_action') {
    relation(f.sqlite, 'candidate-basis', newId, 'question', 'informed_by', 'proposed');
    f.sqlite.prepare("UPDATE claim_versions SET normalized_value_json=? WHERE id='candidate_v1'").run(JSON.stringify({ owner: '小林', due_at: '2026-10-10' }));
  }
  return { ...f, oldId, newId };
}
const conflictChoice = (f, mode) => ({ conflictChoice: { mode, existingRef: { claimId: f.oldId, claimVersionId: `${f.oldId}_v1` },
  candidateRef: { claimId: f.newId, claimVersionId: `${f.newId}_v1` }, ...(mode === 'coexist' ? { applicability: '不同采购阶段分别适用' } : {}) } });

test('shared user acceptance support rule keeps AI support separate from the human decision', () => {
  assert.deepEqual([...USER_ACCEPTABLE_SUPPORT_STATUSES], ['fully_supports', 'unreviewed']);
  for (const status of ['fully_supports', 'unreviewed']) assert.equal(userMayAcceptSupport(status), true);
  for (const status of ['partially_supports', 'does_not_support', '', 'unknown', 'verified']) assert.equal(userMayAcceptSupport(status), false);
});

test('a fresh two-stage unreviewed record can be explicitly confirmed, replayed and undone without changing its AI support', async t => {
  const { db, sqlite } = await setup(t), before = await read(db);
  assert.equal(before.reviewCards.find(card => card.id === 'wfc_budget').members[0].supportStatus, 'unreviewed');
  const saved = await decide(db, 'budget', 'confirm', {}, 'human-confirm');
  assert.deepEqual(await send(db, saved.path, saved.body, 'human-confirm'), saved.receipt);
  let s = await read(db); assert.equal(s.bullets.find(bullet => bullet.id === 'budget').reviewState, 'accepted');
  assert.equal(s.bullets.find(bullet => bullet.id === 'budget').text, '预算大约三十万');
  assert.equal(s.reviewCards.find(card => card.id === 'wfc_budget').members[0].supportStatus, 'unreviewed');
  assert.equal(sqlite.prepare("SELECT semantic_support_verdict FROM evidence_refs WHERE id='budget_ev'").get().semantic_support_verdict, 'unreviewed');
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status, 'verified');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claim_versions WHERE claim_id='budget'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT action FROM verdicts WHERE claim_id='budget'").get().action, 'confirm');
  await undo(db, saved); s = await read(db);
  assert.equal(s.bullets.find(bullet => bullet.id === 'budget').reviewState, 'draft');
  assert.equal(sqlite.prepare("SELECT semantic_support_verdict FROM evidence_refs WHERE id='budget_ev'").get().semantic_support_verdict, 'unreviewed');
});

test('mixed fully supported and unreviewed direct evidence remains available to explicit human confirmation', async t => {
  const { db, sqlite } = await setup(t);
  insert(sqlite, 'evidence_refs', { id: 'budget_extra', workspace_id: 'ws', project_id: 'p', event_id: 'e', claim_version_id: 'budget_v1', kind: 'text',
    asset_version_id: 'av', segment_ids_json: '["seg"]', quote_raw: '预算大约三十万', evidence_role: 'supporting', provenance_grade: 'primary',
    structural_validation_status: 'valid', semantic_support_verdict: 'fully_supports' });
  await decide(db, 'budget', 'confirm');
  assert.equal((await read(db)).bullets.find(bullet => bullet.id === 'budget').reviewState, 'accepted');
  assert.deepEqual(sqlite.prepare("SELECT semantic_support_verdict FROM evidence_refs WHERE claim_version_id='budget_v1' ORDER BY id").all()
    .map(row => row.semantic_support_verdict), ['unreviewed', 'fully_supports']);
});

test('a group can confirm unreviewed records and accept its unreviewed action in one atomic decision', async t => {
  const { db, sqlite } = await setup(t); claim(sqlite, 'place', 'fact', '在门店核对报价');
  sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='unreviewed' WHERE id='place_ev'").run();
  insert(sqlite, 'workflow_cards', { id: 'human-group', workspace_id: 'ws', project_id: 'p', event_id: 'e', group_key: 'human-group', revision: 1,
    kind: 'record', title: '共同核对', needs_decision: 0, reason: '', disposition: 'active' });
  for (const id of ['budget', 'place', 'action']) insert(sqlite, 'card_members', { id: `group_${id}`, workspace_id: 'ws', card_id: 'human-group',
    claim_id: id, claim_version_id: `${id}_v1`, role: 'primary' });
  const body = { operation: 'review_members', expectedContextVersion: 0, expectedCardRevision: 1,
    members: ['budget', 'place', 'action'].map(id => ({ claimId: id, claimVersionId: `${id}_v1`, operation: id === 'action' ? 'accept_action' : 'confirm' })) };
  const receipt = await send(db, 'review-cards/human-group/decisions', body, 'confirm-unreviewed-group');
  assert.deepEqual(await send(db, 'review-cards/human-group/decisions', body, 'confirm-unreviewed-group'), receipt);
  const s = await read(db); assert.equal(s.actions.length, 1);
  assert.equal(s.reviewCards.find(card => card.id === 'human-group').members.every(member => member.reviewState === 'accepted'), true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM decision_members').get().n, 3);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM evidence_refs WHERE semantic_support_verdict<>'unreviewed'").get().n, 0);
});

for (const timing of ['before_prepare', 'at_commit']) test(`one negative member ${timing} cannot partially confirm an unreviewed group`, async t => {
  const { db, sqlite } = await setup(t); claim(sqlite, 'place', 'fact', '在门店核对报价');
  sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='unreviewed' WHERE id='place_ev'").run();
  insert(sqlite, 'workflow_cards', { id: 'human-group', workspace_id: 'ws', project_id: 'p', event_id: 'e', group_key: 'human-group', revision: 1,
    kind: 'record', title: '共同核对', needs_decision: 0, reason: '', disposition: 'active' });
  for (const id of ['budget', 'place']) insert(sqlite, 'card_members', { id: `group_${id}`, workspace_id: 'ws', card_id: 'human-group',
    claim_id: id, claim_version_id: `${id}_v1`, role: 'primary' });
  const markNegative = () => sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='does_not_support' WHERE id='place_ev'").run();
  if (timing === 'before_prepare') markNegative();
  else { const batch = db.batch; db.batch = async statements => { markNegative(); return batch(statements); }; }
  const before = mutationCounts(sqlite), body = { operation: 'review_members', expectedContextVersion: 0, expectedCardRevision: 1,
    members: ['budget', 'place'].map(id => ({ claimId: id, claimVersionId: `${id}_v1`, operation: 'confirm' })) };
  await assert.rejects(send(db, 'review-cards/human-group/decisions', body), error => error.code === (timing === 'before_prepare' ? 'dependency_conflict' : 'version_conflict'));
  assert.deepEqual(mutationCounts(sqlite), before);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claims WHERE id IN ('budget','place') AND review_status='pending'").get().n, 2);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version, 0);
});

for (const mode of ['use_candidate', 'coexist']) test(`an unreviewed conflict candidate can be chosen by explicit ${mode} and reversed`, async t => {
  const f = await conflictSetup(t), saved = await decide(f.db, f.newId, 'resolve_conflict', conflictChoice(f, mode));
  let s = await read(f.db); assert.equal(s.bullets.find(bullet => bullet.id === f.newId).reviewState, 'accepted');
  assert.equal(f.sqlite.prepare("SELECT semantic_support_verdict FROM evidence_refs WHERE id='candidate_ev'").get().semantic_support_verdict, 'unreviewed');
  assert.equal(f.sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='budget'").get().lifecycle_status, mode === 'use_candidate' ? 'superseded' : 'active');
  await undo(f.db, saved); s = await read(f.db);
  assert.equal(s.bullets.find(bullet => bullet.id === f.newId).reviewState, 'draft');
  assert.equal(f.sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='budget'").get().lifecycle_status, 'active');
});

for (const status of ['partially_supports', 'does_not_support']) for (const operation of ['confirm', 'use_candidate', 'coexist'])
  test(`${status} continues to require correction before ${operation}`, async t => {
    const f = operation === 'confirm' ? await setup(t) : await conflictSetup(t), target = operation === 'confirm' ? 'budget' : f.newId;
    f.sqlite.prepare('UPDATE evidence_refs SET semantic_support_verdict=? WHERE claim_version_id=?').run(status, `${target}_v1`);
    const before = mutationCounts(f.sqlite);
    await assert.rejects(decide(f.db, target, operation === 'confirm' ? 'confirm' : 'resolve_conflict', operation === 'confirm' ? {} : conflictChoice(f, operation)), error => error.code === 'dependency_conflict');
    assert.deepEqual(mutationCounts(f.sqlite), before);
  });

for (const source of ['missing', 'stale', 'invalid']) for (const operation of ['confirm', 'use_candidate'])
  test(`${source} source still blocks explicit unreviewed ${operation}`, async t => {
    const f = operation === 'confirm' ? await setup(t) : await conflictSetup(t), target = operation === 'confirm' ? 'budget' : f.newId;
    if (source === 'missing') f.sqlite.prepare('DELETE FROM evidence_refs WHERE claim_version_id=?').run(`${target}_v1`);
    if (source === 'stale') f.sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
    if (source === 'invalid') f.sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE claim_version_id=?").run(`${target}_v1`);
    const before = mutationCounts(f.sqlite);
    await assert.rejects(decide(f.db, target, operation === 'confirm' ? 'confirm' : 'resolve_conflict', operation === 'confirm' ? {} : conflictChoice(f, operation)), error => error.code === 'dependency_conflict');
    assert.deepEqual(mutationCounts(f.sqlite), before);
  });

for (const status of ['partially_supports', 'does_not_support']) for (const operation of ['confirm', 'use_candidate', 'coexist'])
  test(`a commit-time change to ${status} rolls back the entire ${operation}`, async t => {
    const f = operation === 'confirm' ? await setup(t) : await conflictSetup(t), target = operation === 'confirm' ? 'budget' : f.newId;
    const before = mutationCounts(f.sqlite), batch = f.db.batch;
    f.db.batch = async statements => { f.sqlite.prepare('UPDATE evidence_refs SET semantic_support_verdict=? WHERE claim_version_id=?').run(status, `${target}_v1`); return batch(statements); };
    await assert.rejects(decide(f.db, target, operation === 'confirm' ? 'confirm' : 'resolve_conflict', operation === 'confirm' ? {} : conflictChoice(f, operation)), error => error.code === 'version_conflict');
    assert.deepEqual(mutationCounts(f.sqlite), before);
    assert.equal(f.sqlite.prepare('SELECT review_status FROM claims WHERE id=?').get(target).review_status, 'pending');
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n, 0);
  });

for (const operation of ['confirm', 'use_candidate']) test(`changing evidence role to contextual cannot bypass the ${operation} support guard`, async t => {
  const f = operation === 'confirm' ? await setup(t) : await conflictSetup(t), target = operation === 'confirm' ? 'budget' : f.newId;
  const before = mutationCounts(f.sqlite), batch = f.db.batch;
  f.db.batch = async statements => { f.sqlite.prepare("UPDATE evidence_refs SET evidence_role='contextual',semantic_support_verdict='does_not_support' WHERE claim_version_id=?").run(`${target}_v1`); return batch(statements); };
  await assert.rejects(decide(f.db, target, operation === 'confirm' ? 'confirm' : 'resolve_conflict', operation === 'confirm' ? {} : conflictChoice(f, operation)), error => error.code === 'version_conflict');
  assert.deepEqual(mutationCounts(f.sqlite), before);
});

test('a commit-time negative action support change also prevents an accepted stale suggestion', async t => {
  const f = await setup(t), batch = f.db.batch;
  f.db.batch = async statements => { f.sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='does_not_support' WHERE id='action_ev'").run(); return batch(statements); };
  await assert.rejects(decide(f.db, 'action', 'accept_action'), error => error.code === 'version_conflict');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM action_metadata').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n, 0);
});

test('action conflict adoption saves complete owner/date receipts and undo restores the old completed action', async t => {
  const f = await conflictSetup(t, 'next_action'); let s = await read(f.db), action = s.actions.find(action => action.id === 'action');
  await send(f.db, 'actions/action/transitions', { operation: 'complete', expectedContextVersion: s.contextVersion, expectedActionRevision: action.revision });
  const saved = await decide(f.db, 'candidate', 'resolve_conflict', conflictChoice(f, 'use_candidate'));
  s = await read(f.db); action = s.actions.find(action => action.id === 'candidate');
  assert.equal(action.ownerHint, '小林'); assert.equal(action.dueAt, '2026-10-10'); assert.equal(action.executionState, 'open');
  const row = f.sqlite.prepare("SELECT after_state_json FROM decision_members WHERE decision_id=? AND claim_id='candidate'").get(saved.receipt.mutationId);
  const after = JSON.parse(row.after_state_json).actionMetadata;
  assert.equal(after.owner_hint, '小林'); assert.equal(after.due_at, '2026-10-10'); assert.equal(after.cancelled_at, null);
  await undo(f.db, saved); s = await read(f.db); action = s.actions.find(action => action.id === 'action');
  assert.equal(action.ownerHint, '小陈'); assert.equal(action.dueAt, '2026-10-08'); assert.equal(action.executionState, 'completed');
  assert.equal(s.actions.some(action => action.id === 'candidate'), false);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM action_metadata WHERE claim_id='candidate'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT semantic_support_verdict FROM evidence_refs WHERE id='candidate_ev'").get().semantic_support_verdict, 'unreviewed');
});
