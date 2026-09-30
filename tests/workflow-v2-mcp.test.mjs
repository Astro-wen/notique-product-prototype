import assert from 'node:assert/strict';
import test from 'node:test';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {workflowDatabase,seed,relation,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {mcpIdentity,setMcpConnection,assertMcpRead} from '../lib/server/mcp/access.ts';
import {handleMcpRequest} from '../lib/server/mcp/server.ts';
import {reserveMcpRequest,withMcpDeadline} from '../lib/server/mcp/limits.ts';
import {parseMcpConnectionStatus,parseWorkflowRequest} from '../lib/shared/workflow-v2.ts';
import {readMcpTool} from '../lib/server/mcp/readers.ts';
const ENV={APP_ENV:'local',AUTH_GATEWAY:'chatgpt',INTERNAL_WORKSPACE_ID:'ws'};
const IDENTITY={workspaceId:'ws',actorId:'owner',gatewaySubject:'sites-user'};
const headers={'oai-authenticated-user-email':'owner@example.com','oai-authenticated-user-id':'sites-user'};
async function setup(t){const f=await workflowDatabase({through:25});t.after(f.close);seed(f.sqlite);await setMcpConnection(f.db,IDENTITY,ENV,true);return f;}
const clientFetch=db=>async(input,init)=>{const req=new Request(input,init);req.headers.set('oai-authenticated-user-email','owner@example.com');req.headers.set('oai-authenticated-user-id','sites-user');return handleMcpRequest(req,db,ENV);};
async function protocolClient(t,db){const client=new Client({name:'actual-sdk-client',version:'1.0'});const transport=new StreamableHTTPClientTransport(new URL('http://localhost/mcp'),{fetch:clientFetch(db)});await client.connect(transport);t.after(()=>client.close());return client;}
const unchanged=(sqlite)=>Object.fromEntries(['claims','claim_versions','claim_relations','workflow_outbox','extraction_runs','event_ai_artifact_runs','workflow_snapshots','verdicts'].map(table=>[table,sqlite.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
test('strict identity never uses anonymous demo or service credentials as a user',()=>{assert.throws(()=>mcpIdentity(new Request('http://localhost/mcp'),ENV),e=>e.status===401);assert.throws(()=>mcpIdentity(new Request('http://localhost/mcp',{headers:{'oai-authenticated-user-id':'service'}}),ENV),e=>e.status===401);assert.equal(mcpIdentity(new Request('http://localhost/mcp',{headers}),ENV).actorId,'owner@example.com');});
test('opt-in, expiry, revocation and membership loss are checked on every read',async t=>{const {db,sqlite}=await setup(t);assert.equal((await assertMcpRead(db,IDENTITY)).access,'members');await setMcpConnection(db,IDENTITY,ENV,false);await assert.rejects(assertMcpRead(db,IDENTITY),e=>e.status===403);await setMcpConnection(db,IDENTITY,ENV,true);sqlite.prepare('UPDATE access_grants SET expires_at=?').run(T);await assert.rejects(assertMcpRead(db,IDENTITY),e=>e.status===403);await setMcpConnection(db,IDENTITY,ENV,true);sqlite.prepare('UPDATE workspace_members SET revoked_at=?').run(T);await assert.rejects(setMcpConnection(db,IDENTITY,ENV,true),e=>e.status===403);await assert.rejects(assertMcpRead(db,IDENTITY),e=>e.status===403);});
test('public demo consent creates only a viewer, while private membership is required',async t=>{const {db,sqlite}=await setup(t),i={...IDENTITY,actorId:'another@example.com',gatewaySubject:'other'};await assert.rejects(setMcpConnection(db,i,ENV,true),e=>e.status===403);await setMcpConnection(db,i,{...ENV,AUTH_GATEWAY:'public'},true);assert.equal(sqlite.prepare('SELECT role FROM workspace_members WHERE actor_id=?').get(i.actorId).role,'viewer');await assert.rejects(assertMcpRead(db,{...i,gatewaySubject:'forged-other'}),e=>e.status===403);});
test('official client discovers six readonly tools and reads current projections without creating work',async t=>{
 const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();await setMcpConnection(db,{...IDENTITY,actorId:'owner@example.com'},ENV,true);const before=unchanged(sqlite);const client=await protocolClient(t,db);const list=await client.listTools();assert.equal(list.tools.length,6);assert.ok(list.tools.every(tool=>tool.annotations.readOnlyHint));assert.ok(!list.tools.some(tool=>/create|retry|write|delete/.test(tool.name)));
 for(const [name,args] of [['list_projects',{}],['list_records',{project_id:'p'}],['get_project_brief',{project_id:'p'}],['get_record_views',{record_id:'e',views:['record','summary','chapters']}],['get_record_excerpt',{record_id:'e'}],['get_evidence',{evidence_id:'budget_ev'}]]){const reply=await client.callTool({name,arguments:args});assert.equal(reply.isError,undefined,JSON.stringify(reply));assert.ok(reply.structuredContent);}
 assert.deepEqual(unchanged(sqlite),before);const reply=await client.callTool({name:'list_projects',arguments:{workspace_id:'other'}});assert.equal(reply.isError,true);
});
test('official client rejects authorization revoked between requests',async t=>{const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE workspace_members SET actor_id='owner@example.com'").run();const i={...IDENTITY,actorId:'owner@example.com'};await setMcpConnection(db,i,ENV,true);const client=await protocolClient(t,db);await setMcpConnection(db,i,ENV,false);await assert.rejects(client.callTool({name:'get_record_views',arguments:{record_id:'e'}}));});
test('raw excerpt splits large source segments without omission or duplicate characters',async t=>{const {db,sqlite}=await setup(t);const original='x'.repeat(19999)+'😀'+'后续'.repeat(15000);sqlite.prepare("UPDATE text_segments SET text_raw=?,text_normalized=? WHERE id='seg'").run(original,original);let cursor,text='',pages=0;do{const result=await readMcpTool(db,SCOPE,'get_record_excerpt',{record_id:'e',cursor});assert.ok(result.segments.reduce((n,s)=>n+s.text.length,0)<=20000);for(const s of result.segments){assert.ok(!/[\uD800-\uDBFF]$/.test(s.text));text+=s.text;}cursor=result.nextCursor;pages++;}while(cursor);assert.equal(text,original);assert.ok(pages>=3);});
test('source changes expire a raw cursor, archive and cross-workspace IDs stay hidden',async t=>{const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE text_segments SET text_raw=? WHERE id='seg'").run('x'.repeat(25000));const first=await readMcpTool(db,SCOPE,'get_record_excerpt',{record_id:'e'});sqlite.prepare("UPDATE text_segments SET speaker='新的说话人'").run();await assert.rejects(readMcpTool(db,SCOPE,'get_record_excerpt',{record_id:'e',cursor:first.nextCursor}),e=>e.code==='cursor_expired');await assert.rejects(readMcpTool(db,{...SCOPE,workspaceId:'another'},'get_evidence',{evidence_id:'budget_ev'}),e=>e.code==='not_found');sqlite.prepare("UPDATE events SET material_status='archived'").run();await assert.rejects(readMcpTool(db,SCOPE,'get_record_views',{record_id:'e'}),e=>e.code==='not_found');});
test('accepted summaries, pending actions and current answers keep their original semantics',async t=>{const {db,sqlite}=await setup(t);sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();relation(sqlite,'answer','budget','question','resolves','active');const brief=await readMcpTool(db,SCOPE,'get_project_brief',{project_id:'p'});assert.equal(brief.items.some(x=>x.kind==='open_question'),false);assert.ok(brief.items.some(x=>x.kind==='accepted_fact'));assert.equal(brief.items.some(x=>x.kind==='action'),false);const record=await readMcpTool(db,SCOPE,'get_record_views',{record_id:'e'});assert.equal(record.items.some(x=>x.id==='question'),false);assert.equal(record.items.find(x=>x.id==='action').reviewState,'draft');sqlite.prepare("UPDATE evidence_refs SET structural_validation_status='invalid' WHERE id='budget_ev'").run();const evidence=await readMcpTool(db,SCOPE,'get_evidence',{evidence_id:'budget_ev'});assert.equal(evidence.quote,null);assert.equal(evidence.sourceStatus,'missing');});
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
