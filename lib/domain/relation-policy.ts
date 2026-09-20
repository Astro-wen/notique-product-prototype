/** Target eligibility only; a proposed relationship still requires evidence review. */
export function canResolveClaim(target: {
  type: string;
  statement?: string;
  normalizedValue?: Record<string, unknown> | null;
  uncertainty?: unknown;
}): boolean {
  if (["open_question", "risk", "concern", "requirement"].includes(target.type)) return true;
  if (target.uncertainty != null) return true;
  const value = target.normalizedValue;
  if (typeof value?.required_prerequisite === "string" && value.required_prerequisite.trim()) return true;
  // A commitment to obtain confirmation can be stored as `other`, not only
  // `requirement`. This permits review of closure; it never infers completion.
  if (typeof value?.action === "string" && value.action.trim()
    && typeof value.sequence_condition === "string" && value.sequence_condition.trim()) return true;
  return ["decision", "other"].includes(target.type)
    && /\b(?:until|prerequisite|pending confirmation|subject to approval)\b|(?:前提|尚待确认|须先|需先|之前不得|之前不能)/iu.test(target.statement ?? "");
}
