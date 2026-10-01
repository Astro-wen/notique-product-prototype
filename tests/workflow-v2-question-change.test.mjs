import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readWorkspace,loadWorkflowLedger} from '../lib/server/workflow/snapshot-store.ts';
import {outcomeRelationIds} from '../lib/server/workflow/question-change.ts';
import {projectWorkspace} from '../lib/domain/workflow-projection.ts';
import {buildRecordText} from '../lib/domain/workflow-v2.ts';
const read=db=>readWorkspace(db,SCOPE,'e',{limit:50},T);
const send=(db,path,body,key=crypto.randomUUID())=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,key);
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
async function decide(db,id,operation,extra={},key=crypto.randomUUID()) {
  const s=await read(db),card=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===id)) ?? projectWorkspace(await loadWorkflowLedger(db,SCOPE,'p'),'e',T,'').reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===id));
  const body={expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation,members:[{...card.memberRefs.find(r=>r.claimId===id),operation,...extra}]};
  return {receipt:await send(db,`review-cards/${card.id}/decisions`,body,key),body,path:`review-cards/${card.id}/decisions`};
}
async function answer(db,text='安装费十二万元',mode){const s=await read(db),q=s.questions.find(q=>q.id==='question');return send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:q.revision,answerText:text,evidenceRefs:[],...(q.answerRefs.length?{answerDecision:{mode:mode??'coexist',priorAnswerRefs:q.answerRefs,...(mode==='replace'?{}:{applicability:'分别适用于一期和二期'})}}:{})});}
async function editQuestion(db,mode='keep',text='含税安装费用是多少？',key=crypto.randomUUID()) {const s=await read(db),q=s.questions.find(q=>q.id==='question');return decide(db,'question','edit',{newText:text,origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:q.answerRefs.map(r=>({...r,mode}))}},key);}
async function completeWithResult(db) {await decide(db,'action','accept_action');const s=await read(db);return send(db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,text:'已收到供应商含税报价',evidenceRefs:[],resolveQuestions:[{questionId:'question',revision:s.questions[0].revision,answerText:'安装费十二万元'}],completeAction:true});}
async function revert(db,id) {const s=await read(db);return send(db,`decisions/${id}/revert`,{expectedContextVersion:s.contextVersion,expectedDecisionRevision:s.recentDecisions.find(d=>d.id===id).revision});}

test('question wording can be corrected before answering and remains directly answerable',async t=>{
  const {db,sqlite}=await setup(t);await editQuestion(db);let s=await read(db);
  assert.equal(s.questions[0].resolutionState,'open');assert.notEqual(s.questions[0].claimRef.claimVersionId,'question_v1');
  assert.equal(s.bullets.find(b=>b.id==='question').text,'含税安装费用是多少？');
  await answer(db);s=await read(db);assert.equal(s.questions[0].resolutionState,'resolved');
  assert.equal(sqlite.prepare('SELECT statement FROM claim_versions WHERE id=?').get('question_v1').statement,'费用是多少？');
});

test('a disputed draft question stays in review and cannot reopen an answered topic before a decision', async t => {
  const { db, sqlite } = await setup(t);
  await answer(db);
  const original = (await read(db)).questions.find(q => q.id === 'question');
  const answerRef = original.answerRefs[0];
  claim(sqlite, 'disputed-question', 'open_question', '费用是否仍未确认？');
  sqlite.prepare("INSERT INTO claim_relations(id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status) VALUES ('disputed-answer','ws','p','contradicts','disputed-question_v1',?,0,'proposed')").run(answerRef.claimVersionId);
  let snapshot = await read(db);
  assert.equal(snapshot.questions.some(q => q.id === 'disputed-question'), false);
  assert.equal(snapshot.questions.find(q => q.id === 'question').resolutionState, 'resolved');
  assert.ok(snapshot.bullets.some(b => b.id === 'disputed-question' && b.reviewState === 'draft'));
  const card = snapshot.reviewCards.find(c => c.memberRefs.some(r => r.claimId === 'disputed-question'));
  assert.equal(card.kind, 'conflict');
  assert.equal(card.needsDecision, true);
  const count = sqlite.prepare('SELECT count(*) AS n FROM workflow_decisions').get().n;
  await assert.rejects(send(db, 'questions/disputed-question/answers', {
    expectedContextVersion: snapshot.contextVersion, expectedQuestionRevision: 1,
    answerText: '尚未确认', evidenceRefs: [],
  }), e => e.code === 'dependency_conflict');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workflow_decisions').get().n, count);
  for (const mode of ['use_candidate', 'coexist']) await assert.rejects(
    decide(db, 'disputed-question', 'resolve_conflict', { conflictChoice: {
      mode, existingRef: answerRef, candidateRef: { claimId: 'disputed-question', claimVersionId: 'disputed-question_v1' },
      ...(mode === 'coexist' ? { applicability: '重新核实费用' } : {}),
    } }), e => e.code === 'dependency_conflict',
  );
  const saved = await decide(db, 'disputed-question', 'resolve_conflict', { conflictChoice: {
    mode: 'keep_existing', existingRef: answerRef, candidateRef: { claimId: 'disputed-question', claimVersionId: 'disputed-question_v1' },
  } });
  snapshot = await read(db);
  assert.equal(snapshot.questions.some(q => q.id === 'disputed-question'), false);
  assert.equal(snapshot.questions.find(q => q.id === 'question').resolutionState, 'resolved');
  assert.deepEqual(snapshot.questions.find(q => q.id === 'question').answerRefs, original.answerRefs);
  await revert(db, saved.receipt.mutationId);
  snapshot = await read(db);
  assert.equal(snapshot.reviewCards.find(c => c.id === card.id).kind, 'conflict');
  assert.equal(snapshot.questions.some(q => q.id === 'disputed-question'), false);
  assert.equal(snapshot.questions.find(q => q.id === 'question').resolutionState, 'resolved');
});
test('retaining an answer preserves completion, freezes old basis and follows the stable question identity',async t=>{
  const {db,sqlite}=await setup(t);await completeWithResult(db);const original=(await read(db)).questions[0].answerRefs;
  const saved=await editQuestion(db,'keep','含税安装费用是多少？','question-edit');
  assert.deepEqual(await send(db,saved.path,saved.body,'question-edit'),saved.receipt);
  const s=await read(db),q=s.questions[0],a=s.actions[0];
  assert.deepEqual(q.answerRefs,original);assert.equal(q.resolutionState,'resolved');assert.equal(a.executionState,'completed');assert.equal(a.basisState,'needs_review');
  assert.equal(a.questionRefs[0].claimVersionId,q.claimRef.claimVersionId);assert.equal(a.latestOutcome.freshness,'current');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM claim_relations WHERE target_claim_version_id='question_v1' AND type='resolves' AND status='active'").get().n,0);
  assert.match(sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json,/question_v1/);
  await decide(db,'action','accept_action');assert.equal((await read(db)).actions[0].basisState,'current');assert.equal((await read(db)).actions[0].executionState,'completed');
});
test('reopening answers removes unshared answers from copied/current record and keeps action completion',async t=>{
  const {db,sqlite}=await setup(t);await completeWithResult(db);const old=(await read(db)).questions[0].answerRefs[0];await editQuestion(db,'reopen');const s=await read(db);
  assert.equal(s.questions[0].resolutionState,'open');assert.deepEqual(s.questions[0].answerRefs,[]);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.actions[0].latestOutcome.freshness,'stale');
  assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(old.claimId).lifecycle_status,'withdrawn');
  const text=buildRecordText({...s,title:'记录',scope:'mixed'});assert.doesNotMatch(text,/安装费十二万元/);assert.match(text,/含税安装费用是多少/);
  await answer(db,'新的费用十三万元');assert.equal((await read(db)).questions[0].resolutionState,'resolved');
});
test('shared answers remain available for another question and are not withdrawn',async t=>{
  const {db,sqlite}=await setup(t);await answer(db);const a=(await read(db)).questions[0].answerRefs[0];claim(sqlite,'other-question','open_question','第一期费用？');
  insert(sqlite,'claim_relations',{id:'shared',workspace_id:'ws',project_id:'p',type:'resolves',source_claim_version_id:a.claimVersionId,target_claim_version_id:'other-question_v1',context_version:1,status:'active'});
  await editQuestion(db,'reopen');const s=await read(db);assert.equal(s.questions.find(q=>q.id==='question').resolutionState,'open');assert.deepEqual(s.questions.find(q=>q.id==='other-question').answerRefs,[a]);
  assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(a.claimId).lifecycle_status,'active');assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='shared'").get().status,'active');
});
test('each coexisting answer has an explicit choice and keeps its applicability through a correction',async t=>{
  const {db}=await setup(t);await answer(db);await answer(db,'二期安装费十四万元');const s=await read(db),q=s.questions[0];
  await decide(db,'question','edit',{newText:'分期含税费用？',origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:q.answerRefs.map((r,i)=>({...r,mode:i?'reopen':'keep'}))}});
  const next=await read(db);assert.equal(next.questions[0].answerRefs.length,1);assert.equal(next.questions[0].resolutionState,'resolved');
  assert.equal(next.bullets.some(b=>b.id===q.answerRefs[1].claimId),false);
});
test('question edit can be undone with every answer link and withdrawn answer restored',async t=>{
  const {db,sqlite}=await setup(t);await answer(db);await answer(db,'二期安装费十四万元');const before=await read(db);const saved=await editQuestion(db,'reopen');
  await revert(db,saved.receipt.mutationId);const after=await read(db);assert.equal(after.questions[0].claimRef.claimVersionId,'question_v1');assert.deepEqual(after.questions[0].answerRefs,before.questions[0].answerRefs);
  assert.equal(after.questions[0].resolutionState,'resolved');for(const ref of before.questions[0].answerRefs)assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(ref.claimId).lifecycle_status,'active');
});
test('outcome withdrawal follows repeated retained-answer corrections without touching independent shared links',async t=>{
  const {db,sqlite}=await setup(t);await completeWithResult(db);let s=await read(db);const outcome=s.actions[0].latestOutcome,a=s.questions[0].answerRefs[0];
  claim(sqlite,'other-question','open_question','第一期费用？');insert(sqlite,'claim_relations',{id:'shared',workspace_id:'ws',project_id:'p',type:'resolves',source_claim_version_id:a.claimVersionId,target_claim_version_id:'other-question_v1',context_version:1,status:'active'});
  await editQuestion(db);await editQuestion(db,'keep','最终含税费用是多少？');s=await read(db);
  await send(db,`outcomes/${outcome.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:outcome.revision,operation:'withdraw'});
  s=await read(db);assert.equal(s.questions.find(q=>q.id==='question').resolutionState,'open');assert.equal(s.questions.find(q=>q.id==='other-question').resolutionState,'resolved');assert.equal(s.actions[0].executionState,'completed');
  assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='shared'").get().status,'active');assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM claim_relations r JOIN claim_versions v ON v.id=r.target_claim_version_id WHERE v.claim_id=? AND r.type=? AND r.status=?').get('question','resolves','active').n,0);
});
test('result replacement after a retained-answer correction updates the latest question',async t=>{
  const {db}=await setup(t);await completeWithResult(db);await editQuestion(db);let s=await read(db),q=s.questions[0],o=s.actions[0].latestOutcome;
  await send(db,`outcomes/${o.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:o.revision,operation:'replace',replacement:{text:'报价修正为十三万元',evidenceRefs:[],resolveQuestions:[{questionId:q.id,revision:q.revision,answerText:'十三万元'}]}});
  s=await read(db);assert.equal(s.questions[0].answerRefs.length,1);assert.equal(s.bullets.find(b=>b.id===s.questions[0].answerRefs[0].claimId).text,'十三万元');assert.equal(s.actions[0].executionState,'completed');
});
test('missing, stale or injected answer choices reject the edit before any writes',async t=>{
  const {db,sqlite}=await setup(t);await answer(db);const base=sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n;
  for(const extra of [{},{questionChange:{answerChoices:[]}},{questionChange:{answerChoices:[{claimId:'budget',claimVersionId:'budget_v1',mode:'keep'}]}}])await assert.rejects(decide(db,'question','edit',{newText:'新问题',origin:'user_input',evidenceRefIds:[],...extra}),e=>e.code==='dependency_conflict');
  await assert.rejects(decide(db,'budget','edit',{newText:'新预算',origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:[]}}),e=>e.code==='dependency_conflict');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,base);assert.equal(sqlite.prepare("SELECT current_version_id FROM claims WHERE id='question'").get().current_version_id,'question_v1');
});
test('a late answer relation or evidence change rolls back the entire question correction',async t=>{
  for(const kind of ['link','source']) {const {db,sqlite}=await setup(t);await answer(db);const batch=db.batch;
    db.batch=async statements=>{if(kind==='link')relation(sqlite,'late-answer','budget','question','resolves');else sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();return batch(statements);};
    const origin=kind==='source'?{origin:'source_statement',evidenceRefIds:['question_ev']}:{};
    await assert.rejects(decide(db,'question','edit',{newText:'新问题',origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:(await read(db)).questions[0].answerRefs.map(r=>({...r,mode:'keep'}))},...origin}),e=>e.code==='version_conflict');
    assert.equal(sqlite.prepare("SELECT current_version_id FROM claims WHERE id='question'").get().current_version_id,'question_v1');
  }
});
test('later answers or an action basis acceptance prevent an unsafe undo',async t=>{
  for(const kind of ['answer','basis']) {const {db}=await setup(t);await completeWithResult(db);const saved=await editQuestion(db);
    if(kind==='answer')await answer(db,'新费用十五万元','replace');else await decide(db,'action','accept_action');
    await assert.rejects(revert(db,saved.receipt.mutationId),e=>e.code==='dependency_conflict');
  }
});
test('outcome lineage ignores malformed metadata and links for another question',async t=>{
  const {db,sqlite}=await setup(t);await answer(db);const ledger=await loadWorkflowLedger(db,SCOPE,'p'),root=ledger.relations.find(r=>r.type==='resolves');
  const fake={...root,id:'fake',target_claim_id:'other-question',reason:JSON.stringify({questionEdit:{predecessorRelationId:root.id}})};
  assert.deepEqual(outcomeRelationIds({...ledger,relations:[...ledger.relations,fake]},[root.id]),[root.id]);
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('a large retained-answer set and its reversal stay within D1 binding limits',async t=>{
  const {db,sqlite}=await setup(t);
  for(let i=0;i<30;i++) {const id=`answer-${i}`;claim(sqlite,id,'other',`第${i+1}期费用`,{status:'verified'});relation(sqlite,`answer-link-${i}`,id,'question','resolves');}
  const batch=db.batch;db.batch=async statements=>{assert.ok(statements.every(s=>s.values.length<=100));return batch(statements);};
  const saved=await editQuestion(db);assert.equal((await read(db)).questions[0].answerRefs.length,30);
  await revert(db,saved.receipt.mutationId);assert.equal((await read(db)).questions[0].answerRefs.length,30);
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
});

for(const keep of [false,true])test(`group question correction accounts for shared answers across the entire transaction, keep=${keep}`,async t=>{
  const {db,sqlite}=await setup(t);await answer(db);const a=(await read(db)).questions[0].answerRefs[0];claim(sqlite,'second-question','open_question','二期费用？');
  insert(sqlite,'claim_relations',{id:'second-link',workspace_id:'ws',project_id:'p',type:'resolves',source_claim_version_id:a.claimVersionId,target_claim_version_id:'second-question_v1',context_version:1,status:'active'});
  insert(sqlite,'workflow_cards',{id:'questions',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'questions',revision:1,kind:'question',title:'分期费用',needs_decision:0,reason:'',disposition:'active'});
  for(const id of ['question','second-question'])insert(sqlite,'card_members',{id:`member-${id}`,workspace_id:'ws',card_id:'questions',claim_id:id,claim_version_id:`${id}_v1`,role:'primary'});
  const s=await read(db),card=s.reviewCards.find(c=>c.id==='questions');
  const r=await send(db,'review-cards/questions/decisions',{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'review_members',members:card.memberRefs.map((ref,i)=>({...ref,operation:'edit',newText:`第${i+1}期含税费用？`,origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:[{...a,mode:keep&&i===1?'keep':'reopen'}]}}))});
  const next=await read(db);assert.equal(next.questions.filter(q=>q.resolutionState==='resolved').length,keep?1:0);assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(a.claimId).lifecycle_status,keep?'active':'withdrawn');
  await revert(db,r.mutationId);assert.equal((await read(db)).questions.filter(q=>q.resolutionState==='resolved').length,2);assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(a.claimId).lifecycle_status,'active');
});

test('joined reference text cannot substitute for two explicit answer choices',async t=>{
  const {db}=await setup(t);await answer(db);await answer(db,'二期报价');const q=(await read(db)).questions[0];const [a,b]=q.answerRefs;
  await assert.rejects(decide(db,'question','edit',{newText:'含税费用？',origin:'user_input',evidenceRefIds:[],questionChange:{answerChoices:[{claimId:a.claimId,claimVersionId:`${a.claimVersionId}|${b.claimId}:${b.claimVersionId}`,mode:'keep'}]}}),e=>e.code==='dependency_conflict');
  const ledger=await loadWorkflowLedger(db,SCOPE,'p'),root=ledger.relations.find(r=>r.type==='resolves');assert.deepEqual(outcomeRelationIds({...ledger,relations:[...ledger.relations,{...root,id:'null-metadata',reason:'null'}]},[root.id]),[root.id]);
});

test('one hundred answers reopened together keep invalidation and reversal within D1 limits',async t=>{
  const {db,sqlite}=await setup(t);
  for(let i=0;i<100;i++) {const id=`answer-${i}`;claim(sqlite,id,'other',`第${i+1}期费用`,{status:'verified'});relation(sqlite,`answer-link-${i}`,id,'question','resolves');}
  const batch=db.batch;db.batch=async statements=>{for(const s of statements)assert.ok(s.values.length<=100,`${s.values.length} bindings: ${s.sql}`);return batch(statements);};
  const saved=await editQuestion(db,'reopen');assert.equal((await read(db)).questions[0].answerRefs.length,0);assert.equal(sqlite.prepare("SELECT count(*) n FROM claims WHERE id LIKE 'answer-%' AND lifecycle_status='withdrawn'").get().n,100);
  await revert(db,saved.receipt.mutationId);assert.equal((await read(db)).questions[0].answerRefs.length,100);assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('undoing a question correction restores its original completed action basis and accepted answers',async t=>{
  const {db}=await setup(t);await completeWithResult(db);const before=await read(db),saved=await editQuestion(db,'reopen');
  await revert(db,saved.receipt.mutationId);const s=await read(db);
  assert.equal(s.actions[0].basisState,'current');assert.equal(s.actions[0].executionState,'completed');
  assert.deepEqual(s.questions[0].answerRefs,before.questions[0].answerRefs);
  assert.equal(s.questions[0].resolutionState,'resolved');
});
