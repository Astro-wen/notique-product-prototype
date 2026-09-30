export type ActionAttributes = { ownerHint: string | null; dueAt: string | null };

/** Uses the same full calendar-date rule as manual action entry. Relative or
 * incomplete dates remain in the source statement until explicitly resolved. */
export function normalizedActionAttributes(normalizedValueJson: string | null | undefined): ActionAttributes {
  let value: unknown;
  try { value = normalizedValueJson ? JSON.parse(normalizedValueJson) : null; }
  catch { return { ownerHint: null, dueAt: null }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ownerHint: null, dueAt: null };
  const normalized = value as Record<string, unknown>;
  const ownerHint = typeof normalized.owner === 'string' && normalized.owner.trim() ? normalized.owner.trim() : null;
  const due = normalized.due_at;
  const dueAt = typeof due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due)
    && Number.isFinite(Date.parse(due)) && new Date(due).toISOString().slice(0, 10) === due ? due : null;
  return { ownerHint, dueAt };
}
