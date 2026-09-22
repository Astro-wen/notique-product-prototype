export const TRANSCRIPTION_MAX_ATTEMPTS = 3;

/**
 * 一次转写从排队起最多拖多久。
 *
 * 次数上限原来只在发件箱那一层判：要等下一次派发把发件箱行领起来，才发现三次
 * 都用完了。派发靠打开的页面唤醒，每次尝试又要等满供应商超时，实测一条注定
 * 失败的转写从开始到判死用了八十分钟，这段时间里界面一直转圈。处理器这一层
 * 在第三次失败时直接判死，另加一个时长上限，和阅读产物同一个口径。
 */
export const TRANSCRIPTION_MAX_AGE_MS = 30 * 60_000;

/**
 * 这次失败之后还值不值得再排一次队。attempt_no 在领取时已经加过一。
 *
 * 时长从 queued_at 算：创建时写一次，用户手动重试失败的块时重置一次，
 * 自动重排只改 current_queued_at。这样手动重试拿到一份新的额度，自动重排不会。
 */
export function transcriptionRetryExhausted(
  run: { attempt_no?: unknown; queued_at?: unknown; created_at?: unknown },
  timestamp: string,
): boolean {
  const attempts = Number(run.attempt_no);
  const since = Date.parse(String(run.queued_at ?? run.created_at));
  const age = Date.parse(timestamp) - since;
  return (Number.isFinite(attempts) && attempts >= TRANSCRIPTION_MAX_ATTEMPTS) ||
    (Number.isFinite(age) && age >= TRANSCRIPTION_MAX_AGE_MS);
}

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
