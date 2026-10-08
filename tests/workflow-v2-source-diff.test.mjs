import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceDiff } from '../lib/domain/source-diff.ts';
import { statementDiff } from '../lib/domain/statement-diff.ts';
import { workflowDatabase, seed, SCOPE, T } from './helpers/workflow-database.mjs';
import { readProjectOverview } from '../lib/server/workflow/overview-service.ts';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';

const before = 'We do them limitedly';
const after = 'Oh no, we have not.';
const value = JSON.stringify({ change_before: before, change_after: after });
const sources = [
  { id: 'a', kind: 'text', quote_raw: before, evidence_role: 'direct', availability: 'ready', structural_validation_status: 'valid' },
  { id: 'b', kind: 'text', quote_raw: after, evidence_role: 'direct', availability: 'ready', structural_validation_status: 'valid' },
];

test('a local clarification must retain both exact source excerpts', () => {
  assert.deepEqual(sourceDiff(value, sources), { before, after, evidenceRefIds: ['a', 'b'] });
  assert.equal(sourceDiff(value, sources.slice(0, 1)), undefined);
  assert.equal(sourceDiff(JSON.stringify({ change_before: before, change_after: 'We approved everything.' }), sources), undefined);
  for (const fields of [{ availability: 'stale' }, { structural_validation_status: 'invalid' }, { evidence_role: 'contextual' }, { kind: 'user_note' }]) {
    assert.equal(sourceDiff(value, [sources[0], { ...sources[1], ...fields }]), undefined);
  }
  for (const invalid of ['null', '[]', '{', JSON.stringify({ change_before: before, change_after: before })]) {
    assert.equal(sourceDiff(invalid, sources), undefined);
  }
});

test('diff isolates changed Chinese money and English negation without losing either statement', () => {
  for (const [old, next] of [['预算约30万元，用于一期。', '预算约35万元，用于一期。'], ['We use inspection waivers.', 'We do not use inspection waivers.']]) {
    const parts = statementDiff(old, next);
    assert.equal(parts.filter(p => !p.added).map(p => p.value).join(''), old);
    assert.equal(parts.filter(p => !p.removed).map(p => p.value).join(''), next);
    assert.ok(parts.some(p => p.added));
    assert.ok(parts.some(p => !p.added && !p.removed));
  }
  assert.equal(statementDiff('x'.repeat(13000), 'new'), null);
});

test('historical source annotations stay in the ledger but are first records in project history', async t => {
  const { db, sqlite, close } = await workflowDatabase(); t.after(close); seed(sqlite);
  sqlite.prepare('UPDATE claim_versions SET normalized_value_json=? WHERE id=?').run(value, 'budget_v1');
  sqlite.prepare('UPDATE evidence_refs SET quote_raw=? WHERE id=?').run(`${before}\n${after}`, 'budget_ev');
  const read = () => readProjectOverview(db, SCOPE, 'p', {}, T);
  const s = await readWorkspace(db, SCOPE, 'e', {}, T);
  assert.deepEqual(s.reviewCards.find(c => c.members.some(m => m.claimId === 'budget')).members[0].sourceDiff,
    { before, after, evidenceRefIds: ['budget_ev'] });
  const overview = await read();
  const entry=overview.timeline.find(e => e.after.ref.claimId === 'budget');
  assert.equal(entry.kind,'introduced');
  assert.equal(entry.sourceDiff,undefined);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM claim_relations WHERE type IN (\'supersedes\',\'contradicts\')').get().n, 0);
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status, 'pending');
  sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
  const next = await read();
  assert.equal(next.timeline.find(e => e.after.ref.claimId === 'budget').sourceDiff, undefined);
});
