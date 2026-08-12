export const OPENAI_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const DEFAULT_AI_TIMEOUT_MS = 90_000;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 24_000;

// A two-stage Run can make inventory, verification, and one escalated
// verification request. The durable stage records make this lease resumable,
// but one healthy dispatch still needs enough wall time for all three calls.
export const EXTRACTION_RUN_LEASE_MS = 30 * 60_000;
export const AI_TIMEOUT_SAFETY_MARGIN_MS = 60_000;
export const MAX_AI_TIMEOUT_MS = 9 * 60_000;

// The Outbox delivery remains owned for the provider timeout plus the same
// persistence margin. A two-minute floor preserves the previous short-run
// behavior without allowing long Luna runs to be reclaimed mid-request.
export const MIN_OUTBOX_LEASE_MS = 2 * 60_000;

export function normalizeAiTimeoutMs(
  value: string | number | undefined,
  fallback = DEFAULT_AI_TIMEOUT_MS,
): number {
  const parsed = Number(value);
  const configured =
    Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(configured, MAX_AI_TIMEOUT_MS);
}

export function outboxLeaseDurationMs(
  frozenTimeoutMs: unknown,
  frozenMaxStages: unknown = 1,
): number {
  const timeoutMs = normalizeAiTimeoutMs(
    typeof frozenTimeoutMs === "number" ? frozenTimeoutMs : undefined,
  );
  const maxStages = Number.isSafeInteger(frozenMaxStages) && Number(frozenMaxStages) > 0
    ? Math.min(Number(frozenMaxStages), 3)
    : 1;
  return Math.max(
    MIN_OUTBOX_LEASE_MS,
    timeoutMs * maxStages + AI_TIMEOUT_SAFETY_MARGIN_MS,
  );
}

export type OpenAiReasoningEffort = typeof OPENAI_REASONING_EFFORTS[number];

export function normalizeOpenAiReasoningEffort(
  value: string | undefined,
): OpenAiReasoningEffort {
  const normalized = value?.trim().toLowerCase() || "xhigh";
  return (OPENAI_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized as OpenAiReasoningEffort
    : "xhigh";
}

export function normalizeVerifierReasoningEffort(
  value: string | undefined,
): OpenAiReasoningEffort {
  const normalized = value?.trim().toLowerCase() || "high";
  return (OPENAI_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized as OpenAiReasoningEffort
    : "high";
}

export function twoPassPipelineEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}
