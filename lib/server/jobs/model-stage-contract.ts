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
