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
  | "complete";

export type ProjectWorkflowPlan = {
  phase: ProjectWorkflowPhase;
  total: number;
  completed: number;
  currentPosition: number;
  currentEventId?: string;
  currentEventTitle?: string;
  currentRunId?: string;
  ignoredEmptyCount: number;
};

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
    };
    const runStatus = current.runStatus?.toLowerCase();
    if (runStatus && successfulRunStatuses.has(runStatus)) {
      if (!current.candidateCount) {
        return { ...base, phase: "empty_output" };
      }
      if (input.needsScenarioConfirmation) {
        return { ...base, phase: "waiting_scenario" };
      }
      if (current.pendingCount > 0) {
        return { ...base, phase: "waiting_review" };
      }
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
    };
  }
  return {
    phase: "complete",
    total,
    completed: total,
    currentPosition: total,
    ignoredEmptyCount,
  };
}
