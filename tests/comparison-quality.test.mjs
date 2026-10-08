import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonQualityIssues, hasRateDurationMismatch, retainUncertainMetrics} from '../lib/domain/comparison-quality.ts';

const claim = (statement, normalized_value = null) => ({client_claim_key: 'new', statement, normalized_value, type: 'fact', relations: [], evidence: [{kind: 'text', quote_hint: '1.8 days higher revision rates'}]});
const link = {final_claim_key: 'new', target_draft_claim_id: 'old', target_draft_claim_version_id: 'version'};
const context = normalizedValue => ({new_event: {title: 'Project'}, verified_context: {active_claims: [], recent_history: [], open_questions: [], active_risks: []}, draft_context: {claims: [{claimId: 'old', claimVersionId: 'version', normalizedValue}]}});

test('standalone prices without change wording remain comparable across conversations', () => {
  const identity = {comparison_subject: 'summer-shop:ice-pop', comparison_dimension: 'unit_price', comparison_scope: 'one stick', currency: 'CNY'};
  const source = claim('冰棍每根 3 元。', {...identity, amount: 3});
  const ctx = context({...identity, amount: 2});
  ctx.draft_context.claims[0].statement = '冰棍每根 2 元。';
  const proposal = {...link, reason: '同一家店同款冰棍的每根价格分别是 2 元与 3 元。', alignment: {same_subject: true, same_dimension: true, comparable_scope: true, conclusion_supported: true}};
  assert.deepEqual(comparisonQualityIssues([source], [proposal], ctx), []);
});

test('duration attributed to a rate is detected without rejecting separate rate and duration facts', () => {
  assert.equal(hasRateDurationMismatch(claim('Citi reported revision rates as 1.8 days higher.')), true);
  assert.equal(hasRateDurationMismatch(claim('Revision rates were 1.8 days higher.')), true);
  assert.equal(hasRateDurationMismatch(claim('Revision rates increased by 10%, and turnaround increased by 1.8 days.')), false);
  assert.equal(hasRateDurationMismatch(claim('Turnaround averaged 1.8 additional days.')), false);
  assert.equal(hasRateDurationMismatch(claim('Revisions increased.', {comparison_dimension: 'revision_rate', unit: 'days'})), true);
});

test('institutions’ own observations do not form a changed link', () => {
  const source = claim('Citi processing time increased.', {comparison_subject: 'Citi', comparison_dimension: 'turnaround'});
  const issues = comparisonQualityIssues([source], [link], context({comparison_subject: 'Citizen Bank', comparison_dimension: 'turnaround'}));
  assert.equal(issues[0].reason, 'comparison_scope_mismatch');
  assert.equal(issues[0].targetVersionId, 'version');
});

test('different speakers can update the same shared budget and older metadata is compatible', () => {
  const source = claim('Bob approves $18,000.', {comparison_subject: 'Northstar workshop', comparison_dimension: 'total_budget'});
  assert.deepEqual(comparisonQualityIssues([source], [link], context({comparison_subject: 'Northstar workshop', comparison_dimension: 'total_budget'})), []);
  assert.deepEqual(comparisonQualityIssues([source], [link], context(null)), []);
});

test('unresolved dimensional errors retain the source as a question rather than a false numeric fact', () => {
  const source = claim('Citi reported revision rates as 1.8 days higher.');
  const [result] = retainUncertainMetrics([source]);
  assert.equal(result.type, 'open_question');
  assert.equal(result.normalized_value, null);
  assert.equal(result.needs_additional_evidence, true);
  assert.deepEqual(result.evidence, source.evidence);
  assert.equal(source.type, 'fact');
});


test('comparison is blocked when its own proof or reason disproves it', () => {
  const source = claim('Fees stay stable.');
  const ctx = context(null);
  const proof = {...link, alignment: {same_subject: true, same_dimension: true, comparable_scope: false, conclusion_supported: true}};
  assert.equal(comparisonQualityIssues([source], [proof], ctx)[0].reason, 'comparison_scope_mismatch');
  assert.equal(comparisonQualityIssues([source], [{...link, reason: 'It does not answer the narrower question.'}], ctx)[0].reason, 'comparison_scope_mismatch');
  assert.equal(comparisonQualityIssues([source], [{...proof, alignment: {...proof.alignment, comparable_scope: true}}], ctx).length, 0);
});

test('confirmed history receives the same scope guard without blocking informed-by provenance', () => {
  const ctx = context(null);
  ctx.draft_context.claims = [];
  ctx.verified_context.active_claims = [{claimId: 'old', claimVersionId: 'version', normalizedValue: {comparison_subject: 'Citizen Bank'}}];
  const source = {...claim('Citi turn time is longer.', {comparison_subject: 'Citi'}), relations: [{type: 'supersedes', target_claim_id: 'old', target_claim_version_id: 'version', reason: 'Same timing topic.'}]};
  assert.equal(comparisonQualityIssues([source], [], ctx)[0].reason, 'comparison_scope_mismatch');
  source.relations[0].type = 'informed_by';
  assert.deepEqual(comparisonQualityIssues([source], [], ctx), []);
});


test('an explicitly institution-owned observation cannot silently change a different institution', () => {
  const ctx = context(null); ctx.new_event.title = 'Citizen Bank · Sept 23';
  ctx.draft_context.claims[0].eventTitle = 'Citi Bank · Val Expo';
  ctx.draft_context.claims[0].statement = 'Citi has experienced software challenges.';
  assert.equal(comparisonQualityIssues([claim('The Philadelphia pilot had two technology problems.')], [link], ctx)[0].reason, 'comparison_scope_mismatch');
  ctx.draft_context.claims[0].statement = 'Competitive markets may keep fees stable.';
  assert.deepEqual(comparisonQualityIssues([claim('Early-adopter demand could increase market fees.')], [link], ctx), []);
});
