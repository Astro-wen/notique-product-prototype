import { buildRecordText } from '../../domain/workflow-v2.ts';
import { projectWorkspace, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type ReportRequest, type ReportSnapshot } from '../../shared/workflow-v2.ts';
import { digestValue, PROJECT_LEDGER_SQL, WorkflowFault, type WorkflowScope } from './snapshot-store.ts';
import { mutationId } from './transaction.ts';

type ReportRow = { id:string; context_version:number; scope:ReportRequest['scope']; content:string; created_at:string };
const toReport = (row: ReportRow): ReportSnapshot => ({ id:row.id, contextVersion:row.context_version, scope:row.scope, content:row.content, createdAt:row.created_at });

/** A report freezes existing text. Viewers can export without invoking generation
 * or advancing the business context. Receipts store IDs, never retained copies. */
export async function createReport(
  db: D1Database, scope: WorkflowScope,
  input: { projectId:string; key:string; request:ReportRequest },
): Promise<ReportSnapshot> {
  const request = parseWorkflowRequest('ReportRequest', input.request);
  if (!input.key.trim() || input.key.length > 128) throw new WorkflowFault(409,'idempotency_conflict','复制需要有效的提交标识');
  const timestamp = new Date().toISOString();
  const endpoint = `projects/${input.projectId}/reports`;
  const hash = await digestValue(request);
  const parameters = [scope.workspaceId, scope.actorId, input.projectId, scope.access === 'demo' ? 1 : 0];
  const authorize = async () => {
    const row = await db.prepare(PROJECT_LEDGER_SQL).bind(...parameters).first<Record<string,unknown>>();
    if (!row) throw new WorkflowFault(404,'not_found','事项不存在或当前账号无法访问');
    return row;
  };
  const replay = async (): Promise<ReportSnapshot | null> => {
    const saved = await db.prepare('SELECT request_hash,response_json FROM mutation_replays WHERE workspace_id=? AND actor_id=? AND endpoint_scope=? AND idempotency_key=?')
      .bind(scope.workspaceId,scope.actorId,endpoint,input.key).first<{request_hash:string;response_json:string}>();
    if (!saved) return null;
    if (saved.request_hash !== hash) throw new WorkflowFault(409,'idempotency_conflict','复制范围发生了变化，请重新操作');
    const id = (JSON.parse(saved.response_json) as {reportId:string}).reportId;
    const report = await db.prepare(`SELECT id,context_version,scope,content,created_at FROM workflow_reports
      WHERE id=? AND workspace_id=? AND project_id=? AND actor_id=?
      AND NOT EXISTS (SELECT 1 FROM json_each(event_ids_json) picked
        WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.id=picked.value AND e.workspace_id=workflow_reports.workspace_id
          AND e.project_id=workflow_reports.project_id AND e.material_status<>'archived'))
      AND json_extract(snapshot_json,'$.schemaVersion')=1
      AND NOT EXISTS (SELECT 1 FROM json_each(snapshot_json,'$.sources') source
        WHERE NOT EXISTS (SELECT 1 FROM assets a
          WHERE a.id=json_extract(source.value,'$.assetId') AND a.current_version_id=json_extract(source.value,'$.assetVersionId')
            AND a.event_id=json_extract(source.value,'$.eventId') AND a.processing_status='ready'
            AND a.workspace_id=workflow_reports.workspace_id AND a.project_id=workflow_reports.project_id
            AND EXISTS (SELECT 1 FROM events e WHERE e.id=a.event_id AND e.workspace_id=a.workspace_id
              AND e.project_id=a.project_id AND e.material_status<>'archived')
            AND (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS
              (SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.event_id=a.event_id
                AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id')))))`)
      .bind(id,scope.workspaceId,input.projectId,scope.actorId).first<ReportRow>();
    if (!report) throw new WorkflowFault(409,'cursor_expired','这份复制结果已失效，请重新复制当前记录');
    return toReport(report);
  };
  const row = await authorize();
  const existing = await replay();
  if (existing) return existing;
  if (Number(row.context_version) !== request.expectedContextVersion) throw new WorkflowFault(409,'version_conflict','记录已有变化，请读取最新内容后复制');
  const collections = Object.keys(row).filter(key => key !== 'id' && key !== 'context_version' && key !== 'can_edit');
  const ledger = {contextVersion:Number(row.context_version), ...Object.fromEntries(collections.map(key => [key,JSON.parse(String(row[key]))]))} as ProjectionLedger;
  const requested = new Set(request.eventIds);
  if (request.eventIds.some(id => !ledger.events.some(event => event.id === id))) throw new WorkflowFault(404,'not_found','所选记录不存在或已移出当前事项');
  const events = ledger.events.filter(event => !requested.size || requested.has(event.id)).sort((a,b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
  const versions = events.map(event => ({event, snapshot:projectWorkspace(ledger,event.id,timestamp,'')}));
  const content = versions.map(({event,snapshot}) => buildRecordText({title:event.title,bullets:snapshot.bullets,questions:snapshot.questions,actions:snapshot.actions,narrative:snapshot.narrative,coverage:snapshot.coverage,reaffirmedMentions:snapshot.reaffirmedMentions,scope:request.scope,format:request.format})).join('\n\n') || '当前事项还没有沟通记录。';
  const report: ReportSnapshot = {id:mutationId('report'),contextVersion:ledger.contextVersion,scope:request.scope,content,createdAt:timestamp};
  const mentionVersions=(snapshot:ReturnType<typeof projectWorkspace>)=>request.scope==='mixed'?(snapshot.reaffirmedMentions ?? []).filter(m=>m.sourceStatus==='ready' && m.targetText!==null).map(m=>m.claimRef.claimVersionId):[];
  const includedVersions = [...new Set(versions.flatMap(({snapshot}) => [...snapshot.bullets.filter(b=>request.scope==='mixed'||b.reviewState==='accepted').flatMap(b=>b.claimRefs.map(r=>r.claimVersionId)),...mentionVersions(snapshot)]))];
  const referencedSources = includedVersions.length ? (await db.prepare(`SELECT DISTINCT a.id AS assetId,av.id AS assetVersionId,a.event_id AS eventId
    FROM evidence_refs er JOIN asset_versions av ON av.id=er.asset_version_id JOIN assets a ON a.id=av.asset_id
    WHERE er.workspace_id=? AND er.project_id=? AND er.claim_version_id IN (${includedVersions.map(()=>'?').join(',')})
    AND a.workspace_id=er.workspace_id AND a.project_id=er.project_id AND a.current_version_id=av.id AND a.processing_status='ready'`)
    .bind(scope.workspaceId,input.projectId,...includedVersions).all<{assetId:string;assetVersionId:string;eventId:string}>()).results : [];
  const sourceMap = new Map((referencedSources ?? []).map(source=>[source.assetVersionId,source]));
  for (const asset of ledger.assets.filter(a=>events.some(e=>e.id===a.event_id) && a.current_version_id && a.processing_status==='ready')) {
    sourceMap.set(asset.current_version_id!,{assetId:asset.id,assetVersionId:asset.current_version_id!,eventId:asset.event_id});
  }
  const frozen = {schemaVersion:1,sources:[...sourceMap.values()],records:versions.map(({event,snapshot})=>({eventId:event.id,coverage:snapshot.coverage,
    bulletRefs:snapshot.bullets.filter(b=>request.scope==='mixed'||b.reviewState==='accepted').map(b=>({id:b.id,claimRefs:b.claimRefs,reviewState:b.reviewState,sourceStatus:b.sourceStatus})),
    mentionRefs:request.scope==='mixed'?(snapshot.reaffirmedMentions ?? []).map(m=>({id:m.id,claimRef:m.claimRef,associationState:m.associationState,targetState:m.targetState,sourceStatus:m.sourceStatus})):[],
    questions:snapshot.questions.map(q=>({claimRef:q.claimRef,answerRefs:q.answerRefs,resolutionState:q.resolutionState}))}))};
  const dependencies: D1PreparedStatement[] = [];
  const dependency = (eventId:string, claimVersionId:string|null, assetVersionId:string|null) =>
    db.prepare('INSERT INTO derived_dependencies (id,workspace_id,project_id,event_id,derived_type,derived_id,claim_version_id,asset_version_id,scope) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(mutationId('dep'),scope.workspaceId,input.projectId,eventId,'report',report.id,claimVersionId,assetVersionId,request.scope);
  for (const {event,snapshot} of versions) {
    const refs = new Set([...snapshot.bullets.filter(b=>request.scope==='mixed'||b.reviewState==='accepted').flatMap(b=>b.claimRefs.map(r=>r.claimVersionId)),...mentionVersions(snapshot)]);
    for (const version of refs) dependencies.push(dependency(event.id,version,null));

  }
  for (const source of sourceMap.values()) dependencies.push(dependency(source.eventId,null,source.assetVersionId));
  const guardId = mutationId('rguard');
  // Compare the entire ledger inside the write batch, including legacy source
  // changes that do not yet advance context_version. Numbered binds are local
  // to this prepared statement and preserve the query's original four binds.
  const guards = ['context_version', ...collections];
  const guardParameters = [...parameters, ...guards.map(key=>row[key]), guardId, timestamp];
  const firstExtra = 5;
  const guardIndex = firstExtra + guards.length;
  const compare = guards.map((key,i)=>`ledger.${key}=?${firstExtra+i}`).join(' AND ');
  const guard = db.prepare(`INSERT INTO mutation_guards (id,guard_value,created_at)
    SELECT ?${guardIndex},CASE WHEN EXISTS (SELECT 1 FROM (${PROJECT_LEDGER_SQL}) ledger WHERE ${compare}) THEN 1 ELSE 0 END,?${guardIndex+1}`).bind(...guardParameters);
  try {
    await db.batch([
      guard,
      db.prepare('INSERT INTO workflow_reports (id,workspace_id,project_id,actor_id,event_ids_json,context_version,scope,format,content,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(report.id,scope.workspaceId,input.projectId,scope.actorId,JSON.stringify(events.map(event=>event.id)),report.contextVersion,request.scope,request.format,content,JSON.stringify(frozen),timestamp),
      ...dependencies,
      db.prepare('INSERT INTO mutation_replays (id,workspace_id,actor_id,endpoint_scope,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .bind(mutationId('mrep'),scope.workspaceId,scope.actorId,endpoint,input.key,hash,JSON.stringify({reportId:report.id}),timestamp),
      db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(guardId),
    ]);
  } catch (error) {
    await authorize();
    const raced = await replay();
    if (raced) return raced;
    if (/mutation_guards|ck_mutation_guards_true/.test(error instanceof Error ? error.message : String(error))) throw new WorkflowFault(409,'version_conflict','记录或来源已有变化，请重新复制');
    throw error;
  }
  return report;
}
