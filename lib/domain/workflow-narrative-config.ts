type NarrativeRuntime = {
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_API_BASE_URL?: string;
  AI_MAX_OUTPUT_TOKENS?: string;
};

/** New formatter checkpoints format already extracted facts under a separate
 * reasoning budget. Existing checkpoints retain their stored configuration. */
export function workflowNarrativeModelConfig(bindings: NarrativeRuntime) {
  return {
    provider: bindings.AI_PROVIDER?.trim() ?? '',
    model: bindings.AI_MODEL?.trim() ?? '',
    reasoningEffort: 'low' as const,
    baseUrl: bindings.AI_API_BASE_URL?.trim() || (bindings.AI_PROVIDER === 'openai' ? 'https://api.openai.com/v1' : bindings.AI_PROVIDER === 'deepseek' ? 'https://api.deepseek.com/v1' : ''),
    maxOutputTokens: Math.min(6000, Number(bindings.AI_MAX_OUTPUT_TOKENS) || 6000),
  };
}
