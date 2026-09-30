import {claimSourceStatus,projectWorkspace,type ProjectionLedger} from '../../domain/workflow-projection.ts';
import type {VersionRef,WorkspaceSnapshot} from '../../shared/workflow-v2.ts';
import {projectOverview} from '../workflow/overview-service.ts';
import {digestValue,findWorkflowEvent,loadWorkflowLedger,WorkflowFault,type WorkflowScope} from '../workflow/snapshot-store.ts';
export type ReadArgs={project_id?:string;record_id?:string;evidence_id?:string;cursor?:string;limit?:number;views?:string[]};
export const MCP_VIEWS=['record','summary','legacy_summary','chapters','speakers','overview','key_points','readable_transcript'] as const;
const unavailable=()=>new WorkflowFault(404,'not_found','资源不存在或当前账号无法访问');
const query=async<T>(db:D1Database,sql:string,...values:unknown[])=>((await db.prepare(sql).bind(...values).all<T>()).results ?? []);
const encode=(value:unknown)=>btoa(JSON.stringify(value));
function decode(raw:string|undefined,stamp:string):{index:number;offset:number} {
 if(!raw)return {index:0,offset:0};try {if(raw.length>2000)throw Error();const v=JSON.parse(atob(raw));if(v.stamp!==stamp || !Number.isSafeInteger(v.index) || v.index<0 || !Number.isSafeInteger(v.offset) || v.offset<0)throw Error();return v;}catch{throw new WorkflowFault(409,'cursor_expired','内容已有变化，请重新读取第一页。');}
}
function page<T>(items:T[],args:ReadArgs,stamp:string,maxChars=24000) {
 const {index,offset}=decode(args.cursor,stamp);if(offset || index>items.length)throw new WorkflowFault(409,'cursor_expired','列表位置无效，请重新读取。');const selected:T[]=[];let size=0;
 for(let i=index;i<items.length && selected.length<(args.limit??20);i++){const length=JSON.stringify(items[i]).length;if(length>maxChars)throw new WorkflowFault(422,'dependency_conflict','这项内容较长，请通过原文片段读取。');if(size+length>maxChars)break;selected.push(items[i]);size+=length;}
 const next=index+selected.length;return {items:selected,nextCursor:next<items.length?encode({stamp,index:next,offset:0}):null};
}
const sameRef=(a:VersionRef,b:VersionRef)=>a.claimId===b.claimId && a.claimVersionId===b.claimVersionId;
function jsonFragments(serialized:string):string[] {
 const fragments:string[]=[];let offset=0;
 while(offset<serialized.length){let end=Math.min(offset+8000,serialized.length);if(end<serialized.length && /[\uD800-\uDBFF]/.test(serialized[end-1]))end--;fragments.push(serialized.slice(offset,end));offset=end;}
 return fragments;
}
/** Large state/association rows must remain readable within the same page budget. */
function boundedEntries(entries:Array<Record<string,unknown>>):Array<Record<string,unknown>> {
 return entries.flatMap(entry=>{
  const serialized=JSON.stringify(entry);if(serialized.length<=24000)return [entry];
  const fragments=jsonFragments(serialized);
  return fragments.map((content,partIndex)=>({view:entry.view,kind:entry.kind,id:entry.id,eventId:entry.eventId,format:'json_fragment',fragmentOf:'entry',partIndex,partCount:fragments.length,content}));
 });
}
/** Transport the authoritative workspace projection, without the UI's answer
 * substitution or open-only filters. Review, execution and resolution differ. */
function workflowEntries(ledger:ProjectionLedger,snapshot:WorkspaceSnapshot,eventId:string):Array<Record<string,unknown>> {
 const claims=new Map(ledger.claims.map(c=>[c.id,c]));
 const versionReady=(ref:VersionRef)=>{
  const evidence=ledger.evidence.filter(e=>e.claim_version_id===ref.claimVersionId && e.evidence_role!=='contextual');
  return evidence.length>0 && evidence.every(e=>e.availability==='ready' && e.structural_validation_status==='valid');
 };
 const entries=snapshot.bullets.map(b=>{
  const action=snapshot.actions.find(a=>b.claimRefs.some(r=>sameRef(r,a.claimRef)));
  const question=snapshot.questions.find(q=>b.claimRefs.some(r=>sameRef(r,q.claimRef)));
  const claim=claims.get(b.id);
  const answerToQuestionRefs=snapshot.questions.filter(q=>q.answerRefs.some(a=>b.claimRefs.some(r=>sameRef(r,a)))).map(q=>({...q.claimRef,revision:q.revision}));
  const resultForActionRefs=snapshot.actions.filter(a=>a.latestOutcome?.resultRefs?.some(result=>b.claimRefs.some(r=>sameRef(r,result)))).map(a=>({...a.claimRef,revision:a.revision}));
  return {...b,kind:claim?.type==='next_action'?'action':claim?.type==='open_question'?'question':'record_bullet',claimType:claim?.type,eventId:claim?.event_id ?? eventId,text:b.sourceStatus==='ready'?b.text:null,
   ...(action?{...action,basisDetails:action.basisDetails.map(basis=>({...basis,acceptedText:versionReady(basis.acceptedRef)?basis.acceptedText:null,currentText:basis.sourceStatus==='ready'?basis.currentText:null})),...(b.sourceStatus!=='ready'?{ownerHint:undefined,dueAt:undefined}:{})}:{}),
   ...(question ?? {}),...(answerToQuestionRefs.length?{answerToQuestionRefs}:{}),...(resultForActionRefs.length?{resultForActionRefs}:{})};
 });
 return [...entries,...(snapshot.actionHistory ?? []).map(action=>{
  const replacement=action.replacementRef?claims.get(action.replacementRef.claimId):null;
  return {...action,kind:'action_history',eventId:claims.get(action.id)?.event_id ?? eventId,reviewState:'accepted',lifecycleState:'superseded',text:action.sourceStatus==='ready'?action.text:null,replacementText:replacement && claimSourceStatus(replacement,ledger.evidence)==='ready'?action.replacementText:null};
 })];
}
async function record(db:D1Database,scope:WorkflowScope,id:string) {const projectId=await findWorkflowEvent(db,scope,id);const ledger=await loadWorkflowLedger(db,scope,projectId);return {projectId,ledger,snapshot:projectWorkspace(ledger,id,new Date().toISOString(),'')};}
export async function readMcpTool(db:D1Database,scope:WorkflowScope,name:string,args:ReadArgs) {
 const now=new Date().toISOString();
 if(name==='list_projects'){
  const rows=await query<{id:string;name:string;updated_at:string;context_version:number}>(db,`SELECT p.id,p.name,p.updated_at,p.context_version FROM projects p WHERE p.workspace_id=? AND p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=p.workspace_id AND m.actor_id=? AND m.revoked_at IS NULL) ORDER BY p.updated_at DESC,p.id`,scope.workspaceId,scope.actorId);
  return {kind:'projects',...page(rows,args,await digestValue(rows))};
 }
 if(name==='list_records'){
  const ledger=await loadWorkflowLedger(db,scope,args.project_id!);const rows=ledger.events.toSorted((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||a.id.localeCompare(b.id)).map(e=>({id:e.id,title:e.title,occurredAt:e.occurred_at,sourceRevision:e.source_revision,analysisState:ledger.runs.find(r=>r.id===e.active_run_id)?.status ?? 'not_generated'}));return {kind:'records',contextVersion:ledger.contextVersion,...page(rows,args,await digestValue(rows))};
 }
 if(name==='get_project_brief'){
  const ledger=await loadWorkflowLedger(db,scope,args.project_id!);const brief=projectOverview(ledger,now);
  const projected=ledger.events.toSorted((a,b)=>b.occurred_at.localeCompare(a.occurred_at)||a.id.localeCompare(b.id)).flatMap(event=>workflowEntries(ledger,projectWorkspace(ledger,event.id,now,''),event.id));
  const byEntry=new Map<string,Record<string,unknown>>();
  for(const entry of projected.filter(entry=>entry.kind!=='record_bullet' || entry.reviewState==='accepted')){
   const key=`${entry.kind}:${entry.id}`,previous=byEntry.get(key);
   const merged:Record<string,unknown>={...(previous ?? entry),kind:entry.kind==='record_bullet'?'accepted_fact':entry.kind};
   // The same answer can appear in its source record and in several question
   // records. Deduplication must retain every projected exact association.
   for(const field of ['answerToQuestionRefs','resultForActionRefs']){
    const refs=[...((previous?.[field] as VersionRef[] | undefined) ?? []),...((entry[field] as VersionRef[] | undefined) ?? [])];
    if(refs.length)merged[field]=[...new Map(refs.map(ref=>[JSON.stringify(ref),ref])).values()];
   }
   byEntry.set(key,merged);
  }
  const entries=[...byEntry.values()];
  return {kind:'project_brief',contextVersion:ledger.contextVersion,counts:brief.counts,...page(boundedEntries(entries),args,await digestValue({contextVersion:ledger.contextVersion,entries}))};
 }
 if(name==='get_record_views'){
  const {projectId,ledger,snapshot}=await record(db,scope,args.record_id!);const views=args.views ?? ['record'];const entries:Array<Record<string,unknown>>=[];
  if(views.includes('record'))for(const entry of workflowEntries(ledger,snapshot,args.record_id!))entries.push({view:'record',...entry});
  if(views.includes('record'))for(const mention of snapshot.reaffirmedMentions ?? [])entries.push({view:'record',...mention,memberKind:mention.kind,kind:'reaffirmed_mention'});
  if(views.includes('summary')){const n=snapshot.narrative;if(n?.text)for(const sentence of n.sentenceRefs)entries.push({view:'summary',...sentence,freshness:n.freshness,basedOnContextVersion:n.basedOnContextVersion});else entries.push({view:'summary',state:n?.freshness ?? 'not_generated'});}
  for(const kind of views.filter(v=>!['record','summary'].includes(v))){
   const storageKind=kind==='legacy_summary'?'summary':kind;
   const latest=await db.prepare(`SELECT status FROM event_ai_artifact_runs WHERE workspace_id=? AND project_id=? AND event_id=? AND kind=? ORDER BY queued_at DESC,id DESC LIMIT 1`).bind(scope.workspaceId,projectId,args.record_id,storageKind).first<{status:string}>();
   const generationState=latest?.status ?? 'not_generated';
   const rows=await query<{id:string;artifact_version:number;content_json:string;created_at:string;input_manifest_json:string}>(db,`SELECT a.id,a.artifact_version,a.content_json,a.created_at,r.input_manifest_json FROM event_ai_artifacts a JOIN event_ai_artifact_runs r ON r.id=a.run_id AND r.workspace_id=a.workspace_id AND r.project_id=a.project_id AND r.event_id=a.event_id WHERE a.workspace_id=? AND a.project_id=? AND a.event_id=? AND a.kind=? ORDER BY a.artifact_version DESC LIMIT 1`,scope.workspaceId,projectId,args.record_id,storageKind);
   if(!rows.length){entries.push({view:kind,state:generationState,content:null});continue;}
   const a=rows[0],manifest=JSON.parse(a.input_manifest_json || '{}');
   const sourceIds=Array.isArray(manifest)?manifest.map((entry:{asset_version_id?:string})=>entry.asset_version_id).filter((value):value is string=>typeof value==='string'):[];
   const current=await query<{current_version_id:string}>(db,`SELECT current_version_id FROM assets a WHERE workspace_id=? AND project_id=? AND event_id=? AND processing_status='ready' AND current_version_id IN(SELECT value FROM json_each(?)) AND COALESCE(a.failure_code,'') NOT IN ('UPLOAD_ABORTED','UPLOAD_EXPIRED') AND (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS(SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.project_id=a.project_id AND audio.event_id=a.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id')))`,scope.workspaceId,projectId,args.record_id,JSON.stringify(sourceIds));
   const ready=sourceIds.length>0 && sourceIds.every(id=>current.some(asset=>asset.current_version_id===id));
   if(!ready){entries.push({view:kind,id:a.id,version:a.artifact_version,state:'stale',generationState,content:null});continue;}
   const serialized=JSON.stringify(JSON.parse(a.content_json));
   // Fragment offsets preserve UTF-16 boundaries so rejoining yields exact JSON.
   const fragments=jsonFragments(serialized);
   fragments.forEach((content,partIndex)=>entries.push({view:kind,id:a.id,version:a.artifact_version,createdAt:a.created_at,state:'generated',generationState,reviewState:'draft',format:'json_fragment',partIndex,partCount:fragments.length,content}));
  }
  return {kind:'record_views',contextVersion:snapshot.contextVersion,sourceRevision:snapshot.sourceRevision,coverage:snapshot.coverage,...page(boundedEntries(entries),args,await digestValue({contextVersion:snapshot.contextVersion,sourceRevision:snapshot.sourceRevision,coverage:snapshot.coverage,entries}))};
 }
 if(name==='get_record_excerpt'){
  const {projectId,ledger,snapshot}=await record(db,scope,args.record_id!);const rows=await query<{id:string;asset_version_id:string;ordinal:number;speaker:string|null;start_ms:number|null;end_ms:number|null;text_raw:string}>(db,`SELECT s.id,s.asset_version_id,s.ordinal,s.speaker,s.start_ms,s.end_ms,s.text_raw FROM text_segments s JOIN assets a ON a.id=s.asset_id AND a.current_version_id=s.asset_version_id WHERE s.workspace_id=? AND s.project_id=? AND s.event_id=? AND a.workspace_id=s.workspace_id AND a.project_id=s.project_id AND a.event_id=s.event_id AND a.processing_status='ready' AND COALESCE(a.failure_code,'') NOT IN ('UPLOAD_ABORTED','UPLOAD_EXPIRED') AND COALESCE(json_extract(a.metadata_json,'$.analysis_source'),1)<>0 AND COALESCE(json_extract(a.metadata_json,'$.artifact_kind'),'')<>'readable_transcript' AND COALESCE(json_extract(a.metadata_json,'$.transcription_chunk'),0)<>1 AND (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS(SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.project_id=a.project_id AND audio.event_id=a.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id'))) ORDER BY s.asset_version_id,s.ordinal,s.id`,scope.workspaceId,projectId,args.record_id);
  const stamp=await digestValue({sourceRevision:snapshot.sourceRevision,rows});let {index,offset}=decode(args.cursor,stamp);if(index>rows.length || offset>(rows[index]?.text_raw.length ?? 0))throw new WorkflowFault(409,'cursor_expired','原文位置无效。');let remaining=20000;const segments=[];
  while(index<rows.length && segments.length<Math.min(args.limit??100,100) && remaining>0){const row=rows[index];let end=Math.min(offset+remaining,row.text_raw.length);if(end<row.text_raw.length && /[\uD800-\uDBFF]/.test(row.text_raw[end-1] ?? ''))end--;if(end===offset && row.text_raw.length>offset)break;const text=row.text_raw.slice(offset,end);segments.push({...row,text_raw:undefined,text,startOffset:offset,endOffset:offset+text.length});remaining-=text.length;offset+=text.length;if(offset>=row.text_raw.length){index++;offset=0;}}
  return {kind:'original_excerpt',sourceRevision:snapshot.sourceRevision,contextVersion:ledger.contextVersion,segments,nextCursor:index<rows.length?encode({stamp,index,offset}):null};
 }
 if(name==='get_evidence'){
  const e=await db.prepare(`SELECT er.id,er.project_id,er.event_id,er.claim_version_id,er.kind,er.asset_version_id,er.segment_ids_json,er.quote_raw,er.user_note_id FROM evidence_refs er JOIN events ev ON ev.id=er.event_id AND ev.workspace_id=er.workspace_id JOIN projects p ON p.id=er.project_id AND p.workspace_id=er.workspace_id WHERE er.id=? AND er.workspace_id=? AND ev.project_id=p.id AND ev.material_status<>'archived' AND p.deleted_at IS NULL`).bind(args.evidence_id,scope.workspaceId).first<{id:string;project_id:string;event_id:string;claim_version_id:string;kind:string;asset_version_id:string|null;segment_ids_json:string|null;quote_raw:string|null;user_note_id:string|null}>();if(!e)throw unavailable();const ledger=await loadWorkflowLedger(db,scope,e.project_id);const ref=ledger.evidence.find(r=>r.id===e.id);const availability=ref?.structural_validation_status==='valid'?ref.availability:'missing';if(availability!=='ready')return {kind:'evidence',id:e.id,recordId:e.event_id,claimVersionId:e.claim_version_id,sourceStatus:availability,quote:null,segments:[]};let quote=e.quote_raw ?? '';if(e.kind==='user_note'){const note=await db.prepare('SELECT body FROM user_notes WHERE id=? AND workspace_id=? AND project_id=?').bind(e.user_note_id,scope.workspaceId,e.project_id).first<{body:string}>();quote=note?.body ?? '';}
  const selectedIds=e.segment_ids_json || '[]';
  const segments=await query<{id:string;ordinal:number;text_raw:string;speaker:string|null;start_ms:number|null;end_ms:number|null;selected:number}>(db,`SELECT id,ordinal,text_raw,speaker,start_ms,end_ms,CASE WHEN id IN(SELECT value FROM json_each(?)) THEN 1 ELSE 0 END AS selected FROM text_segments WHERE workspace_id=? AND project_id=? AND event_id=? AND asset_version_id=? AND ordinal BETWEEN (SELECT MIN(ordinal)-1 FROM text_segments WHERE asset_version_id=? AND id IN(SELECT value FROM json_each(?))) AND (SELECT MAX(ordinal)+1 FROM text_segments WHERE asset_version_id=? AND id IN(SELECT value FROM json_each(?))) ORDER BY CASE WHEN id IN(SELECT value FROM json_each(?)) THEN 0 ELSE 1 END,ordinal,id LIMIT 101`,selectedIds,scope.workspaceId,e.project_id,e.event_id,e.asset_version_id,e.asset_version_id,selectedIds,e.asset_version_id,selectedIds,selectedIds);
  const safePrefix=(value:string,limit:number)=>{let end=Math.min(value.length,limit);if(end<value.length && /[\uD800-\uDBFF]/.test(value[end-1] ?? ''))end--;return value.slice(0,end);};
  let left=6000;const context:Array<(typeof segments)[number]>=[];
  for(const segment of segments.slice(0,100)){if(left<=0)break;const text=safePrefix(segment.text_raw,left);if(!text && segment.text_raw)break;context.push({...segment,text_raw:text});left-=text.length;}
  const contextTruncated=context.length<segments.length || context.some(segment=>segment.text_raw.length<segments.find(original=>original.id===segment.id)!.text_raw.length);
  context.sort((a,b)=>a.ordinal-b.ordinal || a.id.localeCompare(b.id));
  return {kind:'evidence',id:e.id,recordId:e.event_id,claimVersionId:e.claim_version_id,assetVersionId:e.asset_version_id,sourceStatus:availability,quote:safePrefix(quote,6000),quoteTruncated:quote.length>6000,segments:context,contextTruncated};
 }
 throw new WorkflowFault(404,'not_found','没有找到这个只读工具。');
}
