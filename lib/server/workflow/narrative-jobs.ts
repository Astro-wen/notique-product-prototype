import { currentRecordBullets } from '../../domain/workflow-v2.ts';
import { projectWorkspace, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { WORKFLOW_NARRATIVE_PROMPT_VERSION, WORKFLOW_NARRATIVE_SCHEMA_VERSION, validateWorkflowNarrative, workflowNarrativeSentences, type WorkflowNarrativeInput, type WorkflowNarrativeOutput, type WorkflowNarrativeProvider } from '../../domain/workflow-narrative.ts';
import type { ModelUsage } from '../../domain/model-contract.ts';
import { PROJECT_LEDGER_SQL, digestValue } from './snapshot-store.ts';
import { mutationId } from './transaction.ts';

export type NarrativeModelConfig = { provider: string; model: string; reasoningEffort: string; baseUrl: string; maxOutputTokens: number };
type Checkpoint = {
  input: WorkflowNarrativeInput;
  sourceStamp: string;
  inputHash: string;
  schemaVersion: string;
  promptVersion: string;
  config: NarrativeModelConfig;
  providerResponseId: string | null;
  attempt: number;
  repairCount: number;
  generation: number;
  startedAt: string;
  transportFailures: number;
  feedback: string[];
  output?: WorkflowNarrativeOutput;
  usage: Array<ModelUsage & { attempt: number }>;
};
export type NarrativeJob = {
  id: string; workspace_id: string; project_id: string; event_id: string;
  input_revision: number; payload_json: string; state: string; created_at: string;
  lease_owner: string | null; lease_expires_at: string | null; fencing_token: number;
};
export type NarrativeRunner = {
  config: NarrativeModelConfig;
  provider: (config: NarrativeModelConfig) => WorkflowNarrativeProvider;
  clock?: () => string;
  random?: () => number;
  limit?: number;
  leaseMs?: number;
  cancelProvider?: (config: NarrativeModelConfig, responseId: string) => Promise<void>;
};
const MAX_ATTEMPTS = 3;
const MAX_AGE_MS = 30 * 60_000;
const defaultClock = () => new Date().toISOString();
const after = (timestamp: string, ms: number) => new Date(Date.parse(timestamp) + ms).toISOString();
const parse = (row: NarrativeJob): { eventId: string; contextVersion: number; checkpoint?: Checkpoint } => JSON.parse(row.payload_json);
const leaseWhere = `id=? AND state='running' AND lease_owner=? AND fencing_token=? AND lease_expires_at>?`;
const leaseValues = (job: NarrativeJob, now: string) => [job.id, job.lease_owner, job.fencing_token, now];
// This exact database state is checked again in the publishing transaction. It
// catches legacy writers that have not yet advanced Workflow V2's context.
const STAMP_EXPRESSION = `json_object('context',context_version,'events',json(events),'claims',json(claims),'evidence',json(evidence),'relations',json(relations),'assets',json(assets),'runs',json(runs),'mentions',json(mentions))`;
export const NARRATIVE_SOURCE_STAMP_SQL = `SELECT ${STAMP_EXPRESSION} AS stamp FROM (${PROJECT_LEDGER_SQL})`;
const PUBLISH_STAMP_SQL = NARRATIVE_SOURCE_STAMP_SQL.replace(/\?([1-4])/g, (_, n: string) => `?${Number(n) + 6}`);
const sourceBinds = (job: Pick<NarrativeJob, 'workspace_id' | 'project_id'>) => [job.workspace_id, '$workflow-runner', job.project_id, 1];
async function source(db: D1Database, job: NarrativeJob, now: string) {
  const row = await db.prepare(`SELECT ledger.*, ${STAMP_EXPRESSION} AS source_stamp FROM (${PROJECT_LEDGER_SQL}) ledger`).bind(...sourceBinds(job)).first<Record<string, unknown>>();
  if (!row) return null;
  const ledger = { contextVersion: Number(row.context_version), ...Object.fromEntries(Object.keys(row).filter(k => !['id','context_version','can_edit','source_stamp'].includes(k)).map(k => [k, JSON.parse(String(row[k]))])) } as ProjectionLedger;
  const event = ledger.events.find(e => e.id === job.event_id);
  if (!event) return null;
  const stamp = String(row.source_stamp);
  const snapshot = projectWorkspace(ledger, job.event_id, now, '');
  const input: WorkflowNarrativeInput = { eventId: job.event_id, contextVersion: ledger.contextVersion, sourceRevision: event.source_revision, coverage: snapshot.coverage,
    bullets: currentRecordBullets(snapshot.bullets, snapshot.questions).filter(b => b.sourceStatus === 'ready').map(({text,claimRefs,reviewState,origin,applicability,conflictWith}) => ({text,claimRefs,reviewState,origin,...(applicability ? {applicability} : {}),...(conflictWith?.length ? {conflictWith} : {})})) };
  return { input, stamp };
}

/** Latest job per communication wins, with a two-second quiet window capped at
 * ten seconds. Claiming and coalescing happen in a single D1 batch. */
export async function leaseNarrativeJob(db: D1Database, candidate: NarrativeJob, now: string, owner: string, leaseMs = 40_000): Promise<NarrativeJob | null> {
  const guard = mutationId('wguard');
  const due = `j.kind='narrative' AND (j.state='queued' OR (j.state='running' AND j.lease_expires_at<=?))
    AND (j.available_at<=? OR json_extract(j.payload_json,'$.checkpoint') IS NULL AND EXISTS (SELECT 1 FROM workflow_outbox older WHERE older.workspace_id=j.workspace_id AND older.project_id=j.project_id AND older.event_id=j.event_id AND older.kind='narrative' AND older.state='queued' AND julianday(older.created_at)<=julianday(?)-10.0/86400))
    AND NOT EXISTS (SELECT 1 FROM workflow_outbox newer WHERE newer.workspace_id=j.workspace_id AND newer.project_id=j.project_id AND newer.event_id=j.event_id AND newer.kind='narrative' AND newer.state='queued' AND newer.input_revision>j.input_revision)`;
  try {
    await db.batch([
      db.prepare(`INSERT INTO mutation_guards (id,guard_value,created_at) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM workflow_outbox j WHERE j.id=? AND ${due}) THEN 1 ELSE 0 END,?`).bind(guard,candidate.id,now,now,now,now),
      db.prepare(`UPDATE workflow_outbox SET state='running',lease_owner=?,lease_expires_at=?,fencing_token=fencing_token+1,error_code=NULL,updated_at=? WHERE id=?`).bind(owner,after(now,leaseMs),now,candidate.id),
      db.prepare(`UPDATE workflow_outbox SET state='cancelled',error_code='COALESCED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE workspace_id=? AND project_id=? AND event_id=? AND kind='narrative' AND state='queued' AND id<>? AND input_revision<=?`).bind(now,candidate.workspace_id,candidate.project_id,candidate.event_id,candidate.id,candidate.input_revision),
      db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(guard),
    ]);
  } catch (error) { if (/mutation_guards|ck_mutation_guards_true/.test(String(error))) return null; throw error; }
  return db.prepare('SELECT * FROM workflow_outbox WHERE id=? AND lease_owner=?').bind(candidate.id,owner).first<NarrativeJob>();
}
async function checkpoint(db: D1Database, job: NarrativeJob, cp: Checkpoint, now: string) {
  const payload = {...parse(job), checkpoint: cp};
  const updated = await db.prepare(`UPDATE workflow_outbox SET payload_json=json_set(payload_json,'$.checkpoint',json(?)),attempt=?,updated_at=? WHERE ${leaseWhere}`).bind(JSON.stringify(cp),cp.attempt,now,...leaseValues(job,now)).run();
  if (!updated.meta.changes) throw new LostLeaseError();
  job.payload_json = JSON.stringify(payload);
}
/** Usage is append-only audit, even if the publishing lease was lost. It
 * never changes another executor's checkpoint or makes an output current. */
async function recordUsage(db: D1Database, job: NarrativeJob, cp: Checkpoint, usage: ModelUsage, now: string) {
  const audit={...usage,attempt:cp.attempt,fencingToken:job.fencing_token,inputHash:cp.inputHash,recordedAt:now};
  await db.prepare(`UPDATE workflow_outbox SET payload_json=json_insert(json_set(payload_json,'$.auditUsage',json(COALESCE(json_extract(payload_json,'$.auditUsage'),'[]'))),'$.auditUsage[#]',json(?))
    WHERE id=? AND workspace_id=? AND project_id=? AND json_extract(payload_json,'$.checkpoint.inputHash')=?
    AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(workflow_outbox.payload_json,'$.auditUsage'),'[]')) a WHERE (? IS NOT NULL AND json_extract(a.value,'$.providerRequestId')=? OR ? IS NULL AND json_extract(a.value,'$.attempt')=? AND json_extract(a.value,'$.fencingToken')=?))`)
    .bind(JSON.stringify(audit),job.id,job.workspace_id,job.project_id,cp.inputHash,usage.providerRequestId,usage.providerRequestId,usage.providerRequestId,cp.attempt,job.fencing_token).run();
}
class LostLeaseError extends Error { constructor() { super('任务租约已交给另一执行器'); this.name='LostLeaseError'; } }
async function release(db: D1Database, job: NarrativeJob, now: string, state: 'queued' | 'failed' | 'cancelled', code: string, delayMs = 0) {
  const updated=await db.prepare(`UPDATE workflow_outbox SET state=?,error_code=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${leaseWhere}`).bind(state,code,after(now,delayMs),now,...leaseValues(job,now)).run();
  if(!updated.meta.changes)throw new LostLeaseError();
}
async function failCheckpoint(db: D1Database, job: NarrativeJob, cp: Checkpoint, now: string, code: string) {
  const updated=await db.prepare(`UPDATE workflow_outbox SET payload_json=json_set(payload_json,'$.checkpoint',json(?)),attempt=?,state='failed',error_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE ${leaseWhere}`)
    .bind(JSON.stringify(cp),cp.attempt,code,now,...leaseValues(job,now)).run();
  if(!updated.meta.changes)throw new LostLeaseError();
}
async function enqueueFresh(db: D1Database, job: NarrativeJob, now: string) {
  const current = await source(db,job,now);
  if (!current) return;
  const key = `narrative:${job.project_id}:${job.event_id}:${current.input.contextVersion}:${await digestValue(current.stamp)}`;
  await db.prepare(`INSERT INTO workflow_outbox (id,workspace_id,project_id,event_id,kind,task_key,input_revision,payload_json,available_at,created_at,updated_at)
    SELECT ?,?,?,?,'narrative',?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM events e JOIN projects p ON p.id=e.project_id AND p.workspace_id=e.workspace_id WHERE e.id=? AND e.workspace_id=? AND e.project_id=? AND e.material_status<>'archived' AND p.deleted_at IS NULL AND p.context_version=?)
    AND NOT EXISTS (SELECT 1 FROM workflow_outbox j WHERE j.workspace_id=? AND j.project_id=? AND j.event_id=? AND j.kind='narrative' AND j.state IN ('queued','running') AND j.input_revision=? AND (json_extract(j.payload_json,'$.checkpoint.sourceStamp') IS NULL OR json_extract(j.payload_json,'$.checkpoint.sourceStamp')=?)) ON CONFLICT(workspace_id,task_key) DO NOTHING`)
    .bind(mutationId('wjob'),job.workspace_id,job.project_id,job.event_id,key,current.input.contextVersion,JSON.stringify({eventId:job.event_id,contextVersion:current.input.contextVersion}),after(now,2000),now,now,
      job.event_id,job.workspace_id,job.project_id,current.input.contextVersion,job.workspace_id,job.project_id,job.event_id,current.input.contextVersion,current.stamp).run();
}
async function obsolete(db: D1Database, job: NarrativeJob, now: string) {
  await release(db,job,now,'cancelled','INPUT_CHANGED');
  await enqueueFresh(db,job,now);
}

/** The validated output, frozen input, provider ID and usage survive Worker
 * interruption. Publication is fenced against lease, sources and context. */
export async function publishNarrative(db: D1Database, job: NarrativeJob, cp: Checkpoint, now: string): Promise<boolean> {
  const id = mutationId('wnar'), guard = mutationId('wguard');
  const sentences = workflowNarrativeSentences(validateWorkflowNarrative(cp.output,cp.input),cp.input);
  const refs = [...new Map(sentences.flatMap(s => s.claimRefs).map(r => [r.claimVersionId,r])).values()];
  try {
    await db.batch([
      db.prepare(`INSERT INTO mutation_guards (id,guard_value,created_at) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM workflow_outbox WHERE ${leaseWhere}) AND (? IS (SELECT stamp FROM (${PUBLISH_STAMP_SQL}))) AND EXISTS (SELECT 1 FROM events WHERE id=? AND workspace_id=? AND project_id=? AND source_revision=? AND material_status<>'archived') THEN 1 ELSE 0 END,?`)
        .bind(guard,...leaseValues(job,now),cp.sourceStamp,...sourceBinds(job),job.event_id,job.workspace_id,job.project_id,cp.input.sourceRevision,now),
      db.prepare(`INSERT INTO workflow_narratives (id,workspace_id,project_id,event_id,scope_key,scope_kind,based_on_context_version,text,sentence_refs_json,freshness,input_hash,created_at,updated_at) VALUES (?,?,?,?,?,'mixed',?,?,?,'current',?,?,?)
        ON CONFLICT(workspace_id,scope_key,scope_kind,based_on_context_version) DO UPDATE SET text=excluded.text,sentence_refs_json=excluded.sentence_refs_json,freshness='current',input_hash=excluded.input_hash,updated_at=excluded.updated_at`)
        .bind(id,job.workspace_id,job.project_id,job.event_id,job.event_id,cp.input.contextVersion,sentences.map(s=>s.text).join(' '),JSON.stringify(sentences),cp.inputHash,now,now),
      db.prepare(`DELETE FROM derived_dependencies WHERE workspace_id=? AND derived_type='narrative' AND derived_id=(SELECT id FROM workflow_narratives WHERE workspace_id=? AND scope_key=? AND scope_kind='mixed' AND based_on_context_version=?)`).bind(job.workspace_id,job.workspace_id,job.event_id,cp.input.contextVersion),
      ...refs.map(r => db.prepare(`INSERT INTO derived_dependencies (id,workspace_id,project_id,event_id,derived_type,derived_id,claim_version_id,scope) SELECT ?,?,?,?,'narrative',id,?,'mixed' FROM workflow_narratives WHERE workspace_id=? AND scope_key=? AND scope_kind='mixed' AND based_on_context_version=?`).bind(mutationId('dep'),job.workspace_id,job.project_id,job.event_id,r.claimVersionId,job.workspace_id,job.event_id,cp.input.contextVersion)),
      db.prepare('DELETE FROM workflow_snapshots WHERE workspace_id=? AND project_id=?').bind(job.workspace_id,job.project_id),
      db.prepare(`UPDATE workflow_outbox SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=? WHERE ${leaseWhere}`).bind(now,...leaseValues(job,now)),
      db.prepare('DELETE FROM mutation_guards WHERE id=?').bind(guard),
    ]);
    return true;
  } catch (error) {
    if (!/mutation_guards|ck_mutation_guards_true/.test(String(error))) throw error;
    const owns = await db.prepare(`SELECT id FROM workflow_outbox WHERE ${leaseWhere}`).bind(...leaseValues(job,now)).first();
    if (!owns) throw new LostLeaseError();
    await obsolete(db,job,now); return false;
  }
}
function errorInfo(error: unknown) {
  const e = error as { code?: string; status?: number | null; issues?: unknown[]; usage?: ModelUsage | null; providerResponseId?: string };
  const code = e?.code ?? (error instanceof TypeError ? 'NETWORK_ERROR' : 'NARRATIVE_FAILED');
  const pending = code === 'MODEL_BACKGROUND_PENDING';
  const invalid = code === 'MODEL_OUTPUT_INVALID';
  const retryable = code === 'NETWORK_ERROR' || code === 'MODEL_TIMEOUT' || code === 'MODEL_BACKGROUND_STALLED' || code === 'MODEL_PROVIDER_REQUEST_FAILED' && (e.status == null || e.status===408 || e.status===429 || e.status>=500);
  return {e,code,pending,invalid,retryable};
}
async function runJob(db: D1Database, job: NarrativeJob, runner: NarrativeRunner): Promise<'succeeded' | 'pending' | 'failed' | 'obsolete' | 'lostLease'> {
  const clock=runner.clock ?? defaultClock;
  let cp=parse(job).checkpoint;
  try {
    const current=await source(db,job,clock());
    if (!current || current.input.contextVersion!==job.input_revision || cp && current.stamp!==cp.sourceStamp) {await obsolete(db,job,clock());if(cp?.providerResponseId)await runner.cancelProvider?.(cp.config,cp.providerResponseId).catch(()=>undefined);return 'obsolete';}
    if (!cp) {
      cp={input:current.input,sourceStamp:current.stamp,inputHash:await digestValue({input:current.input,config:runner.config,schemaVersion:WORKFLOW_NARRATIVE_SCHEMA_VERSION,promptVersion:WORKFLOW_NARRATIVE_PROMPT_VERSION}),schemaVersion:WORKFLOW_NARRATIVE_SCHEMA_VERSION,promptVersion:WORKFLOW_NARRATIVE_PROMPT_VERSION,config:runner.config,providerResponseId:null,attempt:0,repairCount:0,generation:0,startedAt:clock(),transportFailures:0,feedback:[],usage:[]};
      await checkpoint(db,job,cp,clock());
    }
    if(Date.parse(clock())-Date.parse(cp.startedAt ?? job.created_at)>=MAX_AGE_MS) {await release(db,job,clock(),'failed','NARRATIVE_RETRY_EXHAUSTED');if(cp.providerResponseId)await runner.cancelProvider?.(cp.config,cp.providerResponseId).catch(()=>undefined);return 'failed';}
    if(cp.schemaVersion!==WORKFLOW_NARRATIVE_SCHEMA_VERSION || cp.promptVersion!==WORKFLOW_NARRATIVE_PROMPT_VERSION) {await release(db,job,clock(),'failed','NARRATIVE_CONTRACT_CHANGED');return 'failed';}
    if(cp.input.bullets.length>200 || cp.input.bullets.reduce((n,b)=>n+b.text.length,0)>40000) {await release(db,job,clock(),'failed','NARRATIVE_INPUT_LIMIT');return 'failed';}
    if (!cp.output && cp.input.bullets.length) {
      if (!cp.providerResponseId) {
        if(cp.attempt>=MAX_ATTEMPTS) {await release(db,job,clock(),'failed','NARRATIVE_RETRY_EXHAUSTED');return 'failed';}
        cp.attempt++; await checkpoint(db,job,cp,clock());
      }
      const frozen=cp;
      const result=await runner.provider(cp.config).summarizeWorkflow(cp.input,{
        idempotencyKey:`notique:${job.id}:${cp.inputHash}:${cp.generation ?? 0}`,
        ...(cp.providerResponseId?{resumeProviderResponseId:cp.providerResponseId}:{}),qualityFeedback:cp.feedback,
        backgroundStallMs:5*60_000,
        onProviderResponse:async r=>{frozen.providerResponseId=r.id;await checkpoint(db,job,frozen,clock());},
      });
      await recordUsage(db,job,cp,result.usage,clock());
      cp.usage.push({...result.usage,attempt:cp.attempt});
      // Keep paid usage before contract validation or stale-input rejection.
      await checkpoint(db,job,cp,clock());
      cp.output=validateWorkflowNarrative(result.output,cp.input);
      await checkpoint(db,job,cp,clock());
    } else if(!cp.output) {cp.output={schema_version:WORKFLOW_NARRATIVE_SCHEMA_VERSION,event_id:job.event_id,sentences:[]};await checkpoint(db,job,cp,clock());}
    const published=await publishNarrative(db,job,cp,clock());
    if(!published && cp.providerResponseId)await runner.cancelProvider?.(cp.config,cp.providerResponseId).catch(()=>undefined);
    return published?'succeeded':'obsolete';
  } catch(error) {
    if(error instanceof LostLeaseError) return 'lostLease';
    const {e,code,pending,invalid,retryable}=errorInfo(error),now=clock();
    if(!cp) {await release(db,job,now,'failed',code);return 'failed';}
    if(e.usage && !cp.usage.some(u=>u.attempt===cp!.attempt)){await recordUsage(db,job,cp,e.usage,now);cp.usage.push({...e.usage,attempt:cp.attempt});}
    if(pending && e.providerResponseId)cp.providerResponseId=e.providerResponseId;
    const expired=Date.parse(now)-Date.parse(cp.startedAt ?? job.created_at)>=MAX_AGE_MS;
    if(retryable){cp.transportFailures=(cp.transportFailures ?? 0)+1;if(cp.transportFailures>=MAX_ATTEMPTS){await failCheckpoint(db,job,cp,now,'NARRATIVE_RETRY_EXHAUSTED');if(cp.providerResponseId)await runner.cancelProvider?.(cp.config,cp.providerResponseId).catch(()=>undefined);return 'failed';}}
    if(invalid && cp.repairCount<1 && cp.attempt<MAX_ATTEMPTS) {cp.repairCount++;cp.generation=(cp.generation ?? 0)+1;cp.providerResponseId=null;cp.feedback=(e.issues ?? ['Repair invalid structure and references.']).slice(0,20).map(i=>typeof i==='string'?i:JSON.stringify(i));}
    else if(!pending && retryable && cp.attempt<MAX_ATTEMPTS) {if(code==='MODEL_BACKGROUND_STALLED'){cp.providerResponseId=null;cp.generation=(cp.generation ?? 0)+1;}}
    else if(!pending) {await failCheckpoint(db,job,cp,now,code);return 'failed';}
    if(expired) {await failCheckpoint(db,job,cp,now,'NARRATIVE_RETRY_EXHAUSTED');return 'failed';}
    await checkpoint(db,job,cp,now);
    const delay=pending?5000:Math.min(60000,2000*2**Math.max(0,cp.attempt-1))+Math.floor((runner.random ?? Math.random)()*1000);
    await release(db,job,now,'queued',pending?'PROVIDER_PENDING':'NARRATIVE_RETRY_SCHEDULED',delay);return 'pending';
  }
}

export async function consumeNarrativeJobs(db: D1Database, runner: NarrativeRunner) {
  const now=(runner.clock ?? defaultClock)(),owner=mutationId('wowner');
  const rows=await db.prepare(`SELECT j.* FROM workflow_outbox j WHERE j.kind='narrative' AND (j.state='queued' OR (j.state='running' AND j.lease_expires_at<=?))
    AND (j.available_at<=? OR json_extract(j.payload_json,'$.checkpoint') IS NULL AND EXISTS (SELECT 1 FROM workflow_outbox older WHERE older.workspace_id=j.workspace_id AND older.project_id=j.project_id AND older.event_id=j.event_id AND older.kind='narrative' AND older.state='queued' AND julianday(older.created_at)<=julianday(?)-10.0/86400))
    AND NOT EXISTS (SELECT 1 FROM workflow_outbox newer WHERE newer.workspace_id=j.workspace_id AND newer.project_id=j.project_id AND newer.event_id=j.event_id AND newer.kind='narrative' AND newer.state='queued' AND newer.input_revision>j.input_revision)
    ORDER BY j.available_at,j.id LIMIT ?`).bind(now,now,now,runner.limit ?? 2).all<NarrativeJob>();
  const result={claimed:0,succeeded:0,pending:0,failed:0,obsolete:0,lostLease:0};
  for(const row of rows.results ?? []) {
    const job=await leaseNarrativeJob(db,row,(runner.clock ?? defaultClock)(),owner,runner.leaseMs);
    if(job){result.claimed++;try {result[await runJob(db,job,runner)]++;} catch(error) {if(error instanceof LostLeaseError)result.lostLease++;else throw error;}}
  }
  return result;
}
