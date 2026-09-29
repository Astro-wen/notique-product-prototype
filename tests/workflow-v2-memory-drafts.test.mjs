import assert from 'node:assert/strict';
import test from 'node:test';
import {MemoryDraftSession,ownDraftText} from '../app/features/workflow/services/memory-drafts.ts';
const owner={workspaceId:'ws',actorId:'one',eventId:'event'};
const inline={kind:'inline',targetId:'card',claimId:'budget',mode:'edit',origin:'user_input',value:'我的未保存输入'};
const bind=()=>{const session=new MemoryDraftSession();session.bind(owner);return {session,editor:session.bindEditor(owner)};};

test('suspension retains own text and fences both late checkpoint updates and late clearing',()=>{
  const {session,editor}=bind();editor.put(inline);const epoch=session.epoch;session.suspend();
  editor.put({...inline,value:'迟到内容'});editor.clear();assert.equal(session.isCurrent(epoch),false);
  assert.equal(session.read('inline').value,'我的未保存输入');assert.equal(session.read('inline').needsReview,true);
  session.bind(owner);const recovered=session.bindEditor(owner);assert.equal(recovered.restored('inline').value,'我的未保存输入');
  assert.equal(editor.restored('inline'),undefined);editor.put({...inline,value:'旧编辑器又写入'});assert.equal(session.read('inline').value,'我的未保存输入');
  recovered.clear('inline');assert.equal(session.getSnapshot().length,0);
});

test('actor, workspace and record changes destroy previous input and reject old editor writes',()=>{
  for(const next of [{...owner,actorId:'two'},{...owner,workspaceId:'other'},{...owner,eventId:'other'}]) {
    const {session,editor}=bind();editor.put(inline);session.suspend();session.bind(next);editor.put(inline);editor.clear();
    assert.equal(session.getSnapshot().length,0);assert.equal(session.bindEditor(next).restored('inline'),undefined);
  }
});

test('checkpoint allowlists drop snapshots, quotes, cached source statements and arbitrary nested properties',()=>{
  const {session,editor}=bind();
  editor.put({...inline,quote:'原文',snapshot:{bullets:[{text:'受保护内容'}]},error:'服务器正文'});
  assert.deepEqual(ownDraftText(session.read('inline')),[{label:'修改重点',text:'我的未保存输入'}]);assert.doesNotMatch(JSON.stringify(session.getSnapshot()),/受保护内容|原文|服务器正文/);
  editor.put({kind:'members',targetId:'card',choices:{one:{operation:'confirm',claimVersionId:'v1',origin:'source_statement',statement:'旧的原文'},two:{operation:'edit',claimVersionId:'v2',origin:'user_input',text:'用户修改',snapshot:'秘密'}}});
  assert.deepEqual(ownDraftText(session.read('members')),[{label:'修改重点',text:'用户修改'}]);assert.doesNotMatch(JSON.stringify(session.getSnapshot()),/旧的原文|秘密/);
});

test('outcome recovery contains touched answers and own conditions rather than a full saved result',()=>{
  const {session,editor}=bind();
  editor.put({kind:'outcome',targetId:'action',targetKind:'action',correctionId:'old-outcome',answers:{q:'用户的新答案'},choices:{q:{mode:'coexist',applicability:'用于加急',priorAnswerRefs:[{claimId:'answer',claimVersionId:'av',statement:'旧答案'}]}},complete:true,correction:{text:'上次结果正文'}});
  assert.deepEqual(ownDraftText(session.read('outcome')),[{label:'问题答案',text:'用户的新答案'},{label:'适用情况',text:'用于加急'}]);
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()),/上次结果正文|旧答案/);
});

test('original source selection preserves immutable locations and never the selected quote',()=>{
  const {session,editor}=bind();editor.put({kind:'highlight',targetId:'selection',assetVersionId:'av',ranges:[{segmentId:'s',startOffset:2,endOffset:7,quote:'原文全文'}],quote:'原文全文'});
  session.suspend();assert.deepEqual(ownDraftText(session.read('highlight')),[]);
  assert.deepEqual(session.read('highlight').ranges,[{segmentId:'s',startOffset:2,endOffset:7}]);assert.doesNotMatch(JSON.stringify(session.getSnapshot()),/原文全文/);
});

test('changing the caller object after checkpointing cannot overwrite retained input',()=>{
  const {session,editor}=bind(),input={kind:'members',targetId:'card',choices:{one:{operation:'edit',claimVersionId:'v',origin:'user_input',text:'我的文字'}}};
  editor.put(input);input.choices.one.text='后来篡改';session.suspend();assert.equal(session.read('members').choices.one.text,'我的文字');
  session.discard();assert.deepEqual(session.getSnapshot(),[]);assert.equal(session.isCurrent(session.epoch),false);
});

test('question recovery retains only the user edit and exact answer choices',()=>{
  const s=new MemoryDraftSession();const owner={workspaceId:'w',actorId:'a',eventId:'e'};s.bind(owner);
  s.put({kind:'question',targetId:'q',text:'我的新问题',origin:'user_input',choices:{answer:{claimVersionId:'answer-v1',mode:'keep',statement:'private old answer'}},original:'private question',snapshot:{secret:true}});
  s.suspend();const draft=s.restored('question');assert.equal(draft.text,'我的新问题');assert.deepEqual(draft.choices,{answer:{claimVersionId:'answer-v1',mode:'keep'}});assert.equal(JSON.stringify(draft).includes('private'),false);
  assert.deepEqual(ownDraftText(draft),[{label:'修改问题',text:'我的新问题'}]);
});

test('fact correction recovery retains exact user choices and excludes question text for single and grouped edits',()=>{
 const {session,editor}=bind();const choices={q:{claimVersionId:'q-v1',mode:'reopen',text:'private question',snapshot:{secret:true}}};
 editor.put({kind:'inline',targetId:'card',mode:'edit',claimId:'fact',value:'我的修正',origin:'user_input',questionChoices:choices});
 editor.put({kind:'members',targetId:'group',choices:{fact:{operation:'edit',claimVersionId:'fact-v1',origin:'user_input',text:'我的修正',questionChoices:choices}}});choices.q.mode='keep';session.suspend();assert.deepEqual(session.read('inline').questionChoices,{q:{claimVersionId:'q-v1',mode:'reopen'}});assert.deepEqual(session.read('members').choices.fact.questionChoices,{q:{claimVersionId:'q-v1',mode:'reopen'}});assert.doesNotMatch(JSON.stringify(session.getSnapshot()),/private|secret/);
});
