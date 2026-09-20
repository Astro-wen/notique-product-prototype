import test from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeSummarySections, readingPriority } from '../lib/domain/ux-priority.ts';

test('business-critical reading order retains exact statements, evidence and stable identity', () => {
  const sections = [
    { kind: 'overview', items: [{ text: 'The buyer has three children.', source_segment_ids: ['s1'] }] },
    { kind: 'decision', items: [{ text: 'The search target is $220,000, subject to lender approval.', source_segment_ids: ['s2'], support_quote: 'Subject to approval.' }] },
  ];
  const original = structuredClone(sections);
  const ranked = prioritizeSummarySections(sections);
  assert.equal(ranked[0].kind, 'decision');
  assert.equal(ranked[0].items[0].item_key, '1-0');
  assert.equal(ranked[0].items[0].text, original[1].items[0].text);
  assert.deepEqual(ranked[0].items[0].source_segment_ids, ['s2']);
  assert.deepEqual(sections, original);
  assert.ok(readingPriority({type:'requirement',statement:'Three bedrooms'}) < readingPriority({statement:'Family background'}));
});

test('incomplete summaries remain safe to render and ties retain source order', () => {
  assert.deepEqual(prioritizeSummarySections([]), []);
  const ranked = prioritizeSummarySections([{items:[null, 'invalid', {text:'A',item_key:'a'}, {text:'B',item_key:'b'}]}, {items:null}]);
  assert.deepEqual(ranked[0].items.map(item=>item.item_key), ['a','b']);
});
