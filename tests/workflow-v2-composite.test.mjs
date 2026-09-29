import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {decideRecord} from '../lib/server/workflow/record-decision.ts';
import {revertDecision} from '../lib/server/workflow/revert-decision.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {parseWorkflowRequest,WorkflowValidationError} from '../lib/shared/workflow-v2.ts';

async function setup(t,{actions=false}={}) {
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  const ids=actions?['action','other-action']:['budget','time','place','remaining'];
  if(actions) {claim(f.sqlite,'other-action','next_action','向第二家供应商询价');relation(f.sqlite,'other-basis','other-action','question','informed_by','proposed');}
  else {claim(f.sqlite,'time','time','周末确认时间');claim(f.sqlite,'place','fact','在门店讨论');claim(f.sqlite,'remaining','fact','材料品牌待讨论');}
  insert(f.sqlite,'workflow_cards',{id:'group',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'group',revision:1,kind:actions?'action':'record',title:actions?'供应商询价':'装修安排',needs_decision:Number(actions),reason_code:actions?'action_choice':null,reason:actions?'决定是否加入跟进':'',disposition:'active',created_at:T,updated_at:T});
  for(const id of ids) insert(f.sqlite,'card_members',{id:`member_${id}`,workspace_id:'ws',card_id:'group',claim_id:id,claim_version_id:`${id}_v1`,role:'primary',created_at:T});
  return {...f,ids};
}
function input(members,{operation='review_members',context=0,revision=1,key='group-decision'}={}) {return {projectId:'p',eventId:'e',cardId:'group',key,request:{operation,expectedContextVersion:context,expectedCardRevision:revision,members}};}
const choose=(id,operation,extra={})=>({claimId:id,claimVersionId:`${id}_v1`,operation,...extra});
const mixed=()=>[choose('budget','confirm'),choose('time','edit',{newText:'周六上午确认时间',origin:'user_input',evidenceRefIds:[]}),choose('place','reject')];
const counts=sql=>Object.fromEntries(['verdicts','workflow_decisions','decision_members','mutation_replays','workflow_changes','workflow_outbox'].map(table=>[table,sql.prepare(`SELECT count(*) n FROM ${table}`).get().n]));

test('mixed member decisions save once, retain untouched drafts and preserve a group after rejection',async t=>{
  const {db,sqlite}=await setup(t);const command=input(mixed());
  const original=(await readWorkspace(db,SCOPE,'e',{},T)).reviewCards.find(c=>c.id==='group').memberRefs.map(r=>r.claimId);
  const receipt=await decideRecord(db,SCOPE,command);
  const w=await readWorkspace(db,SCOPE,'e',{},T),g=w.reviewCards.find(c=>c.id==='group');
  assert.equal(receipt.contextVersion,1);assert.equal(g.revision,2);assert.equal(g.disposition,'active');assert.equal(g.members.length,4);assert.deepEqual(g.memberRefs.map(r=>r.claimId),original);
  assert.equal(g.members.find(m=>m.claimId==='place').reviewState,'rejected');
  assert.equal(w.bullets.find(b=>b.id==='budget').reviewState,'accepted');
  assert.equal(w.bullets.find(b=>b.id==='time').text,'周六上午确认时间');
  assert.equal(w.bullets.find(b=>b.id==='remaining').reviewState,'draft');assert.ok(!w.bullets.some(b=>b.id==='place'));
  assert.equal(sqlite.prepare("SELECT statement FROM claim_versions WHERE id='time_v1'").get().statement,'周末确认时间');
  assert.deepEqual(counts(sqlite),{verdicts:3,workflow_decisions:1,decision_members:3,mutation_replays:1,workflow_changes:1,workflow_outbox:1});
  assert.equal(w.recentDecisions[0].operation,'review_members');assert.match(w.recentDecisions[0].summary,/周六上午/);
  const replay=await decideRecord(db,SCOPE,command);assert.deepEqual(replay,receipt);assert.equal(counts(sqlite).verdicts,3);
  await decideRecord(db,SCOPE,input([choose('remaining','confirm')],{operation:'confirm',context:1,revision:2,key:'remaining-confirm'}));
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).reviewCards.find(c=>c.id==='group').disposition,'processed');
});

test('reverting a mixed decision restores every selected member and the untouched group',async t=>{
  const {db,sqlite}=await setup(t);const receipt=await decideRecord(db,SCOPE,input(mixed()));
  await revertDecision(db,SCOPE,{projectId:'p',eventId:'e',decisionId:receipt.mutationId,key:'undo-group',request:{expectedContextVersion:1,expectedDecisionRevision:1}});
  const w=await readWorkspace(db,SCOPE,'e',{},T),g=w.reviewCards.find(c=>c.id==='group');
  assert.equal(w.contextVersion,2);assert.equal(g.members.length,4);assert.equal(g.disposition,'active');
  assert.equal(g.members.every(m=>m.reviewState==='draft'),true);assert.equal(w.bullets.find(b=>b.id==='time').text,'周末确认时间');assert.ok(w.bullets.some(b=>b.id==='place'));
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claim_versions WHERE claim_id='time'").get().n,2);
});

test('one unsupported or foreign member rejects the entire selection before writing',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='partially_supports' WHERE id='time_ev'").run();
  await assert.rejects(decideRecord(db,SCOPE,input([choose('budget','confirm'),choose('time','confirm')])),e=>e.code==='dependency_conflict' && e.details.affectedItems[0].claimId==='time');
  await assert.rejects(decideRecord(db,SCOPE,input([choose('budget','confirm'),choose('question','confirm')])),e=>e.code==='version_conflict');
  assert.equal(counts(sqlite).verdicts,0);assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,0);
});

test('legacy member-set change during commit rolls back all verdicts and revised versions',async t=>{
  const {db,sqlite}=await setup(t);const batch=db.batch;
  db.batch=async statements=>{sqlite.prepare("DELETE FROM card_members WHERE claim_id='remaining'").run();return batch(statements);};
  await assert.rejects(decideRecord(db,SCOPE,input(mixed())),e=>e.code==='version_conflict');
  assert.equal(counts(sqlite).verdicts,0);assert.equal(sqlite.prepare("SELECT count(*) n FROM claim_versions WHERE claim_id='time'").get().n,1);
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,0);
});

test('permission loss during commit keeps every member unchanged',async t=>{
  const {db,sqlite}=await setup(t);const batch=db.batch;
  db.batch=async statements=>{sqlite.prepare("UPDATE workspace_members SET revoked_at=? WHERE actor_id='owner'").run(T);return batch(statements);};
  await assert.rejects(decideRecord(db,SCOPE,input(mixed())),e=>e.code==='forbidden');
  assert.equal(counts(sqlite).verdicts,0);assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'pending');
});

test('partial action acceptance preserves the next choice and generic confirmation never starts actions',async t=>{
  const {db,sqlite}=await setup(t,{actions:true});
  await assert.rejects(decideRecord(db,SCOPE,input([choose('action','confirm')],{operation:'confirm'})),e=>e.code==='dependency_conflict');
  await decideRecord(db,SCOPE,input([choose('action','accept_action')]));
  const w=await readWorkspace(db,SCOPE,'e',{},T),g=w.reviewCards.find(c=>c.id==='group');
  assert.equal(g.disposition,'active');assert.equal(g.needsDecision,true);assert.equal(w.actions.length,1);
  assert.equal(g.members.find(m=>m.claimId==='other-action').reviewState,'draft');assert.equal(sqlite.prepare('SELECT count(*) n FROM action_metadata').get().n,1);
});

test('reverting two accepted actions restores both frozen bases and leaves no accepted follow-up',async t=>{
  const {db,sqlite}=await setup(t,{actions:true});
  const receipt=await decideRecord(db,SCOPE,input([choose('action','accept_action'),choose('other-action','accept_action')]));
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).actions.length,2);
  await revertDecision(db,SCOPE,{projectId:'p',eventId:'e',decisionId:receipt.mutationId,key:'undo-actions',request:{expectedContextVersion:1,expectedDecisionRevision:1}});
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).actions.length,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM action_metadata').get().n,0);
  assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='basis'").get().status,'proposed');
  assert.equal(sqlite.prepare("SELECT status FROM claim_relations WHERE id='other-basis'").get().status,'proposed');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claim_relations WHERE status='active'").get().n,0);
});

test('reverting a group detects later use of any accepted action, including the second member',async t=>{
  const {db,sqlite}=await setup(t,{actions:true});const receipt=await decideRecord(db,SCOPE,input([choose('action','accept_action'),choose('other-action','accept_action')]));
  claim(sqlite,'completion','fact','第二次询价已完成',{status:'verified'});relation(sqlite,'completion-use','completion','other-action','resolves','active');
  await assert.rejects(revertDecision(db,SCOPE,{projectId:'p',eventId:'e',decisionId:receipt.mutationId,key:'undo-used',request:{expectedContextVersion:1,expectedDecisionRevision:1}}),e=>e.code==='dependency_conflict' && e.details.affectedItems[0].claimId==='completion');
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).actions.length,2);
});

test('mixed wire commands validate each edit independently and forbid hidden or duplicate choices',()=>{
  const request=input(mixed()).request;assert.equal(parseWorkflowRequest('DecisionRequest',request).members.length,3);
  for(const members of [[choose('budget','defer')],[choose('budget','review_members')],[choose('budget','edit')],[choose('budget','confirm'),choose('budget','reject')]]) assert.throws(()=>parseWorkflowRequest('DecisionRequest',{...request,members}),WorkflowValidationError);
  assert.throws(()=>parseWorkflowRequest('DecisionRequest',{...request,members:[]}),WorkflowValidationError);
  assert.throws(()=>parseWorkflowRequest('DecisionRequest',{...request,operation:'confirm'}),WorkflowValidationError);
});

test('an untouched member changed at commit prevents partial group storage',async t=>{
  const {db,sqlite}=await setup(t),batch=db.batch;
  db.batch=async statements=>{sqlite.prepare("UPDATE claims SET workflow_revision=workflow_revision+1 WHERE id='remaining'").run();return batch(statements);};
  await assert.rejects(decideRecord(db,SCOPE,input(mixed())),e=>e.code==='version_conflict');
  assert.equal(counts(sqlite).verdicts,0);assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'pending');
});

test('reversal never restores an outdated untouched member from an old group snapshot',async t=>{
  const {db,sqlite}=await setup(t),receipt=await decideRecord(db,SCOPE,input(mixed()));
  insert(sqlite,'claim_versions',{id:'remaining_v2',claim_id:'remaining',version_no:2,statement:'后续材料更新',source:'human'});
  sqlite.prepare("UPDATE claims SET current_version_id='remaining_v2' WHERE id='remaining'").run();
  await assert.rejects(revertDecision(db,SCOPE,{projectId:'p',eventId:'e',decisionId:receipt.mutationId,key:'undo-stale-group',request:{expectedContextVersion:1,expectedDecisionRevision:1}}),e=>e.code==='dependency_conflict');
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'verified');
});

test('twenty source corrections stay within actual D1 parameter limits and retain one atomic decision',async t=>{
  const f=await setup(t),{db,sqlite}=f;
  for(let i=0;i<16;i++) {const id=`extra-${i}`;claim(sqlite,id,'fact',`原话${i}`);insert(sqlite,'card_members',{id:`member_${id}`,workspace_id:'ws',card_id:'group',claim_id:id,claim_version_id:`${id}_v1`,role:'primary',created_at:T});f.ids.push(id);}
  const batch=db.batch;let guardCount=0;
  db.batch=async statements=>{for(const s of statements)assert.ok(s.values.length<=100,`D1 statement uses ${s.values.length} parameters`);guardCount=statements.filter(s=>s.sql.startsWith('INSERT INTO mutation_guards')).length;return batch(statements);};
  const members=f.ids.map(id=>choose(id,'edit',{newText:`修正后的${id}`,origin:'source_statement',evidenceRefIds:[`${id}_ev`]}));
  const result=await decideRecord(db,SCOPE,input(members));
  assert.ok(guardCount>1);assert.equal(result.contextVersion,1);assert.equal(counts(sqlite).workflow_decisions,1);assert.equal(counts(sqlite).verdicts,20);assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,0);
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).reviewCards.find(c=>c.id==='group').disposition,'processed');
});

test('a failing guard in a later D1 chunk rolls back the entire review and clears temporary guards',async t=>{
  const {db,sqlite}=await setup(t),batch=db.batch;
  const members=[choose('budget','confirm'),choose('time','edit',{newText:'周六十点',origin:'source_statement',evidenceRefIds:['time_ev']}),choose('place','reject')];
  db.batch=async statements=>{assert.ok(statements.filter(s=>s.sql.startsWith('INSERT INTO mutation_guards')).length>1);sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='time_ev'").run();return batch(statements);};
  await assert.rejects(decideRecord(db,SCOPE,input(members)),e=>e.code==='version_conflict');
  assert.equal(counts(sqlite).verdicts,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,0);assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,0);
});
