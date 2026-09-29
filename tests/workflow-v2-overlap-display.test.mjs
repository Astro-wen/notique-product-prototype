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
