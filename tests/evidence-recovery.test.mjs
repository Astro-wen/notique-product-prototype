import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

test("a garbled evidence version id is recovered from the cited sentences, never guessed", async () => {
  const { repairEvidenceAssetVersion } = await import("../lib/domain/evidence.ts");
  const real = "av_7605aa13666d4b89a713e7c0646785f0";
  const other = "av_other";
  const inputs = new Set([real, other]);
  const segmentVersion = new Map([["s1", real], ["s2", real], ["o1", other]]);
  // 2026-09-22 实测的抄错：版本 ID 前半段接上了记录 ID 的后半段。
  const garbled = "av_7605aa13666d4b89a06503f42b41d299";
  assert.equal(repairEvidenceAssetVersion({ kind: "transcript", asset_version_id: garbled, segment_ids: ["s1", "s2"] }, inputs, segmentVersion), real);
  // 本来就对的不动。
  assert.equal(repairEvidenceAssetVersion({ kind: "transcript", asset_version_id: real, segment_ids: ["s1"] }, inputs, segmentVersion), null);
  // 句子跨了两份材料、句子不存在、没有句子、不是逐字稿引文：都不猜，交给后面的校验拒掉。
  assert.equal(repairEvidenceAssetVersion({ kind: "transcript", asset_version_id: garbled, segment_ids: ["s1", "o1"] }, inputs, segmentVersion), null);
  assert.equal(repairEvidenceAssetVersion({ kind: "transcript", asset_version_id: garbled, segment_ids: ["nope"] }, inputs, segmentVersion), null);
  assert.equal(repairEvidenceAssetVersion({ kind: "transcript", asset_version_id: garbled, segment_ids: [] }, inputs, segmentVersion), null);
  assert.equal(repairEvidenceAssetVersion({ kind: "photo", asset_version_id: garbled, segment_ids: ["s1"] }, inputs, segmentVersion), null);
  // 句子属于一份不在本次输入里的材料，也不改。
  assert.equal(repairEvidenceAssetVersion({ kind: "transcript", asset_version_id: garbled, segment_ids: ["s1"] }, new Set([other]), segmentVersion), null);
});

test("the processor repairs the version before validating evidence and says so", async () => {
  const processor = await readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8");
  const prepare = processor.slice(processor.indexOf("function prepareEvidence("), processor.indexOf("if (item.kind === \"photo\")"));
  const repairAt = prepare.indexOf("repairEvidenceAssetVersion(original");
  const scopeCheckAt = prepare.indexOf("manifestById.get(item.asset_version_id)");
  assert.ok(repairAt > 0 && repairAt < scopeCheckAt, "先修版本再查范围");
  assert.match(prepare, /code: "EVIDENCE_VERSION_REPAIRED"/);
});
