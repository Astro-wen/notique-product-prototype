export const OPENAI_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const DEFAULT_AI_TIMEOUT_MS = 90_000;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 24_000;

// A processor owns a Run for ten minutes. Provider I/O must stop early enough
// to leave one minute for validation and persistence before that lease expires.
export const EXTRACTION_RUN_LEASE_MS = 10 * 60_000;
export const AI_TIMEOUT_SAFETY_MARGIN_MS = 60_000;
export const MAX_AI_TIMEOUT_MS =
  EXTRACTION_RUN_LEASE_MS - AI_TIMEOUT_SAFETY_MARGIN_MS;

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

export function outboxLeaseDurationMs(frozenTimeoutMs: unknown): number {
  const timeoutMs = normalizeAiTimeoutMs(
    typeof frozenTimeoutMs === "number" ? frozenTimeoutMs : undefined,
  );
  return Math.max(
    MIN_OUTBOX_LEASE_MS,
    timeoutMs + AI_TIMEOUT_SAFETY_MARGIN_MS,
  );
}

export type OpenAiReasoningEffort = typeof OPENAI_REASONING_EFFORTS[number];

export function normalizeOpenAiReasoningEffort(
  value: string | undefined,
): OpenAiReasoningEffort {
  const normalized = value?.trim().toLowerCase() || "max";
  return (OPENAI_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized as OpenAiReasoningEffort
    : "max";
}
