export type AutoAnalysisGateInput = {
  baseRunId?: string;
  extractionFingerprint?: string;
  currentFingerprint: string;
  latestRunId?: string;
  latestRunLoaded: boolean;
  latestRunInProgress: boolean;
  waitingForAudio: boolean;
  currentEventTranscriptionRunning: boolean;
  hasAnalyzableAssets: boolean;
};

export type AutoAnalysisDecision = "wait" | "clear" | "start";

export function autoAnalysisDecision(input: AutoAnalysisGateInput): AutoAnalysisDecision {
  if (
    input.waitingForAudio
    || input.currentEventTranscriptionRunning
    || !input.hasAnalyzableAssets
  ) return "wait";

  if (input.latestRunId && !input.latestRunLoaded) return "wait";

  if (input.latestRunId && input.latestRunId !== input.baseRunId) {
    // The same material manifest already produced a newer Run. This covers a
    // committed POST whose response was lost before the browser cleared its
    // session intent, regardless of whether that Run is active or terminal.
    if (input.extractionFingerprint === input.currentFingerprint) return "clear";
    // New material arrived while another Run was active. Wait for the old Run
    // rather than colliding with the workspace concurrency guard.
    if (input.latestRunInProgress) return "wait";
  } else if (input.latestRunInProgress) {
    return "wait";
  }

  return "start";
}
