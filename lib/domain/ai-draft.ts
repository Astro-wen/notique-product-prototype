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
  evidenceRefs?: Array<{
    id: string;
    quote?: string;
    speaker?: string;
    timestampStart?: string | number;
  }>;
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

export type AiDraftSummaryItem = {
  claimId: string;
  section: AiDraftSectionKey;
  statement: string;
  reviewStatus: string;
  evidenceId: string | null;
  quote: string | null;
  speaker: string | null;
  timestampStart: number | null;
};

const draftSectionOrder: AiDraftSectionKey[] = [
  "decisions",
  "money_dates_owners",
  "preferences",
  "open_questions",
  "risks",
  "other",
];

function numericTimestamp(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1_000;
  if (parts.length === 3) return (parts[0] * 3_600 + parts[1] * 60 + parts[2]) * 1_000;
  return null;
}

/**
 * Builds the readable AI-first summary from already validated Agent B claims.
 * This is presentation-only: it never merges claims or creates new statements.
 */
export function buildAiDraftSummary<T extends DraftClaimLike>(claims: T[]): AiDraftSummaryItem[] {
  return claims
    .map((claim) => {
      const evidence = claim.evidenceRefs?.find((item) => Boolean(item.quote)) ?? claim.evidenceRefs?.[0];
      return {
        claimId: claim.id,
        section: aiDraftSectionForClaim(claim),
        statement: claim.statement,
        reviewStatus: claim.reviewStatus,
        evidenceId: evidence?.id ?? null,
        quote: evidence?.quote?.trim() || null,
        speaker: evidence?.speaker?.trim() || null,
        timestampStart: numericTimestamp(evidence?.timestampStart),
      } satisfies AiDraftSummaryItem;
    })
    .sort((left, right) => {
      const leftSection = draftSectionOrder.indexOf(left.section);
      const rightSection = draftSectionOrder.indexOf(right.section);
      if (leftSection !== rightSection) return leftSection - rightSection;
      if (left.timestampStart !== null && right.timestampStart !== null) {
        const timeDifference = left.timestampStart - right.timestampStart;
        if (timeDifference) return timeDifference;
      } else if (left.timestampStart !== null) {
        return -1;
      } else if (right.timestampStart !== null) {
        return 1;
      }
      return left.claimId.localeCompare(right.claimId);
    });
}
