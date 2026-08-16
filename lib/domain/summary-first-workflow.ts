export type ReadingAidTarget = "summary" | "readable" | "raw";

const extractionInProgress = new Set(["queued", "processing", "extracting"]);
const extractionComplete = new Set([
  "succeeded",
  "completed",
  "completed_with_warnings",
]);

export function preferredReadingAid(input: {
  summaryStatus: string | null;
  readableTranscriptStatus: string | null;
  extractionStatus: string | null;
}): ReadingAidTarget | null {
  if (input.summaryStatus === "succeeded") return "summary";
  if (input.readableTranscriptStatus === "succeeded") return "readable";
  if (
    extractionComplete.has(input.extractionStatus ?? "")
    && input.summaryStatus == null
    && input.readableTranscriptStatus == null
  ) return "raw";
  return null;
}

export function shouldAutoFocusSummary(input: {
  summaryStatus: string | null;
  extractionStatus: string | null;
  activeWorkspaceTab: "materials" | "transcript" | "review" | "results";
  userNavigated: boolean;
  alreadyFocused: boolean;
  materialInteractionActive: boolean;
}): boolean {
  return input.summaryStatus === "succeeded"
    && (
      extractionInProgress.has(input.extractionStatus ?? "")
      || extractionComplete.has(input.extractionStatus ?? "")
    )
    && input.activeWorkspaceTab === "materials"
    && !input.materialInteractionActive
    && !input.userNavigated
    && !input.alreadyFocused;
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
