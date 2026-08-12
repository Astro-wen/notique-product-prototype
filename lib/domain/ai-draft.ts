export type DraftClaimLike = {
  id: string;
  type: string;
  statement: string;
  reviewStatus: string;
  source?: "ai" | "human" | "occurrence_conversion";
  needsAdditionalEvidence?: boolean;
  uncertainty?: unknown;
  relationsForReview?: Array<{ status: string }>;
  confidence?: number;
  createdAt?: string;
};

export type AiDraftSectionKey =
  | "decisions"
  | "money_dates_owners"
  | "preferences"
  | "open_questions"
  | "risks"
  | "other";

const criticalTypes = new Set(["budget", "decision", "timing", "person_role", "requirement"]);

export function reviewRiskScore(claim: DraftClaimLike): number {
  let score = 0;
  if (claim.source === "human") score += 1_000;
  if (criticalTypes.has(claim.type)) score += 500;
  if (claim.relationsForReview?.some((relation) => relation.status === "proposed")) score += 300;
  if (claim.needsAdditionalEvidence || claim.uncertainty != null) score += 200;
  if (["risk", "concern", "open_question"].includes(claim.type)) score += 150;
  score += Math.round((claim.confidence ?? 0) * 20);
  return score;
}

export function sortClaimsForReview<T extends DraftClaimLike>(claims: T[]): T[] {
  return [...claims].sort((left, right) => {
    const scoreDifference = reviewRiskScore(right) - reviewRiskScore(left);
    if (scoreDifference) return scoreDifference;
    const timeDifference = String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""));
    if (timeDifference) return timeDifference;
    return left.id.localeCompare(right.id);
  });
}

export function aiDraftSectionForClaim(claim: DraftClaimLike): AiDraftSectionKey {
  if (["decision", "requirement"].includes(claim.type)) return "decisions";
  if (["budget", "timing", "person_role", "measurement"].includes(claim.type)) return "money_dates_owners";
  if (["preference", "material"].includes(claim.type)) return "preferences";
  if (claim.type === "open_question") return "open_questions";
  if (["risk", "concern"].includes(claim.type) || claim.needsAdditionalEvidence) return "risks";
  return "other";
}

export function groupAiDraftClaims<T extends DraftClaimLike>(claims: T[]): Record<AiDraftSectionKey, T[]> {
  const result: Record<AiDraftSectionKey, T[]> = {
    decisions: [],
    money_dates_owners: [],
    preferences: [],
    open_questions: [],
    risks: [],
    other: [],
  };
  for (const claim of claims) result[aiDraftSectionForClaim(claim)].push(claim);
  return result;
}
