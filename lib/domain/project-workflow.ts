export type ProjectWorkflowEvent = {
  id: string;
  title: string;
  occurredAt?: string;
  createdAt?: string;
  hasMaterial: boolean;
  ready: boolean;
  runId?: string;
  runStatus?: string;
  candidateCount?: number;
  pendingCount: number;
};

export type ProjectWorkflowPhase =
  | "empty"
  | "waiting_material"
  | "ready"
  | "running"
  | "empty_output"
  | "waiting_scenario"
  | "waiting_review"
  | "draft_ready"
  | "partially_reviewed"
  | "complete";

export type ProjectTrustState = "draft_ready" | "partially_reviewed" | "trusted";

export type ProjectWorkflowPlan = {
  phase: ProjectWorkflowPhase;
  total: number;
  completed: number;
  currentPosition: number;
  currentEventId?: string;
  currentEventTitle?: string;
  currentRunId?: string;
  ignoredEmptyCount: number;
  pendingTotal: number;
  trustState: ProjectTrustState;
};

export type ProjectWorkflowDisplayStatus =
  | "waiting_material"
  | "transcribing"
  | "ready"
  | "queued"
  | "inventory"
  | "verify"
  | "verify_escalated"
  | "waiting_scenario"
  | "waiting_review"
  | "complete"
  | "needs_attention";

export function deriveProjectWorkflowDisplayStatus(input: {
  materialStatus: string;
  materialTotal: number;
  materialProcessing: number;
  materialFailed: number;
  transcriptionStatus: string | null;
  extractionStatus: string | null;
  extractionStage: "inventory" | "verify" | "verify_escalated" | null;
  scenarioStatus: string;
  pendingCount: number;
  candidateCount: number;
}): ProjectWorkflowDisplayStatus {
  if (
    input.materialFailed > 0 ||
    input.transcriptionStatus === "failed" ||
    input.extractionStatus === "failed" ||
    input.extractionStatus === "cancelled"
  ) return "needs_attention";
  if (
    input.transcriptionStatus === "queued" ||
    input.transcriptionStatus === "processing"
  ) return "transcribing";
  if (
    input.materialTotal === 0 ||
    input.materialStatus !== "ready" ||
    input.materialProcessing > 0
  ) return "waiting_material";
  if (!input.extractionStatus) return "ready";
  if (input.extractionStatus === "queued") return "queued";
  if (input.extractionStatus === "processing") {
    return input.extractionStage ?? "inventory";
  }
  if (
    input.extractionStatus === "succeeded" ||
    input.extractionStatus === "completed_with_warnings"
  ) {
    if (input.candidateCount === 0) return "needs_attention";
    if (input.scenarioStatus === "pending_confirmation") return "waiting_scenario";
    if (input.pendingCount > 0) return "waiting_review";
    return "complete";
  }
  return "needs_attention";
}

const successfulRunStatuses = new Set([
  "succeeded",
  "completed",
  "completed_with_warnings",
]);

const runningRunStatuses = new Set(["queued", "processing", "extracting"]);

export function sortProjectWorkflowEvents(
  events: ProjectWorkflowEvent[],
): ProjectWorkflowEvent[] {
  // listEvents is the ordering authority (sequence_no ASC). Preserve it so
  // backfilled records and equal timestamps cannot change conversation order.
  return [...events];
}

export function projectNeedsScenarioConfirmation(input: {
  scenarioStatus?: string;
  scenarioCandidateCount: number;
}): boolean {
  return input.scenarioStatus === "pending_confirmation" || (
    input.scenarioCandidateCount > 0 && input.scenarioStatus !== "confirmed"
  );
}

export function planProjectWorkflow(input: {
  events: ProjectWorkflowEvent[];
  needsScenarioConfirmation: boolean;
}): ProjectWorkflowPlan {
  const ordered = sortProjectWorkflowEvents(input.events);
  const included = ordered.filter((event) => event.hasMaterial || Boolean(event.runId));
  const ignoredEmptyCount = ordered.length - included.length;
  const total = included.length;
  let completed = 0;
  let pendingTotal = 0;
  let reviewedCandidateCount = 0;

  for (const current of included) {
    const currentPosition = completed + 1;
    const base = {
      total,
      completed,
      currentPosition,
      currentEventId: current.id,
      currentEventTitle: current.title,
      currentRunId: current.runId,
      ignoredEmptyCount,
      pendingTotal,
      trustState: (pendingTotal > 0
        ? reviewedCandidateCount > 0 ? "partially_reviewed" : "draft_ready"
        : "trusted") as ProjectTrustState,
    };
    const runStatus = current.runStatus?.toLowerCase();
    if (runStatus && successfulRunStatuses.has(runStatus)) {
      if (!current.candidateCount) {
        return { ...base, phase: "empty_output" };
      }
      if (input.needsScenarioConfirmation) {
        return { ...base, phase: "waiting_scenario" };
      }
      pendingTotal += current.pendingCount;
      reviewedCandidateCount += Math.max(0, (current.candidateCount ?? 0) - current.pendingCount);
      completed += 1;
      continue;
    }
    if (!current.ready) {
      return { ...base, phase: "waiting_material" };
    }
    if (runStatus && runningRunStatuses.has(runStatus)) {
      return { ...base, phase: "running" };
    }
    return { ...base, phase: "ready" };
  }

  if (total === 0) {
    return {
      phase: "empty",
      total: 0,
      completed: 0,
      currentPosition: 0,
      ignoredEmptyCount,
      pendingTotal: 0,
      trustState: "trusted",
    };
  }
  if (pendingTotal > 0) {
    const trustState: ProjectTrustState = reviewedCandidateCount > 0
      ? "partially_reviewed"
      : "draft_ready";
    return {
      phase: trustState,
      total,
      completed: total,
      currentPosition: total,
      ignoredEmptyCount,
      pendingTotal,
      trustState,
    };
  }
  return {
    phase: "complete",
    total,
    completed: total,
    currentPosition: total,
    ignoredEmptyCount,
    pendingTotal: 0,
    trustState: "trusted",
  };
}
