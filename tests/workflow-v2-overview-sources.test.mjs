import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase, seed, insert, SCOPE, T } from './helpers/workflow-database.mjs';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { readProjectOverview } from '../lib/server/workflow/overview-service.ts';
import { dispatchWorkflowCommand } from '../lib/server/workflow/commands.ts';

async function setup(t) {
  const f = await workflowDatabase();
  t.after(f.close);
  seed(f.sqlite);
  return f;
}
const overview = (db, query = {}) => readProjectOverview(db, SCOPE, 'p', query, T);
async function edit(db, text) {
  const workspace = await readWorkspace(db, SCOPE, 'e', {}, T);
  const card = workspace.reviewCards.find(card => card.id === 'wfc_budget');
  await dispatchWorkflowCommand(db, SCOPE, ['review-cards', card.id, 'decisions'], {
    expectedContextVersion: workspace.contextVersion,
    expectedCardRevision: card.revision,
    operation: 'edit',
    members: [{ ...card.memberRefs[0], operation: 'edit', newText: text, origin: 'user_input', evidenceRefIds: [] }],
  }, crypto.randomUUID());
}
function change(sqlite, id, refs, text = '冻结的历史内容') {
  insert(sqlite, 'workflow_changes', {
    id, workspace_id: 'ws', project_id: 'p', event_id: 'e', mutation_id: id,
    context_version: 0, actor_id: 'owner', kind: 'edit', created_at: T,
    changed_refs_json: JSON.stringify([{ entityType: 'claim', id: 'budget', claimRefs: refs, text }]),
  });
}
const source = (snapshot, claimId, versionId = `${claimId}_v1`) => snapshot.sourceRefs.find(ref => ref.claimId === claimId && ref.claimVersionId === versionId);

test('overview maps current records, questions and suggested actions to exact source versions', async t => {
  const { db } = await setup(t);
  const snapshot = await overview(db);
  for (const id of ['budget', 'question', 'action']) {
    assert.deepEqual(source(snapshot, id), {
      claimId: id, claimVersionId: `${id}_v1`, eventId: 'e', evidenceRefIds: [`${id}_ev`],
      origin: id === 'action' ? 'ai_suggestion' : 'source_statement', sourceStatus: 'ready',
    });
  }
});

test('historical human edits retain their own note sources across overview pages', async t => {
  const { db, sqlite } = await setup(t);
  await edit(db, '预算三十五万');
  await edit(db, '预算四十万');
  const first = await overview(db, { limit: 1 });
  const next = await overview(db, { snapshotId: first.snapshotId, cursor: first.nextCursor, limit: 1 });
  const changes = [...first.recentChanges, ...next.recentChanges];
  const historical = changes.find(change => change.text.includes('三十五万')).claimRefs[0];
  const current = first.currentBullets.find(bullet => bullet.id === 'budget').claimRefs[0];
  assert.notEqual(current.claimVersionId, historical.claimVersionId);
  const oldSource = source(first, 'budget', historical.claimVersionId);
  assert.equal(oldSource.origin, 'user_input');
  assert.equal(oldSource.sourceStatus, 'ready');
  assert.equal(oldSource.evidenceRefIds.length, 1);
  assert.deepEqual(next.sourceRefs, first.sourceRefs);
  const oldNote = sqlite.prepare('SELECT er.claim_version_id, er.kind, n.body FROM evidence_refs er JOIN user_notes n ON n.id=er.user_note_id WHERE er.id=?').get(oldSource.evidenceRefIds[0]);
  assert.equal(oldNote.claim_version_id, historical.claimVersionId);
  assert.equal(oldNote.kind, 'user_note');
  assert.equal(oldNote.body, '预算三十五万');
  assert.notDeepEqual(oldSource.evidenceRefIds, source(first, 'budget', current.claimVersionId).evidenceRefIds);
  assert.ok(!oldSource.evidenceRefIds.includes('budget_ev'));
});

test('a historical version cannot borrow another claim source or current source', async t => {
  const { db, sqlite } = await setup(t);
  change(sqlite, 'mismatched', [{ claimId: 'budget', claimVersionId: 'question_v1' }], '不能泄露的内容');
  change(sqlite, 'unknown', [{ claimId: 'budget', claimVersionId: 'budget_missing_version' }], '不存在的历史内容');
  const snapshot = await overview(db);
  assert.equal(source(snapshot, 'budget', 'question_v1'), undefined);
  assert.equal(source(snapshot, 'budget', 'budget_missing_version'), undefined);
  assert.doesNotMatch(snapshot.recentChanges.map(change => change.text).join(' '), /不能泄露|不存在的历史/);
});

test('an original historical quote keeps its origin after the current text becomes a human note', async t => {
  const { db, sqlite } = await setup(t);
  change(sqlite, 'original-wording', [{ claimId: 'budget', claimVersionId: 'budget_v1' }]);
  await edit(db, '修改后的预算');
  const snapshot = await overview(db);
  assert.equal(source(snapshot, 'budget', 'budget_v1').origin, 'source_statement');
  assert.deepEqual(source(snapshot, 'budget', 'budget_v1').evidenceRefIds, ['budget_ev']);
  const current = snapshot.currentBullets.find(bullet => bullet.id === 'budget').claimRefs[0];
  assert.equal(source(snapshot, 'budget', current.claimVersionId).origin, 'user_input');
});

test('a human note without its authorized attributed note record cannot supply a source', async t => {
  const { db, sqlite } = await setup(t);
  await edit(db, '人工填写的预算');
  const first = await overview(db);
  const current = first.currentBullets.find(bullet => bullet.id === 'budget').claimRefs[0];
  sqlite.prepare("UPDATE user_notes SET author_id='' WHERE claim_id='budget'").run();
  const invalid = await overview(db);
  assert.equal(source(invalid, 'budget', current.claimVersionId).sourceStatus, 'missing');
  assert.deepEqual(source(invalid, 'budget', current.claimVersionId).evidenceRefIds, []);
  assert.doesNotMatch(invalid.recentChanges[0].text, /人工填写的预算/);
  await assert.rejects(overview(db, { snapshotId: first.snapshotId }), error => error.code === 'cursor_expired');
});

test('stale and invalid sources remove preview pointers and expire cached pages', async t => {
  const { db, sqlite } = await setup(t);
  change(sqlite, 'original', [{ claimId: 'budget', claimVersionId: 'budget_v1' }]);
  const first = await overview(db);
  sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
  await assert.rejects(overview(db, { snapshotId: first.snapshotId }), error => error.code === 'cursor_expired');
  const stale = await overview(db);
  assert.equal(source(stale, 'budget').sourceStatus, 'stale');
  assert.deepEqual(source(stale, 'budget').evidenceRefIds, []);
  assert.doesNotMatch(stale.recentChanges[0].text, /冻结的历史内容/);
  sqlite.prepare("UPDATE assets SET current_version_id='av' WHERE id='asset'").run();
  sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='budget_ev'").run();
  const invalid = await overview(db);
  assert.equal(source(invalid, 'budget').sourceStatus, 'missing');
  assert.deepEqual(source(invalid, 'budget').evidenceRefIds, []);
});

test('contextual and derived references never become original-source preview pointers', async t => {
  const { db, sqlite } = await setup(t);
  sqlite.prepare("UPDATE evidence_refs SET evidence_role='contextual' WHERE id='budget_ev'").run();
  sqlite.prepare("UPDATE evidence_refs SET provenance_grade='secondary' WHERE id='question_ev'").run();
  const snapshot = await overview(db);
  for (const id of ['budget', 'question']) {
    assert.equal(source(snapshot, id).sourceStatus, 'missing');
    assert.deepEqual(source(snapshot, id).evidenceRefIds, []);
  }
});

test('archived, moved and foreign project sources cannot escape the authorized overview', async t => {
  const { db, sqlite } = await setup(t);
  const first = await overview(db);
  sqlite.prepare("UPDATE events SET material_status='archived' WHERE id='e'").run();
  assert.deepEqual((await overview(db)).sourceRefs, []);
  await assert.rejects(overview(db, { snapshotId: first.snapshotId }), error => error.code === 'cursor_expired');
  sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
  insert(sqlite, 'projects', { id: 'foreign-project', workspace_id: 'ws', name: 'Other' });
  sqlite.prepare("UPDATE evidence_refs SET project_id='foreign-project' WHERE id='budget_ev'").run();
  const foreign = await overview(db);
  assert.equal(source(foreign, 'budget').sourceStatus, 'missing');
  assert.deepEqual(source(foreign, 'budget').evidenceRefIds, []);
  sqlite.prepare("UPDATE events SET project_id='foreign-project' WHERE id='e'").run();
  assert.deepEqual((await overview(db)).sourceRefs, []);
});

test('source identity changes invalidate a cached overview even when the words stay identical', async t => {
  const { db, sqlite } = await setup(t);
  const first = await overview(db);
  sqlite.prepare("UPDATE evidence_refs SET id='budget_replacement_source' WHERE id='budget_ev'").run();
  await assert.rejects(overview(db, { snapshotId: first.snapshotId }), error => error.code === 'cursor_expired');
  assert.deepEqual(source(await overview(db), 'budget').evidenceRefIds, ['budget_replacement_source']);
});
