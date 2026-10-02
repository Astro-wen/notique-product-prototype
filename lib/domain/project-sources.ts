import { claimOrigin, type ProjectionLedger } from './workflow-projection.ts';
import type { ProjectSourceRef, SourceStatus, VersionRef } from '../shared/workflow-v2.ts';

/** A source always belongs to the referenced version, including historical changes.
 * The authorized ledger supplies version ownership from the same database snapshot.
 * No current-version fallback is permitted for an older version. */
export function projectSourceRefs(ledger: ProjectionLedger, refs: readonly VersionRef[]): ProjectSourceRef[] {
  const claims = new Map(ledger.claims.map(claim => [claim.id, claim]));
  const events = new Set(ledger.events.map(event => event.id));
  const seen = new Set<string>();
  return refs.flatMap(ref => {
    const key = JSON.stringify([ref.claimId, ref.claimVersionId]);
    if (seen.has(key)) return [];
    seen.add(key);
    const claim = claims.get(ref.claimId);
    if (!claim || !events.has(claim.event_id)) return [];
    const current = claim.current_version_id === ref.claimVersionId;
    const evidence = ledger.evidence.filter(source =>
      source.claim_version_id === ref.claimVersionId
      && (source.claim_id === ref.claimId || source.claim_id === undefined && current)
      && (source.event_id === claim.event_id || source.event_id === undefined)
      && source.evidence_role !== 'contextual');
    // Older in-memory fixtures may omit ownership metadata for current sources.
    // A historical version always needs an explicit persisted claim/version pair.
    if (!current && !evidence.some(source => source.claim_id === ref.claimId)) return [];
    const version = evidence[0];
    const notes = evidence.filter(source => source.kind === 'user_note');
    const origin = notes.length && notes.length === evidence.length ? 'user_input' : current ? claimOrigin(claim)
      : version?.workflow_origin ?? (version?.version_source === 'human' || evidence.some(source => source.kind === 'user_note')
        ? 'user_input' : claim.type === 'next_action' ? 'ai_suggestion' : 'source_statement');
    const candidates = origin === 'user_input' && notes.length ? notes : evidence;
    const sourceStatus: SourceStatus = !candidates.length || candidates.some(source =>
      source.availability === 'missing' || source.structural_validation_status !== 'valid'
      || source.kind !== 'user_note' && source.provenance_grade !== undefined && source.provenance_grade !== 'primary')
      ? 'missing' : candidates.some(source => source.availability === 'stale') ? 'stale' : 'ready';
    return [{ ...ref, eventId: claim.event_id, origin, sourceStatus,
      evidenceRefIds: sourceStatus === 'ready' ? [...new Set(candidates.map(source => source.id))].sort() : [] }];
  });
}
