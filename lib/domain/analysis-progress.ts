export type AnalysisModelStage = {
  stage: "inventory" | "verify" | "verify_escalated";
  status: "processing" | "succeeded" | "failed";
  attempt?: number;
};

export type AnalysisProgressNodeStatus = "completed" | "processing" | "waiting" | "failed";

export type AnalysisProgressNode = {
  key: "prepare" | "inventory" | "verify" | "persist";
  label: string;
  status: AnalysisProgressNodeStatus;
};

export type AnalysisProgress = {
  completed: number;
  total: number;
  percent: number;
  remaining: number;
  nodes: AnalysisProgressNode[];
};

const terminalSuccess = new Set(["succeeded", "completed", "completed_with_warnings"]);
const terminalFailure = new Set(["failed", "cancelled"]);

function latestStage(
  stages: AnalysisModelStage[],
  name: AnalysisModelStage["stage"],
): AnalysisModelStage | undefined {
  return stages
    .filter((stage) => stage.stage === name)
    .sort((left, right) => (right.attempt ?? 0) - (left.attempt ?? 0))[0];
}

function statusForStage(
  stage: AnalysisModelStage | undefined,
  active: boolean,
  runFailed: boolean,
): AnalysisProgressNodeStatus {
  if (stage?.status === "succeeded") return "completed";
  if (stage?.status === "processing" || active) return "processing";
  if (stage?.status === "failed" && runFailed) return "failed";
  return "waiting";
}

/**
 * Builds a deliberately coarse progress view from durable Run/Stage state.
 * Active work does not earn partial credit: the percentage only advances when
 * a real checkpoint has completed.
 */
export function buildAnalysisProgress(input: {
  runStatus: string;
  pipelineStage?: AnalysisModelStage["stage"];
  stages: AnalysisModelStage[];
}): AnalysisProgress {
  const runSucceeded = terminalSuccess.has(input.runStatus);
  const runFailed = terminalFailure.has(input.runStatus);
  const runStarted = input.runStatus === "processing" || runSucceeded || runFailed;
  const inventory = latestStage(input.stages, "inventory");
  const verify = latestStage(input.stages, "verify");
  const escalated = latestStage(input.stages, "verify_escalated");
  const hasModelStage = Boolean(inventory || verify || escalated || input.pipelineStage);

  const prepareStatus: AnalysisProgressNodeStatus = runSucceeded || hasModelStage
    ? "completed"
    : runFailed
      ? "failed"
      : runStarted || input.runStatus === "queued"
        ? "processing"
        : "waiting";

  const inventoryStatus = runSucceeded
    ? "completed"
    : statusForStage(inventory, input.pipelineStage === "inventory" && input.runStatus === "processing", runFailed);

  let verifyStatus: AnalysisProgressNodeStatus;
  if (runSucceeded) {
    verifyStatus = "completed";
  } else if (escalated?.status === "processing" || input.pipelineStage === "verify_escalated") {
    verifyStatus = "processing";
  } else if (escalated?.status === "succeeded" || verify?.status === "succeeded") {
    verifyStatus = "completed";
  } else if (verify?.status === "failed" && runFailed) {
    verifyStatus = "failed";
  } else if (verify?.status === "processing" || input.pipelineStage === "verify") {
    verifyStatus = "processing";
  } else {
    verifyStatus = "waiting";
  }

  const verificationFinished = verifyStatus === "completed";
  const persistStatus: AnalysisProgressNodeStatus = runSucceeded
    ? "completed"
    : runFailed
      ? "failed"
      : input.runStatus === "processing" && verificationFinished
        ? "processing"
        : "waiting";

  const nodes: AnalysisProgressNode[] = [
    { key: "prepare", label: "准备材料", status: prepareStatus },
    { key: "inventory", label: "识别事实", status: inventoryStatus },
    { key: "verify", label: "查漏复核", status: verifyStatus },
    { key: "persist", label: "草稿可核对", status: persistStatus },
  ];
  const completed = nodes.filter((node) => node.status === "completed").length;
  const total = nodes.length;
  return {
    completed,
    total,
    percent: Math.floor((completed / total) * 100),
    remaining: total - completed,
    nodes,
  };
}
