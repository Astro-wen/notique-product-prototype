export type ExtractionCoverageSummary = {
  omittedStatements: string[];
  inventoryLimitReached: boolean;
  finalClaimLimitReached: boolean;
  followUpOmitted: boolean;
};

/** Only source statements and fixed coverage flags are exposed to readers. */
export function extractionCoverageSummary(errorDetails: unknown): ExtractionCoverageSummary {
  const result: ExtractionCoverageSummary = {
    omittedStatements: [], inventoryLimitReached: false,
    finalClaimLimitReached: false, followUpOmitted: false,
  };
  if (!errorDetails || typeof errorDetails !== "object" || Array.isArray(errorDetails)) return result;
  const warnings = (errorDetails as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) return result;
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || result.omittedStatements.length >= 200) return;
    const statement = value.trim().slice(0, 8_000);
    if (!statement || seen.has(statement)) return;
    seen.add(statement);
    result.omittedStatements.push(statement);
  };
  for (const warning of warnings) {
    if (!warning || typeof warning !== "object" || Array.isArray(warning)) continue;
    const item = warning as Record<string, unknown>;
    const reached = typeof item.limit === "number" && Number.isSafeInteger(item.limit) && item.limit > 0 && typeof item.observed === "number" && Number.isSafeInteger(item.observed) && item.observed >= item.limit;
    if (item.code === "MODEL_INVENTORY_LIMIT_REACHED" && reached) result.inventoryLimitReached = true;
    if (item.code === "MODEL_FINAL_CLAIM_LIMIT_REACHED" && reached) result.finalClaimLimitReached = true;
    if (item.code === "MODEL_SUPPORTED_FOLLOWUP_OMITTED" && Array.isArray(item.inventory_keys) && item.inventory_keys.some(key => typeof key === "string" && key.trim())) result.followUpOmitted = true;
    if (item.code === "MODEL_CANDIDATE_OMITTED" || item.code === "CLAIM_WITHOUT_VALID_EVIDENCE") add(item.statement);
    if (item.code === "MODEL_QUALITY_GATE_UNRESOLVED" && Array.isArray(item.omitted_statements)) {
      for (const statement of item.omitted_statements) add(statement);
    }
  }
  return result;
}
