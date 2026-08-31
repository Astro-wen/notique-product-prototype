export type AutoAnalysisGateInput = {
  baseRunId?: string;
  extractionFingerprint?: string;
  currentFingerprint: string;
  currentAssetVersionIds: string[];
  intentIdempotencyKey?: string;
  latestRunId?: string;
  latestRunIdempotencyKey?: string;
  latestRunAssetVersionIds?: string[];
  latestRunLoaded: boolean;
  latestRunInProgress: boolean;
  waitingForAudio: boolean;
  currentEventTranscriptionRunning: boolean;
  hasAnalyzableAssets: boolean;
};

export type AutoAnalysisDecision = "wait" | "clear" | "start";

function sameVersionSet(left: string[] | undefined, right: string[]): boolean {
  if (!left?.length || left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

export function autoAnalysisDecision(input: AutoAnalysisGateInput): AutoAnalysisDecision {
  if (
    input.waitingForAudio
    || input.currentEventTranscriptionRunning
    || !input.hasAnalyzableAssets
  ) return "wait";

  if (input.latestRunId && !input.latestRunLoaded) return "wait";

  if (input.latestRunId && input.latestRunId !== input.baseRunId) {
    // Clear only when the newer Run can be tied to this exact request or its
    // exact source-version manifest. A newer Run from another tab/device must
    // not silently consume an intent for material it did not include.
    const ownResponseLost = Boolean(
      input.intentIdempotencyKey
      && input.latestRunIdempotencyKey
      && input.intentIdempotencyKey === input.latestRunIdempotencyKey
      && input.extractionFingerprint === input.currentFingerprint,
    );
    const manifestAlreadyCovered = sameVersionSet(
      input.latestRunAssetVersionIds,
      input.currentAssetVersionIds,
    );
    if (ownResponseLost || manifestAlreadyCovered) return "clear";
    // New material arrived while another Run was active. Wait for the old Run
    // rather than colliding with the workspace concurrency guard.
    if (input.latestRunInProgress) return "wait";
  } else if (input.latestRunInProgress) {
    return "wait";
  }

  return "start";
}
