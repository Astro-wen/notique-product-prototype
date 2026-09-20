import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalizeTranscriptEvidence, recoverTranscriptEvidence } from '../lib/domain/evidence.ts';
const segments = [
  {id:'a', textRaw:"We've probably got about ten twelve thousand, I'd"},
  {id:'b', textRaw:'Okay.'},
  {id:'c', textRaw:'say, available right now.'},
].map((s,ordinal)=>({...s,ordinal,eventId:'e',assetVersionId:'v',speaker:'Buyer',startMs:ordinal*1000,endMs:(ordinal+1)*1000}));
const map = new Map(segments.map(s=>[s.id,s]));
const options = {expectedEventId:'e',allowedSegmentIds:new Set(['a','b','c'])};
test('recovers sparse model citation with full original intervening context',()=>{
  const quote="we've probably got about ten twelve thousand ... available right now.";
  assert.equal(canonicalizeTranscriptEvidence(['a','c'],quote,map,options).valid,false);
  const result=recoverTranscriptEvidence(['c','a'],quote,map,options);
  assert.equal(result.valid,true);
  assert.deepEqual(result.segmentIds,['a','b','c']);
  assert.match(result.quoteRaw,/Okay/);
});
test('recovery does not accept rewritten, ambiguous, or out-of-scope evidence',()=>{
  assert.equal(recoverTranscriptEvidence(['a','c'],'We have twenty thousand',map,options).valid,false);
  assert.equal(recoverTranscriptEvidence(['a','c'],'available right now',map,{...options,allowedSegmentIds:new Set(['a','c'])}).valid,false);
  const foreign=new Map(map);foreign.set('c',{...map.get('c'),eventId:'other'});
  assert.equal(recoverTranscriptEvidence(['a','c'],'available right now',foreign,options).valid,false);
  const distant=new Map(map);distant.set('c',{...map.get('c'),ordinal:200});
  assert.equal(recoverTranscriptEvidence(['a','c'],'available right now',distant,options).valid,false);
});
test('recovery keeps verbatim repetition strict',()=>{
 const repeated=new Map([['a',{...segments[0],textRaw:'nothing nothing older than that'}]]);
 assert.equal(recoverTranscriptEvidence(['a'],'nothing older than that',repeated,options).valid,true);
 assert.equal(recoverTranscriptEvidence(['a'],'built recently, nothing older than that',repeated,options).valid,false);
});
