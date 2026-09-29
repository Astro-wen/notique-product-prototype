import { readJson, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { ANALYSIS_SOURCE_SQL, type AnalysisGuard } from './analysis-service.ts';
import { digestValue } from './snapshot-store.ts';
import { mutationId } from './transaction.ts';

type Scope = { workspaceId: string; actorId: string };
type Job = {
  id: string; workspace_id: string; project_id: string; event_id: string;
  input_revision: number; lease_owner: string; fencing_token: number;
  attempt: number; payload_json: string;
};
type Source = {
  projectId: string; contextVersion: number; sourceRevision: number;
  materialStatus: string; assets: ProjectionLedger['assets'];
};
export type MaterialAnalysisCreation = {
  scope: Scope; eventId: string; key: string; assetVersionIds: string[];
  sourceRevision: number; guard: AnalysisGuard;
  replay: (runId: string) => D1PreparedStatement;
};
export type MaterialAnalysisRunner = {
  create: (input: MaterialAnalysisCreation) => Promise<{ id: string }>;
  clock?: () => string; limit?: number;
};
const after = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
const leaseWhere = "id=? AND kind='initial_analysis' AND state='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at>?";
const leaseValues = (job: Job, now: string) => [job.id, job.lease_owner, job.fencing_token, now];

/** Append to the material-finalization transaction, after its version is saved.
 * Derived transcripts, audio chunks and reading artifacts do not submit a new
 * communication. The originating material already owns that submission. */
export function materialAnalysisStatements(
  db: D1Database, scope: Scope, eventId: string, assetId: string,
  assetVersionId: string, now: string,
): D1PreparedStatement[] {
  const submitted = `EXISTS (SELECT 1 FROM assets a WHERE a.id=? AND a.workspace_id=e.workspace_id
    AND a.event_id=e.id AND a.current_version_id=? AND a.processing_status='ready'
    AND COALESCE(json_extract(a.metadata_json,'$.analysis_source'),1)<>0
    AND COALESCE(json_extract(a.metadata_json,'$.transcription_chunk'),0)<>1
    AND COALESCE(json_extract(a.metadata_json,'$.artifact_kind'),'')<>'readable_transcript'
    AND json_extract(a.metadata_json,'$.source_audio_asset_version_id') IS NULL)`;
  const liveEvent = `e.workspace_id=? AND e.id=? AND e.material_status<>'archived'
    AND EXISTS (SELECT 1 FROM projects p WHERE p.id=e.project_id AND p.workspace_id=e.workspace_id AND p.deleted_at IS NULL)
    AND ${submitted}`;
  const values = [scope.workspaceId, eventId, assetId, assetVersionId];
  return [
    db.prepare(`UPDATE events AS e SET source_revision=source_revision+1,updated_at=? WHERE ${liveEvent}`).bind(now, ...values),
    db.prepare(`UPDATE workflow_narratives SET freshness='stale',updated_at=? WHERE workspace_id=?
      AND project_id=(SELECT project_id FROM events e WHERE ${liveEvent}) AND (event_id=? OR event_id IS NULL)`)
      .bind(now, scope.workspaceId, ...values, eventId),
    db.prepare(`DELETE FROM workflow_snapshots WHERE workspace_id=? AND project_id=(SELECT project_id FROM events e WHERE ${liveEvent})`)
      .bind(scope.workspaceId, ...values),
    db.prepare(`INSERT INTO workflow_outbox (id,workspace_id,project_id,event_id,kind,task_key,input_revision,payload_json,available_at,created_at,updated_at)
      SELECT ?,e.workspace_id,e.project_id,e.id,'initial_analysis','material:'||e.id||':'||e.source_revision,e.source_revision,
        json_object('actorId',?,'assetVersionId',?,'sourceRevision',e.source_revision),?,?,?
      FROM events e WHERE ${liveEvent} ON CONFLICT(workspace_id,task_key) DO NOTHING`)
      .bind(mutationId('mat'), scope.actorId, assetVersionId, after(now, 2000), now, now, ...values),
    db.prepare(`UPDATE workflow_outbox SET state='cancelled',error_code='MATERIAL_COALESCED',updated_at=?
      WHERE workspace_id=? AND event_id=? AND kind='initial_analysis' AND state='queued'
      AND input_revision<(SELECT source_revision FROM events e WHERE ${liveEvent})`)
      .bind(now, scope.workspaceId, eventId, ...values),
  ];
}

async function claim(db: D1Database, id: string, now: string): Promise<Job | null> {
  const owner = mutationId('material_lease');
  const result = await db.prepare(`UPDATE workflow_outbox SET state='running',lease_owner=?,lease_expires_at=?,
      fencing_token=fencing_token+1,updated_at=? WHERE id=? AND kind='initial_analysis'
      AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_expires_at<=?))`)
    .bind(owner, after(now, 40_000), now, id, now, now).run();
  if (!result.meta.changes) return null;
  return db.prepare('SELECT * FROM workflow_outbox WHERE id=? AND lease_owner=?').bind(id, owner).first<Job>();
}
async function finish(db: D1Database, job: Job, state: string, code: string | null, now: string, attempt = job.attempt) {
  await db.prepare(`UPDATE workflow_outbox SET state=?,error_code=?,attempt=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${leaseWhere}`)
    .bind(state, code, attempt, now, ...leaseValues(job, now)).run();
}
async function defer(db: D1Database, job: Job, code: string, now: string, transport = false) {
  const attempts = job.attempt + (transport ? 1 : 0);
  if (attempts >= 3) return finish(db, job, 'failed', code, now, attempts);
  await db.prepare(`UPDATE workflow_outbox SET state='queued',error_code=?,attempt=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${leaseWhere}`)
    .bind(code, attempts, after(now, transport ? 10_000 * 2 ** attempts : 5000), now, ...leaseValues(job, now)).run();
}
function ready(source: Source): boolean {
  return source.materialStatus === 'ready' && source.assets.length > 0 && source.assets.every(a =>
    a.processing_status === 'ready' && a.current_version_id && (a.kind !== 'audio' || source.assets.some(t =>
      t.kind === 'transcript' && readJson<{ source_audio_asset_version_id?: string }>(t.metadata_json, {}).source_audio_asset_version_id === a.current_version_id)));
}
function completion(db: D1Database, job: Job, now: string, runId: string) {
  return db.prepare(`UPDATE workflow_outbox SET state='succeeded',error_code=NULL,
    payload_json=json_set(payload_json,'$.analysisRunId',?),lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${leaseWhere}`)
    .bind(runId, now, ...leaseValues(job, now));
}

/** Commission only persisted submissions. Reads and recovery of unrelated
 * communications cannot create an intent. The native run and its queue own
 * provider retries after this handoff succeeds. */
export async function consumeMaterialAnalysisJobs(
  db: D1Database, runner: MaterialAnalysisRunner, scope?: { workspaceId: string; eventId?: string },
): Promise<{ claimed: number; commissioned: number; reused: number; deferred: number }> {
  const clock = runner.clock ?? (() => new Date().toISOString());
  const now = clock();
  const candidates = (await db.prepare(`SELECT id FROM workflow_outbox WHERE kind='initial_analysis'
      AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_expires_at<=?))
      AND (? IS NULL OR workspace_id=?) AND (? IS NULL OR event_id=?) ORDER BY available_at,id LIMIT ?`)
    .bind(now, now, scope?.workspaceId ?? null, scope?.workspaceId ?? null, scope?.eventId ?? null, scope?.eventId ?? null, runner.limit ?? 4)
    .all<{ id: string }>()).results ?? [];
  const result = { claimed: 0, commissioned: 0, reused: 0, deferred: 0 };
  for (const candidate of candidates) {
    const job = await claim(db, candidate.id, clock());
    if (!job) continue;
    result.claimed++;
    try {
      const row = await db.prepare(ANALYSIS_SOURCE_SQL)
        .bind(job.workspace_id, job.event_id).first<{ stamp: string }>();
      if (!row) { await finish(db, job, 'cancelled', 'SOURCE_UNAVAILABLE', clock()); continue; }
      const source = readJson<Source>(row.stamp, {} as Source);
      if (source.sourceRevision !== job.input_revision || source.projectId !== job.project_id) {
        await finish(db, job, 'cancelled', 'SOURCE_CHANGED', clock()); continue;
      }
      if (!ready(source)) {
        if (source.assets.some(a => a.processing_status === 'failed')) await finish(db, job, 'failed', 'MATERIAL_FAILED', clock());
        else await defer(db, job, 'MATERIAL_NOT_READY', clock());
        result.deferred++; continue;
      }
      const ids = source.assets.filter(a => a.kind !== 'audio').map(a => a.current_version_id!).sort();
      if (!ids.length || ids.length > 25) { await finish(db, job, 'failed', 'MATERIAL_LIMIT', clock()); continue; }
      const runs = (await db.prepare(`SELECT id,input_manifest_json,model_params_json FROM extraction_runs
        WHERE workspace_id=? AND event_id=? ORDER BY created_at DESC,id DESC`).bind(job.workspace_id, job.event_id).all<Record<string, unknown>>()).results ?? [];
      const existing = runs.find(r => {
        const revision = readJson<{ workflow_source_revision?: number }>(String(r.model_params_json), {}).workflow_source_revision;
        return (revision === undefined || revision === source.sourceRevision) && JSON.stringify(ids) === JSON.stringify(
          readJson<Array<{ asset_version_id: string }>>(String(r.input_manifest_json), []).map(a => a.asset_version_id).sort());
      });
      const guardedAt = clock();
      const guard: AnalysisGuard = {
        sql: `EXISTS (SELECT 1 FROM workflow_outbox WHERE ${leaseWhere}) AND (${ANALYSIS_SOURCE_SQL})=?`,
        values: [...leaseValues(job, guardedAt), job.workspace_id, job.event_id, row.stamp],
      };
      if (existing) {
        // A browser fast path can win before this server consumer. Acknowledge
        // its exact input without commissioning a second model invocation.
        const receipt = completion(db, job, guardedAt, String(existing.id));
        const guardId = mutationId('material_guard');
        await db.batch([
          db.prepare(`INSERT INTO mutation_guards (id,guard_value,created_at) SELECT ?,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END,?`).bind(guardId, ...guard.values, guardedAt),
          receipt, db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(guardId),
        ]);
        result.reused++; continue;
      }
      const payload = readJson<{ actorId: string }>(job.payload_json, { actorId: '$material-submission' });
      const created = await runner.create({ scope: { workspaceId: job.workspace_id, actorId: payload.actorId }, eventId: job.event_id,
        key: `material:${await digestValue({ eventId: job.event_id, revision: job.input_revision, ids })}`,
        assetVersionIds: ids, sourceRevision: source.sourceRevision, guard,
        replay: runId => completion(db, job, guardedAt, runId) });
      // The native creator can return a run created concurrently. Otherwise it
      // has already acknowledged the job inside the run-creation transaction.
      await completion(db, job, clock(), created.id).run();
      result.commissioned++;
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'MATERIAL_HANDOFF_FAILED';
      const permanent = /NOT_CONFIGURED|BUDGET|TOO_MANY|ASSET_TOO_LARGE|SCENARIO_CONFIRMATION/.test(code);
      if (permanent) await finish(db, job, 'failed', code, clock());
      else await defer(db, job, code, clock(), !/CONFLICT|RUN_LIMIT|EVENT_NOT_READY/.test(code));
      result.deferred++;
    }
  }
  return result;
}
