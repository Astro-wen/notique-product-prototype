import { recordCounts } from './workflow-v2.ts';
import { projectReaffirmedMentions, type LedgerMention } from './reaffirmed-mentions.ts';
import { outcomeRelationIds } from './workflow-relations.ts';
import { WORKFLOW_NARRATIVE_PROMPT_VERSION } from './workflow-narrative.ts';
import { keyDetailReview } from './key-detail-review.ts';
import { sourceDiff } from './source-diff.ts';
import type { Action, ActionHistoryEntry, Bullet, ContentOrigin, Coverage, LatestOutcome, Narrative, Question, ReviewCard, ReviewMember, SourceStatus, VersionRef, WorkspaceSnapshot } from '../shared/workflow-v2.ts';

export type LedgerClaim = {
  id: string; project_id: string; event_id: string; type: string; review_status: string; lifecycle_status: string;
  current_version_id: string; workflow_revision: number; extraction_run_id: string; source: string;
  statement: string; normalized_value_json: string | null; version_source: string; workflow_origin: ContentOrigin | null;
  confidence?: number | null; needs_additional_evidence?: number; resolved_at?: string | null;
  materiality?: string; uncertainty_json?: string | null;
  created_at: string; updated_at: string;
};
export type LedgerEvidence = {
  quote_raw?: string | null;
  id: string; claim_version_id: string; kind: string; evidence_role: string;
  claim_id?: string; event_id?: string; version_source?: string;
  workflow_origin?: ContentOrigin | null; provenance_grade?: string;
  structural_validation_status: string; semantic_support_verdict: ReviewMember['supportStatus'];
  availability: SourceStatus;
};
export type LedgerRelation = {
  id: string; source_claim_version_id: string; target_claim_version_id: string;
  resolved_at?: string | null; resolved_by_verdict_id?: string | null; resolved_by_relation_id?: string | null;
  source_claim_id?: string; target_claim_id?: string;
  type: string; status: string; contradiction_status: string | null; reason: string | null;
};
export type LedgerEvent = { id: string; active_run_id: string | null; source_revision: number; title: string; occurred_at: string; created_at?:string; uploaded_at?:string };
export type StoredCard = {
  group_key?: string;
  created_at?: string;
  id: string; event_id: string; revision: number; kind: ReviewCard['kind']; title: string;
  needs_decision: number; reason_code: ReviewCard['reasonCode']; reason: string;
  disposition: 'active' | 'processed'; latest_decision_id: string | null; decision_revision: number | null;
};
export type ProjectionLedger = {
  draftLinks?: Array<{id:string;source_claim_id:string;source_claim_version_id:string;target_draft_claim_id:string;target_draft_claim_version_id:string;type:string}>;
  mentions?: LedgerMention[];
  access?: WorkspaceSnapshot['access'];
  contextVersion: number;
  changes?: Array<{id:string;event_id:string|null;kind:string;changed_refs_json:string;created_at:string}>;
  decisions?: Array<{id:string;event_id:string;revision:number;operation:string;summary:string;created_at:string;reverted_by:string|null;choice_mode?:string|null}>;
  events: LedgerEvent[];
  claims: LedgerClaim[];
  evidence: LedgerEvidence[];
  relations: LedgerRelation[];
  cards: StoredCard[];
  members: Array<{ card_id: string; claim_id: string; claim_version_id: string; role: 'primary' | 'context' }>;
  progress?: Array<{event_id:string;last_card_id:string|null;finished_at:string|null}>;
  deferrals: Array<{ card_id: string; until_at: string | null }>;
  basisVersions?: Array<{id:string;claim_id:string;statement:string}>;
  timelineVersions?: Array<{id:string;claim_id:string;statement:string}>;
  actions: Array<{ claim_id: string; basis_version_refs_json: string; basis_state: string; cancelled_at: string | null; owner_hint: string | null; due_at: string | null }>;
  outcomes: Array<{ id: string; subject_claim_id: string; revision: number; text: string; answer_claim_version_ids_json: string; relation_ids_json?: string; withdrawn_at: string | null; updated_at: string }>;
  narrativeJobs?: Array<{event_id:string;input_revision:number;state:string;error_code:string|null;created_at:string}>;
  narratives: Array<{ event_id: string | null; text: string; sentence_refs_json: string; based_on_context_version: number; freshness: Narrative['freshness']; scope_kind: Narrative['scope']; created_at: string; prompt_version?: string | null }>;
  assets: Array<{ id: string; event_id: string; current_version_id: string | null; processing_status: string; kind: string; metadata_json: string }>;
  segments: Array<{ id: string; event_id: string; asset_version_id: string; ordinal: number }>;
  runs: Array<{ id: string; event_id: string; status: string; input_manifest_json: string; created_at?: string }>;
};
export function readJson<T>(text: string | null | undefined, fallback: T): T {
  try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; }
}
const ref = (c: LedgerClaim): VersionRef => ({ claimId: c.id, claimVersionId: c.current_version_id });
const accepted = (c: LedgerClaim) => c.review_status === 'verified';
const current = (c: LedgerClaim) => !['withdrawn', 'superseded'].includes(c.lifecycle_status) && c.review_status !== 'rejected';
export function isCompletionRecord(c: LedgerClaim): boolean {
  const value = readJson<{completed_action_claim_id?: string;workflow_kind?: string}>(c.normalized_value_json,{});
  return Boolean(value.completed_action_claim_id) || value.workflow_kind === 'completion';
}
export function claimOrigin(c: LedgerClaim): ContentOrigin {
  if (c.workflow_origin) return c.workflow_origin;
  if (c.version_source === 'human') return 'user_input';
  return c.type === 'next_action' ? 'ai_suggestion' : 'source_statement';
}
export function claimSourceStatus(c: LedgerClaim, evidence: readonly LedgerEvidence[]): SourceStatus {
  const candidates = evidence.filter(e => e.claim_version_id === c.current_version_id && e.evidence_role !== 'contextual');
  const notes = candidates.filter(e => e.kind === 'user_note');
  const refs = claimOrigin(c) === 'user_input' && notes.length ? notes : candidates;
  if (!refs.length) return 'missing';
  if (refs.some(e => e.availability === 'missing' || e.structural_validation_status !== 'valid')) return 'missing';
  return refs.some(e => e.availability === 'stale') ? 'stale' : 'ready';
}
function pendingActionChoice(c: LedgerClaim, evidence: readonly LedgerEvidence[]): boolean {
  return c.type === 'next_action' && current(c) && !accepted(c) && c.version_source !== 'human'
    && ['ai_suggestion', 'source_statement'].includes(claimOrigin(c)) && claimSourceStatus(c,evidence) === 'ready';
}
export function factAnswerTargets(ledger:ProjectionLedger,c:LedgerClaim):NonNullable<ReviewMember['answerTargets']> {
  if(!accepted(c) || !current(c) || ['open_question','next_action'].includes(c.type))return [];
  return [...new Map(ledger.relations.filter(r=>r.type==='resolves' && r.status==='active' && r.source_claim_version_id===c.current_version_id).flatMap(r=>{
    const q=ledger.claims.find(q=>q.current_version_id===r.target_claim_version_id && q.type==='open_question' && current(q) && ledger.events.some(e=>e.id===q.event_id));
    return q?[[q.id,{questionRef:ref(q),revision:q.workflow_revision,text:claimSourceStatus(q,ledger.evidence)==='missing'?null:q.statement}] as const]:[];
  })).values()];
}
function member(c: LedgerClaim, evidence: readonly LedgerEvidence[]): ReviewMember {
  const refs = evidence.filter(e => e.claim_version_id === c.current_version_id && e.structural_validation_status === 'valid' && e.availability === 'ready');
  const supporting = refs.filter(e => e.evidence_role !== 'contextual');
  const supportStatus = supporting.length && supporting.every(e => e.semantic_support_verdict === 'fully_supports') ? 'fully_supports'
    : supporting.some(e => e.semantic_support_verdict === 'does_not_support') ? 'does_not_support'
    : supporting.some(e => e.semantic_support_verdict === 'partially_supports') ? 'partially_supports' : 'unreviewed';
  return { ...ref(c), sourceDiff:claimSourceStatus(c,evidence)==='ready'?sourceDiff(c.normalized_value_json,refs):undefined, keyDetail:keyDetailReview(c), kind: c.type === "next_action" ? "action" : c.type === "open_question" ? "question" : "record", statement: c.statement, origin: claimOrigin(c), reviewState: accepted(c) ? 'accepted' : c.review_status === 'rejected' ? 'rejected' : 'draft', supportStatus, evidenceRefIds: refs.map(e => e.id) };
}

/** Only an explicit persisted model group can share an intent choice. */
function sameIntentRefs(ledger:ProjectionLedger, stored:StoredCard, members:LedgerClaim[]):ReviewCard['sameIntent'] {
  if(!stored.group_key?.startsWith('same_intent:') || stored.kind!=='action' || members.length!==2 || members.some(m=>m.event_id!==stored.event_id))return undefined;
  const action=members.find(m=>m.type==='next_action'),record=members.find(m=>m.type==='decision');
  if(!action || !record || !ledger.relations.some(r=>r.type==='informed_by' && ['active','proposed'].includes(r.status) && (r.source_claim_id===action.id || r.source_claim_version_id===action.current_version_id) && (r.target_claim_id===record.id || r.target_claim_version_id===record.current_version_id)))return undefined;
  return {recordRef:ref(record),actionRef:ref(action)};
}

/** A post-Summary human action and a later model suggestion share one review
 * entry only while their exact persisted member versions remain together. */
export function frozenActionOverlapRefs(groupKey:string|null):ReviewCard['actionOverlap'] {
  if(!groupKey?.startsWith('action_overlap:'))return undefined;
  let frozen:unknown;
  try { frozen=JSON.parse(decodeURIComponent(groupKey.slice('action_overlap:'.length))); }
  catch { return undefined; }
  if(!frozen || typeof frozen!=='object' || Array.isArray(frozen))return undefined;
  const payload=frozen as Record<string,unknown>;
  const versionRef=(value:unknown):VersionRef|undefined=>{
    if(!value || typeof value!=='object' || Array.isArray(value))return undefined;
    const ref=value as Record<string,unknown>;
    return typeof ref.claimId==='string' && ref.claimId.trim() && typeof ref.claimVersionId==='string' && ref.claimVersionId.trim()
      ? {claimId:ref.claimId,claimVersionId:ref.claimVersionId}:undefined;
  };
  const manualRef=versionRef(payload.manualRef),modelRef=versionRef(payload.modelRef);
  if(payload.v!==1 || typeof payload.runId!=='string' || !payload.runId.trim()
    || typeof payload.clientClaimKey!=='string' || !payload.clientClaimKey.trim()
    || !manualRef || !modelRef || manualRef.claimId===modelRef.claimId || manualRef.claimVersionId===modelRef.claimVersionId)return undefined;
  return {manualRef,modelRef};
}
function actionOverlapRefs(stored:StoredCard, members:LedgerClaim[]):ReviewCard['actionOverlap'] {
  if(stored.kind!=='action' || members.length!==2
    || members.some(m=>m.event_id!==stored.event_id || m.type!=='next_action'))return undefined;
  const frozen=frozenActionOverlapRefs(stored.group_key ?? null);
  if(!frozen)return undefined;
  // card_members follows normal edits. The original pairing is immutable so
  // updating that table cannot silently keep two different tasks folded.
  const manual=members.find(m=>m.source==='human' && m.id===frozen.manualRef.claimId && m.current_version_id===frozen.manualRef.claimVersionId);
  const model=members.find(m=>m.source==='ai' && m.id===frozen.modelRef.claimId && m.current_version_id===frozen.modelRef.claimVersionId);
  return manual && model?{manualRef:ref(manual),modelRef:ref(model)}:undefined;
}

/** Frozen accepted basis takes precedence over newly proposed model relations. */
export function actionBasisRefs(ledger:ProjectionLedger, action:LedgerClaim):VersionRef[] {
  const stored=ledger.actions.find(a=>a.claim_id===action.id);
  if(stored) return readJson<VersionRef[]>(stored.basis_version_refs_json,[]);
  return [...new Map(ledger.relations.filter(r=>r.type==='informed_by' && ['active','proposed'].includes(r.status)
    && (r.source_claim_id===action.id || r.source_claim_version_id===action.current_version_id)).flatMap(r=>{
      const target=ledger.claims.find(c=>c.id===r.target_claim_id || c.current_version_id===r.target_claim_version_id);
      const targetId=r.target_claim_id ?? target?.id;
      return targetId?[[targetId,{claimId:targetId,claimVersionId:r.target_claim_version_id}] as const]:[];
    })).values()];
}

/** Follow explicit user-approved replacements, retaining the path for commit guards.
 * Ambiguous or retired paths remain unresolved so a model proposal cannot silently
 * become the basis of an accepted action. */
export function resolveActionBasis(ledger:ProjectionLedger, basis:VersionRef):{source:LedgerClaim|null;path:LedgerClaim[]} {
  const path:LedgerClaim[]=[];
  let claim=ledger.claims.find(c=>c.id===basis.claimId);
  while(claim && !path.some(c=>c.id===claim!.id)) {
    path.push(claim);
    if(!ledger.events.some(e=>e.id===claim!.event_id) || claim.review_status==='rejected' || claim.lifecycle_status==='withdrawn') break;
    if(claim.lifecycle_status!=='superseded') return {source:claim,path};
    const successors=[...new Set(ledger.relations.filter(r=>{
      const reason=readJson<{operation?:string;mode?:string}>(r.reason,{});
      return r.target_claim_version_id===claim!.current_version_id && ['contradicts','supersedes'].includes(r.type)
        && r.status==='active' && r.contradiction_status==='resolved' && reason.operation==='resolve_conflict' && reason.mode==='use_candidate';
    }).flatMap(r=>{
      const next=ledger.claims.find(c=>c.id===r.source_claim_id || c.current_version_id===r.source_claim_version_id);
      return next && accepted(next)?[next.id]:[];
    }))];
    if(successors.length!==1) break;
    claim=ledger.claims.find(c=>c.id===successors[0]);
  }
  return {source:null,path};
}

/** Coverage counts processed source segments, never the number of extracted facts. */
export function projectCoverage(ledger: Pick<ProjectionLedger, 'events' | 'assets' | 'segments' | 'runs'>, eventId: string): Coverage {
  const event = ledger.events.find(e => e.id === eventId);
  const eventAssets = ledger.assets.filter(a => a.event_id === eventId);
  const assets = eventAssets.filter(a => a.kind !== 'audio');
  const pendingAudio = eventAssets.some(a => a.kind === 'audio' && (!a.current_version_id || !assets.some(t => readJson<{source_audio_asset_version_id?: string}>(t.metadata_json,{}).source_audio_asset_version_id === a.current_version_id && t.processing_status === 'ready')));
  const versions = new Set(assets.map(a => a.current_version_id).filter(Boolean));
  const segments = ledger.segments.filter(s => s.event_id === eventId && versions.has(s.asset_version_id));
  const run = ledger.runs.find(r => r.id === event?.active_run_id);
  const manifest = readJson<Array<{ asset_version_id: string }>>(run?.input_manifest_json, []);
  const processed = new Set(run && ['succeeded','completed_with_warnings'].includes(run.status) ? manifest.map(m => m.asset_version_id) : []);
  const missing = segments.filter(s => !processed.has(s.asset_version_id)).sort((a,b) => a.asset_version_id.localeCompare(b.asset_version_id) || a.ordinal - b.ordinal);
  const unprocessedRanges: Coverage['unprocessedRanges'] = [];
  for (const s of missing) {
    const last = unprocessedRanges.at(-1);
    if (last?.assetVersionId === s.asset_version_id && last.lastOrdinal + 1 === s.ordinal) last.lastOrdinal = s.ordinal;
    else unprocessedRanges.push({ assetVersionId: s.asset_version_id, firstOrdinal: s.ordinal, lastOrdinal: s.ordinal });
  }
  return { totalSegments: segments.length, completedSegments: segments.length - missing.length,
    complete: !pendingAudio && assets.length > 0 && assets.every(a => a.processing_status === 'ready' && a.current_version_id !== null && processed.has(a.current_version_id)) && missing.length === 0,
    unprocessedRanges };
}

/** One deterministic projection backs the record, reports and MCP reads. */
export function projectWorkspace(ledger: ProjectionLedger, eventId: string, now: string, snapshotId: string): WorkspaceSnapshot {
  const event = ledger.events.find(e => e.id === eventId);
  if (!event) throw new Error('Event absent from authorized ledger');
  const events = new Map(ledger.events.map(e => [e.id, e]));
  // A queued replacement is not a published record. Keep the previous drafts
  // readable until the successor has actually published its validated output.
  const readableRuns = new Map(ledger.events.map(e => {
    const active = ledger.runs.find(r => r.id === e.active_run_id);
    const previous = active && ['queued','processing','failed','cancelled'].includes(active.status)
      ? ledger.runs.filter(r => r.event_id === e.id && ['succeeded','completed_with_warnings'].includes(r.status))
        .toSorted((a,b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id.localeCompare(a.id))[0]
      : null;
    return [e.id, previous?.id ?? e.active_run_id];
  }));
  // A new model draft list does not retire references the user has already
  // used for an action or an answer. Source/version checks still apply below.
  const humanAnchors=new Set<string>();
  for(const meta of ledger.actions){
    const action=ledger.claims.find(c=>c.id===meta.claim_id);
    if(action && accepted(action) && current(action))for(const basis of readJson<VersionRef[]>(meta.basis_version_refs_json,[]))humanAnchors.add(basis.claimId);
  }
  for(const relation of ledger.relations){
    const source=ledger.claims.find(c=>c.current_version_id===relation.source_claim_version_id);
    const target=ledger.claims.find(c=>c.current_version_id===relation.target_claim_version_id);
    if(source && target && accepted(source) && current(source) &&
      (relation.status==='active' && relation.type==='resolves' || source.type==='next_action' && relation.type==='informed_by' && ['active','proposed'].includes(relation.status)))humanAnchors.add(target.id);
  }
  const visible = ledger.claims.filter(c => {
    const e = events.get(c.event_id);
    return e && (accepted(c) || humanAnchors.has(c.id) || c.version_source === 'human' || c.source !== 'ai' || readableRuns.get(e.id) === c.extraction_run_id);
  });
  const byVersion = new Map(visible.map(c => [c.current_version_id, c]));
  const relations = ledger.relations.filter(r => byVersion.has(r.source_claim_version_id) && byVersion.has(r.target_claim_version_id));
  const liveRelations = relations.filter(r => r.status === 'active' && current(byVersion.get(r.source_claim_version_id)!) && accepted(byVersion.get(r.source_claim_version_id)!) && current(byVersion.get(r.target_claim_version_id)!));
  const reaffirmedMentions=projectReaffirmedMentions(ledger,eventId,readableRuns.get(eventId) ?? null);
  const repeatedVersions=new Set(reaffirmedMentions.filter(m=>m.associationState==='confirmed' && m.targetState==='current' && m.sourceStatus==='ready' && m.targetText!==null).map(m=>m.claimRef.claimVersionId));
  const latestOutcome = (claimId: string, answers: VersionRef[] = []): LatestOutcome | null => {
    const versions = new Set(answers.map(r=>r.claimVersionId));
    const o = ledger.outcomes.filter(o => ((o.subject_claim_id === claimId && ledger.claims.find(c=>c.id===claimId)?.type!=='open_question') || (readJson<string[]>(o.answer_claim_version_ids_json,[]).some(id=>versions.has(id)) || ledger.relations.some(r=>outcomeRelationIds(ledger,readJson<string[]>(o.relation_ids_json,[])).includes(r.id) && r.status==='active' && versions.has(r.source_claim_version_id)))) && !o.withdrawn_at).sort((a,b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id))[0];
    if (!o) return null;
    const originalVersions=readJson<string[]>(o.answer_claim_version_ids_json,[]);
    const answerRefs = originalVersions.flatMap(v => {
      const c = byVersion.get(v);
      const resolves=liveRelations.some(r=>r.type==='resolves' && r.source_claim_version_id===v && byVersion.get(r.target_claim_version_id)?.type==='open_question');
      return c && current(c) && accepted(c) && resolves && claimSourceStatus(c,ledger.evidence)==='ready' ? [ref(c)] : [];
    });
    const roots=new Set(readJson<string[]>(o.relation_ids_json,[]));
    const resultVersions=ledger.relations.filter(r=>roots.has(r.id) && r.type==='informed_by' && readJson<{workflowOutcomeResult?:boolean}>(r.reason,{}).workflowOutcomeResult===true).map(r=>r.source_claim_version_id);
    const resultRefs=resultVersions.flatMap(v=>{
      const c=byVersion.get(v);
      return c && current(c) && accepted(c) && claimSourceStatus(c,ledger.evidence)==='ready' && liveRelations.some(r=>roots.has(r.id) && r.source_claim_version_id===v)?[ref(c)]:[];
    });
    const accessible=[...originalVersions,...resultVersions].every(v=>{const refs=ledger.evidence.filter(e=>e.claim_version_id===v && e.evidence_role!=='contextual');return refs.length>0 && refs.every(e=>e.availability==='ready' && e.structural_validation_status==='valid');});
    return { id: o.id, revision: o.revision, text: accessible?o.text:'', answerRefs, ...(resultVersions.length?{resultRefs}:{}), updatedAt: o.updated_at, freshness:originalVersions.length===answerRefs.length && resultVersions.length===resultRefs.length?'current':'stale' };
  };
  const selected = visible.filter(c => {
    if(!(c.event_id===eventId || repeatedVersions.has(c.current_version_id)) || !current(c) || isCompletionRecord(c))return false;
    if(readJson<{workflow_kind?:string}>(c.normalized_value_json,{}).workflow_kind!=='result')return true;
    return ledger.outcomes.some(o=>{
      const subject=visible.find(a=>a.id===o.subject_claim_id && a.type==='next_action' && current(a));
      const result=subject?latestOutcome(subject.id):null;
      return result?.freshness==='current' && result.resultRefs?.some(r=>r.claimVersionId===c.current_version_id);
    });
  }).sort((a,b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const questions: Question[] = selected.filter(c => {
    if (c.type !== 'open_question') return false;
    // A model's disputed question is a review proposal. It must not reopen a
    // user's answered topic or enter follow-up before the conflict is decided.
    return accepted(c) || !relations.some(r =>
      r.source_claim_version_id === c.current_version_id &&
      ['contradicts', 'supersedes'].includes(r.type) &&
      ['active', 'proposed'].includes(r.status) && r.contradiction_status !== 'resolved' &&
      accepted(byVersion.get(r.target_claim_version_id)!) && current(byVersion.get(r.target_claim_version_id)!),
    );
  }).map(c => {
    const answers = liveRelations.filter(r => r.type === 'resolves' && r.target_claim_version_id === c.current_version_id)
      .map(r => byVersion.get(r.source_claim_version_id)!).filter(a => a.type !== 'next_action' && a.type !== 'open_question' && claimSourceStatus(a, ledger.evidence) === 'ready');
    return { id: c.id, claimRef: ref(c), revision: c.workflow_revision, resolutionState: answers.length ? 'resolved' : 'open', answerRefs: [...new Map(answers.map(a => [a.id, ref(a)])).values()], latestOutcome: latestOutcome(c.id, answers.map(ref)) };
  });
  const projectAction = (c:LedgerClaim):Action => {
    const meta = ledger.actions.find(a => a.claim_id === c.id);
    // Execution belongs to the stable action. Its completion still points to
    // the exact wording that was completed, even after a description correction.
    const completed = ledger.relations.some(r => r.type === 'resolves' && r.status === 'active'
      && (r.target_claim_id === c.id || r.target_claim_version_id === c.current_version_id)
      && byVersion.has(r.source_claim_version_id) && current(byVersion.get(r.source_claim_version_id)!) && accepted(byVersion.get(r.source_claim_version_id)!));
    const basis = actionBasisRefs(ledger,c);
    const basisDetails = basis.map(b => {
      const {source} = resolveActionBasis({...ledger,claims:visible},b);
      const sourceStatus = source ? claimSourceStatus(source,ledger.evidence) : 'missing' as const;
      const prior = ledger.basisVersions?.find(v=>v.id===b.claimVersionId && v.claim_id===b.claimId);
      const oldEvidence = ledger.evidence.filter(e=>e.claim_version_id===b.claimVersionId && e.evidence_role!=='contextual');
      const priorReadable = oldEvidence.length>0 && oldEvidence.every(e=>e.availability!=='missing' && e.structural_validation_status==='valid');
      return {acceptedRef:b,acceptedText:!priorReadable?null:prior?.statement ?? (source?.current_version_id===b.claimVersionId?source.statement:null),
        currentRef:source?ref(source):null,currentText:sourceStatus==='missing'?null:source!.statement,sourceStatus};
    });
    const basisChanged = basisDetails.some(b=>b.currentRef?.claimVersionId!==b.acceptedRef.claimVersionId || b.sourceStatus!=='ready');
    const questionRefs = [...new Map(ledger.relations.filter(r => r.type === 'informed_by' && ['active','proposed'].includes(r.status) && (r.source_claim_id === c.id || r.source_claim_version_id === c.current_version_id))
      .flatMap(r => { const q = visible.find(q=>q.id===r.target_claim_id || q.current_version_id===r.target_claim_version_id); return q?.type === 'open_question' && current(q) ? [[q.id,{ ...ref(q), revision: q.workflow_revision }] as const] : []; })).values()];
    return { id: c.id, claimRef: ref(c), revision: c.workflow_revision,
      executionState: meta?.cancelled_at ? 'cancelled' : completed ? 'completed' : 'open', questionRefs, basisDetails,
      basisState: basisChanged || meta?.basis_state === 'needs_review' || claimSourceStatus(c,ledger.evidence) !== 'ready' ? 'needs_review' : 'current', latestOutcome: latestOutcome(c.id),
      ...(meta?.owner_hint ? { ownerHint: meta.owner_hint } : {}), ...(meta?.due_at ? { dueAt: meta.due_at } : {}) };
  };
  const actions = selected.filter(c => c.type === 'next_action' && accepted(c)).map(projectAction);
  const actionHistory:ActionHistoryEntry[] = visible.filter(c=>c.event_id===eventId && c.type==='next_action' && accepted(c) && c.lifecycle_status==='superseded').map(c=>{
    const sourceStatus=claimSourceStatus(c,ledger.evidence),replacement=resolveActionBasis({...ledger,claims:visible},ref(c)).source;
    return {id:c.id,claimRef:ref(c),text:sourceStatus==='missing'?null:c.statement,sourceStatus,executionState:projectAction(c).executionState,replacementRef:replacement?ref(replacement):null,replacementText:replacement && claimSourceStatus(replacement,ledger.evidence)!=='missing'?replacement.statement:null,latestOutcome:latestOutcome(c.id)};
  });
  const answerVersions = new Set(questions.flatMap(q => q.answerRefs.map(r => r.claimVersionId)));
  const bulletClaims = [...new Map([...selected, ...visible.filter(c => c.event_id !== eventId && answerVersions.has(c.current_version_id))].map(c=>[c.id,c])).values()];
  const bullets: Bullet[] = bulletClaims.map(c => {
    const applicability = [...new Set(liveRelations.filter(r=>((r.source_claim_version_id===c.current_version_id && r.type==='resolves') || (['contradicts','supersedes'].includes(r.type) && (r.source_claim_version_id===c.current_version_id || r.target_claim_version_id===c.current_version_id))))
      .flatMap(r=>{const reason=readJson<{operation?:string;applicability?:string}>(r.reason,{});return (reason.operation==='coexist' || reason.operation==='resolve_conflict' && readJson<{mode?:string}>(r.reason,{}).mode==='coexist') && reason.applicability?[reason.applicability]:[];}))].join(' / ');
    const conflictWith=relations.filter(r=>r.source_claim_version_id===c.current_version_id && ['contradicts','supersedes'].includes(r.type) && ['active','proposed'].includes(r.status) && r.contradiction_status!=='resolved' && accepted(byVersion.get(r.target_claim_version_id)!) && current(byVersion.get(r.target_claim_version_id)!)).map(r=>ref(byVersion.get(r.target_claim_version_id)!));
    return { ...(conflictWith.length?{conflictWith}:{}), id:c.id,text:c.statement,claimRefs:[ref(c)],reviewState:accepted(c)?'accepted':'draft',origin:claimOrigin(c),sourceStatus:claimSourceStatus(c,ledger.evidence),...(applicability?{applicability}:{}) };
  });
  const cards: ReviewCard[] = [];
  const covered = new Set<string>();
  // A repeated member can appear in a later record without moving the
  // original two-member agreement. Reuse its established card ownership.
  const originalGroupMembers = new Set<string>();
  for (const stored of ledger.cards.filter(c=>c.group_key?.startsWith('same_intent:'))) {
    const refs=ledger.members.filter(m=>m.card_id===stored.id);
    const members=refs.flatMap(m=>{const c=byVersion.get(m.claim_version_id);return c?.id===m.claim_id?[c]:[];});
    if(members.length===refs.length && sameIntentRefs(ledger,stored,members)) members.forEach(c=>originalGroupMembers.add(c.id));
  }
  for (const stored of ledger.cards.filter(c => c.event_id === eventId || c.group_key?.startsWith('same_intent:') && ledger.members.filter(m=>m.card_id===c.id).length===2 && ledger.members.filter(m=>m.card_id===c.id).every(m=>repeatedVersions.has(m.claim_version_id)))) {
    if(!stored.group_key?.startsWith('same_intent:') && stored.id.startsWith('wfc_') && ledger.members.some(m=>m.card_id===stored.id && originalGroupMembers.has(m.claim_id)))continue;
    const members = ledger.members.filter(m => m.card_id === stored.id).flatMap(m => { const c = byVersion.get(m.claim_version_id); return c?.id === m.claim_id && !['withdrawn','superseded'].includes(c.lifecycle_status) ? [c] : []; }).sort((a,b)=>a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    // A group with any outdated member is replaced by current individual cards.
    if (!members.length || members.length !== ledger.members.filter(m => m.card_id === stored.id).length) continue;
    const sameIntent=sameIntentRefs(ledger,stored,members);
    const actionOverlap=actionOverlapRefs(stored,members);
    if(stored.group_key?.startsWith('same_intent:') && !sameIntent
      || stored.group_key?.startsWith('action_overlap:') && !actionOverlap)continue;
    members.forEach(c => covered.add(c.id));
    cards.push({ eventId:stored.event_id, ...(sameIntent?{sameIntent}:{}), ...(actionOverlap?{actionOverlap}:{}), createdAt:stored.created_at ?? members.map(c=>c.created_at).sort()[0], id: stored.id, revision: stored.revision, kind: stored.kind, title: stored.title, memberRefs: members.map(ref), members: members.map(c => member(c,ledger.evidence)), suggestedOperation: actionOverlap ? 'review_members' : stored.kind === 'action' ? 'accept_action' : stored.kind === 'conflict' ? 'resolve_conflict' : 'confirm', needsDecision: Boolean(stored.needs_decision), reasonCode: stored.reason_code, reason: stored.reason, disposition: stored.disposition, sourceStatus: members.some(c => claimSourceStatus(c,ledger.evidence) === 'missing') ? 'missing' : members.some(c => claimSourceStatus(c,ledger.evidence) === 'stale') ? 'stale' : 'ready', latestDecisionId: stored.latest_decision_id, decisionRevision: stored.decision_revision });
  }
  for (const c of selected.filter(c => !covered.has(c.id) && !(c.event_id!==eventId && originalGroupMembers.has(c.id)))) {
    const conflicts = relations.filter(r => ['contradicts','supersedes'].includes(r.type) && ['proposed','active'].includes(r.status) && r.contradiction_status !== 'resolved' && r.source_claim_version_id === c.current_version_id && accepted(byVersion.get(r.target_claim_version_id)!) && current(byVersion.get(r.target_claim_version_id)!));
    const actionable = pendingActionChoice(c,ledger.evidence);
    const needsDecision = !accepted(c) && (conflicts.length > 0 || actionable);
    const reasonCode = needsDecision ? conflicts.length ? 'accepted_change' : 'action_choice' : null;
    // An invalidated overlap leaves its original card row for decision audit.
    // Give the now-independent model claim a different writable card identity.
    const defaultCardId=`wfc_${c.id}`;
    const soloCardId=ledger.cards.some(stored=>stored.id===defaultCardId && stored.group_key?.startsWith('action_overlap:'))
      ? `${defaultCardId}_solo` : defaultCardId;
    cards.push({ eventId:c.event_id, createdAt:c.created_at, id: soloCardId, revision: c.workflow_revision, kind: conflicts.length ? 'conflict' : c.type === 'next_action' ? 'action' : c.type === 'open_question' ? 'question' : 'record', title: c.statement, memberRefs: [ref(c)], members: [member(c,ledger.evidence)], suggestedOperation: conflicts.length ? 'resolve_conflict' : c.type === 'next_action' ? 'accept_action' : 'confirm', needsDecision, reasonCode, reason: reasonCode === 'accepted_change' ? '这条信息涉及已采纳内容的变化' : reasonCode === 'action_choice' ? '决定是否加入跟进' : '', disposition: accepted(c) ? 'processed' : 'active', sourceStatus: claimSourceStatus(c,ledger.evidence), latestDecisionId: null, decisionRevision: null });
  }
  for (const card of cards) {
    for(const m of card.members) {
      const targets=factAnswerTargets(ledger,byVersion.get(m.claimVersionId)!);
      if(targets.length)m.answerTargets=targets;
    }
    // Stored cards can predate priority rules or carry the database's zero
    // default. Derive action choice from current members for both stored and
    // virtual cards. A shared agreement is handled once; independent actions
    // in other groups keep their choice until each is handled.
    const intentHandled=Boolean(card.sameIntent) && card.members.some(m=>m.reviewState!=='draft');
    const pendingChoice=card.sourceStatus==='ready' && !intentHandled && card.members.some(m=>{
      const c=byVersion.get(m.claimVersionId)!;
      return pendingActionChoice(c,ledger.evidence) || Boolean(card.actionOverlap) && c.type==='next_action' && current(c) && !accepted(c);
    });
    const actionChoice=card.disposition==='active' && pendingChoice;
    const uncertain=card.members.find(m=>m.reviewState==='draft' && m.keyDetail && (m.keyDetail.question || m.keyDetail.alternatives.length || byVersion.get(m.claimVersionId)?.needs_additional_evidence || ['partially_supports','does_not_support'].includes(m.supportStatus)));
    if(!card.needsDecision && uncertain && card.disposition==='active') {
      card.needsDecision=true;card.reasonCode='key_detail';card.reason=uncertain.keyDetail!.question ?? `核对${uncertain.keyDetail!.label}，原文还有不明确的地方`;
    } else if(card.reasonCode==='key_detail' && !uncertain) {
      card.needsDecision=false;card.reasonCode=null;card.reason='';
    }
    if(card.reasonCode==='action_choice' || !card.needsDecision && actionChoice) {
      card.needsDecision=actionChoice;card.reasonCode=actionChoice?'action_choice':null;
      card.reason=actionChoice?'决定是否加入跟进':'';
    }
    const conflicts=relations.filter(r=>['contradicts','supersedes'].includes(r.type) && ['active','proposed'].includes(r.status) && r.contradiction_status!=='resolved'
      && card.memberRefs.some(m=>m.claimVersionId===r.source_claim_version_id) && accepted(byVersion.get(r.target_claim_version_id)!) && current(byVersion.get(r.target_claim_version_id)!));
    if(conflicts.length) {
      card.conflicts=conflicts.map(r=>({relationId:r.id,existing:member(byVersion.get(r.target_claim_version_id)!,ledger.evidence),candidateRef:ref(byVersion.get(r.source_claim_version_id)!),...(byVersion.get(r.target_claim_version_id)!.type==='next_action'?{existingActionState:projectAction(byVersion.get(r.target_claim_version_id)!).executionState}:{})}));
      card.kind='conflict';card.needsDecision=true;card.reasonCode='accepted_change';card.reason='新信息与已采纳内容有差异，请决定采用哪一项';card.disposition='active';card.suggestedOperation='resolve_conflict';
    }
    if(actions.some(a=>a.basisState==='needs_review' && card.memberRefs.some(r=>r.claimId===a.id))) {
      card.needsDecision=true;card.reasonCode='accepted_change';card.reason='行动依据已有变化，请核对是否继续保留';card.disposition='active';
    }
    const deferred = ledger.deferrals.find(d => d.card_id === card.id);
    if (card.disposition === 'active' && deferred && (!deferred.until_at || deferred.until_at > now)) card.disposition = 'deferred';
  }
  cards.sort((a,b)=>(a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
  // Context versions belong to projects. A record moved from a mature project
  // can carry an old narrative with a larger number than its new project's
  // current version, so compare against the current project before recency.
  const stored = ledger.narratives.filter(n => n.event_id === eventId && n.scope_kind === 'mixed').sort((a,b) =>
    Number(b.based_on_context_version === ledger.contextVersion && b.freshness === 'current' && b.prompt_version === WORKFLOW_NARRATIVE_PROMPT_VERSION) - Number(a.based_on_context_version === ledger.contextVersion && a.freshness === 'current' && a.prompt_version === WORKFLOW_NARRATIVE_PROMPT_VERSION) ||
    Number(b.based_on_context_version === ledger.contextVersion) - Number(a.based_on_context_version === ledger.contextVersion) ||
    b.created_at.localeCompare(a.created_at) || b.based_on_context_version - a.based_on_context_version)[0];
  let narrative: Narrative | null = null;
  if (stored) {
    const sentences = readJson<Narrative['sentenceRefs']>(stored.sentence_refs_json, []);
    const valid = sentences.length > 0 && sentences.every(s => s.claimRefs.length > 0 && s.claimRefs.every(r => { const c = byVersion.get(r.claimVersionId); return c?.id === r.claimId && current(c) && claimSourceStatus(c,ledger.evidence) === 'ready'; }) && s.reviewState === (s.claimRefs.every(r => accepted(byVersion.get(r.claimVersionId)!)) ? 'accepted' : 'draft'));
    const accessible = sentences.every(s => s.claimRefs.every(r => { const c=ledger.claims.find(c=>c.id===r.claimId); const refs=ledger.evidence.filter(e=>e.claim_version_id===r.claimVersionId && e.evidence_role!=='contextual'); return c && refs.length>0 && refs.every(e=>e.availability==='ready' && e.structural_validation_status==='valid'); }));
    narrative = { text: accessible ? stored.text : '', sentenceRefs: accessible ? sentences : [], basedOnContextVersion: stored.based_on_context_version, scope: stored.scope_kind, freshness: valid && stored.based_on_context_version === ledger.contextVersion && stored.prompt_version === WORKFLOW_NARRATIVE_PROMPT_VERSION ? stored.freshness : 'stale' };
  }
  const narrativeJob=(ledger.narrativeJobs ?? []).filter(j=>j.event_id===eventId && j.input_revision===ledger.contextVersion && j.state!=='cancelled').toSorted((a,b)=>b.created_at.localeCompare(a.created_at))[0];
  if(narrativeJob && ['queued','running','failed'].includes(narrativeJob.state)) {
    narrative={text:narrative?.text ?? '',sentenceRefs:narrative?.sentenceRefs ?? [],basedOnContextVersion:narrative?.basedOnContextVersion ?? ledger.contextVersion,scope:'mixed',freshness:narrativeJob.state==='failed'?'failed':'updating'};
  }
  const recentDecisions=(ledger.decisions ?? []).filter(d=>d.event_id===eventId && ['confirm','edit','reject','accept_action','resolve_conflict','review_members','confirm_mention','reject_mention','convert_mention'].includes(d.operation)).sort((a,b)=>b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0,10).map(d=>({id:d.id,revision:d.revision,operation:d.operation,summary:d.summary,createdAt:d.created_at,reverted:Boolean(d.reverted_by),...(["keep_existing","use_candidate","coexist"].includes(d.choice_mode ?? "")?{choiceMode:d.choice_mode as "keep_existing"|"use_candidate"|"coexist"}:{})}));
  const progress=ledger.progress?.find(p=>p.event_id===eventId);
  const counts=recordCounts(bullets,cards,actions,questions);
  const reviewProgress={lastCardId:progress?.last_card_id && cards.some(c=>c.id===progress.last_card_id)?progress.last_card_id:null,finishedAt:progress?.finished_at ?? null,remainingCount:counts.needsDecisionCount};
  return { reaffirmedMentions, analysisRunId:event.active_run_id, reviewProgress, recentDecisions, access: ledger.access ?? {workspaceId:'',actorId:'',canEdit:false}, snapshotId, contextVersion: ledger.contextVersion, sourceRevision: event.source_revision, coverage: projectCoverage(ledger,eventId), bullets, reviewCards: cards, actions, actionHistory, questions, narrative, counts, nextCursor: null };
}
