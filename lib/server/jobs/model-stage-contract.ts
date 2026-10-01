export type ModelStageFrozenInput = {
  provider: string;
  model: string;
  reasoningEffort: string;
  promptVersion: string;
  schemaVersion: string;
  inputHash: string;
};

export type PersistedModelStageContract = {
  status: string;
  provider: string;
  model: string;
  reasoning_effort: string;
  prompt_version: string;
  schema_version: string;
  input_hash: string;
};

/**
 * A model-stage result belongs to the exact frozen input that paid for it.
 * Schema-valid output from another prompt, model, effort, or input projection
 * is not interchangeable, even when it lives under the same Run and stage.
 */
export function modelStageFrozenInputMatches(
  persisted: PersistedModelStageContract,
  expected: ModelStageFrozenInput,
): boolean {
  return persisted.provider === expected.provider
    && persisted.model === expected.model
    && persisted.reasoning_effort === expected.reasoningEffort
    && persisted.prompt_version === expected.promptVersion
    && persisted.schema_version === expected.schemaVersion
    && persisted.input_hash === expected.inputHash;
}

export function canReuseSucceededModelStage(
  persisted: PersistedModelStageContract,
  expected: ModelStageFrozenInput,
): boolean {
  return persisted.status === "succeeded"
    && modelStageFrozenInputMatches(persisted, expected);
}

export function canResumeProcessingModelStage(
  persisted: PersistedModelStageContract,
  expected: ModelStageFrozenInput,
): boolean {
  return persisted.status === "processing"
    && modelStageFrozenInputMatches(persisted, expected);
}

/** Reference or internal completion metadata repair can reread the same paid response. Unknown or stale
 * targets still fail normal context validation, without starting another POST. */
export function canRecoverFailedReferenceDecoding(
  persisted: PersistedModelStageContract & { provider_request_id?: string | null; error_code?: string | null; error_details?: unknown },
  expected: ModelStageFrozenInput,
): boolean {
  if (persisted.status !== 'failed' || persisted.error_code !== 'MODEL_OUTPUT_INVALID' || !persisted.provider_request_id ||
    !/^claim-extraction-prompt\.v9\.(?:9|10):verify(?:_escalated)?$/.test(persisted.prompt_version) || !modelStageFrozenInputMatches(persisted, expected)) return false;
  const details = persisted.error_details as { issues?: Array<{path?:string;message?:string}> } | null;
  return Boolean(Array.isArray(details?.issues) && details.issues.length && details.issues.every(issue =>
    issue && (/^\$\.claims\[\d+\]\.reaffirmed_target_version_id$/.test(issue.path ?? '') &&
    issue.message === 'Reaffirmed target must be the current active claim version in this Context Pack.' ||
    persisted.prompt_version.startsWith('claim-extraction-prompt.v9.10:') && /^\$\.claims\[\d+\]\.normalized_value$/.test(issue.path ?? '') &&
    issue.message === 'A reaffirmed occurrence must keep the target normalized value exactly; changed or additional facts require a new atomic claim.')));
}


/** Freeze validation guidance on the user-requested retry, including GET recovery. */
export function inventoryRetryFeedback(
  persisted: (PersistedModelStageContract & { error_code?: string | null; error_details?: unknown }) | null,
  expected: ModelStageFrozenInput,
): string[] {
  if (!persisted || !modelStageFrozenInputMatches(persisted, expected)) return [];
  const details = persisted.error_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const data = details as Record<string, unknown>;
  if (persisted.status === "processing") {
    return Array.isArray(data.retry_validation_feedback)
      ? data.retry_validation_feedback.filter((v): v is string => typeof v === "string").slice(0, 8).map(v => v.slice(0, 600))
      : [];
  }
  if (persisted.status !== "failed" || persisted.error_code !== "MODEL_OUTPUT_INVALID" || !Array.isArray(data.issues)) return [];
  return data.issues.slice(0, 8).flatMap(issue => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const { path, message } = issue as Record<string, unknown>;
    return typeof path === "string" && typeof message === "string"
      ? [`${path.slice(0, 200)}: ${message.slice(0, 380)}`] : [];
  });
}
