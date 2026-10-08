import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {comparisonFacts,comparisonFor,keyInformation} from '../lib/domain/project-comparisons.ts';

const ref=id=>({claimId:id,claimVersionId:`${id}-v1`});
const bullet=(id,text)=>({id,text,claimRefs:[ref(id)]});
const entry=(id,before,after,proposalType='changed',category='金额')=>({id,before:before?{ref:ref(before)}:undefined,after:{ref:ref(after)},kind:'conflict',reviewState:'draft',proposalType,category});
test('comparison display groups versions while preserving exact-version matching and standalone facts',()=>{
 const facts=[bullet('old','预算15,000'),bullet('new','预算18,000'),bullet('other','其他内容')];
 const s={timeline:[entry('change','old','new')],openQuestions:[]};
 assert.deepEqual(comparisonFacts(s,facts).map(b=>b.id),['new','other']);
 assert.deepEqual(comparisonFacts(s,[facts[0],facts[2]]).map(b=>b.id),['old','other']);
 assert.equal(comparisonFor(s,[{claimId:'new',claimVersionId:'new-stale'}]),undefined);
 assert.equal(comparisonFor(s,[ref('old')],'before').id,'change');
 assert.equal(s.timeline[0].reviewState,'draft');
});
test('a proposed answer belongs with its open question without changing question state',()=>{
 const q={claimRef:ref('question')};
 const s={timeline:[entry('answer','question','answer','possibly_answered','待解答')],openQuestions:[q]};
 const facts=[bullet('answer','Covered space is available'),bullet('date','October 20')];
 assert.deepEqual(comparisonFacts(s,facts).map(b=>b.id),['date']);
 assert.equal(s.openQuestions.length,1);
 assert.deepEqual(comparisonFacts({...s,openQuestions:[]},facts),facts);
});
test('key information reserves money date and attendance slots, prioritizes total budget over fees',()=>{
 const facts=[bullet('fee','Insurance costs $500'),bullet('venue','Venue rental is $2,000'),bullet('budget','Total budget is $15,000'),bullet('date','October 18, 2026'),bullet('count','Plan for 30 participants')];
 const s={timeline:facts.map(b=>entry(b.id,null,b.id,undefined,b.id==='date'?'日期':b.id==='count'?'其他':'金额')),openQuestions:[]};
 const selected=keyInformation(s,facts);
 assert.deepEqual(selected.slice(0,3).map(i=>i.label),['总预算','日期与时间','人数']);
 assert.equal(selected.length,3);
 assert.equal(selected[0].bullet.text,'Total budget is $15,000');
});
test('datetime-local values round trip without timezone shifts',()=>{
 for(const TZ of ['America/Los_Angeles','Asia/Shanghai','UTC']) {
  const result=execFileSync(process.execPath,['--input-type=module','-e',`import {localDateInput} from './lib/domain/local-date-input.ts';const date=new Date(2026,9,7,23,45);const value=localDateInput(date);console.log(JSON.stringify([value,new Date(value).getTime()===date.getTime()]));`],{cwd:new URL('..',import.meta.url),env:{...process.env,TZ},encoding:'utf8'});
  assert.deepEqual(JSON.parse(result),['2026-10-07T23:45',true]);
 }
});

test('comparison prompt update preserves old run contracts',async()=>{
 const {inventoryContractForRun,verificationContractForRun}=await import('../lib/domain/two-stage-extraction.ts');
 const {isClaimExtractionPromptVersion,hasChronologicalExtraction,hasSourceChangeExtraction}=await import('../lib/domain/model-contract.ts');
 for(const prompt of ['claim-extraction-prompt.v9.15','claim-extraction-prompt.v9.16']) {
  assert.equal(isClaimExtractionPromptVersion(prompt),true);
  assert.equal(hasChronologicalExtraction(prompt),true);
  assert.equal(hasSourceChangeExtraction(prompt),true);
  assert.equal(inventoryContractForRun({inventory_prompt_version:prompt}).promptVersion,prompt);
  assert.equal(verificationContractForRun({verification_schema_version:'claim-verification.v7',verification_prompt_version:prompt}).promptVersion,prompt);
 }
});

test('a backfilled older conversation does not displace the chronologically later statement',()=>{
 const change=entry('change','later','older');
 change.before.eventId='late';change.after.eventId='early';
 const s={timeline:[change],openQuestions:[],recordSummaries:[{eventId:'late',title:'Later',occurredAt:'2026-10-02T12:00:00Z'},{eventId:'early',title:'Early',occurredAt:'2026-10-01T12:00:00Z'}]};
 assert.deepEqual(comparisonFacts(s,[bullet('later','18,000'),bullet('older','15,000')]).map(b=>b.id),['later']);
 assert.equal(comparisonFor(s,[ref('later')]).id,'change');
});
