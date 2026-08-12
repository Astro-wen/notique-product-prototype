export type GuidedDisplayStatusKey =
  | "waiting_material"
  | "transcribing"
  | "ready"
  | "inventory"
  | "verify"
  | "verify_escalated"
  | "waiting_scenario"
  | "waiting_review"
  | "complete"
  | "action_required";

export type GuidedDisplayStatus = {
  key: GuidedDisplayStatusKey;
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "active";
};

const runningStatuses = new Set(["queued", "processing", "extracting"]);
const successfulStatuses = new Set(["succeeded", "completed", "completed_with_warnings"]);
const failedStatuses = new Set(["failed", "cancelled"]);

export function deriveGuidedDisplayStatus(input: {
  assetCount: number;
  analyzableAssetCount: number;
  transcriptionStatus?: string;
  runStatus?: string;
  pipelineStage?: "inventory" | "verify" | "verify_escalated";
  needsScenarioConfirmation?: boolean;
  pendingCount: number;
}): GuidedDisplayStatus {
  const transcriptionStatus = input.transcriptionStatus?.toLowerCase();
  const runStatus = input.runStatus?.toLowerCase();

  if (transcriptionStatus && runningStatuses.has(transcriptionStatus)) {
    return { key: "transcribing", label: "正在转写", tone: "active" };
  }
  if (runStatus && failedStatuses.has(runStatus)) {
    return { key: "action_required", label: "需要处理", tone: "danger" };
  }
  if (runStatus && runningStatuses.has(runStatus)) {
    if (input.pipelineStage === "verify_escalated") {
      return { key: "verify_escalated", label: "需要加强复核", tone: "warning" };
    }
    if (input.pipelineStage === "verify") {
      return { key: "verify", label: "正在查漏纠错", tone: "active" };
    }
    return { key: "inventory", label: "正在识别事实", tone: "active" };
  }
  if (runStatus && successfulStatuses.has(runStatus)) {
    if (input.needsScenarioConfirmation) {
      return { key: "waiting_scenario", label: "等待场景确认", tone: "warning" };
    }
    if (input.pendingCount > 0) {
      return { key: "waiting_review", label: "等待人工核对", tone: "warning" };
    }
    return { key: "complete", label: "已完成", tone: "success" };
  }
  if (input.pendingCount > 0) {
    return { key: "waiting_review", label: "等待人工核对", tone: "warning" };
  }
  if (transcriptionStatus && failedStatuses.has(transcriptionStatus)) {
    return { key: "action_required", label: "需要处理", tone: "danger" };
  }
  if (input.analyzableAssetCount > 0) {
    return { key: "ready", label: "可以分析", tone: "success" };
  }
  return {
    key: "waiting_material",
    label: input.assetCount > 0 ? "等待材料准备" : "等待材料",
    tone: "neutral",
  };
}

export function nextPendingClaimId(
  claims: Array<{ id: string; reviewStatus: string }>,
  currentClaimId: string,
): string | null {
  const currentIndex = claims.findIndex((claim) => claim.id === currentClaimId);
  const ordered = currentIndex < 0
    ? claims
    : [...claims.slice(currentIndex + 1), ...claims.slice(0, currentIndex)];
  return ordered.find((claim) => claim.reviewStatus === "pending")?.id ?? null;
}

export function chooseRememberedSelection<T extends { id: string }>(
  items: T[],
  rememberedId?: string | null,
): T | null {
  return items.find((item) => item.id === rememberedId) ?? items[0] ?? null;
}
