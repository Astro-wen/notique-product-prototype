import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,SCOPE,T} from './helpers/workflow-database.mjs';
import {decideRecord} from '../lib/server/workflow/record-decision.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
async function setup(t) { const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f; }
const edit = {projectId:'p',eventId:'e',cardId:'wfc_budget',key:'correct-budget',request:{operation:'edit',expectedCardRevision:1,expectedContextVersion:0,members:[{claimId:'budget',claimVersionId:'budget_v1',operation:'edit',newText:'预算大约三十五万',origin:'source_statement',evidenceRefIds:['budget_ev']}]}};

test('real record correction changes the current text, keeps the original version and full remaining draft',async t=>{
  const {db,sqlite}=await setup(t);
  const receipt=await decideRecord(db,SCOPE,edit);
  assert.equal(receipt.contextVersion,1);
  const result=await readWorkspace(db,SCOPE,'e',{minContextVersion:1},T);
  assert.equal(result.bullets.find(b=>b.id==='budget').text,'预算大约三十五万');
  assert.equal(result.bullets.find(b=>b.id==='budget').reviewState,'accepted');
  assert.equal(result.bullets.length,3);
  assert.equal(result.counts.draftCount,2);
  assert.equal(sqlite.prepare("SELECT statement FROM claim_versions WHERE id='budget_v1'").get().statement,'预算大约三十万');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM claim_versions WHERE claim_id='budget'").get().n,2);
  const replay=await decideRecord(db,SCOPE,edit);assert.deepEqual(replay,receipt);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n,1);
});

test('user supplied correction records the author and note evidence and clears old structured values',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE claim_versions SET normalized_value_json='{\"amount\":300000}' WHERE id='budget_v1'").run();
  await decideRecord(db,SCOPE,{...edit,request:{...edit.request,members:[{...edit.request.members[0],origin:'user_input',evidenceRefIds:[]}]}});
  const current=sqlite.prepare("SELECT cv.* FROM claim_versions cv JOIN claims c ON c.current_version_id=cv.id WHERE c.id='budget'").get();
  assert.equal(current.normalized_value_json,null);assert.equal(current.workflow_origin,'user_input');
  assert.equal(current.created_by,'owner');
  assert.equal(sqlite.prepare('SELECT author_id FROM user_notes').get().author_id,'owner');
  const snapshot=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(snapshot.bullets.find(b=>b.id==='budget').sourceStatus,'ready');
});

test('confirmation retains qualifying words and rejects insufficient source support',async t=>{
  const {db,sqlite}=await setup(t);
  const confirm={...edit,key:'confirm',request:{operation:'confirm',expectedContextVersion:0,expectedCardRevision:1,members:[{claimId:'budget',claimVersionId:'budget_v1',operation:'confirm'}]}};
  sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='partially_supports' WHERE id='budget_ev'").run();
  await assert.rejects(decideRecord(db,SCOPE,confirm),e=>e.code==='dependency_conflict');
  sqlite.prepare("UPDATE evidence_refs SET semantic_support_verdict='fully_supports' WHERE id='budget_ev'").run();
  await decideRecord(db,SCOPE,confirm);
  const snapshot=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(snapshot.bullets.find(b=>b.id==='budget').text,'预算大约三十万');
  assert.equal(snapshot.actions.length,0);
});
