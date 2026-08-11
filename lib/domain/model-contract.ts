import type { ClaimType, EvidenceRole } from "./types";
import type { ContextPack } from "./context-pack";

export const CLAIM_EXTRACTION_SCHEMA_VERSION = "claim-extraction.v1" as const;
export const CLAIM_EXTRACTION_PROMPT_VERSION = "claim-extraction-prompt.v5" as const;

export const MODEL_CONTRACT_LIMITS = {
  claims: 10,
  evidencePerClaim: 20,
  relationsPerClaim: 20,
  segmentIdsPerEvidence: 20,
  alternativesPerUncertainty: 10,
  normalizedValueEntries: 50,
  identifierLength: 200,
  scenarioLength: 1_000,
  statementLength: 10_000,
  explanationLength: 4_000,
  alternativeLength: 2_000,
  normalizedValueJsonLength: 20_000,
} as const;

export type ModelEvidence =
  | {
      kind: "transcript" | "text";
      asset_version_id: string;
      segment_ids: string[];
      quote_hint: string;
      evidence_role: EvidenceRole;
    }
  | {
      kind: "photo";
      asset_version_id: string;
      observation: string;
      bbox_norm: [number, number, number, number] | null;
      evidence_role: EvidenceRole;
    }
  | {
      kind: "document";
      asset_version_id: string;
      page_number: number | null;
      quote_hint: string | null;
      observation: string;
      evidence_role: EvidenceRole;
    };

export type ExtractClaimsOutput = {
  schema_version: typeof CLAIM_EXTRACTION_SCHEMA_VERSION;
  event_id: string;
  scenario_assessment: {
    candidates: Array<{ scenario: string; confidence: number; reason: string }>;
  } | null;
  claims: Array<{
    client_claim_key: string;
    disposition: "new" | "reaffirmed" | "duplicate";
    reaffirmed_target_claim_id: string | null;
    reaffirmed_target_version_id: string | null;
    type: ClaimType;
    statement: string;
    normalized_value: Record<string, unknown> | null;
    materiality: "high" | "medium" | "low";
    confidence: number;
    needs_additional_evidence: boolean;
    uncertainty: {
      reason: string;
      alternatives: string[];
      question: string;
    } | null;
    evidence: ModelEvidence[];
    relations: Array<{
      type: "supersedes" | "contradicts" | "resolves" | "informed_by";
      target_claim_id: string;
      target_claim_version_id: string;
      reason: string;
      confidence: number;
    }>;
  }>;
};

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  providerRequestId: string | null;
};

export interface ModelProvider {
  readonly provider: string;
  readonly model: string;
  extractClaims(input: ContextPack, signal?: AbortSignal): Promise<{
    output: ExtractClaimsOutput;
    usage: ModelUsage;
  }>;
}

export class ModelProviderNotConfiguredError extends Error {
  readonly code = "MODEL_PROVIDER_NOT_CONFIGURED";

  constructor() {
    super("No AI model provider is configured on the server.");
    this.name = "ModelProviderNotConfiguredError";
  }
}

export class UnconfiguredModelProvider implements ModelProvider {
  readonly provider = "unconfigured";
  readonly model = "unconfigured";

  async extractClaims(): Promise<never> {
    throw new ModelProviderNotConfiguredError();
  }
}

export type ModelContractIssue = { path: string; message: string };

type StrictNormalizedValueEntry = {
  key: string;
  value: string | number | boolean | null;
};

const CLAIM_TYPES = new Set<ClaimType>([
  "budget",
  "preference",
  "requirement",
  "decision",
  "concern",
  "risk",
  "open_question",
  "person_role",
  "timing",
  "property_fact",
  "material",
  "measurement",
  "other",
]);
const EVIDENCE_ROLES = new Set<EvidenceRole>(["direct", "corroborating", "contextual"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * OpenAI strict JSON schemas cannot express an object with arbitrary property
 * names. The provider therefore emits normalized values as a bounded list of
 * key/value entries. This decoder restores the public object shape before the
 * authoritative contract validator and persistence boundary.
 *
 * Non-strict provider adapters may continue returning the public object shape.
 * When requireEnvelope is true, any non-null normalized value must use the
 * strict entry envelope. Duplicate keys are rejected rather than overwritten.
 */
export function decodeProviderNormalizedValues(
  value: unknown,
  requireEnvelope: boolean,
): { value: unknown; issues: ModelContractIssue[] } {
  const issues: ModelContractIssue[] = [];
  if (!record(value) || !Array.isArray(value.claims)) return { value, issues };

  const claims = value.claims.map((claim, claimIndex) => {
    if (!record(claim) || claim.normalized_value === null) return claim;
    const path = `$.claims[${claimIndex}].normalized_value`;
    const normalized = claim.normalized_value;
    if (!record(normalized)) {
      if (requireEnvelope) issues.push({ path, message: "Expected a normalized-value entry envelope or null." });
      return claim;
    }

    const keys = Object.keys(normalized);
    const hasEnvelope = keys.length === 1 && keys[0] === "entries";
    if (!hasEnvelope) {
      if (requireEnvelope) issues.push({ path, message: "Expected an object containing only the entries field." });
      return claim;
    }
    if (!Array.isArray(normalized.entries) || normalized.entries.length > MODEL_CONTRACT_LIMITS.normalizedValueEntries) {
      issues.push({
        path: `${path}.entries`,
        message: `Expected at most ${MODEL_CONTRACT_LIMITS.normalizedValueEntries} normalized value entries.`,
      });
      return claim;
    }

    const seen = new Set<string>();
    const entries: StrictNormalizedValueEntry[] = [];
    normalized.entries.forEach((entry, entryIndex) => {
      const entryPath = `${path}.entries[${entryIndex}]`;
      if (!record(entry)) {
        issues.push({ path: entryPath, message: "Expected a key/value entry object." });
        return;
      }
      exactKeys(entry, ["key", "value"], entryPath, issues);
      const key = entry.key;
      if (typeof key !== "string" || !key.trim() || key.length > MODEL_CONTRACT_LIMITS.identifierLength) {
        issues.push({ path: `${entryPath}.key`, message: "Expected a bounded non-empty key." });
        return;
      }
      if (seen.has(key)) {
        issues.push({ path: `${entryPath}.key`, message: "Normalized value keys must be unique." });
        return;
      }
      const entryValue = entry.value;
      if (
        entryValue !== null &&
        typeof entryValue !== "string" &&
        typeof entryValue !== "number" &&
        typeof entryValue !== "boolean"
      ) {
        issues.push({ path: `${entryPath}.value`, message: "Expected a scalar JSON value." });
        return;
      }
      if (typeof entryValue === "number" && !Number.isFinite(entryValue)) {
        issues.push({ path: `${entryPath}.value`, message: "Expected a finite number." });
        return;
      }
      if (typeof entryValue === "string" && entryValue.length > MODEL_CONTRACT_LIMITS.explanationLength) {
        issues.push({ path: `${entryPath}.value`, message: "Normalized string value is too long." });
        return;
      }
      seen.add(key);
      entries.push({ key, value: entryValue as StrictNormalizedValueEntry["value"] });
    });

    if (issues.some((issue) => issue.path.startsWith(`${path}.`))) return claim;
    return {
      ...claim,
      normalized_value: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    };
  });

  return { value: { ...value, claims }, issues };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, issues: ModelContractIssue[]) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ path: `${path}.${key}`, message: "Unexpected field." });
  }
  for (const key of keys) {
    if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "Required field is missing." });
  }
}

function stringField(
  value: unknown,
  path: string,
  issues: ModelContractIssue[],
  nullable = false,
  maxLength: number = MODEL_CONTRACT_LIMITS.explanationLength,
) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: "Expected a non-empty string." });
    return;
  }
  if (value.length > maxLength) {
    issues.push({ path, message: `String exceeds the ${maxLength}-character limit.` });
  }
}

function confidence(value: unknown, path: string, issues: ModelContractIssue[]) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push({ path, message: "Confidence must be between 0 and 1." });
  }
}

function normalizedStatement(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function validateReaffirmedClaimsAgainstContext(
  claims: unknown[],
  context: ContextPack,
  issues: ModelContractIssue[],
) {
  // Only active, Verified claims may receive another occurrence. The Context
  // Pack partitions those claims across these three arrays.
  const targets = new Map(
    [
      ...context.verified_context.active_claims,
      ...context.verified_context.open_questions,
      ...context.verified_context.active_risks,
    ].map((claim) => [claim.claimId, claim]),
  );

  claims.forEach((claim, index) => {
    if (!record(claim) || claim.disposition !== "reaffirmed") return;
    const path = `$.claims[${index}]`;
    const target = typeof claim.reaffirmed_target_claim_id === "string"
      ? targets.get(claim.reaffirmed_target_claim_id)
      : undefined;
    if (!target || target.claimVersionId !== claim.reaffirmed_target_version_id) {
      issues.push({
        path: `${path}.reaffirmed_target_version_id`,
        message: "Reaffirmed target must be the current active claim version in this Context Pack.",
      });
      return;
    }
    if (claim.type !== target.type) {
      issues.push({
        path: `${path}.type`,
        message: "A reaffirmed occurrence must keep the target claim type.",
      });
    }
    if (
      typeof claim.statement !== "string" ||
      normalizedStatement(claim.statement) !== normalizedStatement(target.statement)
    ) {
      issues.push({
        path: `${path}.statement`,
        message: "A reaffirmed occurrence must copy the target statement exactly; any new decision, date, person, amount, state, condition, or next step must be a new atomic claim.",
      });
    }
    if (canonicalJson(claim.normalized_value) !== canonicalJson(target.normalizedValue)) {
      issues.push({
        path: `${path}.normalized_value`,
        message: "A reaffirmed occurrence must keep the target normalized value exactly; changed or additional facts require a new atomic claim.",
      });
    }
  });
}

function validateRelationsAgainstContext(
  claims: unknown[],
  context: ContextPack,
  issues: ModelContractIssue[],
) {
  const activeTargets = [
    ...context.verified_context.active_claims,
    ...context.verified_context.open_questions,
    ...context.verified_context.active_risks,
  ];
  const targetByClaimId = new Map(
    [...activeTargets, ...context.verified_context.recent_history]
      .map((claim) => [claim.claimId, claim]),
  );
  const activeTargetIds = new Set(activeTargets.map((claim) => claim.claimId));

  claims.forEach((claim, claimIndex) => {
    if (!record(claim) || !Array.isArray(claim.relations)) return;
    const lifecycleRelationByTarget = new Set<string>();
    claim.relations.forEach((relation, relationIndex) => {
      if (!record(relation)) return;
      const path = `$.claims[${claimIndex}].relations[${relationIndex}]`;
      const target = typeof relation.target_claim_id === "string"
        ? targetByClaimId.get(relation.target_claim_id)
        : undefined;
      if (!target || target.claimVersionId !== relation.target_claim_version_id) {
        issues.push({
          path: `${path}.target_claim_version_id`,
          message: "Relation target must be an exact Verified Claim version in this Context Pack.",
        });
        return;
      }

      const relationType = relation.type;
      if (
        (relationType === "supersedes" || relationType === "contradicts" || relationType === "resolves") &&
        !activeTargetIds.has(target.claimId)
      ) {
        issues.push({
          path: `${path}.type`,
          message: "A lifecycle relation may only change a currently active Verified Claim.",
        });
      }
      if (
        relationType === "resolves" &&
        target.type !== "open_question" &&
        target.type !== "risk" &&
        target.type !== "concern" &&
        target.uncertainty === null
      ) {
        issues.push({
          path: `${path}.type`,
          message: "Resolves requires an open question, risk, concern, or explicitly uncertain target.",
        });
      }

      if (relationType === "supersedes" || relationType === "contradicts" || relationType === "resolves") {
        const key = target.claimId;
        if (lifecycleRelationByTarget.has(key)) {
          issues.push({
            path,
            message: "One source Claim cannot apply more than one lifecycle relation to the same target.",
          });
        }
        lifecycleRelationByTarget.add(key);
      }
    });
  });
}

function validBbox(value: unknown): value is [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!value.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  const [xMin, yMin, xMax, yMax] = value;
  return xMin >= 0 && yMin >= 0 && xMax <= 1 && yMax <= 1 && xMin < xMax && yMin < yMax;
}

function validateEvidence(value: unknown, path: string, issues: ModelContractIssue[]) {
  if (!record(value)) {
    issues.push({ path, message: "Expected an evidence object." });
    return;
  }
  const kind = value.kind;
  if (kind === "transcript" || kind === "text") {
    exactKeys(value, ["kind", "asset_version_id", "segment_ids", "quote_hint", "evidence_role"], path, issues);
    if (
      !Array.isArray(value.segment_ids) ||
      !value.segment_ids.length ||
      value.segment_ids.length > MODEL_CONTRACT_LIMITS.segmentIdsPerEvidence ||
      value.segment_ids.some(
        (id) =>
          typeof id !== "string" ||
          !id ||
          id.length > MODEL_CONTRACT_LIMITS.identifierLength,
      )
    ) {
      issues.push({
        path: `${path}.segment_ids`,
        message: `Expected one to ${MODEL_CONTRACT_LIMITS.segmentIdsPerEvidence} valid segment IDs.`,
      });
    }
    stringField(value.quote_hint, `${path}.quote_hint`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
  } else if (kind === "photo") {
    exactKeys(value, ["kind", "asset_version_id", "observation", "bbox_norm", "evidence_role"], path, issues);
    stringField(value.observation, `${path}.observation`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
    if (value.bbox_norm !== null && !validBbox(value.bbox_norm)) {
      issues.push({ path: `${path}.bbox_norm`, message: "BBox must contain four numbers or null." });
    }
  } else if (kind === "document") {
    exactKeys(value, ["kind", "asset_version_id", "page_number", "quote_hint", "observation", "evidence_role"], path, issues);
    if (value.page_number !== null && (!Number.isInteger(value.page_number) || Number(value.page_number) < 1)) {
      issues.push({ path: `${path}.page_number`, message: "Page number must be a positive integer or null." });
    }
    stringField(value.quote_hint, `${path}.quote_hint`, issues, true, MODEL_CONTRACT_LIMITS.explanationLength);
    stringField(value.observation, `${path}.observation`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
  } else {
    issues.push({ path: `${path}.kind`, message: "Unsupported evidence kind." });
    return;
  }
  stringField(value.asset_version_id, `${path}.asset_version_id`, issues, false, MODEL_CONTRACT_LIMITS.identifierLength);
  if (!EVIDENCE_ROLES.has(value.evidence_role as EvidenceRole)) {
    issues.push({ path: `${path}.evidence_role`, message: "Unsupported evidence role." });
  }
}

export function validateExtractClaimsOutput(value: unknown, context?: ContextPack): {
  valid: boolean;
  issues: ModelContractIssue[];
  output: ExtractClaimsOutput | null;
} {
  const issues: ModelContractIssue[] = [];
  if (!record(value)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  exactKeys(value, ["schema_version", "event_id", "scenario_assessment", "claims"], "$", issues);
  if (value.schema_version !== CLAIM_EXTRACTION_SCHEMA_VERSION) issues.push({ path: "$.schema_version", message: "Unsupported schema version." });
  stringField(value.event_id, "$.event_id", issues, false, MODEL_CONTRACT_LIMITS.identifierLength);
  if (value.scenario_assessment !== null) {
    if (!record(value.scenario_assessment)) issues.push({ path: "$.scenario_assessment", message: "Expected an object or null." });
    else {
      exactKeys(value.scenario_assessment, ["candidates"], "$.scenario_assessment", issues);
      if (!Array.isArray(value.scenario_assessment.candidates) || value.scenario_assessment.candidates.length < 2 || value.scenario_assessment.candidates.length > 3) {
        issues.push({ path: "$.scenario_assessment.candidates", message: "Expected two or three candidates." });
      } else value.scenario_assessment.candidates.forEach((candidate, index) => {
        const path = `$.scenario_assessment.candidates[${index}]`;
        if (!record(candidate)) return issues.push({ path, message: "Expected an object." });
        exactKeys(candidate, ["scenario", "confidence", "reason"], path, issues);
        stringField(candidate.scenario, `${path}.scenario`, issues, false, MODEL_CONTRACT_LIMITS.scenarioLength);
        stringField(candidate.reason, `${path}.reason`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
        confidence(candidate.confidence, `${path}.confidence`, issues);
      });
    }
  }
  if (!Array.isArray(value.claims) || value.claims.length > MODEL_CONTRACT_LIMITS.claims) {
    issues.push({ path: "$.claims", message: `Claims must be an array with at most ${MODEL_CONTRACT_LIMITS.claims} items.` });
  } else value.claims.forEach((claim, index) => {
    const path = `$.claims[${index}]`;
    if (!record(claim)) return issues.push({ path, message: "Expected an object." });
    exactKeys(claim, ["client_claim_key", "disposition", "reaffirmed_target_claim_id", "reaffirmed_target_version_id", "type", "statement", "normalized_value", "materiality", "confidence", "needs_additional_evidence", "uncertainty", "evidence", "relations"], path, issues);
    stringField(claim.client_claim_key, `${path}.client_claim_key`, issues, false, MODEL_CONTRACT_LIMITS.identifierLength);
    stringField(claim.statement, `${path}.statement`, issues, false, MODEL_CONTRACT_LIMITS.statementLength);
    if (!new Set(["new", "reaffirmed", "duplicate"]).has(claim.disposition as string)) issues.push({ path: `${path}.disposition`, message: "Unsupported disposition." });
    if (!CLAIM_TYPES.has(claim.type as ClaimType)) issues.push({ path: `${path}.type`, message: "Unsupported claim type." });
    if (!new Set(["high", "medium", "low"]).has(claim.materiality as string)) issues.push({ path: `${path}.materiality`, message: "Unsupported materiality." });
    confidence(claim.confidence, `${path}.confidence`, issues);
    if (typeof claim.needs_additional_evidence !== "boolean") issues.push({ path: `${path}.needs_additional_evidence`, message: "Expected a boolean." });
    if (claim.normalized_value !== null && !record(claim.normalized_value)) {
      issues.push({ path: `${path}.normalized_value`, message: "Expected an object or null." });
    } else if (claim.normalized_value !== null) {
      let serialized = "";
      try {
        serialized = JSON.stringify(claim.normalized_value);
      } catch {
        issues.push({ path: `${path}.normalized_value`, message: "Value must be JSON serializable." });
      }
      if (serialized.length > MODEL_CONTRACT_LIMITS.normalizedValueJsonLength) {
        issues.push({
          path: `${path}.normalized_value`,
          message: `Serialized value exceeds the ${MODEL_CONTRACT_LIMITS.normalizedValueJsonLength}-character limit.`,
        });
      }
    }
    const targetRequired = claim.disposition === "reaffirmed";
    stringField(claim.reaffirmed_target_claim_id, `${path}.reaffirmed_target_claim_id`, issues, !targetRequired, MODEL_CONTRACT_LIMITS.identifierLength);
    stringField(claim.reaffirmed_target_version_id, `${path}.reaffirmed_target_version_id`, issues, !targetRequired, MODEL_CONTRACT_LIMITS.identifierLength);
    if (!targetRequired && (claim.reaffirmed_target_claim_id !== null || claim.reaffirmed_target_version_id !== null)) {
      issues.push({ path, message: "Only reaffirmed claims may include a target." });
    }
    if (!Array.isArray(claim.evidence) || claim.evidence.length > MODEL_CONTRACT_LIMITS.evidencePerClaim) {
      issues.push({
        path: `${path}.evidence`,
        message: `Expected an array with at most ${MODEL_CONTRACT_LIMITS.evidencePerClaim} items.`,
      });
    }
    else {
      if (claim.disposition !== "duplicate" && claim.evidence.length === 0) {
        issues.push({ path: `${path}.evidence`, message: "A reviewable claim needs evidence." });
      }
      claim.evidence.forEach((item, evidenceIndex) => validateEvidence(item, `${path}.evidence[${evidenceIndex}]`, issues));
    }
    if (claim.uncertainty !== null) {
      if (!record(claim.uncertainty)) issues.push({ path: `${path}.uncertainty`, message: "Expected an object or null." });
      else {
        exactKeys(claim.uncertainty, ["reason", "alternatives", "question"], `${path}.uncertainty`, issues);
        stringField(claim.uncertainty.reason, `${path}.uncertainty.reason`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
        stringField(claim.uncertainty.question, `${path}.uncertainty.question`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
        if (
          !Array.isArray(claim.uncertainty.alternatives) ||
          claim.uncertainty.alternatives.length > MODEL_CONTRACT_LIMITS.alternativesPerUncertainty ||
          claim.uncertainty.alternatives.some(
            (item) =>
              typeof item !== "string" ||
              !item.trim() ||
              item.length > MODEL_CONTRACT_LIMITS.alternativeLength,
          )
        ) {
          issues.push({
            path: `${path}.uncertainty.alternatives`,
            message: `Expected at most ${MODEL_CONTRACT_LIMITS.alternativesPerUncertainty} bounded non-empty strings.`,
          });
        }
      }
    }
    if (!Array.isArray(claim.relations) || claim.relations.length > MODEL_CONTRACT_LIMITS.relationsPerClaim) {
      issues.push({
        path: `${path}.relations`,
        message: `Expected an array with at most ${MODEL_CONTRACT_LIMITS.relationsPerClaim} items.`,
      });
    }
    else {
      if (claim.disposition === "reaffirmed" && claim.relations.length > 0) {
        issues.push({
          path: `${path}.relations`,
          message: "A reaffirmed occurrence cannot create claim relations; changed or resolving facts must be new claims.",
        });
      }
      claim.relations.forEach((relation, relationIndex) => {
        const relationPath = `${path}.relations[${relationIndex}]`;
        if (!record(relation)) return issues.push({ path: relationPath, message: "Expected an object." });
        exactKeys(relation, ["type", "target_claim_id", "target_claim_version_id", "reason", "confidence"], relationPath, issues);
        if (!new Set(["supersedes", "contradicts", "resolves", "informed_by"]).has(relation.type as string)) {
          issues.push({ path: `${relationPath}.type`, message: "Unsupported relation type." });
        }
        stringField(relation.target_claim_id, `${relationPath}.target_claim_id`, issues, false, MODEL_CONTRACT_LIMITS.identifierLength);
        stringField(relation.target_claim_version_id, `${relationPath}.target_claim_version_id`, issues, false, MODEL_CONTRACT_LIMITS.identifierLength);
        stringField(relation.reason, `${relationPath}.reason`, issues, false, MODEL_CONTRACT_LIMITS.explanationLength);
        confidence(relation.confidence, `${relationPath}.confidence`, issues);
      });
    }
  });
  if (context && Array.isArray(value.claims)) {
    validateReaffirmedClaimsAgainstContext(value.claims, context, issues);
    validateRelationsAgainstContext(value.claims, context, issues);
  }
  return { valid: issues.length === 0, issues, output: issues.length ? null : value as ExtractClaimsOutput };
}
