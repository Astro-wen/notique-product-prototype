import assert from 'node:assert/strict';
import test from 'node:test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {workflowDatabase,seed,claim,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {mcpIdentity,setMcpConnection,assertMcpRead} from '../lib/server/mcp/access.ts';
import {handleMcpRequest} from '../lib/server/mcp/server.ts';
import {reserveMcpRequest,withMcpDeadline} from '../lib/server/mcp/limits.ts';
import {parseMcpConnectionStatus,parseWorkflowRequest} from '../lib/shared/workflow-v2.ts';
import {readMcpTool} from '../lib/server/mcp/readers.ts';
import {loadWorkflowLedger} from '../lib/server/workflow/snapshot-store.ts';
import {projectWorkspace} from '../lib/domain/workflow-projection.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';
const ENV={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
const IDENTITY={workspaceId:'ws',actorId:'owner',gatewaySubject:'sites-user'};
const headers={'oai-authenticated-user-email':'owner@example.com','oai-authenticated-user-id':'sites-user'};
async function setup(t){const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);await setMcpConnection(f.db,IDENTITY,ENV,true);return f;}
const clientFetch=db=>async(input,init)=>{const req=new Request(input,init);req.headers.set('oai-authenticated-user-email','owner@example.com');req.headers.set('oai-authenticated-user-id','sites-user');return handleMcpRequest(req,db,ENV);};
async function protocolClient(t,db){const client=new Client({name:'actual-sdk-client',version:'1.0'});const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{fetch:clientFetch(db)});await client.connect(transport);t.after(()=>client.close());return client;}
const unchanged=(sqlite)=>Object.fromEntries(['claims','claim_versions','claim_relations','workflow_outbox','extraction_runs','event_ai_artifact_runs','workflow_snapshots','verdicts','workflow_outcomes','outcome_versions','action_metadata','workflow_narratives'].map(table=>[table,sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
const send=(db,path,body)=>dispatchWorkflowCommand(db,SCOPE,path.split('/'),body,crypto.randomUUID());
const projected=async db=>projectWorkspace(await loadWorkflowLedger(db,SCOPE,'p'),'e',T,'');
async function acceptAction(db){const s=await projected(db),card=s.reviewCards.find(c=>c.id==='wfc_action');await send(db,'review-cards/wfc_action/decisions',{operation:'accept_action',expectedContextVersion:s.contextVersion,expectedCardRevision:card.revision,members:[{...card.memberRefs[0],operation:'accept_action'}]});}
async function transition(db,operation){const s=await projected(db);await send(db,'actions/action/transitions',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,operation});}
async function views(db,sqlite){const before=unchanged(sqlite),record=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e'}),brief=await readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p'});assert.deepEqual(unchanged(sqlite),before);return [record,brief];}
test('strict identity never uses anonymous demo or service credentials as a user',()=>{assert.throws(()=>mcpIdentity(new Request('http://localhost/mcp'),ENV),e=>e.status===401);assert.throws(()=>mcpIdentity(new Request('http://localhost/mcp',{headers:{'oai-authenticated-user-id':'service'}}),ENV),e=>e.status===401);assert.equal(mcpIdentity(new Request('http://localhost/mcp',{headers}),ENV).actorId,'owner@example.com');});
test('opt-in, expiry, revocation and membership loss are checked on every read',async t=>{const {db,sqlite}=await setup(t);assert.equal((await assertMcpRead(db,IDENTITY)).access,'members');await setMcpConnection(db,IDENTITY,ENV,false);await assert.rejects(assertMcpRead(db,IDENTITY),e=>e.status===403);await setMcpConnection(db,IDENTITY,ENV,true);sqlite.prepare('UPDATE access_grants SET expires_at=?').run(T);await assert.rejects(assertMcpRead(db,IDENTITY),e=>e.status===403);await setMcpConnection(db,IDENTITY,ENV,true);sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);await assert.rejects(setMcpConnection(db,IDENTITY,ENV,true),e=>e.status===403);await assert.rejects(assertMcpRead(db,IDENTITY),e=>e.status===403);});
test('public demo consent creates only a viewer, while private membership is required',async t=>{const {db,sqlite}=await setup(t),i={...IDENTITY,actorId:'another@example.com',gatewaySubject:'other'};await assert.rejects(setMcpConnection(db,i,ENV,true),e=>e.status===403);await setMcpConnection(db,i,{...ENV,AUTH_GATEWAY:'public'},true);assert.equal(sqlite.prepare('SELECT role FROM workspace_members WHERE actor_id=?').get(i.actorId).role,'viewer');await assert.rejects(assertMcpRead(db,{...i,gatewaySubject:'forged-other'}),e=>e.status===403);});
test('official client discovers six readonly tools and reads current projections without creating work',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();await setMcpConnection(db,{...IDENTITY,actorId:'owner@example.com'},ENV,true);const before=unchanged(sqlite);const client=await protocolClient(t,db);const list=await client.listTools();assert.equal(list.tools.length,6);assert.ok(list.tools.every(tool=>tool.annotations.readOnlyHint));assert.ok(!list.tools.some(tool=>/create|retry|write|delete/.test(tool.name)));
 for(const [name,args] of [['list_projects',{}],['list_records',{project_id:'p'}],['get_project_brief',{project_id:'p'}],['get_record_views',{record_id:'e',views:['record','summary','chapters']}],['get_record_excerpt',{record_id:'e'}],['get_evidence',{evidence_id:'budget_ev'}]]){const reply=await client.callTool({name,arguments:args});assert.equal(reply.isError,undefined,JSON.stringify(reply));assert.ok(reply.structuredContent);}
 assert.deepEqual(unchanged(sqlite),before);const reply=await client.callTool({name:'list_projects',arguments:{workspace_id:'other'}});assert.equal(reply.isError,true);
});
test('official client rejects authorization revoked between requests',async t=>{const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();const i={...IDENTITY,actorId:'owner@example.com'};await setMcpConnection(db,i,ENV,true);const client=await protocolClient(t,db);await setMcpConnection(db,i,ENV,false);await assert.rejects(client.callTool({name:'get_record_views',arguments:{record_id:'e'}}));});
test('official client chains record and project evidenceRefIds to exact current evidence without creating work',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();await setMcpConnection(db,{...IDENTITY,actorId:'owner@example.com'},ENV,true);
 insert(sqlite,'claim_versions',{id:'budget_v2',claim_id:'budget',version_no:2,statement:'预算四十万',source:'ai'});sqlite.prepare("UPDATE claims SET current_version_id='budget_v2',review_status='verified' WHERE id='budget'").run();sqlite.prepare("UPDATE text_segments SET text_raw='预算四十万。费用待定。请询价。',text_normalized='预算四十万。费用待定。请询价。' WHERE id='seg'").run();
 insert(sqlite,'evidence_refs',{id:'budget_current_ev',workspace_id:'ws',project_id:'p',event_id:'e',claim_version_id:'budget_v2',kind:'text',asset_version_id:'av',segment_ids_json:'["seg"]',quote_raw:'预算四十万',evidence_role:'direct',provenance_grade:'primary',structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
 const before=unchanged(sqlite),client=await protocolClient(t,db);
 for(const [name,args] of [['get_record_views',{record_id:'e'}],['get_project_brief',{project_id:'p'}]]){
  const reply=await client.callTool({name,arguments:args});assert.equal(reply.isError,undefined);const rows=reply.structuredContent.items;
  assert.deepEqual(rows.find(row=>row.id==='budget').evidenceRefIds,['budget_current_ev']);
  for(const id of ['budget','action','question']){const row=rows.find(row=>row.id===id);assert.ok(row.evidenceRefIds.length);for(const evidenceId of row.evidenceRefIds){const result=await client.callTool({name:'get_evidence',arguments:{evidence_id:evidenceId}});assert.equal(result.isError,undefined);const evidence=result.structuredContent;assert.equal(evidence.sourceStatus,'ready');assert.ok(row.claimRefs.some(ref=>ref.claimVersionId===evidence.claimVersionId));assert.equal(evidence.assetVersionId,'av');assert.equal(evidence.recordId,'e');assert.ok(evidence.quote);}}
  assert.equal(rows.some(row=>row.evidenceRefIds?.includes('budget_ev')),false);
 }
 assert.deepEqual(unchanged(sqlite),before);
});
test('evidenceRefIds excludes invalid, stale and foreign sources and user input has no fabricated original citations',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();
 sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='budget_ev'").run();
 for(const v of await views(db,sqlite)){assert.deepEqual(v.items.find(row=>row.id==='budget').evidenceRefIds,[]);assert.equal(v.items.find(row=>row.id==='budget').text,null);}
 sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='valid' WHERE id='budget_ev'").run();sqlite.prepare("UPDATE assets SET current_version_id=NULL WHERE id='asset'").run();
 for(const v of await views(db,sqlite)){assert.deepEqual(v.items.find(row=>row.id==='budget').evidenceRefIds,[]);assert.equal(v.items.find(row=>row.id==='budget').text,null);}
 sqlite.prepare("UPDATE assets SET current_version_id='av' WHERE id='asset'").run();
 insert(sqlite,'workspaces',{id:'foreign-ws',name:'Foreign'});insert(sqlite,'projects',{id:'foreign-p',workspace_id:'foreign-ws',name:'Foreign'});insert(sqlite,'events',{id:'foreign-e',workspace_id:'foreign-ws',project_id:'foreign-p',event_type:'meeting',title:'Foreign',occurred_at:T,sequence_no:1});insert(sqlite,'assets',{id:'foreign-asset',workspace_id:'foreign-ws',project_id:'foreign-p',event_id:'foreign-e',kind:'text',filename:'foreign.txt',current_version_id:'foreign-av',processing_status:'ready'});insert(sqlite,'asset_versions',{id:'foreign-av',asset_id:'foreign-asset',version_no:1,content_sha256:'foreign',mime_type:'text/plain',size_bytes:10,r2_original_key:'foreign/source',finalized_at:T});
 insert(sqlite,'evidence_refs',{id:'forged-foreign-ev',workspace_id:'ws',project_id:'p',event_id:'e',claim_version_id:'budget_v1',kind:'text',asset_version_id:'foreign-av',segment_ids_json:'[]',quote_raw:'foreign source',evidence_role:'direct',provenance_grade:'primary',structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
 for(const v of await views(db,sqlite)){const row=v.items.find(row=>row.id==='budget');assert.deepEqual(row.evidenceRefIds,[]);assert.equal(row.text,null);assert.ok(!JSON.stringify(v).includes('foreign source'));}
 sqlite.prepare("DELETE FROM evidence_refs WHERE id='forged-foreign-ev'").run();
 const s=await projected(db);await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'用户补充：十二万元',evidenceRefs:[]});
 const after=await projected(db),answerRef=after.questions[0].answerRefs[0];
 for(const v of await views(db,sqlite)){const row=v.items.find(row=>row.id===answerRef.claimId);assert.equal(row.origin,'user_input');assert.equal(row.sourceStatus,'ready');assert.deepEqual(row.evidenceRefIds,[]);assert.equal(row.text,'用户补充：十二万元');}
});
test('stale summary citations remain available only while their exact referenced claim version is current',async t=>{
 const {db,sqlite}=await setup(t);
 insert(sqlite,'workflow_narratives',{id:'stored-summary',workspace_id:'ws',project_id:'p',event_id:'e',scope_key:'e',scope_kind:'mixed',based_on_context_version:0,text:'预算大约三十万。',sentence_refs_json:JSON.stringify([{text:'预算大约三十万。',claimRefs:[{claimId:'budget',claimVersionId:'budget_v1'}],reviewState:'draft'}]),freshness:'stale',input_hash:'stored',created_at:T});
 let before=unchanged(sqlite),reply=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e',views:['summary']});assert.equal(reply.items[0].freshness,'stale');assert.deepEqual(reply.items[0].evidenceRefIds,['budget_ev']);assert.deepEqual(unchanged(sqlite),before);
 insert(sqlite,'claim_versions',{id:'budget_v2',claim_id:'budget',version_no:2,statement:'预算四十万',source:'ai'});sqlite.prepare("UPDATE claims SET current_version_id='budget_v2' WHERE id='budget'").run();
 insert(sqlite,'evidence_refs',{id:'current-budget-ev',workspace_id:'ws',project_id:'p',event_id:'e',claim_version_id:'budget_v2',kind:'text',asset_version_id:'av',segment_ids_json:'["seg"]',quote_raw:'预算四十万',evidence_role:'direct',provenance_grade:'primary',structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
 before=unchanged(sqlite);reply=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e',views:['summary']});assert.equal(reply.items[0].freshness,'stale');assert.equal(reply.items[0].text,'预算大约三十万。');assert.deepEqual(reply.items[0].claimRefs,[{claimId:'budget',claimVersionId:'budget_v1'}]);assert.deepEqual(reply.items[0].evidenceRefIds,[]);assert.deepEqual(unchanged(sqlite),before);
});
test('raw excerpt splits large source segments without omission or duplicate characters',async t=>{const {db,sqlite}=await setup(t);const original='x'.repeat(19999)+'😀'+'后续'.repeat(15000);sqlite.prepare("UPDATE text_segments SET text_raw=?,text_normalized=? WHERE id='seg'").run(original,original);let cursor,text='',pages=0;do{const result=await readMcpTool(db,SCOPE,'get_record_excerpt',{record_id:'e',cursor});assert.ok(result.segments.reduce((n,s)=>n+s.text.length,0)<=20000);for(const s of result.segments){assert.ok(!/[\uD800-\uDBFF]$/.test(s.text));text+=s.text;}cursor=result.nextCursor;pages++;}while(cursor);assert.equal(text,original);assert.ok(pages>=3);});
test('source changes expire a raw cursor, archive and cross-workspace IDs stay hidden',async t=>{const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE text_segments SET text_raw=? WHERE id='seg'").run('x'.repeat(25000));const first=await readMcpTool(db,SCOPE,'get_record_excerpt',{record_id:'e'});sqlite.prepare("UPDATE text_segments SET speaker='新的说话人'").run();await assert.rejects(readMcpTool(db,SCOPE,'get_record_excerpt',{record_id:'e',cursor:first.nextCursor}),e=>e.code==='cursor_expired');await assert.rejects(readMcpTool(db,{...SCOPE,workspaceId:'another'},'get_evidence',{evidence_id:'budget_ev'}),e=>e.code==='not_found');sqlite.prepare("UPDATE events SET material_status='archived'").run();await assert.rejects(readMcpTool(db,SCOPE,'get_record_views',{record_id:'e'}),e=>e.code==='not_found');});
test('accepted facts, draft actions and resolved questions retain exact current answer semantics',async t=>{const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();relation(sqlite,'answer','budget','question','resolves','active');for(const v of await views(db,sqlite)){const q=v.items.find(x=>x.id==='question'),a=v.items.find(x=>x.id==='action'),answer=v.items.find(x=>x.id==='budget');assert.equal(q.resolutionState,'resolved');assert.deepEqual(q.answerRefs,[{claimId:'budget',claimVersionId:'budget_v1'}]);assert.deepEqual(answer.answerToQuestionRefs,[{claimId:'question',claimVersionId:'question_v1',revision:q.revision}]);assert.equal(a.reviewState,'draft');assert.equal(a.executionState,undefined);assert.equal(a.latestOutcome,undefined);}sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='budget_ev'").run();const evidence=await readMcpTool(db,SCOPE,'get_evidence',{evidence_id:'budget_ev'});assert.equal(evidence.quote,null);assert.equal(evidence.sourceStatus,'missing');});
test('MCP retains completed and cancelled actions independently of question answers and expires state cursors',async t=>{
 const {db,sqlite}=await setup(t);await acceptAction(db);
 const cursors=await Promise.all([readMcpTool(db,SCOPE,'get_record_views',{record_id:'e',limit:1}),readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p',limit:1})]);
 await transition(db,'complete');
 for(const v of await views(db,sqlite)){const a=v.items.find(x=>x.id==='action'),q=v.items.find(x=>x.id==='question');assert.equal(a.reviewState,'accepted');assert.equal(a.executionState,'completed');assert.equal(q.resolutionState,'open');assert.equal(a.latestOutcome,null);assert.deepEqual(a.questionRefs,[{...q.claimRef,revision:q.revision}]);assert.deepEqual(a.basisDetails[0].acceptedRef,q.claimRef);assert.equal(v.counts?.openActionCount ?? 0,0);}
 for(const [i,[name,args]] of [['get_record_views',{record_id:'e'}],['get_project_brief',{project_id:'p'}]].entries())await assert.rejects(readMcpTool(db,SCOPE,name,{...args,cursor:cursors[i].nextCursor}),e=>e.code==='cursor_expired');
 await transition(db,'reopen');let s=await projected(db);
 await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'十二万元',evidenceRefs:[]});
 await transition(db,'cancel');
 for(const v of await views(db,sqlite)){const a=v.items.find(x=>x.id==='action'),q=v.items.find(x=>x.id==='question');assert.equal(a.executionState,'cancelled');assert.equal(q.resolutionState,'resolved');assert.equal(a.latestOutcome,null);assert.equal(q.latestOutcome.text,'十二万元');assert.deepEqual(q.latestOutcome.answerRefs,q.answerRefs);}
 await transition(db,'reopen');for(const v of await views(db,sqlite)){assert.equal(v.items.find(x=>x.id==='action').executionState,'open');assert.equal(v.items.find(x=>x.id==='question').resolutionState,'resolved');}
});
test('MCP exposes action outcomes with exact per-question answers, result refs and corrected revisions',async t=>{
 const {db,sqlite}=await setup(t);claim(sqlite,'time','open_question','交货多久？');relation(sqlite,'basis-time','action','time','informed_by','proposed');await acceptAction(db);
 let s=await projected(db);await send(db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:true,text:'供应商答复',evidenceRefs:[],resolveQuestions:s.questions.map(q=>({questionId:q.id,revision:q.revision,answerText:q.id==='time'?'两周':'十二万元'}))});
 s=await projected(db);const prior=s.actions[0].latestOutcome;
 const check=async expected=>{for(const v of await views(db,sqlite)){const a=v.items.find(x=>x.id==='action');assert.deepEqual(a.latestOutcome,expected.actions[0].latestOutcome);assert.equal(a.executionState,'completed');assert.equal(a.latestOutcome.freshness,'current');for(const q of expected.questions){const row=v.items.find(x=>x.id===q.id);assert.equal(row.resolutionState,'resolved');assert.deepEqual(row.answerRefs,q.answerRefs);assert.equal(row.latestOutcome.id,a.latestOutcome.id);for(const answerRef of q.answerRefs){const answer=v.items.find(x=>x.id===answerRef.claimId);assert.deepEqual(answer.claimRefs,[answerRef]);assert.ok(answer.answerToQuestionRefs.some(ref=>ref.claimVersionId===q.claimRef.claimVersionId));}}for(const resultRef of a.latestOutcome.resultRefs){const row=v.items.find(x=>x.id===resultRef.claimId);assert.deepEqual(row.resultForActionRefs,[{...a.claimRef,revision:a.revision}]);}}};
 await check(s);
 const cursor=await readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p',limit:1});
 await send(db,`outcomes/${prior.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:prior.revision,operation:'replace',replacement:{text:'报价和交期更新',evidenceRefs:[],resolveQuestions:s.questions.map(q=>({questionId:q.id,revision:q.revision,answerText:q.id==='time'?'三周':'十三万元'}))}});
 s=await projected(db);assert.equal(s.actions[0].latestOutcome.revision,2);await check(s);await assert.rejects(readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p',cursor:cursor.nextCursor}),e=>e.code==='cursor_expired');
 await send(db,`outcomes/${prior.id}/corrections`,{expectedContextVersion:s.contextVersion,expectedOutcomeRevision:2,operation:'withdraw'});
 for(const v of await views(db,sqlite)){assert.equal(v.items.find(x=>x.id==='action').executionState,'completed');assert.equal(v.items.find(x=>x.id==='action').latestOutcome,null);assert.ok(v.items.filter(x=>x.kind==='question').every(q=>q.resolutionState==='open' && !q.answerRefs.length));}
});
test('MCP preserves stale prior action results without misreporting replacement answers or leaking missing sources',async t=>{
 const {db,sqlite}=await setup(t);await acceptAction(db);let s=await projected(db);
 await send(db,'actions/action/outcomes',{expectedContextVersion:s.contextVersion,expectedActionRevision:s.actions[0].revision,completeAction:true,text:'旧报价十二万元',evidenceRefs:[],resolveQuestions:[{questionId:'question',revision:s.questions[0].revision,answerText:'十二万元'}]});
 s=await projected(db);const old=s.actions[0].latestOutcome,oldAnswer=s.questions[0].answerRefs[0];
 await send(db,'questions/question/answers',{expectedContextVersion:s.contextVersion,expectedQuestionRevision:s.questions[0].revision,answerText:'新报价十三万元',evidenceRefs:[],answerDecision:{mode:'replace',priorAnswerRefs:s.questions[0].answerRefs}});
 for(const v of await views(db,sqlite)){const a=v.items.find(x=>x.id==='action'),q=v.items.find(x=>x.id==='question');assert.equal(a.executionState,'completed');assert.equal(a.latestOutcome.id,old.id);assert.equal(a.latestOutcome.freshness,'stale');assert.deepEqual(a.latestOutcome.answerRefs,[]);assert.equal(q.latestOutcome.text,'新报价十三万元');assert.equal(q.latestOutcome.freshness,'current');assert.equal(v.items.some(x=>x.id===oldAnswer.claimId),false);}
 sqlite.prepare('DELETE FROM user_notes WHERE claim_id=?').run(oldAnswer.claimId);
 sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id IN ('question_ev','action_ev')").run();
 for(const v of await views(db,sqlite)){const a=v.items.find(x=>x.id==='action'),q=v.items.find(x=>x.id==='question');assert.equal(a.text,null);assert.equal(a.latestOutcome.text,'');assert.equal(a.latestOutcome.freshness,'stale');assert.equal(a.basisState,'needs_review');assert.equal(a.basisDetails[0].acceptedText,null);assert.equal(a.basisDetails[0].currentText,null);assert.equal(q.text,null);assert.equal(q.resolutionState,'resolved');}
});
test('MCP labels superseded actions as history instead of current follow-up',async t=>{
 const {db,sqlite}=await setup(t);await acceptAction(db);await transition(db,'complete');sqlite.prepare("UPDATE claims SET lifecycle_status='superseded' WHERE id='action'").run();
 for(const v of await views(db,sqlite)){const a=v.items.find(x=>x.id==='action');assert.equal(a.kind,'action_history');assert.equal(a.lifecycleState,'superseded');assert.equal(a.executionState,'completed');assert.deepEqual(a.claimRef,{claimId:'action',claimVersionId:'action_v1'});assert.equal(a.replacementRef,null);assert.equal(v.items.some(x=>x.kind==='action'),false);}
});
test('project answer deduplication retains exact associations across records and source ownership',async t=>{
 const {db,sqlite}=await setup(t);
 insert(sqlite,'events',{id:'e2',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'另一条记录',occurred_at:'2026-09-27T10:00:00.000Z',sequence_no:2,active_run_id:'run2'});
 insert(sqlite,'assets',{id:'asset2',workspace_id:'ws',project_id:'p',event_id:'e2',kind:'text',filename:'synthetic2.txt',current_version_id:'av2',processing_status:'ready'});
 insert(sqlite,'asset_versions',{id:'av2',asset_id:'asset2',version_no:1,content_sha256:'synthetic2',mime_type:'text/plain',size_bytes:30,r2_original_key:'synthetic/source2',finalized_at:T});
 insert(sqlite,'text_segments',{id:'seg2',workspace_id:'ws',project_id:'p',event_id:'e2',asset_id:'asset2',asset_version_id:'av2',ordinal:0,parser_version:'test',text_raw:'十二万元',text_normalized:'十二万元'});
 insert(sqlite,'extraction_runs',{id:'run2',workspace_id:'ws',project_id:'p',event_id:'e2',status:'succeeded',idempotency_key:'seed2',input_hash:'seed2',input_snapshot_hash:'seed2',input_manifest_json:'[{"asset_version_id":"av2"}]',context_version:0,context_snapshot_hash:'seed2',prompt_version:'seed',schema_version:'seed',parser_version:'seed'});
 claim(sqlite,'external-answer','other','十二万元',{status:'verified'});sqlite.prepare("UPDATE claims SET event_id='e2',first_event_id='e2',extraction_run_id='run2' WHERE id='external-answer'").run();sqlite.prepare("UPDATE evidence_refs SET event_id='e2',asset_version_id='av2',segment_ids_json='[\"seg2\"]' WHERE id='external-answer_ev'").run();
 claim(sqlite,'second-question','open_question','这笔费用是多少？');relation(sqlite,'first-answer','external-answer','question','resolves');relation(sqlite,'second-answer','external-answer','second-question','resolves');
 for(const v of await views(db,sqlite)){const answers=v.items.filter(x=>x.id==='external-answer');assert.equal(answers.length,1);assert.equal(answers[0].eventId,'e2');assert.deepEqual(new Set(answers[0].answerToQuestionRefs.map(ref=>ref.claimVersionId)),new Set(['question_v1','second-question_v1']));for(const id of ['question','second-question'])assert.deepEqual(v.items.find(x=>x.id===id).answerRefs,[{claimId:'external-answer',claimVersionId:'external-answer_v1'}]);}
});
test('large exact action associations page as reconstructable bounded JSON entries',async t=>{
 const {db,sqlite}=await setup(t);
 for(let i=0;i<55;i++){const id=`q${i}-`+'问'.repeat(230);claim(sqlite,id,'open_question',`问题${i}`);relation(sqlite,`basis-${i}`,'action',id,'informed_by','proposed');}
 await acceptAction(db);const expected=(await projected(db)).actions[0],before=unchanged(sqlite);
 for(const [name,args] of [['get_record_views',{record_id:'e'}],['get_project_brief',{project_id:'p'}]]){let cursor;const fragments=[];do{const reply=await readMcpTool(db,SCOPE,name,{...args,limit:1,cursor});assert.ok(JSON.stringify(reply.items).length<=24002);for(const row of reply.items)if(row.id==='action'){assert.equal(row.fragmentOf,'entry');assert.ok(!/[\uD800-\uDBFF]$/.test(row.content));fragments.push(row);}cursor=reply.nextCursor;}while(cursor);assert.ok(fragments.length>1);assert.equal(fragments.length,fragments[0].partCount);const restored=JSON.parse(fragments.toSorted((a,b)=>a.partIndex-b.partIndex).map(x=>x.content).join(''));assert.deepEqual(restored.questionRefs,expected.questionRefs);assert.deepEqual(restored.basisDetails,expected.basisDetails);assert.equal(restored.reviewState,'accepted');assert.equal(restored.executionState,'open');}
 assert.deepEqual(unchanged(sqlite),before);
});
test('generated long views page exact JSON while stale sources clear their body',async t=>{const {db,sqlite}=await setup(t);const content={text:'章'.repeat(30000)};insert(sqlite,'event_ai_artifact_runs',{id:'ar',workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',kind:'chapters',status:'succeeded',idempotency_key:'ar',input_hash:'ar',input_manifest_json:'[{"asset_version_id":"av"}]',provider:'test',model:'test',reasoning_effort:'low',prompt_version:'test',schema_version:'test',next_attempt_at:T,queued_at:T});insert(sqlite,'event_ai_artifacts',{id:'artifact',workspace_id:'ws',project_id:'p',event_id:'e',run_id:'ar',kind:'chapters',artifact_version:1,input_hash:'ar',content_json:JSON.stringify(content)});let cursor,json='';do{const v=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e',views:['chapters'],cursor});for(const item of v.items){assert.equal(item.reviewState,'draft');json+=item.content;}cursor=v.nextCursor;}while(cursor);assert.deepEqual(JSON.parse(json),content);sqlite.prepare("UPDATE assets SET current_version_id=NULL").run();const v=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e',views:['chapters']});assert.equal(v.items[0].content,null);assert.equal(v.items[0].state,'stale');});
test('HTTP transport rejects missing identity, unexpected browser origins, oversized bodies and unsafe methods',async t=>{const {db}=await setup(t);assert.equal((await handleMcpRequest(new Request('http://localhost/mcp',{method:'POST',body:'{}'}),db,ENV)).status,401);assert.equal((await handleMcpRequest(new Request('http://localhost/mcp',{method:'POST',headers:{...headers,origin:'https://attacker.test'},body:'{}'}),db,ENV)).status,403);assert.equal((await handleMcpRequest(new Request('http://localhost/mcp'),db,ENV)).status,405);});

test('MCP rate counters are shared, atomic and expire independently of business data',async t=>{
 const {db,sqlite}=await setup(t),before=unchanged(sqlite),now=Date.UTC(2026,8,29,12,0,15);
 for(let i=0;i<60;i++)await reserveMcpRequest(db,IDENTITY,now);
 await assert.rejects(reserveMcpRequest(db,IDENTITY,now),e=>e.status===429 && e.retryAfter===45);
 await assert.rejects(reserveMcpRequest(db,{...IDENTITY,gatewaySubject:'new-login'},now),e=>e.status===429);
 await reserveMcpRequest(db,{...IDENTITY,actorId:'another'},now);
 await reserveMcpRequest(db,IDENTITY,now+180000);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM mcp_request_limits').get().n,1);
 assert.deepEqual(unchanged(sqlite),before);
});
test('bounded read aborts its transport and successful reads clear their deadline',async()=>{
 let aborts=0;
 await assert.rejects(withMcpDeadline(new Promise(()=>{}),()=>{aborts++;},5),e=>e.status===504);
 assert.equal(aborts,1);
 assert.equal(await withMcpDeadline(Promise.resolve(42),()=>{aborts++;},5),42);
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(aborts,1);
});
test('authenticated HTTP accepts legacy initialization and rejects oversized input and hostile hosts',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();await setMcpConnection(db,{...IDENTITY,actorId:'owner@example.com'},ENV,true);
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-client',version:'1.0'}}});
 const request=(url,extra={},value=body)=>new Request(url,{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream',...extra},body:value});
 const response=await handleMcpRequest(request('http://localhost/mcp'),db,ENV);assert.equal(response.status,200);const payload=await response.text();const result=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')?payload.split('\n').find(line=>line.startsWith('data: ')).slice(6):payload);assert.equal(result.result.protocolVersion,'2025-11-25');
 const listing=await handleMcpRequest(request('http://localhost/mcp',{'MCP-Protocol-Version':'2025-11-25'},JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})),db,ENV);assert.equal(listing.status,200);const listingBody=await listing.text();const discovered=JSON.parse(listing.headers.get('content-type')?.includes('text/event-stream')?listingBody.split('\n').find(line=>line.startsWith('data: ')).slice(6):listingBody);assert.equal(discovered.result.tools.length,6);
 assert.equal((await handleMcpRequest(request('http://localhost/mcp',{},'x'.repeat(20000)),db,ENV)).status,413);
 assert.equal((await handleMcpRequest(request('http://attacker.test/mcp'),db,ENV)).status,403);
 assert.equal((await handleMcpRequest(request('http://localhost/mcp',{Host:'attacker.test'}),db,ENV)).status,403);
 assert.equal((await handleMcpRequest(request('http://localhost/mcp',{Origin:'http://localhost:3001'}),db,ENV)).status,403);
});
test('missing views reflect existing task state and evidence keeps selected and neighboring source text',async t=>{
 const {db,sqlite}=await setup(t);
 insert(sqlite,'event_ai_artifact_runs',{id:'missing',workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',kind:'speakers',status:'failed',idempotency_key:'missing',input_hash:'missing',input_manifest_json:'[{"asset_version_id":"av"}]',provider:'test',model:'test',reasoning_effort:'low',prompt_version:'test',schema_version:'test',next_attempt_at:T,queued_at:T});
 assert.equal((await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e',views:['speakers']})).items[0].state,'failed');
 insert(sqlite,'text_segments',{id:'next',workspace_id:'ws',project_id:'p',event_id:'e',asset_id:'asset',asset_version_id:'av',ordinal:1,parser_version:'test',text_raw:'下一句话',text_normalized:'下一句话'});
 const evidence=await readMcpTool(db,SCOPE,'get_evidence',{evidence_id:'budget_ev'});assert.equal(evidence.segments.length,2);assert.equal(evidence.segments[0].selected,1);assert.equal(evidence.contextTruncated,false);
 sqlite.prepare("UPDATE text_segments SET text_raw=? WHERE id='seg'").run('x'.repeat(5999)+'😀');
 const long=await readMcpTool(db,SCOPE,'get_evidence',{evidence_id:'budget_ev'});assert.equal(long.contextTruncated,true);assert.ok(!/[\uD800-\uDBFF]$/.test(long.segments[0].text_raw));
 sqlite.prepare("UPDATE text_segments SET text_raw=? WHERE id='seg'").run('x'.repeat(6000));sqlite.prepare("DELETE FROM text_segments WHERE id='next'").run();assert.equal((await readMcpTool(db,SCOPE,'get_evidence',{evidence_id:'budget_ev'})).contextTruncated,false);
});
test('connection wire state rejects anonymous enabled claims and unexpected fields',()=>{
 const empty={authenticated:false,enabled:false,scope:'mcp:read',endpoint:'/mcp',expiresAt:null,accountEmail:null};
 assert.deepEqual(parseMcpConnectionStatus(empty),empty);
 assert.throws(()=>parseMcpConnectionStatus({...empty,enabled:true}));
 assert.throws(()=>parseMcpConnectionStatus({...empty,scope:'write'}));
 assert.throws(()=>parseMcpConnectionStatus({...empty,token:'secret'}));
});

test('framework requests without a disconnect signal still return bounded authorization errors',async t=>{
 const {db}=await setup(t),req=new Request('http://localhost/mcp',{method:'POST',body:'{}'});
 Object.defineProperty(req,'signal',{value:undefined});
 assert.equal((await handleMcpRequest(req,db,ENV)).status,401);
 assert.deepEqual(parseWorkflowRequest('McpConnectionRequest',{enabled:true}),{enabled:true});
 assert.throws(()=>parseWorkflowRequest('McpConnectionRequest',{enabled:true,workspaceId:'other'}));
});


test('an authenticated assistant can discover tools before consent, while record reads require an active grant',async t=>{
 const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);
 const {db,sqlite}=f,before=unchanged(sqlite);
 const accessBefore=Object.fromEntries(['workspace_members','access_grants'].map(table=>[table,sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
 const client=await protocolClient(t,db);
 const list=await client.listTools();assert.equal(list.tools.length,6);
 assert.ok(list.tools.every(tool=>tool.annotations.readOnlyHint));
 for(const name of ['list_projects','get_record_views'])await assert.rejects(client.callTool({name,arguments:name==='list_projects'?{}:{record_id:'e'}}),/FORBIDDEN/);
 assert.deepEqual(unchanged(sqlite),before);
 assert.deepEqual(Object.fromEntries(['workspace_members','access_grants'].map(table=>[table,sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n])),accessBefore);
 sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();
 const identity={...IDENTITY,actorId:'owner@example.com'};
 await setMcpConnection(db,identity,ENV,true);
 const reply=await client.callTool({name:'get_record_views',arguments:{record_id:'e'}});assert.ok(reply.structuredContent);assert.equal(reply.isError,undefined);
 await setMcpConnection(db,identity,ENV,false);
 assert.equal((await client.listTools()).tools.length,6);
 await assert.rejects(client.callTool({name:'get_record_views',arguments:{record_id:'e'}}),/FORBIDDEN/);
 assert.deepEqual(unchanged(sqlite),before);
});
test('legacy discovery works before consent and method headers or batched messages cannot grant data access',async t=>{
 const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);
 const {db,sqlite}=f,before=unchanged(sqlite);
 const request=(body,extra={})=>new Request('http://localhost/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...extra},body:JSON.stringify(body)});
 const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-before-consent',version:'1.0'}}};
 assert.equal((await handleMcpRequest(request(initialize),db,ENV)).status,200);
 const listing={jsonrpc:'2.0',id:2,method:'tools/list'};
 assert.equal((await handleMcpRequest(request(listing),db,ENV)).status,200);
 const call={jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_projects',arguments:{}}};
 assert.equal((await handleMcpRequest(request(call,{'Mcp-Method':'tools/list'}),db,ENV)).status,403);
 assert.equal((await handleMcpRequest(request([listing,call]),db,ENV)).status,403);
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(16000)));controller.enqueue(new TextEncoder().encode('x'.repeat(1000)));controller.close();}});
 const oversized=new Request('http://localhost/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:stream,duplex:'half'});
 assert.equal((await handleMcpRequest(oversized,db,ENV)).status,413);
 assert.equal((await handleMcpRequest(new Request('http://localhost/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(listing)}),db,ENV)).status,401);
 assert.deepEqual(unchanged(sqlite),before);
});

test('pinned modern protocol discovers server capabilities and tool schemas before consent',async t=>{
 const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);
 const before=unchanged(f.sqlite);
 const client=new Client({name:'modern-before-consent',version:'1.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});
 const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{fetch:clientFetch(f.db)});
 t.after(()=>client.close());await client.connect(transport);
 const capabilities=await client.discover();assert.ok(capabilities.capabilities.tools);
 assert.equal((await client.listTools()).tools.length,6);
 await assert.rejects(client.callTool({name:'list_projects',arguments:{}}),/FORBIDDEN/);
 f.sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();
 const identity={...IDENTITY,actorId:'owner@example.com'};await setMcpConnection(f.db,identity,ENV,true);
 const record=await client.callTool({name:'get_record_views',arguments:{record_id:'e'}});assert.ok(record.structuredContent);assert.equal(record.isError,undefined);
 await setMcpConnection(f.db,identity,ENV,false);await assert.rejects(client.callTool({name:'get_record_views',arguments:{record_id:'e'}}),/FORBIDDEN/);
 assert.deepEqual(unchanged(f.sqlite),before);
});

test('protocol rejection diagnostics contain fixed metadata without identity or material',async t=>{
 const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);
 const logs=[],warn=console.warn;console.warn=(...args)=>logs.push(args);t.after(()=>{console.warn=warn;});
 const privateText='SYNTHETIC_PRIVATE_MCP_VALUE';
 const body={jsonrpc:'2.0',id:privateText,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:privateText,version:'1.0'}}};
 const response=await handleMcpRequest(new Request('http://localhost/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28'},body:JSON.stringify(body)}),f.db,ENV);
 assert.equal(response.status,400);
 assert.deepEqual(logs,[['mcp_protocol_rejected',{method:'initialize',protocolHeader:'2026-07-28',initializeVersion:'2025-11-25',hasRequestMeta:false,errorCode:-32020}]]);
 assert.doesNotMatch(JSON.stringify(logs),/SYNTHETIC_PRIVATE_MCP_VALUE|owner@example.com|sites-user/);
});

test('a real modern client works through gateway-stripped routing headers while consent and mismatches remain enforced',async t=>{
 const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);
 const before=unchanged(f.sqlite), captured=[];
 const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{fetch:async(input,init)=>{
  const req=new Request(input,init);req.headers.set('oai-authenticated-user-email','owner@example.com');req.headers.set('oai-authenticated-user-id','sites-user');
  req.headers.delete('mcp-method');req.headers.delete('mcp-name');captured.push(await req.clone().json());return handleMcpRequest(req,f.db,ENV);
 }});
 const client=new Client({name:'sites-gateway-client',version:'1.0'},{versionNegotiation:{mode:{pin:'2026-07-28'}}});t.after(()=>client.close());
 await client.connect(transport);assert.ok((await client.discover()).capabilities.tools);assert.equal((await client.listTools()).tools.length,6);
 await assert.rejects(client.callTool({name:'list_projects',arguments:{}}),/FORBIDDEN/);
 f.sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();const identity={...IDENTITY,actorId:'owner@example.com'};await setMcpConnection(f.db,identity,ENV,true);
 for(const [name,args] of [['list_projects',{}],['list_records',{project_id:'p'}],['get_project_brief',{project_id:'p'}],['get_record_views',{record_id:'e'}],['get_record_excerpt',{record_id:'e'}],['get_evidence',{evidence_id:'budget_ev'}]]){
  const result=await client.callTool({name,arguments:args});assert.ok(result.structuredContent);assert.equal(result.isError,undefined);
 }
 const modernCall=captured.findLast(x=>x.method==='tools/call'), discovery=captured.find(x=>x.method==='server/discover');
 const raw=(body,extra={})=>handleMcpRequest(new Request('http://localhost/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28',...extra},body:JSON.stringify(body)}),f.db,ENV);
 assert.equal((await raw(discovery,{'Mcp-Method':'tools/list'})).status,400);
 assert.equal((await raw(modernCall,{'Mcp-Name':'list_projects'})).status,400);
 assert.equal((await raw(discovery,{'MCP-Protocol-Version':'2025-11-25'})).status,400);
 const invalid=structuredClone(discovery);delete invalid.params._meta;
 assert.equal((await raw(invalid)).status,400);
 await setMcpConnection(f.db,identity,ENV,false);await assert.rejects(client.callTool({name:'get_record_views',arguments:{record_id:'e'}}),/FORBIDDEN/);
 assert.deepEqual(unchanged(f.sqlite),before);
});
