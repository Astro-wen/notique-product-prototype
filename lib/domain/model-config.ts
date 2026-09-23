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

/**
 * 第一轮（清点）的默认强度。
 *
 * 2026-09-22 用同一份 14 分钟真实录音实测：xhigh 三次 2.5 到 3.9 分钟，high
 * 1.7 到 3.0 分钟，出来的事实条数和 xhigh 一样；medium 只有一半输出，整段合同
 * 条款都没清点出来。所以默认 high。
 */
export function normalizeOpenAiReasoningEffort(
  value: string | undefined,
): OpenAiReasoningEffort {
  const normalized = value?.trim().toLowerCase() || "high";
  return (OPENAI_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized as OpenAiReasoningEffort
    : "high";
}

export function normalizeVerifierReasoningEffort(
  value: string | undefined,
): OpenAiReasoningEffort {
  const normalized = value?.trim().toLowerCase() || "high";
  return (OPENAI_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized as OpenAiReasoningEffort
    : "high";
}

/**
 * 升级那一趟用的推理强度：在基础 verify 之上提一档。
 *
 * 之前两趟同强度，所谓"升级"只是换了提示词再掷一次骰子。提一档之后，
 * 基础那趟可以继续配成快的（latency 只在多数正常 Run 上计价），确定性
 * 判断认定需要重核时才付更贵的一次。已经是 xhigh 就保持不变。
 */
export function escalatedReasoningEffort(base: OpenAiReasoningEffort): OpenAiReasoningEffort {
  const index = OPENAI_REASONING_EFFORTS.indexOf(base);
  if (index < 0) return "high";
  return OPENAI_REASONING_EFFORTS[Math.min(index + 1, OPENAI_REASONING_EFFORTS.length - 1)]!;
}

export function twoPassPipelineEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}
