import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { workflowDatabase,seed,claim,relation,insert,SCOPE,T } from './helpers/workflow-database.mjs';
import { loadWorkflowLedger, readWorkspace } from '../lib/server/workflow/snapshot-store.ts';
import { projectWorkspace } from '../lib/domain/workflow-projection.ts';

async function fixture(t) { const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f; }
const errorCode = code => error => error.code === code;

test('real SQL preserves the full unreviewed record, separates decisions and reads source coverage',async t=>{
  const {db,sqlite}=await fixture(t);
  const result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.bullets.length,3);
  assert.equal(result.counts.draftCount,3);
  assert.equal(result.counts.needsDecisionCount,1);
  assert.equal(result.actions.length,0);
  assert.equal(result.questions[0].resolutionState,'open');
  assert.deepEqual(result.coverage,{totalSegments:1,completedSegments:1,complete:true,unprocessedRanges:[]});
  assert.equal(result.reviewCards.find(c=>c.kind==='action').members[0].supportStatus,'fully_supports');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM workflow_outbox').get().n,0,'reading must not schedule generation');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM verdicts').get().n,0);
});

test('completion targets an action and does not answer its question',async t=>{
  const {db,sqlite}=await fixture(t);
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
  claim(sqlite,'completion','other','已联系供应商',{status:'verified'});
  relation(sqlite,'done','completion','action','resolves');
  let result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.actions[0].executionState,'completed');
  assert.equal(result.questions[0].resolutionState,'open');
  claim(sqlite,'answer','other','报价十二万',{status:'verified'});
  relation(sqlite,'answered','answer','question','resolves');
  result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.questions[0].resolutionState,'resolved');
  assert.deepEqual(result.questions[0].answerRefs,[{claimId:'answer',claimVersionId:'answer_v1'}]);
  sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE id='answered'").run();
  result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.questions[0].resolutionState,'open');
  assert.equal(result.actions[0].executionState,'completed');
});

test('scope, role revocation and deleted projects invalidate cached access',async t=>{
  const {db,sqlite}=await fixture(t);
  const initial=await readWorkspace(db,SCOPE,'e',{},T);
  await assert.rejects(readWorkspace(db,{...SCOPE,actorId:'stranger'},'e',{},T),errorCode('not_found'));
  await assert.rejects(readWorkspace(db,{...SCOPE,workspaceId:'other'},'e',{},T),errorCode('not_found'));
  sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:initial.snapshotId},T),errorCode('not_found'));
  sqlite.prepare('UPDATE workspace_members SET revoked_at=NULL').run();
  sqlite.prepare('UPDATE projects SET deleted_at=?').run(T);
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:initial.snapshotId},T),errorCode('not_found'));
});

test('old source replacement expires snapshots even if a legacy write did not bump context',async t=>{
  const {db,sqlite}=await fixture(t);
  const initial=await readWorkspace(db,SCOPE,'e',{},T);
  insert(sqlite,'asset_versions',{id:'av2',asset_id:'asset',version_no:2,content_sha256:'new',mime_type:'text/plain',size_bytes:30,r2_original_key:'synthetic/new',finalized_at:T});
  sqlite.prepare("UPDATE assets SET current_version_id='av2'").run();
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:initial.snapshotId},T),errorCode('cursor_expired'));
  const next=await readWorkspace(db,SCOPE,'e',{},T);
  assert.ok(next.bullets.every(b=>b.sourceStatus==='stale'));
  assert.equal(next.coverage.complete,false);
  assert.equal(next.contextVersion,initial.contextVersion);
});

test('review pagination retains complete bullets and global counts',async t=>{
  const {db}=await fixture(t);
  const first=await readWorkspace(db,SCOPE,'e',{limit:1},T);
  assert.equal(first.reviewCards.length,1);assert.equal(first.bullets.length,3);
  const second=await readWorkspace(db,SCOPE,'e',{snapshotId:first.snapshotId,cursor:first.nextCursor,limit:1},T);
  assert.notEqual(first.reviewCards[0].id,second.reviewCards[0].id);
  assert.equal(first.snapshotId,second.snapshotId);assert.deepEqual(first.counts,second.counts);
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:first.snapshotId,cursor:'999'},T),errorCode('cursor_expired'));
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:first.snapshotId},'2026-09-28T10:16:00Z'),errorCode('cursor_expired'));
  await assert.rejects(readWorkspace(db,SCOPE,'e',{minContextVersion:1},T),errorCode('snapshot_busy'));
});

test('new runs retain accepted history while dropping pending drafts from the prior run',async t=>{
  const {db,sqlite}=await fixture(t);
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();
  sqlite.prepare("UPDATE events SET active_run_id='newrun'").run();
  const result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.deepEqual(result.bullets.map(b=>b.id),['budget']);
  assert.equal(result.counts.draftCount,0);assert.equal(result.coverage.complete,false);
});

test('old relation endpoints and missing source support cannot resolve a question',async t=>{
  const {db,sqlite}=await fixture(t);
  claim(sqlite,'answer','other','报价十二万',{status:'verified'});
  relation(sqlite,'answered','answer','question','resolves');
  sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='answer_ev'").run();
  let result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.questions[0].resolutionState,'open');
  sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='valid' WHERE id='answer_ev'").run();
  insert(sqlite,'claim_versions',{id:'question_v2',claim_id:'question',version_no:2,statement:'新范围的费用是多少？',source:'human'});
  sqlite.prepare("UPDATE claims SET current_version_id='question_v2' WHERE id='question'").run();
  result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.questions[0].resolutionState,'open');
  assert.deepEqual(result.questions[0].answerRefs,[]);
});

test('deferral is per actor and does not erase drafts or change acceptance',async t=>{
  const {db,sqlite}=await fixture(t);
  insert(sqlite,'workflow_cards',{id:'wfc_action',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'action',kind:'action',title:'询价',needs_decision:1,reason_code:'action_choice'});
  insert(sqlite,'card_members',{id:'cm',workspace_id:'ws',card_id:'wfc_action',claim_id:'action',claim_version_id:'action_v1'});
  insert(sqlite,'review_deferrals',{id:'df',workspace_id:'ws',card_id:'wfc_action',actor_id:'owner',until_at:'2026-09-29T10:00:00Z'});
  const result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.equal(result.counts.needsDecisionCount,0);assert.equal(result.counts.draftCount,3);
  insert(sqlite,'workspace_members',{id:'wm2',workspace_id:'ws',actor_id:'other',role:'viewer'});
  assert.equal((await readWorkspace(db,{...SCOPE,actorId:'other'},'e',{},T)).counts.needsDecisionCount,1);
});

test('narrative with old wording or review state is marked stale',async t=>{
  const {db}=await fixture(t);
  const ledger=await loadWorkflowLedger(db,SCOPE,'p');
  ledger.narratives=[{event_id:'e',text:'预算约三十万',sentence_refs_json:JSON.stringify([{text:'预算约三十万',claimRefs:[{claimId:'budget',claimVersionId:'budget_v1'}],reviewState:'accepted'}]),based_on_context_version:0,freshness:'current',scope_kind:'mixed',created_at:T}];
  assert.equal(projectWorkspace(ledger,'e',T,'s').narrative.freshness,'stale');
});

test('incremental migration preserves existing versions, relations, decisions and replay receipts',async t=>{
  const f=await workflowDatabase({through:22});t.after(f.close);seed(f.sqlite,{legacy:true});
  insert(f.sqlite,'verdicts',{id:'old',workspace_id:'ws',project_id:'p',claim_id:'budget',action:'confirm',base_version_id:'budget_v1',user_id:'owner',created_at:T});
  insert(f.sqlite,'mutation_replays',{id:'replay',workspace_id:'ws',actor_id:'owner',endpoint_scope:'legacy',idempotency_key:'saved',request_hash:'hash',response_json:'{"saved":true}',created_at:T});
  const tables=['claims','claim_versions','claim_relations','evidence_refs','verdicts','mutation_replays'];
  const before=Object.fromEntries(tables.map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const migration=await readFile(new URL('../drizzle/0023_workflow_v2.sql',import.meta.url),'utf8');
  f.sqlite.exec(migration.replaceAll('--> statement-breakpoint',''));
  for(const table of tables) {
    const rows=f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    assert.equal(rows.length,before[table].length);
    for(let i=0;i<rows.length;i++) for(const [key,value] of Object.entries(before[table][i])) assert.equal(rows[i][key],value,`${table}.${key}`);
  }
  assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('coverage excludes generated reading drafts and temporary chunks, and treats completed warnings as processed',async t=>{
  const {db,sqlite}=await fixture(t);
  sqlite.prepare("UPDATE extraction_runs SET status='completed_with_warnings'").run();
  for(const [id,metadata] of [['readable',{analysis_source:false,artifact_kind:'readable_transcript'}],['chunk',{analysis_source:false,transcription_chunk:true}]]) {
    insert(sqlite,'assets',{id,workspace_id:'ws',project_id:'p',event_id:'e',kind:'transcript',filename:'derived',current_version_id:id+'_v',processing_status:'ready',metadata_json:JSON.stringify(metadata)});
    insert(sqlite,'asset_versions',{id:id+'_v',asset_id:id,version_no:1,content_sha256:id,mime_type:'text/plain',size_bytes:30,r2_original_key:'synthetic/'+id,finalized_at:T});
    insert(sqlite,'text_segments',{id:id+'_s',workspace_id:'ws',project_id:'p',event_id:'e',asset_id:id,asset_version_id:id+'_v',ordinal:0,parser_version:'test',text_raw:'derived',text_normalized:'derived'});
  }
  const result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.deepEqual(result.coverage,{totalSegments:1,completedSegments:1,complete:true,unprocessedRanges:[]});
  insert(sqlite,'assets',{id:'waiting-audio',workspace_id:'ws',project_id:'p',event_id:'e',kind:'audio',filename:'waiting',processing_status:'ready',current_version_id:'waiting-version'});
  assert.equal((await readWorkspace(db,SCOPE,'e',{},T)).coverage.complete,false);
});

test('moving a record cannot reuse the prior project snapshot',async t=>{
  const {db,sqlite}=await fixture(t);
  const first=await readWorkspace(db,SCOPE,'e',{},T);
  insert(sqlite,'projects',{id:'new-project',workspace_id:'ws',name:'New'});
  sqlite.prepare("UPDATE events SET project_id='new-project' WHERE id='e'").run();
  await assert.rejects(readWorkspace(db,SCOPE,'e',{snapshotId:first.snapshotId},T),errorCode('cursor_expired'));
});

test('a transcript from a replaced audio version is stale even when its text asset is still current',async t=>{
  const {db,sqlite}=await fixture(t);
  sqlite.prepare("UPDATE assets SET metadata_json='{\"source_audio_asset_version_id\":\"old-audio\"}' WHERE id='asset'").run();
  insert(sqlite,'assets',{id:'audio',workspace_id:'ws',project_id:'p',event_id:'e',kind:'audio',filename:'audio',current_version_id:'new-audio',processing_status:'ready'});
  const result=await readWorkspace(db,SCOPE,'e',{},T);
  assert.ok(result.bullets.every(b=>b.sourceStatus==='stale'));
  assert.equal(result.coverage.complete,false);
});


test('reorganizing preserves the last published drafts until a replacement succeeds',async t=>{
  const {db,sqlite}=await fixture(t);
  insert(sqlite,'extraction_runs',{id:'replacement',workspace_id:'ws',project_id:'p',event_id:'e',status:'queued',idempotency_key:'replacement',input_hash:'replacement',input_snapshot_hash:'replacement',input_manifest_json:JSON.stringify([{asset_version_id:'av'}]),context_version:0,context_snapshot_hash:'replacement',prompt_version:'test',schema_version:'test',parser_version:'test',created_at:'2026-09-29T00:00:00Z'});
  sqlite.prepare("UPDATE events SET active_run_id='replacement'").run();
  for(const state of ['queued','processing','failed','cancelled']) {
    sqlite.prepare('UPDATE extraction_runs SET status=? WHERE id=?').run(state,'replacement');
    const record=await readWorkspace(db,SCOPE,'e',{},T);
    assert.equal(record.bullets.length,3,state);
    assert.equal(record.coverage.complete,false,'old text does not claim current coverage');
  }
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();
  sqlite.prepare("UPDATE extraction_runs SET status='succeeded' WHERE id='replacement'").run();
  const replaced=await readWorkspace(db,SCOPE,'e',{},T);
  assert.deepEqual(replaced.bullets.map(b=>b.id),['budget']);
  assert.equal(replaced.coverage.complete,true);
});
