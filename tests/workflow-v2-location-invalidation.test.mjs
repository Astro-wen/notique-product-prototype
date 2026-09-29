import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const dbModule='data:text/javascript,'+encodeURIComponent(`
  export const getD1=()=>globalThis.locationDb;
  export const getBindings=()=>globalThis.locationBindings;
  export const getEvidenceBucket=()=>globalThis.locationBucket;
`);
registerHooks({
  resolve(specifier,context,next){
    if(specifier==='@/db')return {url:dbModule,shortCircuit:true};
    let target;
    if(specifier.startsWith('@/'))target=resolve(root,specifier.slice(2));
    else if(specifier.startsWith('.') && context.parentURL?.startsWith('file:'))target=fileURLToPath(new URL(specifier,context.parentURL));
    if(target?.startsWith(root) && !target.includes('/node_modules/'))for(const path of [target,`${target}.ts`,`${target}/index.ts`])if(existsSync(path) && !path.endsWith('/db'))return next(pathToFileURL(path).href,context);
    return next(specifier,context);
  },
  load(url,context,next){if(url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);},
});
const {moveEvent}=await import('../lib/server/db/event-move-repository.ts');
const {moveEventToTrash,restoreEvent}=await import('../lib/server/db/event-trash-repository.ts');

async function fixture(t){
  const f=await workflowDatabase();
  t.after(()=>{
    delete globalThis.locationDb;delete globalThis.locationBindings;delete globalThis.locationBucket;f.close();
  });
  seed(f.sqlite);
  globalThis.locationDb=f.db;
  globalThis.locationBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
  globalThis.locationBucket={async get(){return null;},async delete(){}};
  f.sqlite.prepare('DELETE FROM claim_relations').run();
  f.sqlite.prepare("UPDATE projects SET scenario_status='confirmed',next_event_sequence=3 WHERE id='p'").run();
  insert(f.sqlite,'projects',{id:'p2',workspace_id:'ws',name:'Target',scenario_status:'confirmed',next_event_sequence:2});
  insert(f.sqlite,'events',{id:'e_source',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'Source remains',occurred_at:T,sequence_no:2});
  insert(f.sqlite,'events',{id:'e_target',workspace_id:'ws',project_id:'p2',event_type:'meeting',title:'Target remains',occurred_at:T,sequence_no:1});
  for(const [id,projectId,eventId] of [['n_old','p','e'],['n_source','p','e_source'],['n_target','p2','e_target']]){
    insert(f.sqlite,'workflow_narratives',{
      id,workspace_id:'ws',project_id:projectId,event_id:eventId,scope_key:eventId,
      scope_kind:'mixed',based_on_context_version:0,text:'Earlier overview',freshness:'current',input_hash:id,
    });
  }
  return f;
}
function project(sqlite,id){return {...sqlite.prepare('SELECT context_version,ledger_version,next_event_sequence FROM projects WHERE id=?').get(id)};}
function row(sqlite,sql,...values){return {...sqlite.prepare(sql).get(...values)};}
function count(sqlite,sql,...values){return sqlite.prepare(sql).get(...values).n;}
function failLastBatch(db){
  const original=db.batch;
  db.batch=statements=>original([
    ...statements.slice(0,-1),
    db.prepare("INSERT INTO mutation_guards (id,guard_value,created_at) VALUES ('forced-failure',0,?)").bind(T),
    statements.at(-1),
  ]);
}

test('moving a record expires both project snapshots and refreshes both narrative queues',async t=>{
  const {db,sqlite}=await fixture(t);
  const oldSource=await readWorkspace(db,SCOPE,'e_source',{},T);
  const oldTarget=await readWorkspace(db,SCOPE,'e_target',{},T);
  const moved=await moveEvent(SCOPE,'e','p2','move-once');
  assert.equal(moved.project_id,'p2');
  assert.equal(row(sqlite,'SELECT project_id FROM claims WHERE id=?','budget').project_id,'p2');
  assert.equal(row(sqlite,'SELECT project_id FROM workflow_narratives WHERE id=?','n_old').project_id,'p2');
  assert.equal(project(sqlite,'p').context_version,1);
  assert.equal(project(sqlite,'p2').context_version,1);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_narratives WHERE freshness='current'"),0);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_outbox WHERE kind='narrative' AND project_id='p'"),1);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_outbox WHERE kind='narrative' AND project_id='p2'"),2);
  await assert.rejects(readWorkspace(db,SCOPE,'e_source',{snapshotId:oldSource.snapshotId},T),error=>error.code==='cursor_expired');
  await assert.rejects(readWorkspace(db,SCOPE,'e_target',{snapshotId:oldTarget.snapshotId},T),error=>error.code==='cursor_expired');
  assert.equal((await moveEvent(SCOPE,'e','p2','move-once')).id,moved.id);
  assert.equal(count(sqlite,'SELECT count(*) n FROM mutation_replays'),1);
});

test('trashing and restoring a claimed record expire the live project without queuing a bin overview',async t=>{
  const {db,sqlite}=await fixture(t);
  const before=await readWorkspace(db,SCOPE,'e_source',{},T);
  const trashed=await moveEventToTrash(SCOPE,'e','trash-once');
  const bin='prj_record_trash_ws';
  assert.equal(trashed.project_id,'p');
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,bin);
  assert.equal(row(sqlite,"SELECT project_id FROM claims WHERE id='budget'").project_id,bin);
  assert.equal(project(sqlite,'p').context_version,1);
  assert.equal(row(sqlite,"SELECT freshness FROM workflow_narratives WHERE id='n_source'").freshness,'stale');
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox WHERE project_id=? AND kind=?',bin,'narrative'),0);
  await assert.rejects(readWorkspace(db,SCOPE,'e_source',{snapshotId:before.snapshotId},T),error=>error.code==='cursor_expired');
  const afterTrash=await readWorkspace(db,SCOPE,'e_source',{},T);
  const restored=await restoreEvent(SCOPE,'e','restore-once');
  assert.equal(restored.project_id,'p');
  assert.equal(restored.sequence_no,1);
  assert.equal(project(sqlite,'p').context_version,2);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox WHERE project_id=? AND kind=?',bin,'narrative'),0);
  await assert.rejects(readWorkspace(db,SCOPE,'e_source',{snapshotId:afterTrash.snapshotId},T),error=>error.code==='cursor_expired');
  assert.equal((await restoreEvent(SCOPE,'e','restore-once')).id,'e');
});

test('no-claim trash and restore still issue fresh narrative tasks without changing the analysis context',async t=>{
  const {sqlite}=await fixture(t);
  insert(sqlite,'events',{id:'empty',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'No claims',occurred_at:T,sequence_no:3});
  sqlite.prepare("UPDATE projects SET next_event_sequence=4 WHERE id='p'").run();
  insert(sqlite,'workflow_outbox',{
    id:'old_job',workspace_id:'ws',project_id:'p',event_id:'e_source',kind:'narrative',
    task_key:'narrative:p:e_source:0',input_revision:0,payload_json:'{}',state:'succeeded',
    available_at:T,created_at:T,updated_at:T,
  });
  await moveEventToTrash(SCOPE,'empty','empty-trash');
  assert.equal(project(sqlite,'p').context_version,0);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_outbox WHERE project_id='p' AND task_key LIKE 'narrative:location:%'"),2);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_outbox WHERE project_id='prj_record_trash_ws'"),0);
  await restoreEvent(SCOPE,'empty','empty-restore');
  assert.equal(project(sqlite,'p').context_version,0);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_outbox WHERE project_id='p' AND task_key LIKE 'narrative:location:%'"),5);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_snapshots'),0);
});

test('a failed move transaction rolls placement, both project contexts, narratives and receipts back',async t=>{
  const {db,sqlite}=await fixture(t);
  failLastBatch(db);
  await assert.rejects(moveEvent(SCOPE,'e','p2','failing-move'));
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,'p');
  assert.equal(project(sqlite,'p').context_version,0);
  assert.equal(project(sqlite,'p2').context_version,0);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_narratives WHERE freshness='current'"),3);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox'),0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM mutation_replays'),0);
});

test('a failed trash transaction rolls the record and visible project back together',async t=>{
  const {db,sqlite}=await fixture(t);
  failLastBatch(db);
  await assert.rejects(moveEventToTrash(SCOPE,'e','failing-trash'));
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,'p');
  assert.equal(project(sqlite,'p').context_version,0);
  assert.equal(count(sqlite,"SELECT count(*) n FROM workflow_narratives WHERE freshness='current'"),3);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox'),0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM trashed_events'),0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM mutation_replays'),0);
});

test('a failed restore transaction keeps the event and receipt in the bin',async t=>{
  const {db,sqlite}=await fixture(t);
  await moveEventToTrash(SCOPE,'e','setup-trash');
  const before=project(sqlite,'p'),outbox=count(sqlite,'SELECT count(*) n FROM workflow_outbox');
  failLastBatch(db);
  await assert.rejects(restoreEvent(SCOPE,'e','failing-restore'));
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,'prj_record_trash_ws');
  assert.deepEqual(project(sqlite,'p'),before);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox'),outbox);
  assert.equal(count(sqlite,"SELECT count(*) n FROM mutation_replays WHERE endpoint_scope='events/e/restore'"),0);
});

test('revoking permission before a move leaves both projects and the event unchanged',async t=>{
  const {db,sqlite}=await fixture(t),original=db.batch;
  db.batch=statements=>{
    sqlite.prepare("UPDATE workspace_members SET revoked_at=? WHERE actor_id='owner'").run(T);
    return original(statements);
  };
  await assert.rejects(moveEvent(SCOPE,'e','p2','revoked-move'),error=>error.status===403);
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,'p');
  assert.equal(project(sqlite,'p').context_version,0);
  assert.equal(project(sqlite,'p2').context_version,0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox'),0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM mutation_replays'),0);
});

test('revoking permission before a trash transaction leaves the event in place',async t=>{
  const {db,sqlite}=await fixture(t),original=db.batch;
  db.batch=statements=>{
    sqlite.prepare("UPDATE workspace_members SET revoked_at=? WHERE actor_id='owner'").run(T);
    return original(statements);
  };
  await assert.rejects(moveEventToTrash(SCOPE,'e','revoked-trash'),error=>error.status===403);
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,'p');
  assert.equal(project(sqlite,'p').context_version,0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox'),0);
  assert.equal(count(sqlite,'SELECT count(*) n FROM mutation_replays'),0);
});

test('revoking permission before restore rolls the event and the narrative queue back to the bin',async t=>{
  const {db,sqlite}=await fixture(t);
  await moveEventToTrash(SCOPE,'e','setup-trash');
  const before=project(sqlite,'p'),outbox=count(sqlite,'SELECT count(*) n FROM workflow_outbox');
  const original=db.batch;
  db.batch=statements=>{
    sqlite.prepare("UPDATE workspace_members SET revoked_at=? WHERE actor_id='owner'").run(T);
    return original(statements);
  };
  await assert.rejects(restoreEvent(SCOPE,'e','revoked-restore'),error=>error.status===403);
  assert.equal(row(sqlite,"SELECT project_id FROM events WHERE id='e'").project_id,'prj_record_trash_ws');
  assert.deepEqual(project(sqlite,'p'),before);
  assert.equal(count(sqlite,'SELECT count(*) n FROM workflow_outbox'),outbox);
  assert.equal(count(sqlite,"SELECT count(*) n FROM mutation_replays WHERE endpoint_scope='events/e/restore'"),0);
});
