export type RunTimingStage = {
  stage: "inventory" | "verify" | "verify_escalated";
  status: "processing" | "succeeded" | "failed";
  reasoningEffort?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  cachedTokens?: number;
  attempt?: number;
};

export type RunTimingInput = {
  status: string;
  createdAt?: string;
  queuedAt?: string;
  firstQueuedAt?: string;
  currentQueuedAt?: string;
  startedAt?: string;
  firstStartedAt?: string;
  currentStartedAt?: string;
  finishedAt?: string;
  processingAttemptNo?: number;
  dispatchAttemptNo?: number;
  stages: RunTimingStage[];
};

export const EXTRACTION_STAGE_STALE_AFTER_MS = 10 * 60_000;

/**
 * Poll quickly while a just-created Run is acquiring a worker, then back off
 * once model work has started. This keeps the UI responsive without turning a
 * long xhigh request into a stream of duplicate status reads.
 */
export function runPollDelayMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 2_000;
  if (elapsedMs < 15_000) return 2_000;
  if (elapsedMs < 120_000) return 5_000;
  return 10_000;
}

export function runNeedsRecovery(
  run: RunTimingInput,
  clockMs = Date.now(),
  staleAfterMs = EXTRACTION_STAGE_STALE_AFTER_MS,
): boolean {
  if (run.status !== "processing") return false;
  const currentStage = [...run.stages]
    .reverse()
    .find((stage) => stage.status === "processing");
  const startedAt = timestamp(currentStage?.startedAt ?? run.startedAt);
  return startedAt !== null && clockMs - startedAt >= staleAfterMs;
}

export type RunTimingItem = {
  key: "queue" | "current_queue" | "prepare" | "inventory" | "verify" | "verify_escalated" | "persist" | "analysis" | "review";
  label: string;
  status: "waiting" | "running" | "done" | "failed";
  durationMs: number | null;
  reasoningEffort?: string;
  cachedTokens?: number;
  attempt?: number;
};

function timestamp(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedDuration(start: number | null, end: number | null): number | null {
  return start === null || end === null ? null : Math.max(0, end - start);
}

function stageTiming(
  stage: RunTimingStage | undefined,
  key: RunTimingItem["key"],
  label: string,
  nowMs: number,
): RunTimingItem | null {
  if (!stage) return null;
  const start = timestamp(stage.startedAt);
  const end = timestamp(stage.finishedAt) ?? (stage.status === "processing" ? nowMs : null);
  return {
    key,
    label: stage.attempt && stage.attempt > 1 ? `${label} · 第 ${stage.attempt} 次` : label,
    status: stage.status === "processing" ? "running" : stage.status === "failed" ? "failed" : "done",
    durationMs: stage.durationMs ?? boundedDuration(start, end),
    reasoningEffort: stage.reasoningEffort,
    cachedTokens: stage.cachedTokens,
    attempt: stage.attempt,
  };
}

export function buildRunTimingItems(
  run: RunTimingInput,
  nowMs: number,
  options: { awaitingReview?: boolean } = {},
): RunTimingItem[] {
  const created = timestamp(run.createdAt);
  const queued = timestamp(run.firstQueuedAt) ?? timestamp(run.queuedAt) ?? created;
  const started = timestamp(run.firstStartedAt) ?? timestamp(run.startedAt);
  const currentQueued = timestamp(run.currentQueuedAt) ?? queued;
  const currentStarted = timestamp(run.currentStartedAt) ?? timestamp(run.startedAt);
  const finished = timestamp(run.finishedAt);
  const result: RunTimingItem[] = [];

  if (queued !== null) {
    const queueEnd = started ?? (run.status === "queued" ? nowMs : null);
    result.push({
      key: "queue",
      label: "排队等待",
      status: started !== null ? "done" : run.status === "queued" ? "running" : "waiting",
      durationMs: boundedDuration(queued, queueEnd),
      attempt: currentQueued !== null && currentQueued > queued ? 1 : run.dispatchAttemptNo,
    });
  }

  if (currentQueued !== null && queued !== null && currentQueued > queued) {
    const currentQueueEnd = currentStarted !== null && currentStarted >= currentQueued
      ? currentStarted
      : run.status === "queued" ? nowMs : null;
    result.push({
      key: "current_queue",
      label: "本轮重新排队",
      status: run.status === "queued" ? "running" : currentQueueEnd !== null ? "done" : "waiting",
      durationMs: boundedDuration(currentQueued, currentQueueEnd),
      attempt: run.dispatchAttemptNo,
    });
  }

  const orderedStages = ["inventory", "verify", "verify_escalated"] as const;
  const stages = new Map(run.stages.map((stage) => [stage.stage, stage]));
  const firstStageStart = orderedStages
    .map((name) => timestamp(stages.get(name)?.startedAt))
    .find((value): value is number => value !== null);
  const preparationStart = currentStarted ?? started;
  if (preparationStart !== null && (run.stages.length > 0 || !finished)) {
    const prepareEnd = firstStageStart ?? (run.status === "processing" ? nowMs : finished);
    result.push({
      key: "prepare",
      label: "准备材料与上下文",
      status: firstStageStart ? "done" : run.status === "processing" ? "running" : "done",
      durationMs: boundedDuration(preparationStart, prepareEnd),
      attempt: run.processingAttemptNo,
    });
  }

  const inventory = stageTiming(stages.get("inventory"), "inventory", "识别事实", nowMs);
  const verify = stageTiming(stages.get("verify"), "verify", "查漏纠错", nowMs);
  const escalated = stageTiming(stages.get("verify_escalated"), "verify_escalated", "加强复核", nowMs);
  if (inventory) result.push(inventory);
  if (verify) result.push(verify);
  if (escalated) result.push(escalated);

  if (!run.stages.length && started !== null) {
    result.push({
      key: "analysis",
      label: "模型分析",
      status: run.status === "processing" ? "running" : run.status === "failed" ? "failed" : "done",
      durationMs: boundedDuration(started, finished ?? (run.status === "processing" ? nowMs : null)),
    });
  }

  const lastStageEnd = [...run.stages]
    .map((stage) => timestamp(stage.finishedAt))
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  if (lastStageEnd !== null) {
    result.push({
      key: "persist",
      label: "验证并保存结果",
      status: finished === null && run.status === "processing" ? "running" : "done",
      durationMs: boundedDuration(lastStageEnd, finished ?? (run.status === "processing" ? nowMs : null)),
    });
  }

  if (options.awaitingReview && finished !== null) {
    result.push({
      key: "review",
      label: "等待人工核对",
      status: "running",
      durationMs: Math.max(0, nowMs - finished),
    });
  }
  return result;
}

export function runTotalDurationMs(run: RunTimingInput, nowMs: number): number | null {
  const start = timestamp(run.createdAt) ?? timestamp(run.queuedAt) ?? timestamp(run.startedAt);
  const end = timestamp(run.finishedAt) ?? (run.status === "queued" || run.status === "processing" ? nowMs : null);
  return boundedDuration(start, end);
}
