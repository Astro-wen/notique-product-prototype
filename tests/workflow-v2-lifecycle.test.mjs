import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {decideRecord} from '../lib/server/workflow/record-decision.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {runCancellationStatements,cancelBinds} from '../lib/domain/run-cancellation.ts';
import {MOVED_TABLES,eventMoveRewriteSql} from '../lib/domain/event-move.ts';
import {CLAIM_LINKED_TABLES,claimLinkedRewrite,recordPurgeStatements,recordPurgeBinds} from '../lib/domain/event-trash.ts';

async function fixture(t) {
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  await decideRecord(f.db,SCOPE,{projectId:'p',eventId:'e',cardId:'wfc_budget',key:'edit',request:{operation:'edit',expectedContextVersion:0,expectedCardRevision:1,members:[{claimId:'budget',claimVersionId:'budget_v1',operation:'edit',newText:'预算三十五万',origin:'user_input',evidenceRefIds:[]}]}});
  await readWorkspace(f.db,SCOPE,'e',{},T);
  insert(f.sqlite,'workflow_reports',{id:'report',workspace_id:'ws',project_id:'p',actor_id:'owner',event_ids_json:'["e"]',context_version:1,scope:'mixed',format:'plain_text',content:'预算三十五万'});
  insert(f.sqlite,'workflow_narratives',{id:'project-narrative',workspace_id:'ws',project_id:'p',scope_key:'p',scope_kind:'mixed',based_on_context_version:1,text:'预算三十五万',freshness:'current',input_hash:'hash'});
  insert(f.sqlite,'derived_dependencies',{id:'project-dep',workspace_id:'ws',project_id:'p',derived_type:'narrative',derived_id:'project-narrative',claim_version_id:'budget_v1',scope:'mixed'});
  return f;
}

test('trashing cancels workflow leases and removes record and project snapshot/report bodies',async t=>{
  const {db,sqlite}=await fixture(t);
  const cached=sqlite.prepare('SELECT * FROM workflow_snapshots').get();
  insert(sqlite,'workflow_snapshots',{...cached,id:'overview-cache',event_id:null});
  sqlite.prepare("UPDATE workflow_outbox SET state='running',lease_owner='worker',fencing_token=2").run();
  for(const statement of runCancellationStatements('event')) sqlite.prepare(statement.sql).run(...cancelBinds(statement,{timestamp:T,scopeId:'e',workspace:'ws',reason:'event_trashed'}));
  const job=sqlite.prepare('SELECT state,lease_owner,fencing_token FROM workflow_outbox').get();
  assert.deepEqual({...job},{state:'cancelled',lease_owner:null,fencing_token:3});
  for(const table of ['workflow_reports','workflow_snapshots']) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).bullets.length,3,'cancellation alone preserves the source ledger');
});

test('workflow decisions and attached user notes retain their scope through trash and restore rewrites',async t=>{
  const {db,sqlite}=await fixture(t);
  insert(sqlite,'projects',{id:'restored',workspace_id:'ws',name:'Restored'});
  for(const table of MOVED_TABLES) sqlite.prepare(eventMoveRewriteSql(table)).run('restored','e','ws');
  for(const table of CLAIM_LINKED_TABLES) {
    const s=claimLinkedRewrite(table);sqlite.prepare(s.sql).run('restored',...Array.from({length:s.pairs},()=>['e','ws']).flat());
  }
  sqlite.prepare("UPDATE events SET project_id='restored' WHERE id='e'").run();
  for(const table of ['workflow_cards','workflow_decisions','verdicts','user_notes','workflow_outbox']) assert.equal(sqlite.prepare(`SELECT project_id FROM ${table}`).get().project_id,'restored');
  const snapshot=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(snapshot.bullets.find(b=>b.id==='budget').text,'预算三十五万');
  assert.equal(snapshot.bullets.find(b=>b.id==='budget').sourceStatus,'ready');
});

test('permanent deletion removes workflow decision bodies, cached reports and project narratives derived from the record',async t=>{
  const {sqlite}=await fixture(t);
  recordPurgeStatements().forEach((s,i)=>sqlite.prepare(s.sql).run(...recordPurgeBinds(i,'e','ws')));
  for(const table of ['claims','claim_versions','user_notes','verdicts','workflow_cards','card_members','workflow_decisions','decision_members','derived_dependencies','workflow_narratives','workflow_snapshots','workflow_outbox','workflow_reports']) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,`${table} retained removed record data`);
  }
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});
