import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {createReport} from '../lib/server/workflow/report-service.ts';
const code=c=>e=>e.code===c;
const request={expectedContextVersion:0,scope:'mixed',eventIds:['e'],format:'plain_text'};
const report=(db,options={},scope=SCOPE)=>createReport(db,scope,{projectId:'p',key:'copy',request,...options});
async function setup(t) {const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}

test('zero-review export returns complete labeled drafts without advancing context or creating generation work',async t=>{
  const {db,sqlite}=await setup(t);
  const result=await report(db);
  assert.match(result.content,/预算大约三十万.*AI 草稿/);
  assert.match(result.content,/费用是多少/);
  assert.match(result.content,/向供应商询价/);
  assert.deepEqual(await report(db),result);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_reports').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,0);
  assert.equal(sqlite.prepare('SELECT context_version FROM projects').get().context_version,0);
  const receipt=sqlite.prepare('SELECT response_json FROM mutation_replays').get().response_json;
  assert.deepEqual(JSON.parse(receipt),{reportId:result.id});
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM derived_dependencies WHERE derived_id=?").get(result.id).n,4);
});

test('exports honor record boundaries, accepted scope, markdown escaping and viewers',async t=>{
  const {db,sqlite}=await setup(t);
  insert(sqlite,'events',{id:'e2',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'Other record',occurred_at:T,sequence_no:2});
  sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
  sqlite.prepare("UPDATE claim_versions SET statement='[链接](https://example.com)' WHERE id='budget_v1'").run();
  const result=await report(db,{request:{...request,format:'markdown'}});
  assert.equal(result.content.includes('Other record'),false);
  assert.match(result.content,/\\\[链接\\\]/);
  const accepted=await report(db,{key:'accepted',request:{...request,scope:'accepted'}});
  assert.match(accepted.content,/尚无已采纳内容/);
  const all=await report(db,{key:'all',request:{...request,eventIds:[]}});
  assert.match(all.content,/Other record/);
  await assert.rejects(report(db,{key:'bad',request:{...request,eventIds:['missing']}}),code('not_found'));
});

test('export retries reauthorize and expire on removed reports, archived records or replaced source',async t=>{
  const {db,sqlite}=await setup(t);await report(db);
  sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);
  await assert.rejects(report(db),code('not_found'));
  sqlite.prepare('UPDATE workspace_members SET revoked_at=NULL').run();
  sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
  await assert.rejects(report(db),code('cursor_expired'));
  sqlite.prepare("UPDATE assets SET current_version_id='av' WHERE id='asset'").run();
  sqlite.prepare("UPDATE events SET material_status='archived'").run();
  await assert.rejects(report(db),code('cursor_expired'));
  sqlite.prepare("UPDATE events SET material_status='ready'").run();
  sqlite.prepare('DELETE FROM workflow_reports').run();
  await assert.rejects(report(db),code('cursor_expired'));
});

test('source changes between projection and saving cannot publish stale export text',async t=>{
  const {db,sqlite}=await setup(t);
  const wrapped={...db,batch:async statements=>{
    sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
    return db.batch(statements);
  }};
  await assert.rejects(report(wrapped),code('version_conflict'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_reports').get().n,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mutation_replays').get().n,0);
});

test('export idempotency distinguishes a changed scope and permits exact concurrent retries',async t=>{
  const {db,sqlite}=await setup(t);
  const results=await Promise.all([report(db),report(db)]);
  assert.deepEqual(results[0],results[1]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_reports').get().n,1);
  await assert.rejects(report(db,{request:{...request,scope:'accepted'}}),code('idempotency_conflict'));
  await assert.rejects(report(db,{key:'new',request:{...request,expectedContextVersion:20}}),code('version_conflict'));
});

test('source deletion remains detectable after foreign keys remove dependency index rows',async t=>{
  const {db,sqlite}=await setup(t);
  const saved=await report(db);
  const frozen=JSON.parse(sqlite.prepare('SELECT snapshot_json FROM workflow_reports WHERE id=?').get(saved.id).snapshot_json);
  assert.equal(frozen.schemaVersion,1);
  assert.equal(frozen.records[0].coverage.totalSegments,1);
  assert.equal(frozen.records[0].bulletRefs.length,3);
  sqlite.prepare("DELETE FROM assets WHERE id='asset'").run();
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM derived_dependencies WHERE asset_version_id IS NOT NULL").get().n,0);
  await assert.rejects(report(db),code('cursor_expired'));
});
