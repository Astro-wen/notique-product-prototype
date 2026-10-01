export const OPTIONAL_VERIFICATION_WAIT_MS = 120_000;

// Coverage and relation failures still receive the full verification budget.
// A validated, complete base can already be read and reviewed by the user.
export function verificationWaitBudget(
  fullBudgetMs: number,
  frozenOptionalBudget: unknown,
  hasValidatedBase: boolean,
  reasons: readonly string[],
): number {
  if (!hasValidatedBase || !reasons.length ||
    reasons.some(reason => reason !== 'compound_claim' && reason !== 'unresolved_conflict') ||
    typeof frozenOptionalBudget !== 'number' || !Number.isFinite(frozenOptionalBudget) || frozenOptionalBudget < 60_000) return fullBudgetMs;
  return Math.min(fullBudgetMs, frozenOptionalBudget);
}
