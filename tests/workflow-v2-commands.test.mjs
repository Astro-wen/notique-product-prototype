import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase, seed, SCOPE, T } from './helpers/workflow-database.mjs';
import { dispatchWorkflowCommand } from '../lib/server/workflow/commands.ts';
import { readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
const code = c => e => e.code === c;
const acceptance = { operation:'accept_action', expectedCardRevision:1, expectedContextVersion:0,
  members:[{claimId:'action',claimVersionId:'action_v1',operation:'accept_action'}] };
async function setup(t) { const f=await workflowDatabase(); t.after(f.close); seed(f.sqlite); return f; }
const read=db=>readWorkspace(db,SCOPE,'e',{},T);
const send=(db,path,body,key=crypto.randomUUID(),scope=SCOPE)=>dispatchWorkflowCommand(db,scope,path.split('/'),body,key);

test('resource dispatch preserves retries and keeps normal answers from invalidating an action basis',async t=>{
  const {db}=await setup(t);
  const saved=await send(db,'review-cards/wfc_action/decisions',acceptance,'accept');
  assert.deepEqual(await send(db,'review-cards/wfc_action/decisions',acceptance,'accept'),saved);
  let s=await read(db);
  await send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation:'complete'});
  s=await read(db);
  await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'十二万',evidenceRefs:[]});
  s=await read(db);
  assert.equal(s.actions[0].basisState,'current');
  assert.equal(s.questions[0].resolutionState,'resolved');
  const outcome=s.questions[0].latestOutcome;
  await send(db,`outcomes/${outcome.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:outcome.revision,operation:'withdraw'});
  s=await read(db);
  assert.equal(s.actions[0].executionState,'completed');
  assert.equal(s.actions[0].basisState,'current');
  assert.equal(s.questions[0].resolutionState,'open');
});

test('resource IDs cannot bypass membership, viewer restrictions or replay authorization',async t=>{
  const {db,sqlite}=await setup(t);
  await assert.rejects(send(db,'review-cards/wfc_action/decisions',acceptance,'accept',{...SCOPE,workspaceId:'other'}),code('not_found'));
  sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
  await assert.rejects(send(db,'review-cards/wfc_action/decisions',acceptance,'accept'),code('forbidden'));
  sqlite.prepare("UPDATE workspace_members SET role='owner'").run();
  await send(db,'review-cards/wfc_action/decisions',acceptance,'accept');
  sqlite.prepare("UPDATE workspace_members SET revoked_at=?").run(T);
  await assert.rejects(send(db,'review-cards/wfc_action/decisions',acceptance,'accept'),code('not_found'));
});

test('archived resources, forged resource types and caller ownership fields are rejected before writes',async t=>{
  const {db,sqlite}=await setup(t);
  await assert.rejects(send(db,'actions/question/transitions',{}),code('not_found'));
  await assert.rejects(send(db,'questions/action/answers',{}),code('not_found'));
  await assert.rejects(send(db,'review-cards/wfc_action/decisions',{...acceptance,projectId:'other'}),e=>e.name==='WorkflowValidationError');
  await assert.rejects(send(db,'actions/action/transitions/extra',{}),code('not_found'));
  sqlite.prepare("UPDATE events SET material_status='archived'").run();
  await assert.rejects(send(db,'review-cards/wfc_action/decisions',acceptance),code('not_found'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_decisions').get().n,0);
});

test('changed answer content invalidates actions that depended on that exact answer version',async t=>{
  const {db,sqlite}=await setup(t);
  await send(db,'questions/question/answers',{expectedContextVersion:0,expectedQuestionRevision:1,answerText:'十二万',evidenceRefs:[]});
  let s=await read(db);
  const answer=s.questions[0].answerRefs[0];
  sqlite.prepare("INSERT INTO claim_relations (id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status) VALUES ('answer-basis','ws','p','informed_by','action_v1',?,1,'active')").run(answer.claimVersionId);
  await send(db,'review-cards/wfc_action/decisions',{...acceptance,expectedContextVersion:1});
  s=await read(db);
  await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'十三万',evidenceRefs:[],answerDecision:{mode:'replace',priorAnswerRefs:s.questions[0].answerRefs}});
  s=await read(db);
  assert.equal(s.actions[0].basisState,'needs_review');
});
