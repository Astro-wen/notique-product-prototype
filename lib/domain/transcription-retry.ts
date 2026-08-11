export const TRANSCRIPTION_MAX_ATTEMPTS = 3;

export type TranscriptionFailureClassification = {
  code: string;
  retryable: boolean;
};

export type TranscriptionRetryState = {
  runStatus: "queued" | "failed";
  outboxStatus: "failed";
  exhausted: boolean;
};

export type TranscriptionRetryDecision = TranscriptionRetryState & {
  runId: string;
  outboxId: string;
  errorCode: string;
};

export function classifyTranscriptionHttpFailure(
  status: number,
): TranscriptionFailureClassification {
  if (status === 408) {
    return { code: "TRANSCRIPTION_TIMEOUT", retryable: true };
  }
  if (status === 429) {
    return { code: "TRANSCRIPTION_RATE_LIMITED", retryable: true };
  }
  if (status >= 500 && status <= 599) {
    return { code: "TRANSCRIPTION_PROVIDER_UNAVAILABLE", retryable: true };
  }
  return { code: "AUDIO_TRANSCRIPTION_FAILED", retryable: false };
}

export function classifyTranscriptionTransportFailure(
  timedOut: boolean,
): TranscriptionFailureClassification {
  return timedOut
    ? { code: "TRANSCRIPTION_TIMEOUT", retryable: true }
    : { code: "TRANSCRIPTION_NETWORK_ERROR", retryable: true };
}

export function transcriptionRetryState(input: {
  retryable: boolean;
  outboxAttempt: number;
  maxAttempts?: number;
}): TranscriptionRetryState {
  const maxAttempts = Math.max(1, input.maxAttempts ?? TRANSCRIPTION_MAX_ATTEMPTS);
  const exhausted = !input.retryable || input.outboxAttempt >= maxAttempts;
  return {
    runStatus: exhausted ? "failed" : "queued",
    outboxStatus: "failed",
    exhausted,
  };
}

export function transcriptionRetryDecision(input: {
  runId: string;
  outboxId: string;
  errorCode: string;
  outboxAttempt: number;
  maxAttempts?: number;
}): TranscriptionRetryDecision {
  return {
    runId: input.runId,
    outboxId: input.outboxId,
    errorCode: input.errorCode,
    ...transcriptionRetryState({
      retryable: true,
      outboxAttempt: input.outboxAttempt,
      maxAttempts: input.maxAttempts,
    }),
  };
}

export async function loadOrStageTranscriptionResult<ProviderResult, StagedResult>(input: {
  stagedResultAvailable: boolean;
  loadStagedResult: () => Promise<StagedResult>;
  callProvider: () => Promise<ProviderResult>;
  stageProviderResult: (providerResult: ProviderResult) => Promise<StagedResult>;
}): Promise<StagedResult> {
  if (input.stagedResultAvailable) return input.loadStagedResult();
  const providerResult = await input.callProvider();
  return input.stageProviderResult(providerResult);
}
