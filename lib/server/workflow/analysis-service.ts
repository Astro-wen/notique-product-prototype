import { projectCoverage, readJson, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type AnalysisRun, type AnalysisState, type RetryAnalysisRequest, type StartAnalysisRequest } from '../../shared/workflow-v2.ts';
import { digestValue, findWorkflowEvent, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { mutationId } from './transaction.ts';

type Row = Record<string, unknown>;
type ModelStage = { id:string; stage:string; attempt:number; status:string; error_code:string|null; updated_at:string };
type Artifact = { id:string; kind:string; status:string; error_code:string|null; updated_at:string };
type NarrativeJob = { id:string; state:string; error_code:string|null; input_revision:number; payload_json:string; updated_at:string };
const published = (status:unknown) => ['succeeded','completed_with_warnings'].includes(String(status));
const state = (status:unknown):AnalysisState => status==='processing'||status==='running'?'running':published(status)?'succeeded':(['queued','failed','cancelled'].includes(String(status))?status as AnalysisState:'failed');
const repairable = (code:string|null) => !code || !/(?:VERSION_CONFLICT|SOURCE|ARCHIVED|DELETED|BUDGET|TOO_MANY|ASSET_TOO_LARGE|NOT_CONFIGURED|CANCEL|QA_MODEL_DISABLED)/.test(code);
const currentSources = `COALESCE(json_extract(a.metadata_json,'$.analysis_source'),1)<>0 AND COALESCE(json_extract(a.metadata_json,'$.artifact_kind'),'')<>'readable_transcript'
  AND COALESCE(json_extract(a.metadata_json,'$.transcription_chunk'),0)<>1 AND COALESCE(a.failure_code,'') NOT IN ('UPLOAD_ABORTED','UPLOAD_EXPIRED')
  AND (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS (SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.event_id=a.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id')))`;
const assetsSql = `(SELECT COALESCE(json_group_array(json_object('id',a.id,'event_id',a.event_id,'current_version_id',a.current_version_id,'processing_status',a.processing_status,'kind',a.kind,'metadata_json',a.metadata_json)), '[]') FROM assets a WHERE a.workspace_id=e.workspace_id AND a.event_id=e.id AND ${currentSources} ORDER BY a.id)`;
const sourceObject = `json_object('projectId',e.project_id,'contextVersion',p.context_version,'sourceRevision',e.source_revision,'materialStatus',e.material_status,'assets',json(${assetsSql}))`;
const access = `( ?=1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=p.workspace_id AND wm.actor_id=? AND wm.revoked_at IS NULL))`;
const editor = `( ?=1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=p.workspace_id AND wm.actor_id=? AND wm.revoked_at IS NULL AND wm.role IN ('owner','editor')))`;
const eventJoin = `FROM events e JOIN projects p ON p.id=e.project_id AND p.workspace_id=e.workspace_id WHERE e.workspace_id=? AND e.id=? AND e.material_status<>'archived' AND p.deleted_at IS NULL`;
export const ANALYSIS_SOURCE_SQL = `SELECT ${sourceObject} AS stamp ${eventJoin}`;
const ANALYSIS_SQL = `SELECT r.*,e.source_revision,e.active_run_id,e.material_status,p.context_version AS current_context_version,
 ${editor} AS can_edit,${sourceObject} AS source_stamp,${assetsSql} AS assets,
 (SELECT COALESCE(json_group_array(json_object('id',s.id,'stage',s.stage,'attempt',s.attempt,'status',s.status,'error_code',s.error_code,'updated_at',s.updated_at)), '[]') FROM extraction_model_stages s WHERE s.run_id=r.id) AS stages,
 (SELECT COALESCE(json_group_array(json_object('id',a.id,'kind',a.kind,'status',a.status,'error_code',a.error_code,'updated_at',a.updated_at)), '[]') FROM event_ai_artifact_runs a WHERE a.extraction_run_id=r.id AND a.workspace_id=r.workspace_id AND a.event_id=r.event_id AND a.kind<>'readable_transcript') AS artifacts,
 (SELECT COALESCE(json_group_array(json_object('id',j.id,'state',j.state,'error_code',j.error_code,'input_revision',j.input_revision,'payload_json',j.payload_json,'updated_at',j.updated_at)), '[]') FROM workflow_outbox j WHERE j.workspace_id=r.workspace_id AND j.project_id=r.project_id AND j.event_id=r.event_id AND j.kind='narrative' AND j.input_revision=p.context_version AND e.active_run_id=r.id AND j.state<>'cancelled') AS narratives,
 (SELECT COALESCE(json_group_array(json_object('id',s.id,'event_id',s.event_id,'asset_version_id',s.asset_version_id,'ordinal',s.ordinal)), '[]') FROM text_segments s WHERE s.workspace_id=e.workspace_id AND s.event_id=e.id) AS segments
 FROM extraction_runs r JOIN events e ON e.id=r.event_id AND e.workspace_id=r.workspace_id AND e.project_id=r.project_id JOIN projects p ON p.id=e.project_id AND p.workspace_id=e.workspace_id
 WHERE r.workspace_id=? AND r.id=? AND e.material_status<>'archived' AND p.deleted_at IS NULL AND ${access}`;
const accessValues = (scope:WorkflowScope) => [scope.access==='demo'?1:0,scope.actorId];
async function loadAnalysis(db:D1Database,scope:WorkflowScope,runId:string):Promise<Row> {
 const row=await db.prepare(ANALYSIS_SQL).bind(...accessValues(scope),scope.workspaceId,runId,...accessValues(scope)).first<Row>();
 if(!row) throw new WorkflowFault(404,'not_found','分析任务不存在或当前账号无法访问');
 return row;
}
function modelStages(row:Row):ModelStage[] {
 const all=readJson<ModelStage[]>(String(row.stages),[]);
 return [...new Map(all.toSorted((a,b)=>a.attempt-b.attempt||a.updated_at.localeCompare(b.updated_at)).map(s=>[s.stage,s])).values()];
}
function artifacts(row:Row):Artifact[] {
 return [...new Map(readJson<Artifact[]>(String(row.artifacts),[]).toSorted((a,b)=>a.updated_at.localeCompare(b.updated_at)||a.id.localeCompare(b.id)).map(s=>[s.kind,s])).values()];
}
function narrative(row:Row):NarrativeJob|undefined {
 return readJson<NarrativeJob[]>(String(row.narratives),[]).toSorted((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.id.localeCompare(a.id))[0];
}
function sourceIds(row:Row):string[] {
 return readJson<ProjectionLedger['assets']>(String(row.assets),[]).filter(a=>a.kind!=='audio' && a.processing_status==='ready' && a.current_version_id).map(a=>a.current_version_id!).sort();
}
function sameManifest(row:Row):boolean {
 const ids=readJson<Array<{asset_version_id:string}>>(String(row.input_manifest_json),[]).map(v=>v.asset_version_id).sort();
 const current=sourceIds(row);
 const sources=readJson<ProjectionLedger['assets']>(String(row.assets),[]);
 return ids.length>0 && JSON.stringify(ids)===JSON.stringify(current) && sources.every(a=>a.processing_status==='ready' && a.current_version_id && (a.kind!=='audio' || sources.some(t=>readJson<{source_audio_asset_version_id?:string}>(t.metadata_json,{}).source_audio_asset_version_id===a.current_version_id)));
}
export async function mapAnalysisRun(row:Row):Promise<AnalysisRun> {
 const input=readJson<{workflow_source_revision?:number;two_pass_pipeline?:boolean}>(String(row.model_params_json),{});
 const current=String(row.active_run_id)===String(row.id) && sameManifest(row) && (input.workflow_source_revision===undefined||input.workflow_source_revision===Number(row.source_revision));
 const model=modelStages(row);
 const invalidCheckpoint=model.length>0 && model.every(s=>s.status==='succeeded') && /MODEL_OUTPUT_INVALID|EVIDENCE_VALIDATION_FAILED/.test(String(row.error_code));
 const extractionRetry=!invalidCheckpoint && current && Number(row.context_version)===Number(row.current_context_version) && row.status==='failed' && repairable(row.error_code as string|null);
 const extractionState=state(row.status);
 const stages:AnalysisRun['stages']=[];
 const names:Record<string,string>={inventory:'提取重点',verify:'核对出处',verify_escalated:'复核疑点'};
 for(const s of model) stages.push({id:s.id,name:names[s.stage]??'分析材料',state:state(s.status),retryable:extractionRetry && s.status==='failed' && repairable(s.error_code),errorCode:s.error_code});
 // Publication/transport failures can occur after every paid stage succeeded.
 if(!model.length || !published(row.status) && model.every(s=>s.status==='succeeded') || row.status==='failed' && !stages.some(s=>s.retryable)) stages.push({id:`${row.id}:extraction`,name:input.two_pass_pipeline?'整理记录':'提取重点',state:extractionState,retryable:extractionRetry,errorCode:row.error_code as string|null});
 for(const a of artifacts(row)) stages.push({id:a.id,name:({summary:'原文概要',chapters:'章节整理',speakers:'发言摘要',key_points:'原文要点',overview:'原文总览'} as Record<string,string>)[a.kind]??'整理原文',state:state(a.status),retryable:current && a.status==='failed' && repairable(a.error_code),errorCode:a.error_code});
 const job=narrative(row);
 if(job) stages.push({id:job.id,name:'更新全文概要',state:state(job.state),retryable:current && job.state==='failed' && repairable(job.error_code),errorCode:job.error_code});
 const coverage=projectCoverage({events:[{id:String(row.event_id),active_run_id:String(row.id),source_revision:Number(row.source_revision),title:'',occurred_at:''}],assets:readJson<ProjectionLedger['assets']>(String(row.assets),[]),segments:readJson<ProjectionLedger['segments']>(String(row.segments),[]),runs:[{id:String(row.id),event_id:String(row.event_id),status:String(row.status),input_manifest_json:String(row.input_manifest_json)}]},String(row.event_id));
 const hasFailure=stages.some(s=>s.state==='failed');
 const pending=stages.some(s=>['queued','running'].includes(s.state));
 const overall:AnalysisState=published(row.status)?hasFailure||pending||!coverage.complete?'partial':'succeeded':extractionState;
 // Opaque equality token: GET stays read-only even when the legacy executor
 // changes stage state. It is deliberately separate from business versions.
 const revision=parseInt((await digestValue(row)).slice(0,13),16)+1;
 return {id:String(row.id),revision,state:overall,stages,coverage,inputRevision:input.workflow_source_revision??(sameManifest(row)?Number(row.source_revision):0),retryable:stages.some(s=>s.retryable)};
}
export async function readAnalysisRun(db:D1Database,scope:WorkflowScope,runId:string):Promise<AnalysisRun> {
 return mapAnalysisRun(await loadAnalysis(db,scope,runId));
}
async function authorize(db:D1Database,scope:WorkflowScope,eventId:string):Promise<{stamp:string;projectId:string}> {
 await findWorkflowEvent(db,scope,eventId);
 const row=await db.prepare(`SELECT ${sourceObject} AS stamp,${editor} AS can_edit,e.project_id ${eventJoin}`).bind(...accessValues(scope),scope.workspaceId,eventId).first<{stamp:string;can_edit:number;project_id:string}>();
 if(!row?.can_edit)throw new WorkflowFault(403,'forbidden','当前账号无法启动或重试分析');
 return {stamp:row.stamp,projectId:row.project_id};
}
export type AnalysisGuard = {sql:string;values:unknown[]};
export type AnalysisCreation = {scope:WorkflowScope;eventId:string;key:string;assetVersionIds:string[];sourceRevision:number;guard:AnalysisGuard;replay:(runId:string)=>D1PreparedStatement};
export type AnalysisCreator = (input:AnalysisCreation)=>Promise<{id:string}>;
function sourceGuard(scope:WorkflowScope,eventId:string,stamp:string):AnalysisGuard {
 return {sql:`EXISTS (SELECT 1 ${eventJoin} AND ${editor} AND ${sourceObject}=?)`,values:[scope.workspaceId,eventId,...accessValues(scope),stamp]};
}
function assertKey(key:string) {if(!key.trim()||key.length>128)throw new WorkflowFault(409,'idempotency_conflict','操作需要有效的提交标识');}
async function replayRun(db:D1Database,scope:WorkflowScope,endpoint:string,key:string,hash:string):Promise<string|null> {
 const row=await db.prepare('SELECT request_hash,response_json FROM mutation_replays WHERE workspace_id=? AND actor_id=? AND endpoint_scope=? AND idempotency_key=?').bind(scope.workspaceId,scope.actorId,endpoint,key).first<{request_hash:string;response_json:string}>();
 if(!row)return null;
 if(row.request_hash!==hash)throw new WorkflowFault(409,'idempotency_conflict','同一次提交的内容发生变化，请重新操作');
 return readJson<{runId:string}>(row.response_json,{runId:''}).runId;
}
function replayStatement(db:D1Database,scope:WorkflowScope,endpoint:string,key:string,hash:string,runId:string,timestamp:string) {
 return db.prepare(`INSERT INTO mutation_replays (id,workspace_id,actor_id,endpoint_scope,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,actor_id,endpoint_scope,idempotency_key) DO NOTHING`).bind(mutationId('mrep'),scope.workspaceId,scope.actorId,endpoint,key,hash,JSON.stringify({runId}),timestamp);
}
async function guardedBatch(db:D1Database,guard:AnalysisGuard,statements:D1PreparedStatement[],timestamp:string) {
 const id=mutationId('ag');
 try {await db.batch([db.prepare(`INSERT INTO mutation_guards (id,guard_value,created_at) SELECT ?,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END,?`).bind(id,...guard.values,timestamp),...statements,db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(id)]);}
 catch(error){if(/mutation_guards|ck_mutation_guards_true/.test(error instanceof Error?error.message:String(error)))throw new WorkflowFault(409,'version_conflict','材料、任务或权限已有变化，请重新读取后操作');throw error;}
}
export async function startAnalysis(db:D1Database,scope:WorkflowScope,eventId:string,raw:StartAnalysisRequest,key:string,create:AnalysisCreator,timestamp=new Date().toISOString()):Promise<AnalysisRun> {
 const request=parseWorkflowRequest('StartAnalysisRequest',raw);assertKey(key);
 const {stamp}=await authorize(db,scope,eventId);
 const endpoint=`events/${eventId}/analysis`,hash=await digestValue(request);
 const previous=await replayRun(db,scope,endpoint,key,hash);
 if(previous)return readAnalysisRun(db,scope,previous);
 const source=readJson<{sourceRevision:number;contextVersion:number;materialStatus:string;assets:ProjectionLedger['assets']}>(stamp,{sourceRevision:-1,contextVersion:-1,materialStatus:'',assets:[]});
 if(source.sourceRevision!==request.sourceRevision)throw new WorkflowFault(409,'version_conflict','材料已有更新，请重新读取后整理');
 const assets=source.assets.filter(a=>a.kind!=='audio');
 if(source.materialStatus!=='ready'||!assets.length||source.assets.some(a=>a.processing_status!=='ready'||!a.current_version_id)||source.assets.some(a=>a.kind==='audio'&&!assets.some(t=>readJson<{source_audio_asset_version_id?:string}>(t.metadata_json,{}).source_audio_asset_version_id===a.current_version_id)))throw new WorkflowFault(409,'dependency_conflict','材料仍在处理，请在处理完成后整理记录');
 const ids=assets.map(a=>a.current_version_id!).sort();
 if(ids.length>25)throw new WorkflowFault(409,'dependency_conflict','本次材料超过25份，请分成多次沟通整理');
 const candidates=(await db.prepare('SELECT id,input_manifest_json,status,context_version,model_params_json FROM extraction_runs WHERE workspace_id=? AND event_id=? ORDER BY created_at DESC,id DESC').bind(scope.workspaceId,eventId).all<Row>()).results??[];
 const match=candidates.find(r=>(readJson<{workflow_source_revision?:number}>(String(r.model_params_json),{}).workflow_source_revision===undefined||readJson<{workflow_source_revision?:number}>(String(r.model_params_json),{}).workflow_source_revision===request.sourceRevision) && JSON.stringify(readJson<Array<{asset_version_id:string}>>(String(r.input_manifest_json),[]).map(v=>v.asset_version_id).sort())===JSON.stringify(ids) && (request.mode==='initial'||['queued','processing'].includes(String(r.status))&&Number(r.context_version)===source.contextVersion));
 const guard=sourceGuard(scope,eventId,stamp);
 const replay=(runId:string)=>replayStatement(db,scope,endpoint,key,hash,runId,timestamp);
 if(match){await guardedBatch(db,guard,[replay(String(match.id))],timestamp);return readAnalysisRun(db,scope,String(match.id));}
 const result=await create({scope,eventId,key:`w2:${await digestValue({workspace:scope.workspaceId,actor:scope.actorId,eventId,key})}`,assetVersionIds:ids,sourceRevision:request.sourceRevision,guard,replay});
 // New runs save this receipt with their native outbox. A native deduplication
 // race can return an existing run, in which case only metadata is appended.
 await guardedBatch(db,guard,[replay(result.id)],timestamp);
 return readAnalysisRun(db,scope,result.id);
}
export async function retryAnalysis(db:D1Database,scope:WorkflowScope,runId:string,raw:RetryAnalysisRequest,key:string,timestamp=new Date().toISOString(),limits={maxConcurrentRuns:2}):Promise<AnalysisRun> {
 const request=parseWorkflowRequest('RetryAnalysisRequest',raw);assertKey(key);
 const row=await loadAnalysis(db,scope,runId);
 if(!row.can_edit)throw new WorkflowFault(403,'forbidden','当前账号无法重试分析');
 const endpoint=`analysis-runs/${runId}/retry`,hash=await digestValue(request);
 const previous=await replayRun(db,scope,endpoint,key,hash);
 if(previous)return readAnalysisRun(db,scope,previous);
 const mapped=await mapAnalysisRun(row);
 if(mapped.revision!==request.expectedRunRevision)throw new WorkflowFault(409,'version_conflict','分析进度已有变化，请重新读取');
 const selected=request.stageIds.map(id=>mapped.stages.find(s=>s.id===id));
 if(selected.some(s=>!s||s.state!=='failed'||!s.retryable))throw new WorkflowFault(409,'dependency_conflict','请选择当前允许重试的失败阶段');
 const guard=sourceGuard(scope,String(row.event_id),String(row.source_stamp));
 const statements:D1PreparedStatement[]=[];
 const model=modelStages(row);
 const extraction=selected.some(s=>s!.id===`${runId}:extraction`||model.some(m=>m.id===s!.id));
 const appendGuard=(sql:string,...values:unknown[])=>{guard.sql+=` AND (${sql})`;guard.values.push(...values);};
 appendGuard(`EXISTS (SELECT 1 FROM extraction_runs WHERE id=? AND workspace_id=? AND event_id=? AND status=? AND attempt_no=? AND updated_at=? AND lease_owner IS ?)`,runId,scope.workspaceId,row.event_id,row.status,row.attempt_no,row.updated_at,row.lease_owner);
 if(extraction){
  const omitted=model.filter(s=>s.status==='failed'&&mapped.stages.some(m=>m.id===s.id&&m.retryable)&&!request.stageIds.includes(s.id));
  if(omitted.length)throw new WorkflowFault(409,'dependency_conflict','这些失败阶段需要一起恢复，请选择全部失败的重点分析阶段');
  appendGuard('EXISTS (SELECT 1 FROM queue_outbox WHERE run_id=?)',runId);
  appendGuard('((SELECT COUNT(*) FROM extraction_model_stages WHERE run_id=?)=?)',runId,readJson<ModelStage[]>(String(row.stages),[]).length);
  for(const m of model)appendGuard(`EXISTS (SELECT 1 FROM extraction_model_stages WHERE id=? AND run_id=? AND status=? AND attempt=? AND updated_at=?)`,m.id,runId,m.status,m.attempt,m.updated_at);
  appendGuard(`((SELECT COUNT(*) FROM extraction_runs WHERE workspace_id=? AND status IN ('queued','processing'))<?)`,scope.workspaceId,limits.maxConcurrentRuns);
  appendGuard(`NOT EXISTS (SELECT 1 FROM extraction_runs WHERE workspace_id=? AND event_id=? AND id<>? AND status IN ('queued','processing'))`,scope.workspaceId,row.event_id,runId);
  statements.push(db.prepare(`UPDATE extraction_runs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,error_details_json=NULL,finished_at=NULL,current_queued_at=?,queued_at=?,updated_at=? WHERE id=? AND workspace_id=?`).bind(timestamp,timestamp,timestamp,runId,scope.workspaceId));
  statements.push(db.prepare(`UPDATE queue_outbox SET status='pending',attempt=0,next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,sent_at=NULL,updated_at=? WHERE run_id=?`).bind(timestamp,timestamp,runId));
 }
 for(const a of artifacts(row).filter(a=>request.stageIds.includes(a.id))){
  appendGuard(`EXISTS (SELECT 1 FROM event_ai_artifact_runs WHERE id=? AND workspace_id=? AND extraction_run_id=? AND status='failed' AND updated_at=?)`,a.id,scope.workspaceId,runId,a.updated_at);
  const nextId=mutationId('ear');
  statements.push(db.prepare(`INSERT INTO event_ai_artifact_runs (id,workspace_id,project_id,event_id,extraction_run_id,kind,status,idempotency_key,input_hash,input_manifest_json,provider,model,reasoning_effort,prompt_version,schema_version,provider_request_id,next_attempt_at,queued_at,created_at,updated_at)
    SELECT ?,workspace_id,project_id,event_id,extraction_run_id,kind,'queued',?,input_hash,input_manifest_json,provider,model,reasoning_effort,prompt_version,schema_version,
      CASE WHEN COALESCE(error_code,'') NOT LIKE '%INVALID%' THEN provider_request_id ELSE NULL END,?,?,?,? FROM event_ai_artifact_runs WHERE id=? AND workspace_id=?`)
    .bind(nextId,`w2-retry:${key}`,timestamp,timestamp,timestamp,timestamp,a.id,scope.workspaceId));
 }
 const job=narrative(row);
 if(job && request.stageIds.includes(job.id)){
  appendGuard(`EXISTS (SELECT 1 FROM workflow_outbox WHERE id=? AND workspace_id=? AND state='failed' AND updated_at=? AND payload_json=?)`,job.id,scope.workspaceId,job.updated_at,job.payload_json);
  // A fresh job preserves the failed attempt and its paid usage history. Its
  // checkpoint is rebuilt from the current record rather than reviving stale text.
  statements.push(db.prepare(`INSERT INTO workflow_outbox (id,workspace_id,project_id,event_id,kind,task_key,input_revision,payload_json,available_at,created_at,updated_at) VALUES (?,?,?,?,'narrative',?,?,?, ?,?,?)`).bind(mutationId('wjob'),scope.workspaceId,row.project_id,row.event_id,`narrative-retry:${job.id}:${key}`,row.current_context_version,JSON.stringify(narrativeRetryPayload(job,row,timestamp)),timestamp,timestamp,timestamp));
 }
 statements.push(replayStatement(db,scope,endpoint,key,hash,runId,timestamp));
 try {await guardedBatch(db,guard,statements,timestamp);}catch(error){await authorize(db,scope,String(row.event_id));const raced=await replayRun(db,scope,endpoint,key,hash);if(raced)return readAnalysisRun(db,scope,raced);if(extraction){const count=await db.prepare("SELECT COUNT(*) AS count FROM extraction_runs WHERE workspace_id=? AND status IN ('queued','processing')").bind(scope.workspaceId).first<{count:number}>();if(Number(count?.count)>=limits.maxConcurrentRuns)throw new WorkflowFault(429,'run_limit','已有整理任务正在运行，稍后可重试');}throw error;}
 return readAnalysisRun(db,scope,runId);
}

function narrativeRetryPayload(job:NarrativeJob,row:Row,timestamp:string):Record<string,unknown> {
 const old=readJson<Record<string,unknown>>(job.payload_json,{});
 const cp=old.checkpoint as Record<string,unknown>|undefined;
 if(cp?.providerResponseId && !String(job.error_code).includes('INVALID')) {delete old.auditUsage;return {...old,checkpoint:{...cp,startedAt:timestamp,attempt:0,repairCount:0,transportFailures:0,usage:[]}};}
 return {eventId:row.event_id,contextVersion:row.current_context_version};
}
