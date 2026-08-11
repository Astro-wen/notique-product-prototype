export type FrozenOccurrenceTarget = {
  status: unknown;
  baseVersionId: unknown;
  targetClaimVersionId: unknown;
  currentVersionId: unknown;
  reviewStatus: unknown;
  lifecycleStatus: unknown;
};

export function matchesFrozenOccurrenceTarget(
  candidate: FrozenOccurrenceTarget,
  requestedTargetVersionId: string,
): boolean {
  return (
    String(candidate.status) === "pending" &&
    String(candidate.baseVersionId) === requestedTargetVersionId &&
    String(candidate.targetClaimVersionId) === requestedTargetVersionId &&
    String(candidate.currentVersionId) === String(candidate.targetClaimVersionId) &&
    String(candidate.reviewStatus) === "verified" &&
    String(candidate.lifecycleStatus) === "active"
  );
}

export const OCCURRENCE_FROZEN_TARGET_PREDICATE_SQL = `
  occ.status = 'pending'
  AND occ.base_version_id = ?
  AND occ.target_claim_version_id = ?
  AND c.current_version_id = occ.target_claim_version_id
  AND c.review_status = 'verified'
  AND c.lifecycle_status = 'active'
`;
