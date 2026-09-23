/**
 * Field readers shared by the claim, view and overview surfaces. They stay in
 * the domain layer so tests can import them directly instead of transpiling
 * them back out of the page source.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (value) return value;
  }
  return undefined;
}
