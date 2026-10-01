import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationWaitBudget } from '../lib/domain/verification-wait-budget.ts';

test('complete validated base bounds optional refinement while old runs keep their frozen wait', () => {
  const reasons = ['unresolved_conflict', 'compound_claim'];
  assert.equal(verificationWaitBudget(600_000, 120_000, true, reasons), 120_000);
  assert.equal(verificationWaitBudget(600_000, undefined, true, reasons), 600_000);
  assert.equal(verificationWaitBudget(90_000, 120_000, true, reasons), 90_000);
});

test('missing facts, uncertain relations, invalid base and incomplete coverage retain full verification', () => {
  for (const reason of ['critical_candidate_dropped', 'inventory_candidate_unmapped', 'supported_followup_dropped', 'low_confidence_relation', 'reaffirmed_issue', 'verification_contract_invalid']) {
    assert.equal(verificationWaitBudget(600_000, 120_000, true, ['unresolved_conflict', reason]), 600_000);
  }
  assert.equal(verificationWaitBudget(600_000, 120_000, false, ['unresolved_conflict']), 600_000);
  for (const value of [null, '120000', NaN, 0, 1]) assert.equal(verificationWaitBudget(600_000, value, true, ['unresolved_conflict']), 600_000);
});
