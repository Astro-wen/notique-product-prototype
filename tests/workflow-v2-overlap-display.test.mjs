import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRecordText,recordDisplayBullets} from '../lib/domain/workflow-v2.ts';

const ref=id=>({claimId:id,claimVersionId:`${id}_v1`});
const bullet=(id,origin,reviewState='draft')=>({id,text:id==='manual'?'向供应商询价并确认报价':'向供应商询价',claimRefs:[ref(id)],reviewState,origin,sourceStatus:'ready'});
const card=disposition=>({id:'overlap',disposition,actionOverlap:{manualRef:ref('manual'),modelRef:ref('model')}});

test('an undecided overlap has one reading entry while the accepted view retains the selected action',()=>{
  const manual=bullet('manual','user_input'),model=bullet('model','ai_suggestion');
  assert.deepEqual(recordDisplayBullets([manual,model],[card('active')]).map(b=>b.id),['manual']);
  assert.deepEqual(recordDisplayBullets([manual,model],[card('deferred')]).map(b=>b.id),['manual']);
  const acceptedModel={...model,reviewState:'accepted'};
  assert.deepEqual(recordDisplayBullets([manual,acceptedModel],[card('active')]).filter(b=>b.reviewState==='accepted').map(b=>b.id),['model']);
});

test('two independently adopted actions both remain visible after the group is processed',()=>{
  const bullets=[bullet('manual','user_input','accepted'),bullet('model','ai_suggestion','accepted')];
  assert.deepEqual(recordDisplayBullets(bullets,[card('processed')]).map(b=>b.id),['manual','model']);
});

test('copy retains both exact wordings and marks the human draft separately from the AI suggestion',()=>{
  const text=buildRecordText({title:'沟通记录',bullets:[bullet('manual','user_input'),bullet('model','ai_suggestion')],questions:[],coverage:{complete:true,totalSegments:1,completedSegments:1,unprocessedRanges:[]},scope:'mixed',format:'plain'});
  assert.match(text,/向供应商询价并确认报价 · 用户补充 · 待确认/);
  assert.match(text,/向供应商询价 · AI 草稿/);
});

test('copy groups exact versions by saved subject, keeps every wording and escapes topic headings',()=>{
 const bullets=[bullet('budget','user_input','accepted'),bullet('question','source_statement'),bullet('model','ai_suggestion')];
 bullets[0].text='用户预算约十二万，可能调整';bullets[1].text='是否含安装？';
 const narrative={freshness:'current',sentenceRefs:[{text:'unused model wording',topic:{key:'fees',title:'费用 [*]'},claimRefs:[ref('budget'),ref('question')]},{text:'unused',topic:{key:'task',title:'询价'},claimRefs:[ref('model')]}]};
 const input={title:'记录',bullets,questions:[],narrative,coverage:{complete:true,totalSegments:1,completedSegments:1,unprocessedRanges:[]},scope:'mixed',format:'plain_text'};
 const text=buildRecordText(input);
 assert.ok(text.indexOf('费用 [*]')<text.indexOf('用户预算'));assert.ok(text.indexOf('是否含安装')<text.indexOf('询价'));
 for(const b of bullets)assert.equal(text.split(b.text).length-1,1);
 assert.doesNotMatch(text,/unused model wording/);
 const markdown=buildRecordText({...input,format:'markdown'});assert.match(markdown,/## 费用 \\\[\\\*\\\]/);
 const accepted=buildRecordText({...input,scope:'accepted'});assert.match(accepted,/用户预算约十二万，可能调整/);assert.doesNotMatch(accepted,/是否含安装|AI 草稿|询价/);
 const stale=buildRecordText({...input,narrative:{...narrative,sentenceRefs:[{...narrative.sentenceRefs[0],claimRefs:[{claimId:'budget',claimVersionId:'old'}]}]}});
 assert.doesNotMatch(stale,/费用 \[\*\]/);assert.match(stale,/用户预算约十二万，可能调整/);
});
