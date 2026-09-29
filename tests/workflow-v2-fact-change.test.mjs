import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';

const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,path,body,key=crypto.randomUUID())=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,key);
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
async function decide(db,id,operation,extra={}){const s=await read(db),card=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===id));return send(db,`review-cards/${card.id}/decisions`,{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation,members:[{...card.memberRefs.find(r=>r.claimId===id),operation,...extra}]});}
const edit=(db,id,choices=[],text='修正后的预算三十六万元')=>decide(db,id,'edit',{newText:text,origin:'user_input',evidenceRefIds:[],factChange:{questionChoices:choices}});
async function conflict(db,sqlite,mode){sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();claim(sqlite,'new-budget','budget','预算三十五万元');relation(sqlite,'conflict','new-budget','budget','contradicts','proposed');return decide(db,'new-budget','resolve_conflict',{conflictChoice:{mode,existingRef:{claimId:'budget',claimVersionId:'budget_v1'},candidateRef:{claimId:'new-budget',claimVersionId:'new-budget_v1'},...(mode==='coexist'?{applicability:'一期三十万，二期三十五万'}:{})}});}
async function undo(db,id){const s=await read(db),d=s.recentDecisions.find(d=>d.id===id);return send(db,`decisions/${id}/revert`,{expectedContextVersion:s.contextVersion,expectedDecisionRevision:d.revision});}

test('an accepted replacement can be corrected again without reviving its predecessor',async t=>{
 const {db,sqlite}=await setup(t);await conflict(db,sqlite,'use_candidate');const saved=await edit(db,'new-budget');let s=await read(db);
 assert.equal(s.bullets.find(b=>b.id==='new-budget').text,'修正后的预算三十六万元');assert.equal(s.bullets.some(b=>b.id==='budget'),false);
 assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='conflict'").get().status,'inactive');
 await undo(db,saved.mutationId);s=await read(db);assert.equal(s.bullets.find(b=>b.id==='new-budget').text,'预算三十五万元');assert.equal(s.bullets.some(b=>b.id==='budget'),false);assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='conflict'").get().status,'active');
});
for(const id of ['budget','new-budget'])test(`correcting the ${id} side preserves explicit coexistence and undo`,async t=>{
 const {db,sqlite}=await setup(t);await conflict(db,sqlite,'coexist');const saved=await edit(db,id);let s=await read(db);assert.equal(s.bullets.filter(b=>b.applicability).length,2);assert.match(s.bullets.find(b=>b.id===id).applicability,/一期/);await undo(db,saved.mutationId);s=await read(db);assert.equal(s.bullets.filter(b=>b.applicability).length,2);
});
for(const mode of ['keep','reopen'])test(`a fact edit explicitly ${mode}s its answer and undo restores the original link`,async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'answer','budget','question','resolves');const initial=await read(db);const m=initial.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId==='budget')).members[0];assert.equal(m.answerTargets[0].text,'费用是多少？');
 const saved=await edit(db,'budget',[{claimId:'question',claimVersionId:'question_v1',mode}]);let s=await read(db);assert.equal(s.questions[0].resolutionState,mode==='keep'?'resolved':'open');if(mode==='keep')assert.notEqual(s.questions[0].answerRefs[0].claimVersionId,'budget_v1');
 await undo(db,saved.mutationId);s=await read(db);assert.deepEqual(s.questions[0].answerRefs,[{claimId:'budget',claimVersionId:'budget_v1'}]);assert.equal(s.bullets.find(b=>b.id==='budget').text,'预算大约三十万');
});
test('missing, forged and obsolete question choices leave the accepted fact unchanged',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'answer','budget','question','resolves');
 for(const choices of [[],[{claimId:'question',claimVersionId:'wrong',mode:'keep'}],[{claimId:'action',claimVersionId:'action_v1',mode:'keep'}]])await assert.rejects(edit(db,'budget',choices),e=>e.code==='dependency_conflict');
 assert.equal(sqlite.prepare("SELECT current_version_id FROM claims WHERE id='budget'").get().current_version_id,'budget_v1');
});
test('an edited original basis stays frozen until the completed action is explicitly reviewed',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'budget-basis','action','budget','informed_by','proposed');await decide(db,'action','accept_action');let s=await read(db);await send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation:'complete'});
 await conflict(db,sqlite,'use_candidate');await edit(db,'new-budget');s=await read(db);assert.equal(s.actions[0].basisState,'needs_review');assert.equal(s.actions[0].executionState,'completed');const basis=s.actions[0].basisDetails.find(b=>b.acceptedRef.claimId==='budget');assert.equal(basis.currentText,'修正后的预算三十六万元');assert.equal(basis.acceptedText,'预算大约三十万');
 await decide(db,'action','accept_action');s=await read(db);assert.equal(s.actions[0].basisState,'current');assert.equal(s.actions[0].executionState,'completed');
});
test('a shared answer can reopen one question while retaining another across records',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');claim(sqlite,'other-question','open_question','二期费用？');insert(sqlite,'events',{id:'second-event',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'第二次沟通',occurred_at:T,sequence_no:2});sqlite.prepare("UPDATE claims SET event_id='second-event',source='human' WHERE id='other-question'").run();relation(sqlite,'first-answer','budget','question','resolves');relation(sqlite,'second-answer','budget','other-question','resolves');
 const saved=await edit(db,'budget',[{claimId:'question',claimVersionId:'question_v1',mode:'reopen'},{claimId:'other-question',claimVersionId:'other-question_v1',mode:'keep'}]);let s=await read(db);assert.equal(s.questions[0].resolutionState,'open');const second=await readWorkspace(db,SCOPE,'second-event',{},T);assert.equal(second.questions[0].resolutionState,'resolved');assert.equal(second.bullets.find(b=>b.id==='budget').text,'修正后的预算三十六万元');await undo(db,saved.mutationId);s=await read(db);assert.equal(s.questions[0].resolutionState,'resolved');
});
test('a relation added by an older writer during commit rolls back all correction rows',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');const batch=db.batch;db.batch=async statements=>{relation(sqlite,'late-answer','budget','question','resolves');return batch(statements);};await assert.rejects(edit(db,'budget'),e=>e.code==='version_conflict');assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM claim_versions WHERE claim_id='budget'").get().n,1);
});
test('a corrected outcome answer retains its withdrawal route and lineage',async t=>{
 const {db,sqlite}=await setup(t);let s=await read(db);const result=await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'费用十二万元',evidenceRefs:[]});s=await read(db);const answer=s.questions[0].answerRefs[0],outcome=s.questions[0].latestOutcome;
 await edit(db,answer.claimId,[{claimId:'question',claimVersionId:'question_v1',mode:'keep'}],'费用十三万元');s=await read(db);assert.equal(s.questions[0].latestOutcome.id,outcome.id);assert.equal(s.questions[0].latestOutcome.freshness,'stale');await send(db,`outcomes/${outcome.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:outcome.revision,operation:'withdraw'});s=await read(db);assert.equal(s.questions[0].resolutionState,'open');assert.equal(s.bullets.some(b=>b.id===answer.claimId),false);assert.equal(sqlite.prepare('SELECT lifecycle_status FROM claims WHERE id=?').get(answer.claimId).lifecycle_status,'withdrawn');assert.ok(result.mutationId);
});

test('two coexisting facts in one correction share one relation migration and one reversible decision',async t=>{
 const {db,sqlite}=await setup(t);await conflict(db,sqlite,'coexist');const s=await read(db),ids=['budget','new-budget'];insert(sqlite,'workflow_cards',{id:'group',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'group',revision:1,kind:'record',title:'分期预算',needs_decision:0,reason:'',disposition:'processed',created_at:T,updated_at:T});
 for(const id of ids)insert(sqlite,'card_members',{id:`group-${id}`,workspace_id:'ws',card_id:'group',claim_id:id,claim_version_id:`${id}_v1`,role:'primary',created_at:T});
 const saved=await send(db,'review-cards/group/decisions',{expectedContextVersion:s.contextVersion,expectedCardRevision:1,operation:'review_members',members:ids.map((id,i)=>({claimId:id,claimVersionId:`${id}_v1`,operation:'edit',newText:`第${i+1}期修正预算`,origin:'user_input',evidenceRefIds:[]}))});let current=await read(db);assert.equal(current.bullets.filter(b=>b.applicability).length,2);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM claim_relations WHERE type='contradicts' AND status='active'").get().n,1);await undo(db,saved.mutationId);current=await read(db);assert.equal(current.bullets.find(b=>b.id==='budget').text,'预算大约三十万');assert.equal(current.bullets.find(b=>b.id==='new-budget').text,'预算三十五万元');
});
test('two answer edits together recompute their shared question only once and undo both',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');claim(sqlite,'second-answer','other','二期费用二十万元',{status:'verified'});relation(sqlite,'answer-one','budget','question','resolves');relation(sqlite,'answer-two','second-answer','question','resolves');insert(sqlite,'workflow_cards',{id:'group',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'group',revision:1,kind:'record',title:'分期预算',needs_decision:0,reason:'',disposition:'processed',created_at:T,updated_at:T});
 for(const id of ['budget','second-answer'])insert(sqlite,'card_members',{id:`group-${id}`,workspace_id:'ws',card_id:'group',claim_id:id,claim_version_id:`${id}_v1`,role:'primary',created_at:T});const s=await read(db),q=s.questions[0];
 const saved=await send(db,'review-cards/group/decisions',{expectedContextVersion:s.contextVersion,expectedCardRevision:1,operation:'review_members',members:['budget','second-answer'].map((id,i)=>({claimId:id,claimVersionId:`${id}_v1`,operation:'edit',newText:`第${i+1}期预算修改`,origin:'user_input',evidenceRefIds:[],factChange:{questionChoices:[{...q.claimRef,mode:i?'keep':'reopen'}]}}))});let current=await read(db);assert.equal(current.questions[0].revision,q.revision+1);assert.deepEqual(current.questions[0].answerRefs.map(r=>r.claimId),['second-answer']);await undo(db,saved.mutationId);current=await read(db);assert.equal(current.questions[0].answerRefs.length,2);
});

test('undoing one coexisting answer correction preserves the other pre-existing answer',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'prior-answer','budget','question','resolves');await conflict(db,sqlite,'coexist');const saved=await edit(db,'new-budget',[{claimId:'question',claimVersionId:'question_v1',mode:'reopen'}]);await undo(db,saved.mutationId);assert.equal((await read(db)).questions[0].answerRefs.length,2);
});

test('a newly added answer dependency still blocks undo even though older answers are preserved',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'prior-answer','budget','question','resolves');await conflict(db,sqlite,'coexist');const saved=await edit(db,'new-budget',[{claimId:'question',claimVersionId:'question_v1',mode:'reopen'}]);claim(sqlite,'later-answer','other','后来的独立答案',{status:'verified'});relation(sqlite,'later-answer-link','later-answer','question','resolves');await assert.rejects(undo(db,saved.mutationId),e=>e.code==='dependency_conflict' && e.details.affectedItems.some(x=>x.claimId==='later-answer'));
});
test('a preserved answer changed by an older writer during undo is caught atomically',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'prior-answer','budget','question','resolves');await conflict(db,sqlite,'coexist');const saved=await edit(db,'new-budget',[{claimId:'question',claimVersionId:'question_v1',mode:'reopen'}]);const batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE claim_relations SET reason='later decision' WHERE id='prior-answer'").run();return batch(statements);};await assert.rejects(undo(db,saved.mutationId),e=>e.code==='version_conflict');assert.equal((await read(db)).bullets.find(b=>b.id==='new-budget').text,'修正后的预算三十六万元');
});

test('an older writer leaving support for a historical question cannot block correction or revive it',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');relation(sqlite,'historical-answer','budget','question','resolves');insert(sqlite,'claim_versions',{id:'question_v2',claim_id:'question',version_no:2,statement:'运输费是多少？',source:'human',workflow_origin:'user_input'});sqlite.prepare("UPDATE claims SET current_version_id='question_v2' WHERE id='question'").run();await edit(db,'budget');assert.equal((await read(db)).questions[0].resolutionState,'open');assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='historical-answer'").get().status,'inactive');
});

test('an answer correction keeps a current question even when an older writer also left a historical question link',async t=>{
 const {db,sqlite}=await setup(t);await decide(db,'budget','confirm');claim(sqlite,'old-question','open_question','旧问题？');
 relation(sqlite,'current-answer','budget','question','resolves');relation(sqlite,'historical-answer','budget','old-question','resolves');
 insert(sqlite,'claim_versions',{id:'old-question_v2',claim_id:'old-question',version_no:2,statement:'新的问题？',source:'human',workflow_origin:'user_input'});
 sqlite.prepare("UPDATE claims SET current_version_id='old-question_v2' WHERE id='old-question'").run();
 const saved=await edit(db,'budget',[{claimId:'question',claimVersionId:'question_v1',mode:'keep'}]);let s=await read(db);
 assert.equal(s.questions.find(q=>q.id==='question').resolutionState,'resolved');assert.equal(s.questions.find(q=>q.id==='old-question').resolutionState,'open');
 assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='historical-answer'").get().status,'inactive');
 await undo(db,saved.mutationId);s=await read(db);assert.equal(s.questions.find(q=>q.id==='old-question').resolutionState,'open');
 assert.equal(s.bullets.find(b=>b.id==='budget').text,'预算大约三十万');
});
