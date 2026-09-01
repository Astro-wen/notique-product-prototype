export type ReadingAidTarget = "summary" | "readable" | "raw";

const extractionInProgress = new Set(["queued", "processing", "extracting"]);
const extractionComplete = new Set([
  "succeeded",
  "completed",
  "completed_with_warnings",
]);

export function preferredReadingAid(input: {
  rawAvailable?: boolean;
  summaryStatus: string | null;
  readableTranscriptStatus: string | null;
  extractionStatus: string | null;
}): ReadingAidTarget | null {
  // While work is in flight the source transcript is the first useful result
  // and must never be delayed. Once the readable pass has succeeded, reading
  // starts there: on a real recording the raw text arrives without punctuation
  // and full of fillers, and raw stays one click away as the evidence view.
  if (input.readableTranscriptStatus === "succeeded") return "readable";
  if (input.rawAvailable === true) return "raw";
  if (input.summaryStatus === "succeeded") return "summary";
  if (input.rawAvailable === false) return null;
  if (
    extractionComplete.has(input.extractionStatus ?? "")
    && input.summaryStatus == null
    && input.readableTranscriptStatus == null
  ) return "raw";
  return null;
}

export function shouldAutoFocusReadingAid(input: {
  target: ReadingAidTarget | null;
  activeWorkspaceTab: "materials" | "transcript" | "review" | "results";
  userNavigated: boolean;
  alreadyFocused: boolean;
  materialInteractionActive: boolean;
}): boolean {
  return input.target === "raw"
    && input.activeWorkspaceTab === "materials"
    && !input.materialInteractionActive
    && !input.userNavigated
    && !input.alreadyFocused;
}

/** @deprecated Summary completion must never trigger automatic navigation. */
export function shouldAutoFocusSummary(input: {
  summaryStatus: string | null;
  extractionStatus: string | null;
  activeWorkspaceTab: "materials" | "transcript" | "review" | "results";
  userNavigated: boolean;
  alreadyFocused: boolean;
  materialInteractionActive: boolean;
}): boolean {
  return shouldAutoFocusReadingAid({
    target: input.summaryStatus === "succeeded" ? "summary" : null,
    activeWorkspaceTab: input.activeWorkspaceTab,
    userNavigated: input.userNavigated,
    alreadyFocused: input.alreadyFocused,
    materialInteractionActive: input.materialInteractionActive,
  });
}

export function factsStillRunning(extractionStatus: string | null): boolean {
  return extractionInProgress.has(extractionStatus ?? "");
}

export function factsReadyForReview(input: {
  extractionStatus: string | null;
  pendingCount: number;
  needsScenarioConfirmation: boolean;
}): boolean {
  return extractionComplete.has(input.extractionStatus ?? "")
    && input.pendingCount > 0
    && !input.needsScenarioConfirmation;
}

export function matchingSummarySourceIndexes(
  summarySegmentIds: readonly string[],
  candidateSegmentIds: readonly (readonly string[])[],
): number[] {
  const sourceIds = new Set(summarySegmentIds);
  if (sourceIds.size === 0) return [];
  return candidateSegmentIds.flatMap((segmentIds, index) =>
    segmentIds.some((id) => sourceIds.has(id)) ? [index] : []
  );
}
