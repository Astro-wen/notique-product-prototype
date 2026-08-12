export type RunTimingStage = {
  stage: "inventory" | "verify" | "verify_escalated";
  status: "processing" | "succeeded" | "failed";
  reasoningEffort?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  cachedTokens?: number;
};

export type RunTimingInput = {
  status: string;
  createdAt?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  stages: RunTimingStage[];
};

export type RunTimingItem = {
  key: "queue" | "prepare" | "inventory" | "verify" | "verify_escalated" | "persist" | "analysis" | "review";
  label: string;
  status: "waiting" | "running" | "done" | "failed";
  durationMs: number | null;
  reasoningEffort?: string;
  cachedTokens?: number;
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
    label,
    status: stage.status === "processing" ? "running" : stage.status === "failed" ? "failed" : "done",
    durationMs: stage.durationMs ?? boundedDuration(start, end),
    reasoningEffort: stage.reasoningEffort,
    cachedTokens: stage.cachedTokens,
  };
}

export function buildRunTimingItems(
  run: RunTimingInput,
  nowMs: number,
  options: { awaitingReview?: boolean } = {},
): RunTimingItem[] {
  const created = timestamp(run.createdAt);
  const queued = timestamp(run.queuedAt) ?? created;
  const started = timestamp(run.startedAt);
  const finished = timestamp(run.finishedAt);
  const result: RunTimingItem[] = [];

  if (queued !== null) {
    const queueEnd = started ?? (run.status === "queued" ? nowMs : null);
    result.push({
      key: "queue",
      label: "排队等待",
      status: run.status === "queued" ? "running" : started !== null ? "done" : "waiting",
      durationMs: boundedDuration(queued, queueEnd),
    });
  }

  const orderedStages = ["inventory", "verify", "verify_escalated"] as const;
  const stages = new Map(run.stages.map((stage) => [stage.stage, stage]));
  const firstStageStart = orderedStages
    .map((name) => timestamp(stages.get(name)?.startedAt))
    .find((value): value is number => value !== null);
  if (started !== null && (run.stages.length > 0 || !finished)) {
    const prepareEnd = firstStageStart ?? (run.status === "processing" ? nowMs : finished);
    result.push({
      key: "prepare",
      label: "准备材料与上下文",
      status: firstStageStart ? "done" : run.status === "processing" ? "running" : "done",
      durationMs: boundedDuration(started, prepareEnd),
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
