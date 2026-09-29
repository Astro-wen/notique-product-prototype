import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {seedReaffirmedRecord} from './helpers/reaffirmed-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const dbModule='data:text/javascript,'+encodeURIComponent('export const getD1=()=>globalThis.nativeBridgeDb; export const getBindings=()=>globalThis.nativeBridgeBindings; export const getEvidenceBucket=()=>({delete:async()=>{}});');
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
const {applyClaimVerdict,withdrawClaim,applyOccurrenceVerdict}=await import('../lib/server/db/verdict-repository.ts');
const {completeProjectAction,reopenProjectAction}=await import('../lib/server/db/buyer-journey-repository.ts');
const {getRequestScope,initializeRequestWorkspace,assertRequestAccess}=await import('../lib/server/http/context.ts');
const {getEvent,createExtractionRun,sweepStaleAssetUploadsForWorkspaces}=await import('../lib/server/db/core-repository.ts');
const {getWorkflowSnapshot}=await import('../lib/server/db/workflow-repository.ts');

async function fixture(t){const f=await workflowDatabase();t.after(()=>{delete globalThis.nativeBridgeDb;delete globalThis.nativeBridgeBindings;f.close();});seed(f.sqlite);globalThis.nativeBridgeDb=f.db;globalThis.nativeBridgeBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};return f;}

test('V1 request access follows current member roles and does not revive a revoked account',async t=>{
  const {sqlite}=await fixture(t);
  globalThis.nativeBridgeBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
  sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();
  const scope=await getRequestScope(new Request('http://localhost/api/v1/projects',{headers:{'oai-authenticated-user-email':'owner@example.com'}}));
  await assertRequestAccess(scope,'read');await assertRequestAccess(scope,'write');
  sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
  await assertRequestAccess(scope,'read');await assert.rejects(assertRequestAccess(scope,'write'),e=>e.status===403);
  sqlite.prepare("UPDATE workspace_members SET revoked_at=?").run(T);
  await assert.rejects(assertRequestAccess(scope,'read'),e=>e.status===403);
  await initializeRequestWorkspace(scope);
  await assert.rejects(assertRequestAccess(scope,'write'),e=>e.status===403);
});

test('a verified first user can own only a fresh private workspace',async t=>{
  const f=await workflowDatabase();t.after(()=>{delete globalThis.nativeBridgeDb;delete globalThis.nativeBridgeBindings;f.close();});
  globalThis.nativeBridgeDb=f.db;globalThis.nativeBridgeBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'fresh'};
  const scope=await getRequestScope(new Request('http://localhost/api/v1/projects',{headers:{'oai-authenticated-user-email':'first@example.com'}}));
  await assertRequestAccess(scope,'read');
  await initializeRequestWorkspace(scope);await assertRequestAccess(scope,'write');
  assert.equal(f.sqlite.prepare("SELECT role FROM workspace_members WHERE workspace_id='fresh'").get().role,'owner');
  globalThis.nativeBridgeBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
  seed(f.sqlite);f.sqlite.prepare("DELETE FROM workspace_members WHERE workspace_id='ws'").run();
  await assert.rejects(assertRequestAccess({workspaceId:'ws',actorId:'first@example.com'},'read'),e=>e.status===403);
});

test('the fixed public demo actor remains usable without private membership',async t=>{
  await fixture(t);globalThis.nativeBridgeBindings={APP_ENV:'production',AUTH_GATEWAY:'public',INTERNAL_WORKSPACE_ID:'ws'};
  const scope=await getRequestScope(new Request('http://localhost/api/v1/projects',{headers:{'oai-authenticated-user-email':'forged@example.com'}}));
  assert.equal(scope.actorId,'public@notique.test');await assertRequestAccess(scope,'read');await assertRequestAccess(scope,'write');
});

test('V1 reads do not expire or delete assets; internal recovery does the scoped cleanup',async t=>{
  const {sqlite}=await fixture(t);
  insert(sqlite,'assets',{id:'abandoned',workspace_id:'ws',project_id:'p',event_id:'e',kind:'text',filename:'unfinished.txt',current_version_id:null,processing_status:'uploading',created_at:T,updated_at:T});
  const before=sqlite.prepare('SELECT total_changes() n').get().n;
  await getEvent(SCOPE,'e');
  await getWorkflowSnapshot(SCOPE,'p');
  assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(sqlite.prepare("SELECT processing_status FROM assets WHERE id='abandoned'").get().processing_status,'uploading');
  assert.equal(await sweepStaleAssetUploadsForWorkspaces(),1);
  assert.equal(sqlite.prepare("SELECT failure_code FROM assets WHERE id='abandoned'").get().failure_code,'UPLOAD_EXPIRED');
  assert.equal(sqlite.prepare("SELECT material_status FROM events WHERE id='e'").get().material_status,'ready');
  const settled=sqlite.prepare('SELECT total_changes() n').get().n;
  await getEvent(SCOPE,'e');await getWorkflowSnapshot(SCOPE,'p');
  assert.equal(sqlite.prepare('SELECT total_changes() n').get().n,settled);
});

test('selecting a new analysis run expires the old V2 snapshot in the same batch',async t=>{
  const {db,sqlite}=await fixture(t);
  globalThis.nativeBridgeBindings={...globalThis.nativeBridgeBindings,AI_PROVIDER:'openai',AI_MODEL:'synthetic',AI_API_KEY:'synthetic'};
  sqlite.prepare("UPDATE projects SET scenario_status='confirmed' WHERE id='p'").run();
  sqlite.prepare("UPDATE events SET material_status='ready' WHERE id='e'").run();
  const old=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_snapshots WHERE project_id=?').get('p').n,1);
  const result=await createExtractionRun(SCOPE,'e','analysis-replacement',['av'],false,{guard:{sql:'1=1',values:[]},sourceRevision:0});
  assert.equal(result.created,true);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_snapshots WHERE project_id=?').get('p').n,0);
  assert.equal(sqlite.prepare("SELECT active_run_id FROM events WHERE id='e'").get().active_run_id,result.run.id);
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:old.snapshotId},T),e=>e.code==='cursor_expired');
});

test('actual V1 claim confirmation and withdrawal invalidate the V2 page in the same native transaction',async t=>{
  const {db,sqlite}=await fixture(t);
  insert(sqlite,'workflow_narratives',{id:'prior',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',scope_kind:'mixed',based_on_context_version:0,text:'预算三十万',freshness:'current',input_hash:'old'});
  const old=await readWorkspace(db,SCOPE,'e',{},T);
  const saved=await applyClaimVerdict(SCOPE,'budget',{action:'confirm',base_version_id:'budget_v1',retain_relation_ids:[]},'native-confirm');
  assert.equal(saved.claim.review_status,'verified');
  assert.equal(sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='prior'").get().freshness,'stale');
  assert.equal(sqlite.prepare("SELECT input_revision FROM workflow_outbox WHERE project_id='p' AND event_id='e' AND kind='narrative'").get().input_revision,1);
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:old.snapshotId},T),e=>e.code==='cursor_expired');
  assert.equal((await applyClaimVerdict(SCOPE,'budget',{action:'confirm',base_version_id:'budget_v1',retain_relation_ids:[]},'native-confirm')).verdictId,saved.verdictId);
  const removed=await withdrawClaim(SCOPE,'budget',{baseVersionId:'budget_v1'},'native-withdraw');
  assert.equal(removed.claim.lifecycle_status,'withdrawn');
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,2);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE project_id='p' AND event_id='e' AND kind='narrative'").get().n,2);
});

test('actual V1 completion and reopening keep one stable action and update V2 snapshots',async t=>{
  const {db,sqlite}=await fixture(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  const completed=await completeProjectAction(SCOPE,'action','native-complete');
  assert.equal(completed.actionClaimId,'action');
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).actions[0].executionState,'completed');
  assert.equal(sqlite.prepare("SELECT count(*) n FROM action_metadata WHERE claim_id=?").get(completed.completionClaimId).n,0,'completion is not a new follow-up action');
  await reopenProjectAction(SCOPE,'action','native-reopen');
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).actions[0].executionState,'open');
  assert.equal(sqlite.prepare("SELECT workflow_revision FROM claims WHERE id='action'").get().workflow_revision,3);
});

test('actual V1 recurrence verdict advances project context and stores a V2 refresh task',async t=>{
  const {db,sqlite}=await fixture(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();seedReaffirmedRecord(sqlite,{targets:['budget']});
  const result=await applyOccurrenceVerdict(SCOPE,'repeat-budget',{action:'confirm',targetBaseVersionId:'budget_v1'},'native-repeat');
  assert.equal(result.status,'confirm');
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE project_id='p' AND event_id='e2' AND kind='narrative' AND input_revision=1").get().n,1);
  assert.equal((await readWorkspace(db,SCOPE,'e2',{},T)).reaffirmedMentions[0].associationState,'confirmed');
});

test('revoking V1 edit permission just before the commit leaves no verdict or V2 side effect',async t=>{
  const {db,sqlite}=await fixture(t),original=db.batch;
  db.batch=async statements=>{sqlite.prepare('UPDATE workspace_members SET revoked_at=? WHERE actor_id=?').run(T,'owner');return original(statements);};
  await assert.rejects(applyClaimVerdict(SCOPE,'budget',{action:'confirm',base_version_id:'budget_v1',retain_relation_ids:[]},'revoked-race'));
  assert.equal(sqlite.prepare("SELECT review_status FROM claims WHERE id='budget'").get().review_status,'pending');
  assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM verdicts').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_replays').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,0);
});
