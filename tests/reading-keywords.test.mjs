import test from 'node:test';
import assert from 'node:assert/strict';
import { readingKeywords } from '../app/reading-keywords.ts';
test('keywords are source terms, deduplicated without inventing qualifications', () => {
  const text='In San Antonio, the buyer needs pre-approval, an open floor plan and a game room. SAN ANTONIO is the area.';
  const keywords=readingKeywords(text);
  assert.equal(keywords.filter(k=>k.toLowerCase()==='san antonio').length,1);
  assert.ok(keywords.includes('San Antonio'));
  assert.ok(!keywords.includes('VA loan'));
  assert.ok(keywords.every(k=>text.toLowerCase().includes(k.toLowerCase())));
  assert.deepEqual(readingKeywords(''),[]);
});
