import type { ContextPack } from "./context-pack";
import type {
  ExtractClaimsOutput,
  ModelContractIssue,
  ModelEvidence,
  ModelProvider,
  ModelUsage,
} from "./model-contract";
// @ts-expect-error Node's native TypeScript runner requires the explicit extension;
// the application bundler resolves this same source module without emitting it.
import { CLAIM_EXTRACTION_SCHEMA_VERSION, MODEL_CONTRACT_LIMITS, validateExtractClaimsOutput } from "./model-contract.ts";
import type { ClaimType } from "./types";

export const TWO_STAGE_EXTRACTION_PROMPT_VERSION = "claim-extraction-prompt.v8.2" as const;
export const INVENTORY_SCHEMA_VERSION = "claim-inventory.v3" as const;
export const VERIFICATION_SCHEMA_VERSION = "claim-verification.v3" as const;

export const TWO_STAGE_EXTRACTION_LIMITS = {
  inventoryCandidates: 24,
  finalClaims: MODEL_CONTRACT_LIMITS.claims,
  dispositionReasonLength: MODEL_CONTRACT_LIMITS.explanationLength,
  qualityFlags: 24,
} as const;

export type InventoryCandidate = {
  inventory_key: string;
  type: ClaimType;
  statement: string;
  normalized_value: Record<string, unknown> | null;
  materiality: "high" | "medium" | "low";
  critical: boolean;
  critical_reason: string | null;
  confidence: number;
  atomicity: "atomic";
  evidence: ModelEvidence[];
};

export type InventoryOutput = {
  schema_version: typeof INVENTORY_SCHEMA_VERSION;
  event_id: string;
  candidates: InventoryCandidate[];
};

export type InventoryDispositionOutcome =
  | "included"
  | "merged"
  | "duplicate"
  | "unsupported"
  | "lower_priority";

export type InventoryDisposition = {
  inventory_key: string;
  outcome: InventoryDispositionOutcome;
  final_claim_keys: string[];
  reason: string;
};

export type VerificationOutput = {
  schema_version: typeof VERIFICATION_SCHEMA_VERSION;
  event_id: string;
  scenario_assessment: ExtractClaimsOutput["scenario_assessment"];
  claims: ExtractClaimsOutput["claims"];
  candidate_dispositions: InventoryDisposition[];
  quality_review: {
    unresolved_conflict_keys: string[];
    compound_claim_keys: string[];
    reaffirmed_issue_claim_keys: string[];
  };
};

export interface TwoStageModelProvider extends ModelProvider {
  inventoryClaims(input: ContextPack, options?: ModelStageRequestOptions): Promise<{
    output: InventoryOutput;
    usage: ModelUsage;
  }>;
  verifyClaims(
    input: ContextPack,
    inventory: InventoryOutput,
    options?: ModelStageRequestOptions,
  ): Promise<{
    output: VerificationOutput;
    usage: ModelUsage;
  }>;
}

export type ModelStageRequestOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
  promptCacheKey?: string;
  qualityFeedback?: string[];
};

export type FinalExtractClaimsOutput = Omit<ExtractClaimsOutput, "schema_version"> & {
  schema_version: typeof CLAIM_EXTRACTION_SCHEMA_VERSION;
};

export type ContractValidation<T> = {
  valid: boolean;
  issues: ModelContractIssue[];
  output: T | null;
};

export type VerificationEscalationReason =
  | "verification_contract_invalid"
  | "inventory_candidate_unmapped"
  | "critical_candidate_dropped"
  | "low_confidence_relation"
  | "unresolved_conflict"
  | "compound_claim"
  | "reaffirmed_issue";

export type VerificationEscalation = {
  required: boolean;
  reasons: VerificationEscalationReason[];
  unmappedInventoryKeys: string[];
  droppedCriticalInventoryKeys: string[];
  lowConfidenceRelationClaimKeys: string[];
};

export type VerificationSelection = {
  output: VerificationOutput;
  assessment: VerificationEscalation;
  selected: "base" | "candidate";
};

const INVENTORY_KEYS = [
  "inventory_key",
  "type",
  "statement",
  "normalized_value",
  "materiality",
  "critical",
  "critical_reason",
  "confidence",
  "atomicity",
  "evidence",
] as const;
const DISPOSITION_OUTCOMES = new Set<InventoryDispositionOutcome>([
  "included",
  "merged",
  "duplicate",
  "unsupported",
  "lower_priority",
]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: ModelContractIssue[],
) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) issues.push({ path: `${path}.${key}`, message: "Unexpected field." });
  }
  for (const key of expected) {
    if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "Missing required field." });
  }
}

function boundedString(value: unknown, path: string, issues: ModelContractIssue[], max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    issues.push({ path, message: `Expected a non-empty string with at most ${max} characters.` });
  }
}

function boundedUniqueStrings(
  value: unknown,
  path: string,
  issues: ModelContractIssue[],
  limit: number,
): string[] {
  if (!Array.isArray(value) || value.length > limit) {
    issues.push({ path, message: `Expected an array with at most ${limit} items.` });
    return [];
  }
  const strings: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.length > MODEL_CONTRACT_LIMITS.identifierLength) {
      issues.push({ path: `${path}[${index}]`, message: "Expected a bounded non-empty identifier." });
      return;
    }
    if (seen.has(item)) issues.push({ path: `${path}[${index}]`, message: "Duplicate identifier." });
    else {
      seen.add(item);
      strings.push(item);
    }
  });
  return strings;
}

function remapClaimIssues(issues: ModelContractIssue[], candidateIndex: number): ModelContractIssue[] {
  return issues
    .filter((issue) => !issue.path.startsWith("$.schema_version") && !issue.path.startsWith("$.event_id"))
    .map((issue) => ({
      ...issue,
      path: issue.path.replace("$.claims[0]", `$.candidates[${candidateIndex}]`),
    }));
}

export function validateInventoryOutput(value: unknown): ContractValidation<InventoryOutput> {
  const issues: ModelContractIssue[] = [];
  if (!record(value)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  exactKeys(value, ["schema_version", "event_id", "candidates"], "$", issues);
  if (value.schema_version !== INVENTORY_SCHEMA_VERSION) {
    issues.push({ path: "$.schema_version", message: "Unsupported inventory schema version." });
  }
  boundedString(value.event_id, "$.event_id", issues, MODEL_CONTRACT_LIMITS.identifierLength);
  if (!Array.isArray(value.candidates) || value.candidates.length > TWO_STAGE_EXTRACTION_LIMITS.inventoryCandidates) {
    issues.push({
      path: "$.candidates",
      message: `Candidates must be an array with at most ${TWO_STAGE_EXTRACTION_LIMITS.inventoryCandidates} items.`,
    });
  } else {
    const seenKeys = new Set<string>();
    value.candidates.forEach((candidate, index) => {
      const path = `$.candidates[${index}]`;
      if (!record(candidate)) {
        issues.push({ path, message: "Expected an object." });
        return;
      }
      exactKeys(candidate, INVENTORY_KEYS, path, issues);
      boundedString(candidate.inventory_key, `${path}.inventory_key`, issues, MODEL_CONTRACT_LIMITS.identifierLength);
      if (typeof candidate.inventory_key === "string") {
        if (seenKeys.has(candidate.inventory_key)) issues.push({ path: `${path}.inventory_key`, message: "Duplicate inventory key." });
        seenKeys.add(candidate.inventory_key);
      }
      if (candidate.atomicity !== "atomic") {
        issues.push({ path: `${path}.atomicity`, message: "Inventory candidates must assert one atomic fact." });
      }
      if (typeof candidate.critical !== "boolean") {
        issues.push({ path: `${path}.critical`, message: "Expected a boolean." });
      }
      if (candidate.critical === true) {
        boundedString(candidate.critical_reason, `${path}.critical_reason`, issues, MODEL_CONTRACT_LIMITS.explanationLength);
      } else if (candidate.critical_reason !== null) {
        issues.push({ path: `${path}.critical_reason`, message: "Non-critical candidates must use null." });
      }

      const claimValidation = validateExtractClaimsOutput({
        schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION,
        event_id: value.event_id,
        scenario_assessment: null,
        claims: [{
          client_claim_key: candidate.inventory_key,
          disposition: "new",
          reaffirmed_target_claim_id: null,
          reaffirmed_target_version_id: null,
          type: candidate.type,
          statement: candidate.statement,
          normalized_value: candidate.normalized_value,
          materiality: candidate.materiality,
          confidence: candidate.confidence,
          needs_additional_evidence: false,
          uncertainty: null,
          evidence: candidate.evidence,
          relations: [],
        }],
      });
      issues.push(...remapClaimIssues(claimValidation.issues, index));
    });
  }
  return { valid: issues.length === 0, issues, output: issues.length ? null : value as InventoryOutput };
}

export function validateVerificationOutput(
  value: unknown,
  inventory: InventoryOutput,
  context?: ContextPack,
): ContractValidation<VerificationOutput> {
  const issues: ModelContractIssue[] = [];
  if (!record(value)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  exactKeys(value, ["schema_version", "event_id", "scenario_assessment", "claims", "candidate_dispositions", "quality_review"], "$", issues);
  if (value.schema_version !== VERIFICATION_SCHEMA_VERSION) {
    issues.push({ path: "$.schema_version", message: "Unsupported verification schema version." });
  }
  if (value.event_id !== inventory.event_id) {
    issues.push({ path: "$.event_id", message: "Verification event must match the inventory event." });
  }

  const claimValidation = validateExtractClaimsOutput({
    schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION,
    event_id: value.event_id,
    scenario_assessment: value.scenario_assessment,
    claims: value.claims,
  }, context);
  issues.push(...claimValidation.issues.filter((issue) => !issue.path.startsWith("$.schema_version")));
  if (context?.project.scenario === null && value.scenario_assessment === null) {
    issues.push({ path: "$.scenario_assessment", message: "An unassessed project requires two or three scenario candidates." });
  }
  if (context?.project.scenario !== null && value.scenario_assessment !== null) {
    issues.push({ path: "$.scenario_assessment", message: "A project with a confirmed scenario must not be reassessed." });
  }
  const claims = Array.isArray(value.claims) ? value.claims : [];
  const finalKeys = new Set<string>();
  claims.forEach((claim, index) => {
    if (!record(claim) || typeof claim.client_claim_key !== "string") return;
    if (finalKeys.has(claim.client_claim_key)) {
      issues.push({ path: `$.claims[${index}].client_claim_key`, message: "Duplicate final claim key." });
    }
    finalKeys.add(claim.client_claim_key);
  });

  const inventoryKeys = new Set(inventory.candidates.map((candidate) => candidate.inventory_key));
  const mappedKeys = new Set<string>();
  if (!Array.isArray(value.candidate_dispositions)) {
    issues.push({
      path: "$.candidate_dispositions",
      message: "Expected at most one disposition for each inventory candidate.",
    });
  } else {
    if (value.candidate_dispositions.length > inventory.candidates.length) {
      issues.push({
        path: "$.candidate_dispositions",
        message: "Expected at most one disposition for each inventory candidate.",
      });
    }
    value.candidate_dispositions.forEach((disposition, index) => {
    const path = `$.candidate_dispositions[${index}]`;
    if (!record(disposition)) {
      issues.push({ path, message: "Expected an object." });
      return;
    }
    exactKeys(disposition, ["inventory_key", "outcome", "final_claim_keys", "reason"], path, issues);
    boundedString(disposition.inventory_key, `${path}.inventory_key`, issues, MODEL_CONTRACT_LIMITS.identifierLength);
    boundedString(disposition.reason, `${path}.reason`, issues, TWO_STAGE_EXTRACTION_LIMITS.dispositionReasonLength);
    if (!DISPOSITION_OUTCOMES.has(disposition.outcome as InventoryDispositionOutcome)) {
      issues.push({ path: `${path}.outcome`, message: "Unsupported inventory disposition." });
    }
    if (typeof disposition.inventory_key === "string") {
      if (!inventoryKeys.has(disposition.inventory_key)) issues.push({ path: `${path}.inventory_key`, message: "Unknown inventory key." });
      if (mappedKeys.has(disposition.inventory_key)) issues.push({ path: `${path}.inventory_key`, message: "Duplicate inventory disposition." });
      mappedKeys.add(disposition.inventory_key);
    }
    const references = boundedUniqueStrings(
      disposition.final_claim_keys,
      `${path}.final_claim_keys`,
      issues,
      TWO_STAGE_EXTRACTION_LIMITS.finalClaims,
    );
    references.forEach((key, refIndex) => {
      if (!finalKeys.has(key)) issues.push({ path: `${path}.final_claim_keys[${refIndex}]`, message: "Unknown final claim key." });
    });
    const retained = disposition.outcome === "included" || disposition.outcome === "merged";
    if (retained && references.length !== 1) {
      issues.push({ path: `${path}.final_claim_keys`, message: "Included or merged candidates must map to exactly one final claim." });
    }
    if (!retained && references.length !== 0) {
      issues.push({ path: `${path}.final_claim_keys`, message: "Dropped candidates cannot map to a final claim." });
    }
    });
  }
  inventory.candidates.forEach((candidate) => {
    if (!mappedKeys.has(candidate.inventory_key)) {
      issues.push({ path: "$.candidate_dispositions", message: `Missing disposition for inventory key ${candidate.inventory_key}.` });
    }
  });

  if (!record(value.quality_review)) {
    issues.push({ path: "$.quality_review", message: "Expected an object." });
  } else {
    exactKeys(value.quality_review, ["unresolved_conflict_keys", "compound_claim_keys", "reaffirmed_issue_claim_keys"], "$.quality_review", issues);
    boundedUniqueStrings(value.quality_review.unresolved_conflict_keys, "$.quality_review.unresolved_conflict_keys", issues, TWO_STAGE_EXTRACTION_LIMITS.qualityFlags);
    for (const field of ["compound_claim_keys", "reaffirmed_issue_claim_keys"] as const) {
      const refs = boundedUniqueStrings(value.quality_review[field], `$.quality_review.${field}`, issues, TWO_STAGE_EXTRACTION_LIMITS.finalClaims);
      refs.forEach((key, index) => {
        if (!finalKeys.has(key)) issues.push({ path: `$.quality_review.${field}[${index}]`, message: "Unknown final claim key." });
      });
    }
  }

  return { valid: issues.length === 0, issues, output: issues.length ? null : value as VerificationOutput };
}

export function toFinalExtractClaimsOutput(verification: VerificationOutput): FinalExtractClaimsOutput {
  return {
    schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION,
    event_id: verification.event_id,
    scenario_assessment: verification.scenario_assessment,
    claims: verification.claims,
  };
}

export function assessVerificationEscalation(
  inventory: InventoryOutput,
  verification: unknown,
  context?: ContextPack,
): VerificationEscalation {
  const validation = validateVerificationOutput(verification, inventory, context);
  const reasons = new Set<VerificationEscalationReason>();
  if (!validation.valid) reasons.add("verification_contract_invalid");

  const value = record(verification) ? verification : {};
  const dispositions = Array.isArray(value.candidate_dispositions) ? value.candidate_dispositions : [];
  const dispositionByKey = new Map<string, Record<string, unknown>>();
  dispositions.forEach((item) => {
    if (record(item) && typeof item.inventory_key === "string" && !dispositionByKey.has(item.inventory_key)) {
      dispositionByKey.set(item.inventory_key, item);
    }
  });
  const unmappedInventoryKeys = inventory.candidates
    .filter((candidate) => !dispositionByKey.has(candidate.inventory_key))
    .map((candidate) => candidate.inventory_key);
  if (unmappedInventoryKeys.length) reasons.add("inventory_candidate_unmapped");

  const droppedCriticalInventoryKeys = inventory.candidates
    .filter((candidate) => {
      const outcome = dispositionByKey.get(candidate.inventory_key)?.outcome;
      return candidate.critical && outcome !== "included" && outcome !== "merged";
    })
    .map((candidate) => candidate.inventory_key);
  if (droppedCriticalInventoryKeys.length) reasons.add("critical_candidate_dropped");

  const lowConfidenceRelationClaimKeys: string[] = [];
  if (Array.isArray(value.claims)) value.claims.forEach((claim) => {
    if (!record(claim) || typeof claim.client_claim_key !== "string" || !Array.isArray(claim.relations)) return;
    if (claim.relations.some((relation) => record(relation) && typeof relation.confidence === "number" && relation.confidence < 0.85)) {
      lowConfidenceRelationClaimKeys.push(claim.client_claim_key);
    }
  });
  if (lowConfidenceRelationClaimKeys.length) reasons.add("low_confidence_relation");

  if (record(value.quality_review)) {
    if (Array.isArray(value.quality_review.unresolved_conflict_keys) && value.quality_review.unresolved_conflict_keys.length) reasons.add("unresolved_conflict");
    if (Array.isArray(value.quality_review.compound_claim_keys) && value.quality_review.compound_claim_keys.length) reasons.add("compound_claim");
    if (Array.isArray(value.quality_review.reaffirmed_issue_claim_keys) && value.quality_review.reaffirmed_issue_claim_keys.length) reasons.add("reaffirmed_issue");
  }

  return {
    required: reasons.size > 0,
    reasons: [...reasons],
    unmappedInventoryKeys,
    droppedCriticalInventoryKeys,
    lowConfidenceRelationClaimKeys: [...new Set(lowConfidenceRelationClaimKeys)],
  };
}

function reviewIssueVector(
  output: VerificationOutput,
  assessment: VerificationEscalation,
): number[] {
  return [
    output.quality_review.compound_claim_keys.length +
      output.quality_review.reaffirmed_issue_claim_keys.length,
    assessment.unmappedInventoryKeys.length,
    assessment.lowConfidenceRelationClaimKeys.length,
    assessment.droppedCriticalInventoryKeys.length,
    output.quality_review.unresolved_conflict_keys.length,
  ];
}

export function selectPreferredVerificationForReview(
  inventory: InventoryOutput,
  base: VerificationOutput,
  candidate: VerificationOutput,
  context?: ContextPack,
): VerificationSelection {
  const baseAssessment = assessVerificationEscalation(inventory, base, context);
  const candidateAssessment = assessVerificationEscalation(inventory, candidate, context);
  const baseVector = reviewIssueVector(base, baseAssessment);
  const candidateVector = reviewIssueVector(candidate, candidateAssessment);
  let candidateIsBetter = false;
  for (let index = 0; index < candidateVector.length; index += 1) {
    if (candidateVector[index] === baseVector[index]) continue;
    candidateIsBetter = candidateVector[index] < baseVector[index];
    break;
  }

  return candidateIsBetter
    ? { output: candidate, assessment: candidateAssessment, selected: "candidate" }
    : { output: base, assessment: baseAssessment, selected: "base" };
}
