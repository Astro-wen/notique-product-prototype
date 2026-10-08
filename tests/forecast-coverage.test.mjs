import test from 'node:test';
import assert from 'node:assert/strict';
import {retainFinancialForecastSources, LEGACY_FORECAST_COVERAGE_POLICY} from '../lib/domain/forecast-coverage.ts';
import {validateInventoryOutput, INVENTORY_SCHEMA_VERSION} from '../lib/domain/two-stage-extraction.ts';

const segment = (id, textRaw, speaker = 'John') => ({id, textRaw, speaker, assetVersionId: 'av'});
const inventory = {schema_version: INVENTORY_SCHEMA_VERSION, event_id: 'e', candidates: []};
const context = segments => ({new_event: {transcript_segments: segments}});

test('an omitted financial forecast is handed to the existing verifier with exact evidence and preceding scope', () => {
  const result = retainFinancialForecastSources(inventory, context([
    segment('scope', 'Given volume in major metropolitan areas, competition should remain sufficient.'),
    segment('forecast', 'Keep fees fairly stable, is my guess.'),
  ]));
  assert.equal(result.inventory.candidates.length, 1);
  const candidate = result.inventory.candidates[0];
  assert.equal(candidate.evidence[0].quote_hint, 'Keep fees fairly stable, is my guess.');
  assert.equal(candidate.evidence[1].quote_hint, 'Given volume in major metropolitan areas, competition should remain sufficient.');
  assert.equal(candidate.critical, true);
  assert.equal(validateInventoryOutput(result.inventory).valid, true);
  assert.equal(inventory.candidates.length, 0);
});

test('existing direct coverage is not duplicated and unrelated numbers do not seed differences', () => {
  const result = retainFinancialForecastSources(inventory, context([segment('amount', 'The fee is $300.'), segment('chat', 'I think it is nice weather.')]));
  assert.deepEqual(result.addedKeys, []);
  const first = retainFinancialForecastSources(inventory, context([segment('forecast', 'Fees could increase after November 2.')]));
  assert.deepEqual(retainFinancialForecastSources(first.inventory, context([segment('forecast', 'Fees could increase after November 2.')])).addedKeys, []);
});

test('a nonfinancial conclusion from the same paragraph does not hide its financial forecast',()=>{
 const source=context([segment('forecast','Fees are going to go up after November 2. AMC margins may compress and late adopters may have problems.')]);
 const covered=retainFinancialForecastSources(inventory,source).inventory;
 covered.candidates[0].statement='Late adopters may have operational problems.';
 const revised=retainFinancialForecastSources(covered,source);
 assert.equal(revised.addedKeys.length,1);
 assert.equal(validateInventoryOutput(revised.inventory).valid,true);
 assert.deepEqual(retainFinancialForecastSources(covered,source,LEGACY_FORECAST_COVERAGE_POLICY).addedKeys,[]);
});

test('context-only citation cannot hide a missing forecast and selection respects the 64-item ceiling', () => {
  const first = retainFinancialForecastSources(inventory, context([segment('forecast', 'Fees could increase.')])).inventory;
  first.candidates[0].evidence[0].evidence_role = 'contextual';
  assert.equal(retainFinancialForecastSources(first, context([segment('forecast', 'Fees could increase.')])).addedKeys.length, 1);
  const full = {...inventory, candidates: Array.from({length:64}, (_, i) => ({...first.candidates[0], inventory_key: `k${i}`}))};
  assert.equal(retainFinancialForecastSources(full, context([segment('other', 'Fees could decrease.')])).inventory.candidates.length, 64);
});
