import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,SCOPE,T,insert} from './helpers/workflow-database.mjs';
import {seedReaffirmedRecord} from './helpers/reaffirmed-fixture.mjs';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {parseWorkflowRequest} from '../lib/shared/workflow-v2.ts';
async function setup(t,targets=['budget']){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.prepare("UPDATE claims SET review_status='verified'").run();seedReaffirmedRecord(f.sqlite,{targets});return f;}
const snapshot=(db,id='e2')=>readWorkspace(db,SCOPE,id,{},T);
const decide=(db,operation='confirm',id='budget',version=0,key='mention-choice')=>dispatchWorkflowCommand(db,SCOPE,['reaffirmed-mentions',`repeat-${id}`,'decisions'],{expectedContextVersion:version,targetRef:{claimId:id,claimVersionId:`${id}_v1`},operation},key);
const undo=(db,r,version=r.contextVersion,key='undo-choice')=>dispatchWorkflowCommand(db,SCOPE,['decisions',r.mutationId,'revert'],{expectedContextVersion:version,expectedDecisionRevision:1},key);
test('mention request strictly validates operation, frozen target and context without caller evidence or text',()=>{
 assert.equal(parseWorkflowRequest('MentionDecisionRequest',{expectedContextVersion:0,operation:'confirm',targetRef:{claimId:'b',claimVersionId:'v'}}).operation,'confirm');
 for(const patch of [{newText:'a'},{operation:'accept_action'},{expectedContextVersion:-1},{targetRef:{claimId:'b'}}])assert.throws(()=>parseWorkflowRequest('MentionDecisionRequest',{expectedContextVersion:0,operation:'confirm',targetRef:{claimId:'b',claimVersionId:'v'},...patch}));
});
test('confirmation retains exact old identity, adds native evidence once, preserves original version and can fully undo',async t=>{
 const {db,sqlite}=await setup(t),before=await snapshot(db);assert.equal(before.bullets.length,0);const r=await decide(db);assert.equal(r.contextVersion,1);const w=await snapshot(db);assert.equal(w.bullets[0].id,'budget');assert.equal(w.bullets[0].reviewState,'accepted');assert.equal(w.reaffirmedMentions[0].associationState,'confirmed');assert.equal(sqlite.prepare('SELECT count(*) n FROM claim_occurrences').get().n,1);assert.equal(sqlite.prepare("SELECT count(*) n FROM evidence_refs WHERE event_id='e2'").get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM claims').get().n,3);assert.equal((await snapshot(db,'e')).bullets.find(b=>b.id==='budget').text,'预算大约三十万');assert.deepEqual(await decide(db),r);await undo(db,r);const restored=await snapshot(db);assert.equal(restored.bullets.length,0);assert.equal(restored.reaffirmedMentions[0].associationState,'proposed');assert.equal((await snapshot(db,'e')).bullets.find(b=>b.id==='budget').reviewState,'accepted');assert.equal(sqlite.prepare("SELECT count(*) n FROM occurrence_verdicts WHERE action='revert'").get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM claim_occurrences').get().n,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM mutation_guards').get().n,0);
});
test('confirmation of an already completed action continues its completion and result without reopening',async t=>{
 const {db}=await setup(t,['action']);await dispatchWorkflowCommand(db,SCOPE,['actions','action','transitions'],{expectedContextVersion:0,expectedActionRevision:1,operation:'complete'},'complete-original');const r=await decide(db,'confirm','action',1);assert.equal((await snapshot(db)).actions[0].executionState,'completed');await undo(db,r);assert.equal((await snapshot(db,'e')).actions[0].executionState,'completed');
});
test('association changes never dirty a frozen accepted action basis',async t=>{
 const {db,sqlite}=await setup(t);insert(sqlite,'action_metadata',{claim_id:'action',workspace_id:'ws',project_id:'p',event_id:'e',basis_version_refs_json:'[{"claimId":"budget","claimVersionId":"budget_v1"}]',basis_state:'current'});const r=await decide(db);assert.equal((await snapshot(db,'e')).actions[0].basisState,'current');await undo(db,r);assert.equal((await snapshot(db,'e')).actions[0].basisState,'current');
});
test('later source replacement hides the repeat while the original still has its own valid evidence',async t=>{
 const {db,sqlite}=await setup(t);await decide(db);sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset2'").run();assert.equal((await snapshot(db)).reaffirmedMentions[0].sourceStatus,'stale');const original=(await snapshot(db,'e')).bullets.find(b=>b.id==='budget');assert.equal(original.sourceStatus,'ready');assert.equal(original.text,'预算大约三十万');
});
test('conversion detaches the proposal into one source-backed draft without copying the old action or acceptance',async t=>{
 const {db,sqlite}=await setup(t,['action']);const r=await decide(db,'convert','action'),w=await snapshot(db);assert.equal(w.reaffirmedMentions.length,0);assert.equal(w.bullets.length,1);assert.equal(w.bullets[0].reviewState,'draft');assert.equal(w.bullets[0].origin,'ai_suggestion');assert.equal(w.bullets[0].sourceStatus,'ready');assert.equal(w.actions.length,0);const created=sqlite.prepare("SELECT * FROM claims WHERE event_id='e2'").get();assert.notEqual(created.id,'action');assert.equal(created.source,'occurrence_conversion');await undo(db,r);assert.equal((await snapshot(db)).bullets.length,0);assert.equal((await snapshot(db)).reaffirmedMentions[0].associationState,'proposed');assert.equal((await snapshot(db,'e')).actions[0].executionState,'open');assert.equal(sqlite.prepare('pragma foreign_key_check').all().length,0);
});
test('a converted draft edited or accepted later blocks whole association undo',async t=>{
 const {db}=await setup(t),r=await decide(db,'convert'),w=await snapshot(db),card=w.reviewCards[0];await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{expectedContextVersion:w.contextVersion,expectedCardRevision:card.revision,operation:'confirm',members:card.memberRefs.map(ref=>({...ref,operation:'confirm'}))},'accept-independent');await assert.rejects(undo(db,r,2),e=>e.code==='dependency_conflict');assert.equal((await snapshot(db)).bullets[0].reviewState,'accepted');
});
test('ignore can be undone without changing original review or losing a readable new source',async t=>{
 const {db}=await setup(t),r=await decide(db,'reject');assert.equal((await snapshot(db)).reaffirmedMentions.length,0);assert.equal((await snapshot(db,'e')).bullets.find(b=>b.id==='budget').reviewState,'accepted');await undo(db,r);assert.equal((await snapshot(db)).reaffirmedMentions[0].associationState,'proposed');
});
test('a changed old target cannot be silently confirmed but can become an independent draft',async t=>{
 const {db,sqlite}=await setup(t);insert(sqlite,'claim_versions',{id:'budget_v2',claim_id:'budget',version_no:2,statement:'预算三十五万',source:'human'});sqlite.prepare("UPDATE claims SET current_version_id='budget_v2' WHERE id='budget'").run();await assert.rejects(decide(db),e=>e.code==='dependency_conflict');await decide(db,'convert');assert.equal((await snapshot(db)).bullets[0].text,'预算大约三十万');
});
test('an archived old target can be ignored or detached without revealing its body',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE events SET material_status='archived' WHERE id='e'").run();assert.equal((await snapshot(db)).reaffirmedMentions[0].targetText,null);await assert.rejects(decide(db),e=>e.code==='dependency_conflict');const r=await decide(db,'reject');await undo(db,r);await decide(db,'convert','budget',2,'independent-archived');assert.equal((await snapshot(db)).bullets[0].sourceStatus,'ready');
});
test('source or metadata drift inside the transaction rolls back native verdicts, decisions and context',async t=>{
 const {db,sqlite}=await setup(t),batch=db.batch;let fired=false;db.batch=async statements=>{if(!fired){fired=true;sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset2'").run();}return batch(statements);};await assert.rejects(decide(db),e=>e.code==='version_conflict');for(const table of ['occurrence_verdicts','claim_occurrences','workflow_decisions','workflow_mention_decisions','mutation_replays','mutation_guards'])assert.equal(sqlite.prepare('SELECT count(*) n FROM '+table).get().n,0);assert.equal(sqlite.prepare("SELECT context_version FROM projects WHERE id='p'").get().context_version,0);assert.equal(sqlite.prepare("SELECT status FROM claim_occurrence_candidates WHERE id='repeat-budget'").get().status,'pending');
});
test('permission revocation inside save cannot publish an association or return its replay',async t=>{
 const {db,sqlite}=await setup(t),batch=db.batch;db.batch=async statements=>{sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);return batch(statements);};await assert.rejects(decide(db),e=>e.code==='forbidden');assert.equal(sqlite.prepare('SELECT count(*) n FROM occurrence_verdicts').get().n,0);
});
test('reconfirmation after undo keeps one logical repeat and retains every native audit row',async t=>{
 const {db,sqlite}=await setup(t,['question']),r=await decide(db,'confirm','question');assert.equal(sqlite.prepare("SELECT repeat_count FROM claims WHERE id='question'").get().repeat_count,1);await undo(db,r);assert.equal(sqlite.prepare("SELECT repeat_count FROM claims WHERE id='question'").get().repeat_count,0);await decide(db,'confirm','question',2,'second-confirm');assert.equal(sqlite.prepare("SELECT repeat_count FROM claims WHERE id='question'").get().repeat_count,1);assert.equal(sqlite.prepare('SELECT count(*) n FROM occurrence_verdicts').get().n,3);
});
test('unpublished old-run proposals cannot be processed after a newer readable run',async t=>{
 const {db,sqlite}=await setup(t);insert(sqlite,'extraction_runs',{id:'run3',workspace_id:'ws',project_id:'p',event_id:'e2',status:'succeeded',idempotency_key:'new',input_hash:'new',input_snapshot_hash:'new',input_manifest_json:'[]',context_version:0,context_snapshot_hash:'new',prompt_version:'synthetic',schema_version:'synthetic',parser_version:'test',created_at:'2026-09-29T11:00:00.000Z'});sqlite.prepare("UPDATE events SET active_run_id='run3' WHERE id='e2'").run();await assert.rejects(decide(db,'reject'),e=>e.code==='version_conflict');assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n,0);
});
test('malformed stored evidence fields are rejected before native writes while ignoring stays available',async t=>{
 const {db,sqlite}=await setup(t),c=sqlite.prepare("SELECT evidence_ref_json FROM claim_occurrence_candidates WHERE id='repeat-budget'").get(),payload=JSON.parse(c.evidence_ref_json);payload.evidence[0].startMs='wrong';sqlite.prepare("UPDATE claim_occurrence_candidates SET evidence_ref_json=? WHERE id='repeat-budget'").run(JSON.stringify(payload));await assert.rejects(decide(db,'convert'),e=>e.status===422);assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_decisions').get().n,0);await decide(db,'reject');
});
test('candidate fingerprint changes after the choice block reversal without discarding its audit or old accepted state',async t=>{
 const {db,sqlite}=await setup(t),r=await decide(db);const c=sqlite.prepare("SELECT evidence_ref_json FROM claim_occurrence_candidates WHERE id='repeat-budget'").get(),payload=JSON.parse(c.evidence_ref_json);payload.statement='后来改写的提议';sqlite.prepare("UPDATE claim_occurrence_candidates SET evidence_ref_json=? WHERE id='repeat-budget'").run(JSON.stringify(payload));await assert.rejects(undo(db,r),e=>e.code==='dependency_conflict');assert.equal(sqlite.prepare("SELECT status FROM claim_occurrence_candidates WHERE id='repeat-budget'").get().status,'confirmed');assert.equal(sqlite.prepare("SELECT count(*) n FROM occurrence_verdicts WHERE action='revert'").get().n,0);assert.equal((await snapshot(db,'e')).bullets.find(b=>b.id==='budget').reviewState,'accepted');
});
