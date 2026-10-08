import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {seedReaffirmedRecord} from './helpers/reaffirmed-fixture.mjs';
import {readProjectOverview} from '../lib/server/workflow/overview-service.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
import {readMcpTool} from '../lib/server/mcp/readers.ts';
import {priorityCards} from '../lib/domain/workflow-v2.ts';
import {buildContextPack} from '../lib/domain/context-pack.ts';
import {timelineCategory} from '../lib/domain/project-timeline.ts';
import {comparisonOrder} from '../lib/domain/comparison-order.ts';

async function setup(t) {const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);return f;}
const overview=db=>readProjectOverview(db,SCOPE,'p',{},T);
test('one conversation keeps its facts as first records even with same-conversation relations',async t=>{
  const {db,sqlite}=await setup(t);
  claim(sqlite,'local-update','budget','预算调整为三十五万',{status:'verified'});
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();
  relation(sqlite,'local-change','local-update','budget','contradicts');
  const s=await overview(db);
  assert.equal(s.recordSummaries.length,1);
  assert.ok(s.timeline.length>0);
  assert.ok(s.timeline.every(entry=>entry.kind==='introduced' && !entry.before && !entry.sourceDiff));
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claim_relations WHERE id='local-change'").get().n,1);
});

test('multiple unrelated conversations do not create changes just because both are uploaded',async t=>{
  const {db,sqlite}=await setup(t);
  seedReaffirmedRecord(sqlite,{targets:[]});
  noteClaim(sqlite,'unrelated','requirement','需要三个会议室','e2','run2');
  const s=await overview(db);
  assert.equal(s.recordSummaries.length,2);
  assert.ok(s.timeline.some(entry=>entry.eventId==='e2'));
  assert.ok(s.timeline.every(entry=>entry.kind==='introduced'));
});

test('a repeated mention from its own conversation is not a project-history repeat',async t=>{
  const {db,sqlite}=await setup(t);
  seedReaffirmedRecord(sqlite,{targets:['budget']});
  sqlite.prepare("UPDATE claim_occurrence_candidates SET event_id='e' WHERE target_claim_id='budget'").run();
  assert.ok(!(await overview(db)).timeline.some(entry=>entry.kind==='repeated'));
});
test('comparison display follows conversation dates and leaves unknown or equal dates unordered',()=>{
  const early={title:'需求讨论',occurredAt:'2026-09-23T10:00:00Z'};
  const late={title:'方案调整',occurredAt:'2026-10-01T10:00:00Z'};
  assert.equal(comparisonOrder(early,late),'forward');
  assert.equal(comparisonOrder(late,early),'reverse');
  assert.equal(comparisonOrder(early,early),null);
  assert.equal(comparisonOrder({...early,title:'会议日期待核对'},late),null);
  assert.equal(comparisonOrder({...early,occurredAt:'invalid'},late),null);
});
function noteClaim(sqlite,id,type,text,eventId,runId) {
  claim(sqlite,id,type,text,{status:'verified',origin:'user_input'});
  sqlite.prepare('UPDATE claims SET event_id=?,first_event_id=?,extraction_run_id=? WHERE id=?').run(eventId,eventId,runId,id);
  insert(sqlite,'user_notes',{id:`note-${id}`,workspace_id:'ws',project_id:'p',claim_id:id,body:text,verdict_id:`verdict-${id}`,author_id:'owner'});
  sqlite.prepare("UPDATE evidence_refs SET event_id=?,kind='user_note',user_note_id=?,asset_version_id=NULL WHERE claim_version_id=?").run(eventId,`note-${id}`,`${id}_v1`);
}
function third(sqlite) {
  insert(sqlite,'events',{id:'e3',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'确认报价',occurred_at:'2026-09-30T10:00:00.000Z',sequence_no:3,active_run_id:'run3'});
  insert(sqlite,'extraction_runs',{id:'run3',workspace_id:'ws',project_id:'p',event_id:'e3',status:'succeeded',idempotency_key:'run3',input_hash:'run3',input_snapshot_hash:'run3',input_manifest_json:'[]',context_version:0,context_snapshot_hash:'run3',prompt_version:'test',schema_version:'test',parser_version:'test'});
}

test('standalone price difference is visible with both sources even at equal conversation dates', async t => {
  const {db,sqlite}=await setup(t);seedReaffirmedRecord(sqlite,{targets:[]});
  noteClaim(sqlite,'ice-before','budget','夏日小铺冰棍每根 2 元。','e','run');
  noteClaim(sqlite,'ice-after','budget','夏日小铺冰棍每根 3 元。','e2','run2');
  sqlite.prepare("UPDATE events SET occurred_at=? WHERE id IN ('e','e2')").run(T);
  insert(sqlite,'draft_link_candidates',{id:'ice-price',workspace_id:'ws',project_id:'p',extraction_run_id:'run2',source_claim_id:'ice-after',source_claim_version_id:'ice-after_v1',target_draft_claim_id:'ice-before',target_draft_claim_version_id:'ice-before_v1',type:'changed',reason:'同一商品的单价不同。',confidence:0.95});
  const s=await overview(db),entry=s.timeline.find(e=>e.id==='draft-link-ice-price');
  assert.equal(entry.proposalType,'changed');
  assert.equal(entry.before.text,'夏日小铺冰棍每根 2 元。');
  assert.equal(entry.after.text,'夏日小铺冰棍每根 3 元。');
  assert.equal(entry.before.sourceStatus,'ready');assert.equal(entry.after.sourceStatus,'ready');
  assert.equal(sqlite.prepare("SELECT lifecycle_status FROM claims WHERE id='ice-before'").get().lifecycle_status,'active');
});

test('three conversations retain original budget, revision, repeated question and its eventual answer',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id IN ('budget','question')").run();
  seedReaffirmedRecord(sqlite,{targets:['question'],confirmed:true});
  noteClaim(sqlite,'revised','budget','预算调整为三十五万','e2','run2');
  relation(sqlite,'budget-change','revised','budget','supersedes');
  sqlite.prepare("UPDATE claims SET lifecycle_status='superseded' WHERE id='budget'").run();
  let s=await overview(db);
  const update=s.timeline.find(e=>e.kind==='updated');
  assert.equal(update.before.text,'预算大约三十万');assert.equal(update.after.text,'预算调整为三十五万');
  assert.equal(update.before.eventId,'e');assert.equal(update.after.eventId,'e2');
  assert.equal(s.timeline.filter(e=>e.kind==='repeated').length,1);assert.equal(s.openQuestions.length,1);
  assert.ok(s.timeline.some(e=>e.kind==='introduced' && e.after.ref.claimId==='budget'));
  assert.ok(!s.currentBullets.some(b=>b.id==='budget'));
  third(sqlite);noteClaim(sqlite,'answer','other','报价十二万元','e3','run3');relation(sqlite,'answer-rel','answer','question','resolves');
  s=await overview(db);assert.equal(s.openQuestions.length,0);
  const closed=s.timeline.find(e=>e.kind==='resolved');assert.equal(closed.before.text,'费用是多少？');assert.equal(closed.after.text,'报价十二万元');
  assert.equal(s.timeline[0].eventId,'e3');assert.ok(s.timeline.some(e=>e.kind==='repeated'));
  const mcp=await readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p',limit:100});
  const remote=mcp.items.find(e=>e.kind==='project_change' && e.changeKind==='updated');
  assert.deepEqual(remote.before,update.before);assert.deepEqual(remote.after,update.after);
  assert.equal(remote.sources.length,2);assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_outbox').get().n,0);
  assert.ok(!mcp.items.some(e=>e.kind==='project_change' && e.changeKind==='introduced'));
});

test('money remains filterable when its extracted type is preference or measurement',()=>{
  assert.equal(timelineCategory({type:'preference',statement:'Expected sale price in the high-$1.3-million range.'}),'金额');
  assert.equal(timelineCategory({type:'measurement',statement:'Starting list price at $1,250,000.'}),'金额');
  assert.equal(timelineCategory({type:'measurement',statement:'A 4,000-square-foot house.'}),'数量');
  assert.equal(timelineCategory({type:'requirement',statement:'Plan for 30 participants at Harbor Hall.'}),'数量');
});

for(const proposalType of ['same','changed','conflicting','possibly_answered'])test(`unreviewed ${proposalType} comparison exposes both sources without advancing the ledger`,async t=>{
  const {db,sqlite}=await setup(t);seedReaffirmedRecord(sqlite);
  noteClaim(sqlite,'candidate','budget','预算四十万','e2','run2');
  const target=proposalType==='possibly_answered'?'question':'budget';
  insert(sqlite,'draft_link_candidates',{id:'draft-comparison',workspace_id:'ws',project_id:'p',extraction_run_id:'run2',source_claim_id:'candidate',source_claim_version_id:'candidate_v1',target_draft_claim_id:target,target_draft_claim_version_id:`${target}_v1`,type:proposalType,reason:'Model proposal',confidence:0.9});
  let s=await overview(db),comparison=s.timeline.find(e=>e.id==='draft-link-draft-comparison');
  assert.equal(comparison.proposalType,proposalType);assert.equal(comparison.reviewState,'draft');
  assert.equal(comparison.before.ref.claimId,target);assert.equal(comparison.before.sourceStatus,'ready');
  assert.equal(comparison.after.text,'预算四十万');assert.equal(s.openQuestions.length,1);
  assert.equal(sqlite.prepare("SELECT count(*) n FROM claim_relations WHERE source_claim_version_id='candidate_v1'").get().n,0);
  assert.ok(!(await readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p',limit:100})).items.some(e=>e.id===comparison.id));
  sqlite.prepare("UPDATE draft_link_candidates SET target_draft_claim_version_id='superseded-version' WHERE id='draft-comparison'").run();
  s=await overview(db);assert.ok(!s.timeline.some(e=>e.id==='draft-link-draft-comparison'));
});

test('confirmation verifies wording without resolving the question',async t=>{
  const {db}=await setup(t),s=await readWorkspace(db,SCOPE,'e',{},T),card=s.reviewCards.find(c=>c.members.some(m=>m.claimId==='budget'));
  await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'confirm',members:[{...card.memberRefs[0],operation:'confirm'}]},'confirm-statement');
  const next=await overview(db);assert.equal(next.openQuestions.length,1);assert.ok(!next.timeline.some(e=>e.kind==='resolved'));
});

test('a repeated fragment of a changed statement does not display as reaffirming the entire old claim',async t=>{
  const {db,sqlite}=await setup(t);seedReaffirmedRecord(sqlite);
  noteClaim(sqlite,'changed','budget','预算四十万，日期不变','e2','run2');
  noteClaim(sqlite,'fragment','budget','日期不变','e2','run2');
  for(const [id,source,type] of [['change','changed','changed'],['partial','fragment','same']])insert(sqlite,'draft_link_candidates',{id,workspace_id:'ws',project_id:'p',extraction_run_id:'run2',source_claim_id:source,source_claim_version_id:`${source}_v1`,target_draft_claim_id:'budget',target_draft_claim_version_id:'budget_v1',type,reason:'Comparison',confidence:0.9});
  let s=await overview(db);
  assert.ok(s.timeline.some(e=>e.id==='draft-link-change'));
  assert.ok(!s.timeline.some(e=>e.id==='draft-link-partial'));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM draft_link_candidates').get().n,2);
  sqlite.prepare("UPDATE draft_link_candidates SET source_claim_version_id='stale' WHERE id='change'").run();
  s=await overview(db);assert.ok(s.timeline.some(e=>e.id==='draft-link-partial'));
});

test('unaccepted replacement is a comparison and cannot advance current state',async t=>{
  const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();seedReaffirmedRecord(sqlite);
  noteClaim(sqlite,'candidate','budget','预算四十万','e2','run2');sqlite.prepare("UPDATE claims SET review_status='pending',source='ai' WHERE id='candidate'").run();
  relation(sqlite,'candidate-change','candidate','budget','supersedes','proposed');
  const s=await overview(db);assert.equal(s.timeline.find(e=>e.id==='relation-candidate-change').kind,'conflict');assert.ok(s.currentBullets.some(b=>b.id==='budget'));
  const m=await readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p',limit:100});assert.ok(!m.items.some(e=>e.id==='relation-candidate-change'));
});

test('source replacement hides timeline wording and invalidates the snapshot',async t=>{
  const {db,sqlite}=await setup(t),before=await overview(db);
  sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
  await assert.rejects(readProjectOverview(db,SCOPE,'p',{snapshotId:before.snapshotId},T),error=>error.code==='cursor_expired');
  const next=await overview(db);assert.ok(next.timeline.every(e=>e.after.text===null));
});

test('a later upload with an earlier conversation date never displays as a newer conclusion',async t=>{
  const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();seedReaffirmedRecord(sqlite);
  noteClaim(sqlite,'candidate','budget','旧记录预算四十万','e2','run2');relation(sqlite,'reversed','candidate','budget','supersedes');sqlite.prepare("UPDATE claims SET lifecycle_status='superseded' WHERE id='budget'").run();
  sqlite.prepare("UPDATE events SET occurred_at='2026-09-01T10:00:00Z' WHERE id='e2'").run();
  const s=await overview(db);assert.equal(s.timeline[0].eventId,'e');assert.equal(s.timeline.find(e=>e.id==='relation-reversed').kind,'conflict');
});

test('a draft comparison created by a backfilled old file is grouped at the later conversation without reversing its saved relation',async t=>{
  const {db,sqlite}=await setup(t);seedReaffirmedRecord(sqlite);
  noteClaim(sqlite,'backfill','budget','较早预算四十万','e2','run2');
  sqlite.prepare("UPDATE events SET occurred_at='2026-09-01T10:00:00Z' WHERE id='e2'").run();
  insert(sqlite,'draft_link_candidates',{id:'backfill-link',workspace_id:'ws',project_id:'p',extraction_run_id:'run2',source_claim_id:'backfill',source_claim_version_id:'backfill_v1',target_draft_claim_id:'budget',target_draft_claim_version_id:'budget_v1',type:'changed',reason:'Same budget',confidence:0.9});
  const entry=(await overview(db)).timeline.find(e=>e.id==='draft-link-backfill-link');
  assert.equal(entry.eventId,'e');
  assert.equal(entry.after.ref.claimId,'backfill');
  assert.equal(entry.before.ref.claimId,'budget');
  assert.equal(sqlite.prepare("SELECT source_claim_id FROM draft_link_candidates WHERE id='backfill-link'").get().source_claim_id,'backfill');
});

test('uncertain money enters review before actions, clear facts remain optional, confirmation removes the prompt',async t=>{
  const {db,sqlite}=await setup(t);
  sqlite.prepare("UPDATE claim_versions SET uncertainty_json=? WHERE id='budget_v1'").run(JSON.stringify({question:'预算是三十万还是三十五万？',alternatives:['三十万','三十五万'],reason:'金额不清楚'}));
  let s=await readWorkspace(db,SCOPE,'e',{},T),card=s.reviewCards.find(c=>c.id==='wfc_budget');
  assert.equal(priorityCards(s.reviewCards)[0].id,card.id);assert.equal(card.reasonCode,'key_detail');assert.deepEqual(card.members[0].keyDetail.alternatives,['三十万','三十五万']);
  await dispatchWorkflowCommand(db,SCOPE,['review-cards',card.id,'decisions'],{expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,operation:'confirm',members:[{...card.memberRefs[0],operation:'confirm'}]},'confirm-money');
  s=await readWorkspace(db,SCOPE,'e',{},T);assert.ok(!priorityCards(s.reviewCards).some(c=>c.id===card.id));
});

test('context provides actual conversation dates and orders drafts by date rather than insertion sequence',()=>{
  const events=[{id:'old',occurredAt:'2026-09-01T00:00:00Z',sequenceNo:9},{id:'recent',occurredAt:'2026-09-20T00:00:00Z',sequenceNo:1},{id:'now',occurredAt:'2026-10-01T00:00:00Z',sequenceNo:10}];
  const pack=buildContextPack({ledger:{projectId:'p',locale:'zh-CN',scenario:{status:'unconfirmed'},claims:[],events,claimVersions:[],relations:[],withdraws:[]},contextVersion:0,eventId:'now',transcriptSegments:[],draftContextEnabled:true,draftClaims:events.slice(0,2).map(e=>({claimId:e.id,claimVersionId:`${e.id}-v1`,eventId:e.id,eventSequenceNo:e.sequenceNo,type:'budget',statement:'金额',confidence:1,evidenceRefIds:['ev']}))});
  assert.equal(pack.new_event.occurred_at,events[2].occurredAt);assert.deepEqual(pack.draft_context.claims.map(c=>c.eventId),['old','recent']);assert.equal(pack.draft_context.claims[0].eventOccurredAt,events[0].occurredAt);
});

test('new comparison inputs remove date-pending import timestamps while a paid old input retains its frozen shape',()=>{
  const event={id:'e',title:'会议日期待核对',occurredAt:'2026-10-07T00:00:00Z',sequenceNo:2};
  const draft={claimId:'old',claimVersionId:'old-v1',eventId:'old-event',eventTitle:'Date pending',eventOccurredAt:'2026-10-06T00:00:00Z',eventSequenceNo:1,type:'budget',statement:'Budget $100',confidence:1,evidenceRefIds:['ev']};
  const input={ledger:{projectId:'p',locale:'en-US',scenario:{status:'unconfirmed'},claims:[],events:[event],claimVersions:[],relations:[],withdraws:[]},contextVersion:0,eventId:'e',transcriptSegments:[],draftContextEnabled:true,sourceIdentityEnabled:true,draftClaims:[draft]};
  const current=buildContextPack({...input,dateReliabilityEnabled:true});
  assert.equal(current.new_event.occurred_at,null);
  assert.equal(current.draft_context.claims[0].eventOccurredAt,null);
  const paid=buildContextPack(input);
  assert.equal(paid.new_event.occurred_at,event.occurredAt);
  assert.equal(paid.draft_context.claims[0].eventOccurredAt,draft.eventOccurredAt);
});
