import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowDatabase,seed,insert,SCOPE,T } from './helpers/workflow-database.mjs';
import { commitWorkflowMutation } from '../lib/server/workflow/transaction.ts';

const request = {projectId:'p',eventId:'e',endpoint:'test/decision',key:'same-request',payload:{confirm:'budget_v1'},expectedContextVersion:0};
async function fixture(t) { const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f; }
function plan(db) {
  return {statements:[db.prepare("UPDATE claims SET review_status='verified',workflow_revision=workflow_revision+1 WHERE id='budget'")],
    guards:[{sql:"EXISTS (SELECT 1 FROM claims WHERE id=? AND current_version_id=? AND review_status='pending')",values:['budget','budget_v1']}],
    changedRefs:[{entityType:'claim',id:'budget',revision:2}],invalidatedVersionIds:['budget_v1'],kind:'confirm'};
}
const code = expected => e=>e.code===expected;

test('one atomic commit saves ledger, context, dependent invalidation, job and durable receipt',async t=>{
  const {db,sqlite}=await fixture(t);
  insert(sqlite,'workflow_narratives',{id:'affected',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',scope_kind:'mixed',based_on_context_version:0,text:'预算',freshness:'current',input_hash:'seed'});
  insert(sqlite,'derived_dependencies',{id:'dep',workspace_id:'ws',project_id:'p',event_id:'e',derived_type:'narrative',derived_id:'affected',claim_version_id:'budget_v1',scope:'mixed'});
  insert(sqlite,'workflow_narratives',{id:'unaffected',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'other',scope_kind:'mixed',based_on_context_version:0,text:'问题',freshness:'current',input_hash:'other'});
  insert(sqlite,'derived_dependencies',{id:'dep2',workspace_id:'ws',project_id:'p',event_id:'e',derived_type:'narrative',derived_id:'unaffected',claim_version_id:'question_v1',scope:'mixed'});
  const receipt=await commitWorkflowMutation(db,SCOPE,request,async()=>plan(db),T);
  assert.equal(receipt.contextVersion,1);
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'verified');
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='affected'").get().freshness,'stale');
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='unaffected'").get().freshness,'current');
  for(const table of ['workflow_changes','workflow_outbox','mutation_replays']) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mutation_guards').get().n,0);
});

test('same request replays before mutable-version validation and different content conflicts',async t=>{
  const {db,sqlite}=await fixture(t);
  const first=await commitWorkflowMutation(db,SCOPE,request,async()=>plan(db),T);
  const second=await commitWorkflowMutation(db,SCOPE,request,async()=>{throw new Error('must not prepare a duplicate');},T);
  assert.deepEqual(first,second);
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,1);
  await assert.rejects(commitWorkflowMutation(db,SCOPE,{...request,payload:{confirm:'other'}},async()=>plan(db),T),code('idempotency_conflict'));
  await assert.rejects(commitWorkflowMutation(db,SCOPE,{...request,key:'new'},async()=>plan(db),T),code('version_conflict'));
});

test('simultaneous retries return the same receipt and commit once',async t=>{
  const {db,sqlite}=await fixture(t);
  const result=await Promise.all([1,2].map(()=>commitWorkflowMutation(db,SCOPE,request,async()=>plan(db),T)));
  assert.deepEqual(result[0],result[1]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_changes').get().n,1);
});

test('competing decisions and stale member guards cannot partially commit',async t=>{
  const {db,sqlite}=await fixture(t);
  const outcomes=await Promise.allSettled([1,2].map(n=>commitWorkflowMutation(db,SCOPE,{...request,key:`key-${n}`},async()=>plan(db),T)));
  assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);
  assert.equal(outcomes.find(o=>o.status==='rejected').reason.code,'version_conflict');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mutation_replays').get().n,1);
  await assert.rejects(commitWorkflowMutation(db,SCOPE,{...request,key:'stale-member',expectedContextVersion:1},async()=>plan(db),T),code('version_conflict'));
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,1);
});

test('SQL failure after the ledger update rolls back ledger and all bookkeeping',async t=>{
  const {db,sqlite}=await fixture(t);
  await assert.rejects(commitWorkflowMutation(db,SCOPE,request,async()=>{
    const p=plan(db);p.statements.push(db.prepare("INSERT INTO mutation_guards(id,guard_value) VALUES ('force-rollback',0)"));return p;
  },T),code('version_conflict'));
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'pending');
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,0);
  for(const table of ['workflow_changes','workflow_outbox','mutation_replays','mutation_guards']) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
});

test('revoked readers cannot recover old receipts or write using a stale permission check',async t=>{
  const {db,sqlite}=await fixture(t);
  await commitWorkflowMutation(db,SCOPE,request,async()=>plan(db),T);
  sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
  await assert.rejects(commitWorkflowMutation(db,SCOPE,request,async()=>plan(db),T),code('forbidden'));
  sqlite.prepare("UPDATE workspace_members SET role='owner'").run();
  await assert.rejects(commitWorkflowMutation(db,SCOPE,{...request,key:'permission-race',expectedContextVersion:1},async()=>{
    sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);
    return {...plan(db),guards:[]};
  },T),code('forbidden'));
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,1);
});
