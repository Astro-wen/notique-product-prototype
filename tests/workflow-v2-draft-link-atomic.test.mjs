import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const dbModule='data:text/javascript,'+encodeURIComponent('export const getD1=()=>globalThis.draftLinkDb; export const getBindings=()=>globalThis.draftLinkBindings;');
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
const {applyDraftLinkVerdict}=await import('../lib/server/db/buyer-journey-repository.ts');

async function fixture(t,{type='changed',source='action',target='budget',relationId=null}={}){
  const f=await workflowDatabase();
  t.after(()=>{delete globalThis.draftLinkDb;delete globalThis.draftLinkBindings;f.close();});
  seed(f.sqlite);
  globalThis.draftLinkDb=f.db;
  globalThis.draftLinkBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
  f.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id IN ('action','budget','question')").run();
  if(relationId)f.sqlite.prepare("UPDATE claim_relations SET status='active' WHERE id=?").run(relationId);
  insert(f.sqlite,'draft_link_candidates',{
    id:'link',workspace_id:'ws',project_id:'p',extraction_run_id:'run',
    source_claim_id:source,source_claim_version_id:`${source}_v1`,
    target_draft_claim_id:target,target_draft_claim_version_id:`${target}_v1`,
    type,reason:'Source comparison',confidence:0.9,status:'proposed',created_at:T,updated_at:T,
  });
  insert(f.sqlite,'workflow_narratives',{
    id:'prior',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',
    scope_kind:'mixed',based_on_context_version:0,text:'Earlier overview',freshness:'current',input_hash:'old',
  });
  return f;
}

function state(sqlite){
  return {
    candidate:sqlite.prepare("SELECT status FROM draft_link_candidates WHERE id='link'").get().status,
    project:{...sqlite.prepare("SELECT context_version,ledger_version FROM projects WHERE id='p'").get()},
    relations:sqlite.prepare("SELECT count(*) n FROM claim_relations WHERE status='active'").get().n,
    verdicts:sqlite.prepare('SELECT count(*) n FROM relation_verdicts').get().n,
    narrative:sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='prior'").get().freshness,
    outbox:sqlite.prepare("SELECT count(*) n FROM workflow_outbox WHERE kind='narrative'").get().n,
    replays:sqlite.prepare('SELECT count(*) n FROM mutation_replays').get().n,
    guards:sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,
  };
}

test('accepting a new draft relation publishes one atomic formal relation, verdict and V2 invalidation',async t=>{
  const {db,sqlite}=await fixture(t);
  const previous=await readWorkspace(db,SCOPE,'e',{},T);
  const saved=await applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'accept-new');
  assert.equal(saved.status,'accepted');
  assert.equal(sqlite.prepare('SELECT status FROM claim_relations WHERE id=?').get(saved.formalRelationId).status,'active');
  assert.equal(sqlite.prepare('SELECT relation_id FROM relation_verdicts').get().relation_id,saved.formalRelationId);
  assert.deepEqual(state(sqlite),{
    candidate:'accepted',project:{context_version:1,ledger_version:1},relations:1,verdicts:1,
    narrative:'stale',outbox:1,replays:1,guards:0,
  });
  assert.equal(sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='budget'").get().lifecycle_status,'superseded');
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:previous.snapshotId},T),error=>error.code==='cursor_expired');
  assert.deepEqual(await applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'accept-new'),saved);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM claim_relations').get().n,2,'replay does not make a second relation');
});

test('accepting an already formal relation still advances context and invalidates V2 atomically',async t=>{
  const {sqlite}=await fixture(t,{type:'same',source:'action',target:'question',relationId:'basis'});
  const saved=await applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'accept-existing');
  assert.equal(saved.formalRelationId,'basis');
  assert.deepEqual(state(sqlite),{
    candidate:'accepted',project:{context_version:1,ledger_version:1},relations:1,verdicts:0,
    narrative:'stale',outbox:1,replays:1,guards:0,
  });
});

test('a failure after relation creation rolls relation, candidate, ledger, V2 and receipt back together',async t=>{
  const {db,sqlite}=await fixture(t),before=state(sqlite),original=db.batch;
  db.batch=statements=>original([
    ...statements.slice(0,-1),
    db.prepare("INSERT INTO mutation_guards (id,guard_value,created_at) VALUES ('forced-failure',0,?)").bind(T),
    statements.at(-1),
  ]);
  await assert.rejects(applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'accept-fails'),error=>error.status===409);
  assert.deepEqual(state(sqlite),before);
  assert.equal(sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='budget'").get().lifecycle_status,'active');
});

test('revoking edit permission before the transaction leaves no partial accepted draft link',async t=>{
  const {db,sqlite}=await fixture(t),before=state(sqlite),original=db.batch;
  db.batch=statements=>{
    sqlite.prepare("UPDATE workspace_members SET revoked_at=? WHERE actor_id='owner'").run(T);
    return original(statements);
  };
  await assert.rejects(applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'accept-revoked'),error=>error.status===403);
  assert.deepEqual(state(sqlite),before);
});

test('a stale project version cannot accept an existing formal relation by skipping review',async t=>{
  const {sqlite}=await fixture(t,{type:'same',source:'action',target:'question',relationId:'basis'});
  sqlite.prepare("UPDATE projects SET context_version=1 WHERE id='p'").run();
  const before=state(sqlite);
  await assert.rejects(applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'stale-existing'),error=>error.status===409 && error.code==='CLAIM_VERSION_CONFLICT');
  assert.deepEqual(state(sqlite),before);
});

test('a draft link cannot silently mark a certain fact as an answered question',async t=>{
  const {sqlite}=await fixture(t,{type:'possibly_answered',source:'action',target:'budget'}),before=state(sqlite);
  await assert.rejects(applyDraftLinkVerdict(SCOPE,'link',{action:'accept',baseContextVersion:0},'invalid-resolve'),error=>error.status===422);
  assert.deepEqual(state(sqlite),before);
});
