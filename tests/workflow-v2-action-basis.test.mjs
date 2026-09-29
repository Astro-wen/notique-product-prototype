import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,SCOPE,T} from './helpers/workflow-database.mjs';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,path,body,key=crypto.randomUUID())=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,key);
async function setup(t) {const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);relation(f.sqlite,'budget-basis','action','budget','informed_by','proposed');return f;}
async function decide(db,claimId,operation,extra={},key=crypto.randomUUID()) {
  const s=await read(db),c=s.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===claimId));
  const request={operation,expectedContextVersion:s.contextVersion,expectedCardRevision:c.revision,members:[{...c.memberRefs.find(r=>r.claimId===claimId),operation,...extra}]};
  return {receipt:await send(db,`review-cards/${c.id}/decisions`,request,key),path:`review-cards/${c.id}/decisions`,request};
}
async function transition(db,operation) {const s=await read(db);return send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation});}
const change={newText:'预算三十五万',origin:'user_input',evidenceRefIds:[]};

test('editing an action basis preserves completion, exposes old/current wording and requires an explicit refresh',async t=>{
  const {db,sqlite}=await setup(t);
  await decide(db,'action','accept_action');await transition(db,'complete');
  const frozen=sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json;
  await decide(db,'budget','edit',change);
  let s=await read(db),a=s.actions[0];
  assert.equal(a.executionState,'completed');assert.equal(a.basisState,'needs_review');assert.equal(s.counts.needsDecisionCount,1);
  assert.equal(sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json,frozen);
  const b=a.basisDetails.find(b=>b.acceptedRef.claimId==='budget');
  assert.equal(b.acceptedText,'预算大约三十万');assert.equal(b.currentText,'预算三十五万');assert.notEqual(b.acceptedRef.claimVersionId,b.currentRef.claimVersionId);
  const saved=await decide(db,'action','accept_action',{},'keep-action');
  assert.deepEqual(await send(db,saved.path,saved.request,'keep-action'),saved.receipt);
  s=await read(db);assert.equal(s.actions[0].basisState,'current');assert.equal(s.counts.needsDecisionCount,0);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.actions.length,1);
  assert.equal(s.actions[0].basisDetails.find(b=>b.acceptedRef.claimId==='budget').acceptedText,'预算三十五万');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM claim_relations WHERE type='informed_by' AND status='active'").get().n,2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM claim_relations WHERE type='resolves' AND status='active'").get().n,1);
  assert.equal(sqlite.prepare("SELECT statement FROM claim_versions WHERE id='budget_v1'").get().statement,'预算大约三十万');
});

test('correcting a completed action keeps its execution, question links and answer, then reopens all historical completion links',async t=>{
  const {db,sqlite}=await setup(t);
  await decide(db,'action','accept_action');await transition(db,'complete');
  let s=await read(db);
  await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'费用十二万',evidenceRefs:[]});
  await decide(db,'action','edit',{...change,newText:'向供应商核实包含安装的报价'});
  s=await read(db);assert.equal(s.actions[0].executionState,'completed');assert.equal(s.actions[0].questionRefs[0].claimId,'question');assert.equal(s.questions[0].resolutionState,'resolved');assert.equal(s.actions.length,1);
  assert.equal(sqlite.prepare("SELECT target_claim_version_id FROM claim_relations WHERE type='resolves' AND target_claim_version_id='action_v1'").get().target_claim_version_id,'action_v1');
  await transition(db,'reopen');s=await read(db);assert.equal(s.actions[0].executionState,'open');assert.equal(s.questions[0].resolutionState,'resolved');
  await transition(db,'complete');s=await read(db);assert.equal(s.actions[0].executionState,'completed');
  await transition(db,'cancel');s=await read(db);assert.equal(s.actions[0].executionState,'cancelled');assert.equal(s.questions[0].resolutionState,'resolved');
  await transition(db,'reopen');assert.equal((await read(db)).actions[0].executionState,'open');
});

test('missing or withdrawn basis cannot be acknowledged and does not erase the frozen reference',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');
  sqlite.prepare("UPDATE claims SET lifecycle_status='withdrawn' WHERE id='budget'").run();
  const s=await read(db);assert.equal(s.actions[0].basisState,'needs_review');assert.equal(s.actions[0].basisDetails.find(b=>b.acceptedRef.claimId==='budget').currentText,null);
  await assert.rejects(decide(db,'action','accept_action'),e=>e.code==='dependency_conflict');
  assert.match(sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json,/budget_v1/);
});

test('legacy relation changes between preparation and commit roll back the entire correction',async t=>{
  const {db,sqlite}=await setup(t);const batch=db.batch;
  db.batch=async statements=>{relation(sqlite,'concurrent','budget','question','resolves');return batch(statements);};
  await assert.rejects(decide(db,'budget','edit',change),e=>e.code==='version_conflict');
  assert.equal(sqlite.prepare("SELECT current_version_id FROM claims WHERE id='budget'").get().current_version_id,'budget_v1');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,0);
});

test('basis source loss between review and commit cannot clear the review warning',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');await decide(db,'budget','edit',change);
  const batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();return batch(statements);};
  await assert.rejects(decide(db,'action','accept_action'),e=>e.code==='version_conflict');
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state,'needs_review');
});

test('editing an unaccepted action does not silently create a followed action',async t=>{
  const {db,sqlite}=await setup(t);
  await assert.rejects(decide(db,'action','edit',change),e=>e.code==='dependency_conflict');
  assert.equal((await read(db)).actions.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
});


test('legacy accepted actions keep their dependencies when completion creates V2 metadata',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  await transition(db,'complete');
  const saved=JSON.parse(sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json);
  assert.equal(saved.length,2);
  await decide(db,'budget','edit',change);
  const s=await read(db);assert.equal(s.actions[0].basisState,'needs_review');assert.equal(s.actions[0].executionState,'completed');
});

test('accepting an older suggestion keeps its stable basis identities after a fact correction',async t=>{
  const {db}=await setup(t);
  await decide(db,'budget','edit',change);await decide(db,'action','accept_action');
  const s=await read(db),basis=s.actions[0].basisDetails.find(b=>b.acceptedRef.claimId==='budget');
  assert.ok(basis);assert.equal(basis.currentText,'预算三十五万');assert.deepEqual(basis.acceptedRef,basis.currentRef);
});

async function replaceBudget(db,sqlite,oldId='budget',newId='new-budget') {
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id=?").run(oldId);
  claim(sqlite,newId,'budget',newId==='new-budget'?'预算更新为三十五万':'预算最终四十万');
  relation(sqlite,`${newId}-conflict`,newId,oldId,'contradicts','proposed');
  return decide(db,newId,'resolve_conflict',{conflictChoice:{mode:'use_candidate',existingRef:{claimId:oldId,claimVersionId:`${oldId}_v1`},candidateRef:{claimId:newId,claimVersionId:`${newId}_v1`}}});
}

test('a chosen replacement reaches the existing action, preserves completion and becomes its basis only after review',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');await transition(db,'complete');
  const replacement=await replaceBudget(db,sqlite);
  let s=await read(db),a=s.actions[0],b=a.basisDetails.find(b=>b.acceptedRef.claimId==='budget');
  assert.equal(b.acceptedText,'预算大约三十万');assert.equal(b.currentText,'预算更新为三十五万');
  assert.equal(b.currentRef.claimId,'new-budget');assert.equal(a.executionState,'completed');assert.equal(a.basisState,'needs_review');
  assert.match(sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json,/budget_v1/);
  await decide(db,'action','accept_action');s=await read(db);a=s.actions[0];
  assert.equal(a.basisState,'current');assert.equal(a.executionState,'completed');
  assert.equal(a.basisDetails.find(b=>b.acceptedRef.claimId==='new-budget').acceptedText,'预算更新为三十五万');
  const d=s.recentDecisions.find(d=>d.id===replacement.receipt.mutationId);
  await assert.rejects(send(db,`decisions/${d.id}/revert`,{expectedContextVersion:s.contextVersion,expectedDecisionRevision:d.revision}),e=>e.code==='dependency_conflict' && e.details.affectedItems.some(x=>x.claimId==='action'));
});

test('replacement chains reach the latest accepted fact even after that fact is edited',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');
  await replaceBudget(db,sqlite);await replaceBudget(db,sqlite,'new-budget','final-budget');
  // Legacy correction keeps stable identity while relations retain exact historical versions.
  sqlite.prepare("INSERT INTO claim_versions(id,claim_id,version_no,statement,source) VALUES ('final-budget_v2','final-budget',2,'预算四十万含税','human')").run();
  sqlite.prepare("UPDATE claims SET current_version_id='final-budget_v2',workflow_revision=workflow_revision+1 WHERE id='final-budget'").run();
  sqlite.prepare("UPDATE evidence_refs SET claim_version_id='final-budget_v2' WHERE id='final-budget_ev'").run();
  const a=(await read(db)).actions[0];assert.equal(a.basisDetails.find(b=>b.acceptedRef.claimId==='budget').currentText,'预算四十万含税');
  await decide(db,'action','accept_action');assert.equal((await read(db)).actions[0].basisState,'current');
});

for(const invalid of ['proposed','coexist','ambiguous','cycle']) test(`an ${invalid} replacement path cannot silently supply an action basis`,async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');await replaceBudget(db,sqlite);
  if(invalid==='proposed') sqlite.prepare("UPDATE claim_relations SET status='proposed' WHERE id='new-budget-conflict'").run();
  if(invalid==='coexist') sqlite.prepare("UPDATE claim_relations SET reason=json_set(reason,'$.mode','coexist') WHERE id='new-budget-conflict'").run();
  if(invalid==='ambiguous') {
    claim(sqlite,'other-budget','budget','另一个预算',{status:'verified'});relation(sqlite,'ambiguous','other-budget','budget','contradicts');
    sqlite.prepare("UPDATE claim_relations SET contradiction_status='resolved',reason=? WHERE id='ambiguous'").run(JSON.stringify({operation:'resolve_conflict',mode:'use_candidate'}));
  }
  if(invalid==='cycle') {
    sqlite.prepare("UPDATE claims SET lifecycle_status='superseded' WHERE id='new-budget'").run();
    relation(sqlite,'cycle','budget','new-budget','contradicts');
    sqlite.prepare("UPDATE claim_relations SET contradiction_status='resolved',reason=? WHERE id='cycle'").run(JSON.stringify({operation:'resolve_conflict',mode:'use_candidate'}));
  }
  const a=(await read(db)).actions[0];assert.equal(a.basisDetails.find(b=>b.acceptedRef.claimId==='budget').currentRef,null);
  await assert.rejects(decide(db,'action','accept_action'),e=>e.code==='dependency_conflict');
});

test('a replacement relation retired during confirmation rolls back the basis refresh',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');await replaceBudget(db,sqlite);
  const batch=db.batch;db.batch=async statements=>{sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE id='new-budget-conflict'").run();return batch(statements);};
  await assert.rejects(decide(db,'action','accept_action'),e=>e.code==='version_conflict');
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state,'needs_review');
});

async function undoBasisDecision(db,saved) {
  const s=await read(db),d=s.recentDecisions.find(d=>d.id===saved.receipt.mutationId);
  return send(db,`decisions/${d.id}/revert`,{expectedContextVersion:s.contextVersion,expectedDecisionRevision:d.revision});
}

test('undo restores an unchanged completed action basis without asking the user to review it again',async t=>{
  const {db}=await setup(t);await decide(db,'action','accept_action');await transition(db,'complete');
  const saved=await decide(db,'budget','edit',change);assert.equal((await read(db)).actions[0].basisState,'needs_review');
  await undoBasisDecision(db,saved);const s=await read(db);
  assert.equal(s.actions[0].basisState,'current');assert.equal(s.actions[0].executionState,'completed');
  assert.equal(s.actions[0].basisDetails.find(b=>b.acceptedRef.claimId==='budget').currentText,'预算大约三十万');
  assert.equal(s.counts.needsDecisionCount,0);
});

test('undoing one basis correction preserves the warning for another changed basis',async t=>{
  const {db,sqlite}=await setup(t);claim(sqlite,'place','location','上海');relation(sqlite,'place-basis','action','place','informed_by','proposed');
  await decide(db,'action','accept_action');const saved=await decide(db,'budget','edit',change);
  await decide(db,'place','edit',{...change,newText:'苏州'});await undoBasisDecision(db,saved);
  assert.equal((await read(db)).actions[0].basisState,'needs_review');
});

test('undo preserves the basis warning when its original source is no longer available',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');const saved=await decide(db,'budget','edit',change);
  sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();await undoBasisDecision(db,saved);
  assert.equal((await read(db)).actions[0].basisState,'needs_review');
});

test('undoing an unreviewed fact replacement restores the original accepted action basis',async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');await transition(db,'complete');
  const saved=await replaceBudget(db,sqlite);await undoBasisDecision(db,saved);const s=await read(db);
  assert.equal(s.actions[0].basisState,'current');assert.equal(s.actions[0].executionState,'completed');
  assert.equal(s.actions[0].basisDetails.find(b=>b.acceptedRef.claimId==='budget').currentText,'预算大约三十万');
});

for(const race of ['source','other_basis','action_metadata'])test(`a legacy ${race} change during undo cannot clear the original basis warning`,async t=>{
  const {db,sqlite}=await setup(t);await decide(db,'action','accept_action');const saved=await decide(db,'budget','edit',change),batch=db.batch;
  db.batch=async statements=>{
    if(race==='source')sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
    if(race==='other_basis')sqlite.prepare("UPDATE claims SET lifecycle_status='withdrawn' WHERE id='question'").run();
    if(race==='action_metadata')sqlite.prepare("UPDATE action_metadata SET owner_hint='changed' WHERE claim_id='action'").run();
    return batch(statements);
  };
  await assert.rejects(undoBasisDecision(db,saved),e=>e.code==='version_conflict');
  assert.equal(sqlite.prepare("SELECT current_version_id FROM claims WHERE id='budget'").get().current_version_id==='budget_v1',false);
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state,'needs_review');
});

test('undoing a fact confirmation preserves a pre-existing action and does not invent a basis change',async t=>{
  const {db}=await setup(t);await decide(db,'action','accept_action');const saved=await decide(db,'budget','confirm');
  await undoBasisDecision(db,saved);const s=await read(db);
  assert.equal(s.actions[0].basisState,'current');assert.equal(s.bullets.find(b=>b.id==='budget').reviewState,'draft');
});
