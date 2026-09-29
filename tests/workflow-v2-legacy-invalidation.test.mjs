import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {legacyWorkflowInvalidationStatements} from '../lib/server/db/legacy-workflow-invalidation.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';

async function fixture(t) {
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  f.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id IN ('budget','action')").run();
  insert(f.sqlite,'action_metadata',{claim_id:'action',workspace_id:'ws',project_id:'p',event_id:'e',basis_version_refs_json:'[{"claimId":"budget","claimVersionId":"budget_v1"}]',basis_state:'current'});
  insert(f.sqlite,'workflow_narratives',{id:'old-summary',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',scope_kind:'mixed',based_on_context_version:0,text:'预算三十万',freshness:'current',input_hash:'old'});
  return f;
}

test('a native accepted fact edit stales the summary, snapshots, and frozen action basis in its business batch',async t=>{
  const {db,sqlite}=await fixture(t);
  const old=await readWorkspace(db,SCOPE,'e',{},T);
  insert(sqlite,'claim_versions',{id:'budget_v2',claim_id:'budget',version_no:2,statement:'预算三十五万',source:'human'});
  await db.batch([
    db.prepare("UPDATE claims SET current_version_id='budget_v2' WHERE id='budget'"),
    db.prepare("UPDATE projects SET context_version=context_version+1 WHERE id='p'"),
    ...legacyWorkflowInvalidationStatements(db,SCOPE,'p',T,['budget']),
  ]);
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='old-summary'").get().freshness,'stale');
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state,'needs_review');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_snapshots').get().n,0);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE event_id='e' AND kind='narrative' AND input_revision=1").get().n,1);
  assert.equal(sqlite.prepare("SELECT workflow_revision FROM claims WHERE id='budget'").get().workflow_revision,2);
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:old.snapshotId},T),e=>e.code==='cursor_expired');
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).actions[0].basisState,'needs_review');
});

test('a native action confirmation freezes its current basis and retires an approved group without another claim',async t=>{
  const {db,sqlite}=await fixture(t);
  sqlite.prepare("UPDATE claims SET review_status='pending' WHERE id='action'").run();
  insert(sqlite,'workflow_cards',{id:'group',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'same_intent:test',revision:1,kind:'action',title:'供应商报价',needs_decision:1,reason_code:'action_choice',reason:'是否跟进',disposition:'active'});
  insert(sqlite,'card_members',{id:'member',workspace_id:'ws',card_id:'group',claim_id:'action',claim_version_id:'action_v1',role:'primary'});
  sqlite.prepare("DELETE FROM action_metadata WHERE claim_id='action'").run();
  await db.batch([
    db.prepare("UPDATE claims SET review_status='verified' WHERE id='action'"),
    db.prepare("UPDATE claim_relations SET status='active' WHERE id='basis'"),
    db.prepare("UPDATE projects SET context_version=context_version+1 WHERE id='p'"),
    ...legacyWorkflowInvalidationStatements(db,SCOPE,'p',T,['action']),
  ]);
  const basis=JSON.parse(sqlite.prepare("SELECT basis_version_refs_json FROM action_metadata WHERE claim_id='action'").get().basis_version_refs_json);
  assert.deepEqual(basis,[{claimId:'question',claimVersionId:'question_v1'}]);
  assert.deepEqual({...sqlite.prepare("SELECT revision,needs_decision,disposition FROM workflow_cards WHERE id='group'").get()},{revision:2,needs_decision:0,disposition:'processed'});
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claims WHERE id='action'").get().n,1);
});

test('an old occurrence choice advances context and invalidates the visible record atomically',async t=>{
  const {db,sqlite}=await fixture(t);
  await db.batch(legacyWorkflowInvalidationStatements(db,SCOPE,'p',T,['budget'],{advanceContext:true}));
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,1);
  assert.equal(sqlite.prepare("SELECT input_revision FROM workflow_outbox WHERE event_id='e' AND kind='narrative'").get().input_revision,1);
});

test('a failed native batch rolls back its business row, context and all derived invalidation',async t=>{
  const {db,sqlite}=await fixture(t);
  await assert.rejects(db.batch([
    db.prepare("UPDATE claims SET lifecycle_status='withdrawn' WHERE id='budget'"),
    db.prepare("UPDATE projects SET context_version=context_version+1 WHERE id='p'"),
    ...legacyWorkflowInvalidationStatements(db,SCOPE,'p',T,['budget']),
    db.prepare("INSERT INTO mutation_guards(id,guard_value) VALUES('force',0)"),
  ]));
  assert.equal(sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='budget'").get().lifecycle_status,'active');
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,0);
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='old-summary'").get().freshness,'current');
  assert.equal(sqlite.prepare("SELECT basis_state FROM action_metadata WHERE claim_id='action'").get().basis_state,'current');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,0);
});
