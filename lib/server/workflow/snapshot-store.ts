import { projectWorkspace, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { parseWorkflowRequest, type WorkspaceQuery, type WorkspaceSnapshot } from '../../shared/workflow-v2.ts';

export type WorkflowScope = { workspaceId: string; actorId: string; access: 'members' | 'demo' };
export const WORKFLOW_SNAPSHOT_PROJECTION_VERSION = 'workflow-v2-projection.v2';
export class WorkflowFault extends Error {
  status: number;
  code: 'not_found' | 'forbidden' | 'version_conflict' | 'cursor_expired' | 'snapshot_busy' | 'dependency_conflict' | 'idempotency_conflict' | 'run_limit';
  details?: Record<string, unknown>;
  constructor(status: number, code: WorkflowFault['code'], message: string, details?: Record<string, unknown>) {
    super(message); this.name = 'WorkflowFault'; this.status = status; this.code = code; this.details = details;
  }
}

/** Columns are static application identifiers. Values always use bound parameters. */
function collection(table: string, columns: string[], predicate: string, joins = ''): string {
  const entries=columns.flatMap(column=>{const alias=column.match(/ AS ([a-zA-Z_][a-zA-Z_0-9]*)$/);return [`'${alias?.[1] ?? column.split('.').at(-1)}'`,alias?column.slice(0,-alias[0].length):column];});
  return `(SELECT COALESCE(json_group_array(json_object(${entries.join(',')})), '[]') FROM ${table} ${joins} WHERE ${predicate})`;
}
const owned = 'x.workspace_id = p.workspace_id AND x.project_id = p.id';
const liveEvent = `EXISTS (SELECT 1 FROM events alive WHERE alive.id = x.event_id AND alive.workspace_id = p.workspace_id AND alive.project_id = p.id AND alive.material_status <> 'archived')`;
const ownedEvent = `${owned} AND ${liveEvent}`;
const analysisSource = `COALESCE(json_extract(x.metadata_json,'$.analysis_source'),1) <> 0
  AND COALESCE(json_extract(x.metadata_json,'$.artifact_kind'),'') <> 'readable_transcript'
  AND COALESCE(json_extract(x.metadata_json,'$.transcription_chunk'),0) <> 1
  AND COALESCE(x.failure_code,'') NOT IN ('UPLOAD_ABORTED','UPLOAD_EXPIRED')
  AND (json_extract(x.metadata_json,'$.source_audio_asset_version_id') IS NULL OR EXISTS
    (SELECT 1 FROM assets audio WHERE audio.workspace_id = x.workspace_id AND audio.event_id = x.event_id AND audio.kind = 'audio' AND audio.current_version_id = json_extract(x.metadata_json,'$.source_audio_asset_version_id')))`;
// Occurrence payloads retain the model proposal. Resolve every referenced asset
// and segment inside the authorized project before the projection exposes text.
const mentionPayload = "CASE WHEN json_valid(x.evidence_ref_json) THEN x.evidence_ref_json ELSE '{}' END";
const mentionItem = "CASE WHEN item.type='object' THEN item.value ELSE '{}' END";
const mentionVersion = `json_extract(${mentionItem},'$.assetVersionId')`;
const mentionSegmentIds = `CASE WHEN json_valid(json_extract(${mentionItem},'$.segmentIdsJson')) THEN json_extract(${mentionItem},'$.segmentIdsJson') ELSE '[]' END`;
const mentionSources = `(SELECT COALESCE(json_group_array(json_object('ordinal',CAST(item.key AS INTEGER),'asset_version_id',av.id,
  'availability',CASE WHEN a.id IS NULL OR item.type<>'object' THEN 'missing'
    WHEN a.current_version_id IS NULL OR a.current_version_id<>av.id OR a.processing_status<>'ready'
      OR COALESCE(a.failure_code,'') IN ('UPLOAD_ABORTED','UPLOAD_EXPIRED')
      OR (json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM assets audio WHERE audio.workspace_id=p.workspace_id AND audio.project_id=p.id AND audio.event_id=x.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id'))) THEN 'stale' ELSE 'ready' END,
  'segments_json',(SELECT COALESCE(json_group_array(json_object('id',ts.id,'text',ts.text_raw)), '[]')
    FROM json_each(${mentionSegmentIds}) picked
    JOIN text_segments ts ON ts.id=picked.value AND ts.asset_version_id=av.id AND ts.asset_id=a.id
      AND ts.workspace_id=p.workspace_id AND ts.project_id=p.id AND ts.event_id=x.event_id)
  )), '[]') FROM json_each(${mentionPayload},'$.evidence') item
  LEFT JOIN asset_versions av ON av.id=${mentionVersion}
  LEFT JOIN assets a ON a.id=av.asset_id AND a.workspace_id=p.workspace_id AND a.project_id=p.id AND a.event_id=x.event_id)`;
const fields = {
  mentions: collection('claim_occurrence_candidates x', ['x.id','x.event_id','x.extraction_run_id','x.target_claim_id','x.target_claim_version_id','x.base_version_id','x.status','x.evidence_ref_json','x.created_at','target_version.statement AS target_statement',`${mentionSources} AS evidence_sources_json`,
    `EXISTS (SELECT 1 FROM occurrence_verdicts verdict JOIN claim_occurrences occurrence ON occurrence.occurrence_verdict_id=verdict.id JOIN evidence_refs er ON er.id=occurrence.evidence_ref_id
      WHERE verdict.candidate_id=x.id AND verdict.action='confirm' AND verdict.target_base_version_id=x.target_claim_version_id
        AND x.base_version_id=x.target_claim_version_id AND occurrence.claim_id=x.target_claim_id AND occurrence.claim_version_id=x.target_claim_version_id
        AND occurrence.event_id=x.event_id AND er.workspace_id=p.workspace_id AND er.project_id=p.id AND er.event_id=x.event_id
        AND er.claim_version_id=x.target_claim_version_id AND er.structural_validation_status='valid') AS confirmed`], `${ownedEvent} AND x.status IN ('pending','confirmed')`,
    `LEFT JOIN claims target ON target.id=x.target_claim_id AND target.workspace_id=p.workspace_id AND target.project_id=p.id
      AND EXISTS (SELECT 1 FROM events prior WHERE prior.id=target.event_id AND prior.workspace_id=p.workspace_id AND prior.project_id=p.id AND prior.material_status<>'archived')
    LEFT JOIN claim_versions target_version ON target_version.id=x.target_claim_version_id AND target_version.claim_id=target.id`),
  events: collection('events x', ['x.id','x.active_run_id','x.source_revision','x.title','x.occurred_at'], `${owned} AND x.material_status <> 'archived'`),
  claims: collection('claims x', ['x.id','x.project_id','x.event_id','x.type','x.review_status','x.lifecycle_status','x.current_version_id','x.workflow_revision','x.extraction_run_id','x.source','x.confidence','x.needs_additional_evidence','x.resolved_at','v.statement','v.normalized_value_json','v.source AS version_source','v.workflow_origin','x.created_at','x.updated_at'], ownedEvent, 'JOIN claim_versions v ON v.id = x.current_version_id AND v.claim_id = x.id'),
  evidence: collection('evidence_refs x', ['x.id','x.claim_version_id','x.kind','x.evidence_role','x.structural_validation_status','x.semantic_support_verdict', `CASE WHEN x.kind = 'user_note' THEN CASE WHEN EXISTS (SELECT 1 FROM user_notes n WHERE n.id = x.user_note_id AND n.workspace_id = p.workspace_id AND n.project_id = p.id AND n.claim_id = cv.claim_id AND length(n.author_id) > 0) THEN 'ready' ELSE 'missing' END WHEN a.id IS NULL THEN 'missing' WHEN json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assets audio WHERE audio.workspace_id=a.workspace_id AND audio.event_id=a.event_id AND audio.kind='audio' AND audio.current_version_id=json_extract(a.metadata_json,'$.source_audio_asset_version_id')) THEN 'stale' WHEN a.current_version_id IS NULL OR a.current_version_id <> x.asset_version_id OR a.processing_status <> 'ready' THEN 'stale' ELSE 'ready' END AS availability`], ownedEvent,
    `JOIN claim_versions cv ON cv.id = x.claim_version_id JOIN claims c ON c.id = cv.claim_id AND c.workspace_id = p.workspace_id AND c.project_id = p.id AND (x.event_id=c.event_id OR x.evidence_role='contextual') LEFT JOIN asset_versions av ON av.id = x.asset_version_id LEFT JOIN assets a ON a.id = av.asset_id AND a.workspace_id = p.workspace_id AND a.project_id = p.id AND a.event_id = x.event_id`),
  relations: collection('claim_relations x', ['x.id','x.source_claim_version_id','x.target_claim_version_id','x.type','x.status','x.contradiction_status','x.reason','x.resolved_at','x.resolved_by_verdict_id','x.resolved_by_relation_id','sv.claim_id AS source_claim_id','tv.claim_id AS target_claim_id'], owned, 'JOIN claim_versions sv ON sv.id=x.source_claim_version_id JOIN claim_versions tv ON tv.id=x.target_claim_version_id'),
  decisions: collection('workflow_decisions x', ['x.id','x.event_id','x.revision','x.operation',"CASE WHEN x.operation='confirm_mention' THEN '再次提及已沿用原事项' WHEN x.operation='reject_mention' THEN '已忽略此次关联' WHEN x.operation='convert_mention' THEN '再次提及已作为独立草稿' WHEN x.operation='review_members' THEN (SELECT group_concat(v.statement,' / ') FROM decision_members dm JOIN claim_versions v ON v.id=dm.after_version_id WHERE dm.decision_id=x.id AND dm.workspace_id=p.workspace_id) ELSE COALESCE((SELECT cv.statement FROM decision_members dm JOIN claim_versions cv ON cv.id=dm.after_version_id WHERE dm.decision_id=x.id AND dm.workspace_id=p.workspace_id AND json_extract(dm.before_state_json,'$.cardState') IS NOT NULL ORDER BY dm.id LIMIT 1),wc.title,'批阅记录') END AS summary",'x.created_at','x.reverted_by',"(SELECT CASE WHEN json_valid(json_extract(dm.after_state_json,'$.relationStates[0].reason')) THEN json_extract(json_extract(dm.after_state_json,'$.relationStates[0].reason'),'$.mode') ELSE NULL END FROM decision_members dm WHERE dm.decision_id=x.id AND dm.workspace_id=p.workspace_id AND json_extract(dm.before_state_json,'$.cardState') IS NOT NULL ORDER BY dm.id LIMIT 1) AS choice_mode"], ownedEvent, 'LEFT JOIN workflow_cards wc ON wc.id=x.card_id AND wc.workspace_id=p.workspace_id'),
  cards: collection('workflow_cards x', ['x.id','x.event_id','x.group_key','x.created_at','x.revision','x.kind','x.title','x.needs_decision','x.reason_code','x.reason','x.disposition','x.latest_decision_id','x.decision_revision'], ownedEvent),
  members: collection('card_members x', ['x.card_id','x.claim_id','x.claim_version_id','x.role'], 'x.workspace_id = p.workspace_id AND wc.project_id = p.id AND wc.workspace_id = p.workspace_id', 'JOIN workflow_cards wc ON wc.id = x.card_id'),
  changes: collection('workflow_changes x', ['x.id','x.event_id','x.kind','x.changed_refs_json','x.created_at'], ownedEvent),
  progress: collection('review_progress x', ['x.event_id','x.last_card_id','x.finished_at'], `${ownedEvent} AND x.actor_id=?2`),
  deferrals: collection('review_deferrals x', ['x.card_id','x.until_at'], 'x.workspace_id = p.workspace_id AND x.actor_id = ?2 AND wc.project_id = p.id AND wc.workspace_id = p.workspace_id', 'JOIN workflow_cards wc ON wc.id = x.card_id'),
  basisVersions: collection('action_metadata x', ['v.id','v.claim_id','v.statement'], ownedEvent, "JOIN json_each(x.basis_version_refs_json) b JOIN claim_versions v ON v.id=json_extract(b.value,'$.claimVersionId') AND v.claim_id=json_extract(b.value,'$.claimId') JOIN claims c ON c.id=v.claim_id AND c.workspace_id=p.workspace_id AND c.project_id=p.id"),
  actions: collection('action_metadata x', ['x.claim_id','x.basis_version_refs_json','x.basis_state','x.cancelled_at','x.owner_hint','x.due_at'], ownedEvent),
  outcomes: collection('workflow_outcomes x', ['x.id','x.subject_claim_id','x.revision','v.text','v.answer_claim_version_ids_json','v.relation_ids_json','v.withdrawn_at','x.updated_at'], ownedEvent, 'JOIN outcome_versions v ON v.id = x.current_version_id AND v.outcome_id = x.id AND v.workspace_id = p.workspace_id'),
  narrativeJobs: collection('workflow_outbox x', ['x.event_id','x.input_revision','x.state','x.error_code','x.created_at'], `${ownedEvent} AND x.kind='narrative'`),
  narratives: collection('workflow_narratives x', ['x.event_id','x.text','x.sentence_refs_json','x.based_on_context_version','x.freshness','x.scope_kind','x.created_at',
    `(SELECT json_extract(j.payload_json,'$.checkpoint.promptVersion') FROM workflow_outbox j
      WHERE j.workspace_id=x.workspace_id AND j.project_id=x.project_id AND j.event_id=x.event_id
        AND j.kind='narrative' AND j.state='succeeded' AND j.input_revision=x.based_on_context_version
        AND json_extract(j.payload_json,'$.checkpoint.inputHash')=x.input_hash
      ORDER BY j.updated_at DESC,j.id DESC LIMIT 1) AS prompt_version`], owned),
  assets: collection('assets x', ['x.id','x.event_id','x.current_version_id','x.processing_status','x.kind','x.metadata_json'], `${ownedEvent} AND ${analysisSource}`),
  segments: collection('text_segments x', ['x.id','x.event_id','x.asset_version_id','x.ordinal'], ownedEvent),
  runs: collection('extraction_runs x', ['x.id','x.event_id','x.status','x.input_manifest_json','x.created_at'], ownedEvent),
};
// One SELECT gives all participating tables the same SQLite read snapshot.
export const PROJECT_LEDGER_SQL = `SELECT p.id, p.context_version,
  (?4=1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=p.workspace_id AND wm.actor_id=?2 AND wm.revoked_at IS NULL AND wm.role IN ('editor','owner'))) AS can_edit,
  ${Object.entries(fields).map(([name, sql]) => `${sql} AS ${name}`).join(',\n')}
  FROM projects p WHERE p.workspace_id = ?1 AND p.id = ?3 AND p.deleted_at IS NULL
  AND (?4 = 1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = p.workspace_id AND wm.actor_id = ?2 AND wm.revoked_at IS NULL))`;

export async function loadWorkflowLedger(db: D1Database, scope: WorkflowScope, projectId: string): Promise<ProjectionLedger> {
  const row = await db.prepare(PROJECT_LEDGER_SQL).bind(scope.workspaceId,scope.actorId,projectId,scope.access === 'demo' ? 1 : 0).first<Record<string, unknown>>();
  if (!row) throw new WorkflowFault(404,'not_found','事项不存在或当前账号无法访问');
  // JSON originates in SQLite's json_object, not an unvalidated external payload.
  return { access: {workspaceId:scope.workspaceId,actorId:scope.actorId,canEdit:Boolean(row.can_edit)}, contextVersion: Number(row.context_version), ...Object.fromEntries(Object.keys(fields).map(key => [key,JSON.parse(String(row[key]))])) } as ProjectionLedger;
}
export async function findWorkflowEvent(db: D1Database, scope: WorkflowScope, eventId: string): Promise<string> {
  const row = await db.prepare(`SELECT e.project_id FROM events e JOIN projects p ON p.id = e.project_id AND p.workspace_id = e.workspace_id
    WHERE e.id = ? AND e.workspace_id = ? AND p.deleted_at IS NULL AND e.material_status <> 'archived'
    AND (? = 1 OR EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = e.workspace_id AND wm.actor_id = ? AND wm.revoked_at IS NULL))`)
    .bind(eventId,scope.workspaceId,scope.access === 'demo' ? 1 : 0,scope.actorId).first<{project_id: string}>();
  if (!row) throw new WorkflowFault(404,'not_found','记录不存在或当前账号无法访问');
  return row.project_id;
}
export async function digestValue(value: unknown): Promise<string> {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,canonical(x)]));
    return v;
  }
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value))));
  return Array.from(new Uint8Array(bytes),b => b.toString(16).padStart(2,'0')).join('');
}

export async function readWorkspace(db: D1Database, scope: WorkflowScope, eventId: string, rawQuery: WorkspaceQuery = {}, timestamp = new Date().toISOString()): Promise<WorkspaceSnapshot> {
  const query = parseWorkflowRequest('WorkspaceQuery',rawQuery);
  const projectId = await findWorkflowEvent(db,scope,eventId);
  const ledger = await loadWorkflowLedger(db,scope,projectId);
  if (!ledger.events.some(e => e.id === eventId)) throw new WorkflowFault(404,'not_found','记录归属已变化，请重新打开');
  if (query.minContextVersion !== undefined && ledger.contextVersion < query.minContextVersion) throw new WorkflowFault(503,'snapshot_busy','正在同步刚保存的内容，请稍后重试');
  const projected = projectWorkspace(ledger,eventId,timestamp,'');
  // Fingerprint includes source availability and current decisions, so legacy writes
  // cannot accidentally serve an old cached body even before V1 invalidation is wired.
  const fingerprint = await digestValue({ projectionVersion:WORKFLOW_SNAPSHOT_PROJECTION_VERSION, workspace:scope.workspaceId, actor:scope.actorId, projectId, eventId, projected:{...projected,reviewProgress:undefined} });
  const window = Math.floor(Date.parse(timestamp) / 900_000);
  let snapshot = { ...projected, snapshotId: `wss_${fingerprint}_${window}` };
  if (query.snapshotId) {
    const cached = await db.prepare(`SELECT payload_json FROM workflow_snapshots WHERE id = ? AND workspace_id = ? AND project_id = ? AND event_id = ? AND actor_id = ? AND expires_at > ?`)
      .bind(query.snapshotId,scope.workspaceId,projectId,eventId,scope.actorId,timestamp).first<{payload_json:string}>();
    if (!cached) throw new WorkflowFault(409,'cursor_expired','这份列表已更新，请从当前记录继续');
    const saved = JSON.parse(cached.payload_json) as {projectionVersion?:string;fingerprint:string;snapshot:WorkspaceSnapshot};
    if (saved.projectionVersion !== WORKFLOW_SNAPSHOT_PROJECTION_VERSION || saved.fingerprint !== fingerprint) throw new WorkflowFault(409,'cursor_expired','内容或来源已变化，请重新读取记录');
    snapshot = saved.snapshot;
  } else {
    await db.prepare(`INSERT INTO workflow_snapshots (id,workspace_id,project_id,event_id,actor_id,context_version,source_revision,payload_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(snapshot.snapshotId,scope.workspaceId,projectId,eventId,scope.actorId,snapshot.contextVersion,snapshot.sourceRevision,JSON.stringify({projectionVersion:WORKFLOW_SNAPSHOT_PROJECTION_VERSION,fingerprint,snapshot}),new Date((window+1)*900_000).toISOString(),timestamp).run();
  }
  const start = query.cursor ? Number(query.cursor) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || (query.cursor !== undefined && !/^\d+$/.test(query.cursor)) || start > snapshot.reviewCards.length) throw new WorkflowFault(409,'cursor_expired','列表位置无效，请重新读取');
  const end = start + (query.limit ?? 20);
  // Reading and copying always retain the complete record. Only the optional
  // review queue is paginated, with global counts preserved on every page.
  return { ...snapshot, reviewProgress:projected.reviewProgress, reviewCards: snapshot.reviewCards.slice(start,end), nextCursor: end < snapshot.reviewCards.length ? String(end) : null };
}
