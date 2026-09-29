import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {consumeNarrativeJobs} from '../lib/server/workflow/narrative-jobs.ts';
import {WORKFLOW_NARRATIVE_SCHEMA_VERSION} from '../lib/domain/workflow-narrative.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const dbModule='data:text/javascript,'+encodeURIComponent(`
  export const getD1=()=>globalThis.narrativeLocationDb;
  export const getBindings=()=>globalThis.narrativeLocationBindings;
  export const getEvidenceBucket=()=>globalThis.narrativeLocationBucket;
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
  load(url,context,next){
    if(url.startsWith('file:') && url.endsWith('.ts') && fileURLToPath(url).startsWith(root) && !url.includes('/node_modules/'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform'}),shortCircuit:true};
    return next(url,context);
  },
});
const {moveEvent}=await import('../lib/server/db/event-move-repository.ts');
const {moveEventToTrash,restoreEvent}=await import('../lib/server/db/event-trash-repository.ts');

const config={provider:'test',model:'test',reasoningEffort:'low',baseUrl:'https://model.invalid',maxOutputTokens:6000};
const usage={inputTokens:10,outputTokens:5,cachedTokens:0,providerRequestId:'test-response'};
const later=()=>new Date(Date.now()+5000).toISOString();

async function publishQueuedNarrative(db,prefix){
  const result=await consumeNarrativeJobs(db,{
    config,clock:later,random:()=>0,
    provider:()=>({async summarizeWorkflow(input){
      return {output:{schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:input.eventId,
        sentences:input.bullets.map(b=>({text:`${prefix}: ${b.text}`,claim_refs:b.claimRefs}))},usage};
    }}),
  });
  assert.equal(result.succeeded,1);
}

test('a record moved from a high-version project shows its new target narrative after move and restore',async t=>{
  const f=await workflowDatabase();
  t.after(()=>{
    delete globalThis.narrativeLocationDb;
    delete globalThis.narrativeLocationBindings;
    delete globalThis.narrativeLocationBucket;
    f.close();
  });
  seed(f.sqlite);
  globalThis.narrativeLocationDb=f.db;
  globalThis.narrativeLocationBindings={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
  globalThis.narrativeLocationBucket={async get(){return null;},async delete(){}};
  f.sqlite.prepare('DELETE FROM claim_relations').run();
  f.sqlite.prepare("UPDATE projects SET context_version=10,ledger_version=10,scenario_status='confirmed',next_event_sequence=2 WHERE id='p'").run();
  insert(f.sqlite,'projects',{id:'p2',workspace_id:'ws',name:'Target',scenario_status:'confirmed'});
  insert(f.sqlite,'workflow_narratives',{
    id:'source-history',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',scope_kind:'mixed',
    based_on_context_version:10,text:'源项目旧概要',freshness:'current',input_hash:'source-history',
    sentence_refs_json:JSON.stringify([{text:'源项目旧概要',claimRefs:[{claimId:'budget',claimVersionId:'budget_v1'}],reviewState:'draft'}]),
    created_at:T,updated_at:T,
  });

  await moveEvent(SCOPE,'e','p2','narrative-move');
  assert.equal(f.sqlite.prepare("SELECT context_version FROM projects WHERE id='p2'").get().context_version,1);
  assert.equal(f.sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='source-history'").get().freshness,'stale');
  let snapshot=await readWorkspace(f.db,SCOPE,'e',{},later());
  assert.match(snapshot.narrative.text,/源项目旧概要/,'historical text stays readable while its replacement is queued');
  await publishQueuedNarrative(f.db,'目标项目新概要');
  snapshot=await readWorkspace(f.db,SCOPE,'e',{},later());
  assert.equal(snapshot.narrative.freshness,'current');
  assert.match(snapshot.narrative.text,/目标项目新概要/);
  assert.equal(snapshot.narrative.basedOnContextVersion,1);

  await moveEventToTrash(SCOPE,'e','narrative-trash');
  await restoreEvent(SCOPE,'e','narrative-restore');
  assert.equal(f.sqlite.prepare("SELECT context_version FROM projects WHERE id='p2'").get().context_version,3);
  snapshot=await readWorkspace(f.db,SCOPE,'e',{},later());
  assert.match(snapshot.narrative.text,/目标项目新概要/,'the last target summary remains readable during regeneration');
  await publishQueuedNarrative(f.db,'恢复后的新概要');
  snapshot=await readWorkspace(f.db,SCOPE,'e',{},later());
  assert.equal(snapshot.narrative.freshness,'current');
  assert.match(snapshot.narrative.text,/恢复后的新概要/);
  assert.equal(snapshot.narrative.basedOnContextVersion,3);
  assert.equal(f.sqlite.prepare("SELECT freshness FROM workflow_narratives WHERE id='source-history'").get().freshness,'stale');
});
