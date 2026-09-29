import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,insert,claim,relation,SCOPE,T} from './helpers/workflow-database.mjs';
import {seedReaffirmedRecord,confirmReaffirmed,REPEAT_QUOTE} from './helpers/reaffirmed-fixture.mjs';
import {saveReviewProgress} from '../lib/server/workflow/review-progress.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {readProjectOverview} from '../lib/server/workflow/overview-service.ts';
import {createReport} from '../lib/server/workflow/report-service.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readMcpTool} from '../lib/server/mcp/readers.ts';
async function setup(t,options={}){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);f.sqlite.prepare("UPDATE claims SET review_status='verified'").run();seedReaffirmedRecord(f.sqlite,options);return f;}
const snap=(db,event='e2',query={})=>readWorkspace(db,SCOPE,event,query,T);
const editPayload=(sqlite,change)=>{const current=JSON.parse(sqlite.prepare("SELECT evidence_ref_json FROM claim_occurrence_candidates WHERE id='repeat-budget'").get().evidence_ref_json);change(current);sqlite.prepare("UPDATE claim_occurrence_candidates SET evidence_ref_json=? WHERE id='repeat-budget'").run(JSON.stringify(current));};
test('pending repeat remains readable with current source but never adopts its old accepted claim',async t=>{
 const {db}=await setup(t),w=await snap(db),m=w.reaffirmedMentions[0];assert.equal(w.coverage.complete,true);assert.equal(w.bullets.length,0);assert.equal(w.actions.length,0);assert.equal(w.counts.needsDecisionCount,0);assert.equal(m.associationState,'proposed');assert.equal(m.statement,'预算大约三十万');assert.equal(m.targetText,'预算大约三十万');assert.equal(m.sources[0].quote,REPEAT_QUOTE);assert.equal(m.targetState,'current');
});
test('confirmed repeat retains the original stable fact identity and exact version in the new record',async t=>{
 const {db,sqlite}=await setup(t,{confirmed:true}),before=await snap(db),old=await snap(db,'e');assert.equal(before.reaffirmedMentions[0].associationState,'confirmed');assert.deepEqual(before.bullets[0].claimRefs,[{claimId:'budget',claimVersionId:'budget_v1'}]);assert.equal(before.bullets[0].reviewState,'accepted');assert.equal(old.bullets.find(b=>b.id==='budget').reviewState,'accepted');assert.equal(sqlite.prepare("SELECT count(*) n FROM claims WHERE type='budget'").get().n,1);
});
test('repeated action completion uses the existing action and does not answer a repeated question',async t=>{
 const {db}=await setup(t,{targets:['action','question'],confirmed:true}),w=await snap(db);assert.equal(w.actions[0].id,'action');assert.equal(w.questions[0].id,'question');
 await dispatchWorkflowCommand(db,SCOPE,['actions','action','transitions'],{expectedContextVersion:0,expectedActionRevision:w.actions[0].revision,operation:'complete'},'complete-repeat');const next=await snap(db);assert.equal(next.actions[0].id,'action');assert.equal(next.actions[0].executionState,'completed');assert.equal(next.questions[0].resolutionState,'open');assert.equal((await snap(db,'e')).actions[0].executionState,'completed');
});
test('repeated question uses its existing answer state and project queues count stable resources once',async t=>{
 const {db,sqlite}=await setup(t,{targets:['action','question'],confirmed:true});claim(sqlite,'answer','other','报价十二万',{status:'verified'});relation(sqlite,'answered','answer','question','resolves');let w=await snap(db);assert.equal(w.questions[0].resolutionState,'resolved');assert.equal(w.bullets.filter(b=>b.id==='answer').length,1);let overview=await readProjectOverview(db,SCOPE,'p',{},T);assert.equal(overview.nextActions.length,1);assert.equal(overview.nextActions[0].eventId,'e');assert.equal(overview.openQuestions.length,0);sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE id='answered'").run();overview=await readProjectOverview(db,SCOPE,'p',{},T);assert.equal(overview.openQuestions.length,1);assert.equal(overview.openQuestions[0].eventId,'e');
});
test('a status label without the matching native confirmation ledger cannot adopt the old resource',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claim_occurrence_candidates SET status='confirmed'").run();const w=await snap(db);assert.equal(w.reaffirmedMentions[0].associationState,'proposed');assert.equal(w.bullets.length,0);
});
test('a later version retains the frozen mention and separates current wording',async t=>{
 const {db,sqlite}=await setup(t,{confirmed:true});insert(sqlite,'claim_versions',{id:'budget_v2',claim_id:'budget',version_no:2,statement:'预算变为三十五万',source:'human'});sqlite.prepare("UPDATE claims SET current_version_id='budget_v2' WHERE id='budget'").run();sqlite.prepare("INSERT INTO evidence_refs (id,workspace_id,project_id,event_id,claim_version_id,kind,asset_version_id,segment_ids_json,quote_raw,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict) SELECT 'updated-ev',workspace_id,project_id,event_id,'budget_v2',kind,asset_version_id,segment_ids_json,quote_raw,evidence_role,provenance_grade,structural_validation_status,semantic_support_verdict FROM evidence_refs WHERE id='budget_ev'").run();const w=await snap(db);assert.equal(w.bullets.length,0);assert.equal(w.reaffirmedMentions[0].targetState,'changed');assert.equal(w.reaffirmedMentions[0].targetText,'预算大约三十万');assert.equal(w.reaffirmedMentions[0].currentText,'预算变为三十五万');assert.equal(w.reaffirmedMentions[0].claimRef.claimVersionId,'budget_v1');
});
for(const lifecycle of ['superseded','withdrawn'])test(`a ${lifecycle} target stays visible as a historical mention without restarting it`,async t=>{
 const {db,sqlite}=await setup(t,{targets:['action'],confirmed:true});sqlite.prepare('UPDATE claims SET lifecycle_status=? WHERE id=?').run(lifecycle,'action');const w=await snap(db);assert.equal(w.actions.length,0);assert.equal(w.reaffirmedMentions[0].targetState,'retired');assert.equal(w.reaffirmedMentions[0].sources[0].quote,REPEAT_QUOTE);
});
for(const mutation of ['archive','move'])test(`an original record ${mutation} conceals its body while retaining the authorized new occurrence source`,async t=>{
 const {db,sqlite}=await setup(t,{confirmed:true});if(mutation==='archive')sqlite.prepare("UPDATE events SET material_status='archived' WHERE id='e'").run();else {insert(sqlite,'projects',{id:'p2',workspace_id:'ws',name:'Other project'});sqlite.prepare("UPDATE events SET project_id='p2' WHERE id='e'").run();sqlite.prepare("UPDATE claims SET project_id='p2' WHERE event_id='e'").run();}const w=await snap(db),m=w.reaffirmedMentions[0];assert.equal(m.targetState,'unavailable');assert.equal(m.targetText,null);assert.equal(m.currentText,null);assert.equal(m.targetEventId,null);assert.equal(m.sources[0].quote,REPEAT_QUOTE);assert.equal(w.bullets.length,0);
});
for(const invalid of ['foreign-asset','foreign-segment','quote','malformed'])test(`an invalid ${invalid} proposal cannot expose a forged or unscoped source body`,async t=>{
 const {db,sqlite}=await setup(t);if(invalid==='malformed')sqlite.prepare("UPDATE claim_occurrence_candidates SET evidence_ref_json='not json'").run();else editPayload(sqlite,p=>{if(invalid==='foreign-asset')p.evidence[0].assetVersionId='av';if(invalid==='foreign-segment')p.evidence[0].segmentIdsJson='["seg"]';if(invalid==='quote')p.evidence[0].quoteRaw='private forged content';});const m=(await snap(db)).reaffirmedMentions[0];assert.equal(m.sourceStatus,'missing');assert.equal(m.statement,null);assert.ok(m.sources.every(s=>s.quote===null));
});
test('source replacement expires cached mentions and hides old quote text without any legacy context bump',async t=>{
 const {db,sqlite}=await setup(t,{confirmed:true}),w=await snap(db);sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset2'").run();await assert.rejects(snap(db,'e2',{snapshotId:w.snapshotId}),e=>e.code==='cursor_expired');const next=await snap(db);assert.equal(next.reaffirmedMentions[0].sourceStatus,'stale');assert.equal(next.reaffirmedMentions[0].statement,null);assert.equal(next.reaffirmedMentions[0].sources[0].quote,null);assert.equal(next.bullets.length,0);
});
test('new published extraction retires pending proposals while confirmed associations stay visible',async t=>{
 const {db,sqlite}=await setup(t,{targets:['budget','action']});confirmReaffirmed(sqlite,'budget');insert(sqlite,'extraction_runs',{id:'run3',workspace_id:'ws',project_id:'p',event_id:'e2',status:'succeeded',idempotency_key:'new',input_hash:'new',input_snapshot_hash:'new',input_manifest_json:'[]',context_version:0,context_snapshot_hash:'new',prompt_version:'synthetic',schema_version:'synthetic',parser_version:'test',created_at:'2026-09-29T11:00:00.000Z'});sqlite.prepare("UPDATE events SET active_run_id='run3' WHERE id='e2'").run();assert.deepEqual((await snap(db)).reaffirmedMentions.map(m=>m.id),['repeat-budget']);
});
test('zero-review copy includes the pending repeat with its association label and formal export excludes it',async t=>{
 const {db,sqlite}=await setup(t),request={expectedContextVersion:0,scope:'mixed',format:'plain_text',eventIds:['e2']};const copied=await createReport(db,SCOPE,{projectId:'p',key:'repeat-copy',request});assert.match(copied.content,/预算大约三十万.*AI 关联待核对/);assert.doesNotMatch(copied.content,/正在整理/);assert.equal(sqlite.prepare("SELECT count(*) n FROM derived_dependencies WHERE derived_id=? AND claim_version_id='budget_v1'").get(copied.id).n,1);const formal=await createReport(db,SCOPE,{projectId:'p',key:'repeat-formal',request:{...request,scope:'accepted'}});assert.doesNotMatch(formal.content,/三十万/);
});
test('read-only MCP exposes the repeat as a proposed association and revocation blocks the same snapshot',async t=>{
 const {db,sqlite}=await setup(t),body=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e2',views:['record']});assert.equal(body.items[0].kind,'reaffirmed_mention');assert.equal(body.items[0].associationState,'proposed');assert.equal(body.items[0].sources[0].quote,REPEAT_QUOTE);const before=await snap(db);sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);await assert.rejects(snap(db,'e2',{snapshotId:before.snapshotId}),e=>e.code==='not_found');await assert.rejects(readMcpTool(db,SCOPE,'get_record_views',{record_id:'e2'}),e=>e.code==='not_found');assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,0);
});


test('bookmarking a repeated resource keeps its card in the original record and later edits use that owner',async t=>{
 const {db,sqlite}=await setup(t,{confirmed:true}),w=await snap(db),card=w.reviewCards.find(c=>c.id==='wfc_budget');assert.equal(card.eventId,'e');
 await saveReviewProgress(db,SCOPE,'e2',{snapshotId:w.snapshotId,lastCardId:card.id,mode:'bookmark'},'repeat-bookmark',T);assert.equal(sqlite.prepare("SELECT event_id FROM workflow_cards WHERE id='wfc_budget'").get().event_id,'e');
 const next=await snap(db);await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{expectedContextVersion:next.contextVersion,expectedCardRevision:card.revision,operation:'edit',members:[{...card.memberRefs[0],operation:'edit',newText:'预算三十五万',origin:'user_input',evidenceRefIds:[]}]},'edit-original-from-repeat');assert.equal((await snap(db)).reaffirmedMentions[0].targetState,'changed');assert.equal((await snap(db,'e')).bullets.find(b=>b.id==='budget').text,'预算三十五万');
});
test('changing the frozen target type or losing its old source never silently remaps a confirmed association',async t=>{
 const {db,sqlite}=await setup(t,{confirmed:true});sqlite.prepare("UPDATE claims SET type='next_action' WHERE id='budget'").run();let w=await snap(db);assert.equal(w.reaffirmedMentions[0].targetState,'changed');assert.equal(w.actions.length,0);sqlite.prepare("UPDATE claims SET type='budget' WHERE id='budget'").run();sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='budget_ev'").run();w=await snap(db);assert.equal(w.reaffirmedMentions[0].targetText,null);assert.equal(w.reaffirmedMentions[0].sources[0].quote,REPEAT_QUOTE);assert.equal(w.bullets.length,0);
});
test('repeated accepted action basis prompts remain one project decision',async t=>{
 const {db,sqlite}=await setup(t,{targets:['action'],confirmed:true});insert(sqlite,'action_metadata',{claim_id:'action',workspace_id:'ws',project_id:'p',event_id:'e',basis_version_refs_json:'[{"claimId":"question","claimVersionId":"question_v1"}]',basis_state:'needs_review'});const old=await snap(db,'e'),current=await snap(db);assert.equal(old.counts.needsDecisionCount,1);assert.equal(current.counts.needsDecisionCount,1);assert.equal((await readProjectOverview(db,SCOPE,'p',{},T)).counts.needsDecisionCount,1);
});

async function sameIntentRepeat(t,targets=['action']) {
 const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
 claim(f.sqlite,'agreement','decision','约定向供应商询价',{status:'verified'});
 relation(f.sqlite,'agreement-basis','action','agreement','informed_by','active');
 f.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='action'").run();
 insert(f.sqlite,'workflow_cards',{id:'intent',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'same_intent:agreement',revision:1,kind:'action',title:'向供应商询价',needs_decision:0,reason_code:'action_choice',reason:'决定是否加入跟进',disposition:'processed',created_at:T,updated_at:T});
 for(const id of ['action','agreement'])insert(f.sqlite,'card_members',{id:`intent_${id}`,workspace_id:'ws',card_id:'intent',claim_id:id,claim_version_id:`${id}_v1`,role:'primary',created_at:T});
 seedReaffirmedRecord(f.sqlite,{targets,confirmed:true});return f;
}
test('one repeated action keeps its original two-member agreement card without a second review entry',async t=>{
 const {db}=await sameIntentRepeat(t),old=await snap(db,'e'),later=await snap(db);
 assert.ok(old.reviewCards.some(c=>c.id==='intent' && c.sameIntent));
 assert.equal(later.actions[0].id,'action');assert.equal(later.reviewCards.some(c=>c.id==='wfc_action'),false);
 assert.equal(later.reviewCards.some(c=>c.id==='intent'),false);
 assert.equal(later.counts.needsDecisionCount,0);
});
test('a prior bookmark card no longer duplicates the original agreement in either record',async t=>{
 const {db,sqlite}=await sameIntentRepeat(t);
 insert(sqlite,'workflow_cards',{id:'wfc_action',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'action',revision:1,kind:'action',title:'向供应商询价',needs_decision:0,reason:'',disposition:'processed',created_at:T,updated_at:T});
 insert(sqlite,'card_members',{id:'wfc_action_member',workspace_id:'ws',card_id:'wfc_action',claim_id:'action',claim_version_id:'action_v1',role:'primary',created_at:T});
 const old=await snap(db,'e'),later=await snap(db);
 assert.equal(old.reviewCards.filter(c=>c.memberRefs.some(r=>r.claimId==='action')).length,1);
 assert.equal(old.reviewCards.find(c=>c.id==='intent')?.sameIntent?.actionRef.claimId,'action');
 assert.equal(later.reviewCards.some(c=>c.id==='wfc_action'),false);
});
test('both repeated members reuse their one original card, while a broken group falls back to independent review',async t=>{
 const {db,sqlite}=await sameIntentRepeat(t,['action','agreement']);let later=await snap(db);
 assert.deepEqual(later.reviewCards.map(c=>c.id),['intent']);assert.ok(later.reviewCards[0].sameIntent);
 sqlite.prepare("UPDATE claim_relations SET status='inactive' WHERE id='agreement-basis'").run();
 later=await snap(db);assert.equal(later.reviewCards.some(c=>c.id==='intent'),false);
 assert.equal(later.reviewCards.some(c=>c.id==='wfc_action'),true);
});
