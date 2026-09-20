import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEventSummaryProviderOutput, orderReadingViewSources } from '../lib/domain/event-ai-artifacts.ts';
const segments = [
  {id:'s1',assetVersionId:'a1',eventId:'e1',ordinal:0,speaker:'Buyer',textRaw:'I need four bedrooms.',startMs:0,endMs:1000},
  {id:'s2',assetVersionId:'a1',eventId:'e1',ordinal:1,speaker:'Agent',textRaw:'I will search for homes.',startMs:1000,endMs:2000},
  {id:'s3',assetVersionId:'a1',eventId:'e1',ordinal:2,speaker:'Buyer',textRaw:'The budget is provisional.',startMs:2000,endMs:3000},
];
const input = {eventId:'e1',segments};
const output = () => ({schema_version:'event-summary.v2',event_id:'e1',sections:[],
 key_points:[{question:'What does the buyer need?',answer:'The buyer wants four bedrooms; the budget remains provisional.',source_segment_ids:['s1','s3']}],
 speaker_summaries:[{speaker:'Buyer',asset_version_id:'a1',summary:'The buyer described their bedroom requirement and qualified the budget as provisional.',source_segment_ids:['s1','s3']}],
 chapters:[{title:'Housing needs',summary:'The buyer explains their requirements.',source_segment_ids:['s1']},{title:'Budget',summary:'The buyer qualifies the budget.',source_segment_ids:['s3']}],
});
test('reading views preserve generated synthesis and raw source lineage',()=>{
 const value=output(); const result=validateEventSummaryProviderOutput(value,input);
 assert.equal(result.valid,true,JSON.stringify(result.issues));
 assert.deepEqual(result.output.key_points,value.key_points);
 assert.deepEqual(result.output.speaker_summaries,value.speaker_summaries);
 assert.deepEqual(result.output.chapters,value.chapters);
});
for (const [name,change] of [
 ['another speaker citation',v=>v.speaker_summaries[0].source_segment_ids=['s2']],
 ['invented speaker',v=>v.speaker_summaries[0].speaker='Unknown buyer'],
 ['wrong source version',v=>v.speaker_summaries[0].asset_version_id='a2'],
 ['unknown keypoint source',v=>v.key_points[0].source_segment_ids=['missing']],
 ['unordered sources',v=>v.key_points[0].source_segment_ids=['s3','s1']],
 ['reversed chapters',v=>v.chapters.reverse()],
 ['duplicate speaker',v=>v.speaker_summaries.push({...v.speaker_summaries[0]})],
]) test(`rejects ${name}`,()=>{const value=output();change(value);assert.equal(validateEventSummaryProviderOutput(value,input).valid,false);});
test('legacy summaries remain readable without fabricating reading views',()=>{
 const result=validateEventSummaryProviderOutput({schema_version:'event-summary.v2',event_id:'e1',sections:[]},input);
 assert.equal(result.valid,true); assert.equal(result.output.speaker_summaries,undefined);
});

test('citation ordering changes only metadata and preserves all references and prose',()=>{
 const value=output(); value.speaker_summaries[0].source_segment_ids=['s3','s1'];
 const ordered=orderReadingViewSources(value,segments);
 assert.deepEqual(ordered.speaker_summaries[0].source_segment_ids,['s1','s3']);
 assert.equal(ordered.speaker_summaries[0].summary,value.speaker_summaries[0].summary);
 assert.deepEqual(value.speaker_summaries[0].source_segment_ids,['s3','s1']);
 assert.equal(validateEventSummaryProviderOutput(ordered,input).valid,true);
 value.speaker_summaries[0].source_segment_ids=['s1','s1'];
 assert.equal(validateEventSummaryProviderOutput(orderReadingViewSources(value,segments),input).valid,false);
});
