import {recoverTranscriptEvidence} from "./evidence.ts";
import {comparisonQualityIssues, type ComparisonQualityIssue} from './comparison-quality.ts';
import {validHandledFollowup,type HandledFollowupRef} from "./closed-followup-context.ts";
import type { ContextPack } from "./context-pack";
import {sameIntentGroupIssues,type SameIntentGroupProposal} from "./same-intent-groups.ts";
import type {
  ExtractClaimsOutput,
  ModelContractIssue,
  ModelEvidence,
  ModelProvider,
  ModelUsage,
} from "./model-contract";
// The explicit extension keeps Node's native TypeScript runner and the
// application bundler resolving this same source module identically.
import { RETRIEVED_COMPARISON_PROMPT_VERSION, MATCHED_COMPARISON_PROMPT_VERSION, VALUE_CHANGE_PROMPT_VERSION, SUPPORTED_COMPARISON_PROMPT_VERSION, SCOPED_COMPARISON_PROMPT_VERSION, CROSS_CONVERSATION_PROMPT_VERSION, PARTIAL_COMPARISON_PROMPT_VERSION, CROSS_FILE_CLAIM_EXTRACTION_PROMPT_VERSION, DIFF_CLAIM_EXTRACTION_PROMPT_VERSION, CHRONOLOGICAL_CLAIM_EXTRACTION_PROMPT_VERSION, STRICT_HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION, HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION, SHORT_REFERENCE_CLAIM_EXTRACTION_PROMPT_VERSION, CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, MATERIAL_CLAIM_EXTRACTION_PROMPT_VERSION, SERVICE_ACTION_CLAIM_EXTRACTION_PROMPT_VERSION, COVERAGE_CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_PROMPT_VERSION, LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION, ATOMIC_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, CLAIM_EXTRACTION_SCHEMA_VERSION, MODEL_CONTRACT_LIMITS, validateExtractClaimsOutput } from "./model-contract.ts";
import type { ClaimType } from "./types";
import type { EventSummaryOutput, ReadableTranscriptOutput } from "./event-ai-artifacts";
import type { WorkflowNarrativePromptVersion } from "./workflow-narrative.ts";

export const LEGACY_TWO_STAGE_EXTRACTION_PROMPT_VERSION = LEGACY_CLAIM_EXTRACTION_PROMPT_VERSION;
export const TWO_STAGE_EXTRACTION_PROMPT_VERSION = CLAIM_EXTRACTION_PROMPT_VERSION;
export const LEGACY_INVENTORY_SCHEMA_VERSION = "claim-inventory.v3" as const;
export const INVENTORY_SCHEMA_VERSION = "claim-inventory.v4" as const;
export type InventorySchemaVersion = typeof LEGACY_INVENTORY_SCHEMA_VERSION | typeof INVENTORY_SCHEMA_VERSION;
export const LEGACY_VERIFICATION_SCHEMA_VERSION = "claim-verification.v4" as const;
export const ATOMIC_VERIFICATION_SCHEMA_VERSION = "claim-verification.v5" as const;
export const VERIFICATION_SCHEMA_VERSION = "claim-verification.v6" as const;
export const LEGACY_VERIFICATION_PROMPT_VERSION = "claim-extraction-prompt.v9.3" as const;
export const VERIFICATION_PROMPT_VERSION = CLAIM_EXTRACTION_PROMPT_VERSION;
export const HANDLED_VERIFICATION_SCHEMA_VERSION = "claim-verification.v7" as const;
export const SUPPORTED_VERIFICATION_SCHEMA_VERSION = "claim-verification.v8" as const;
export function hasHandledVerification(version: unknown): boolean { return version === HANDLED_VERIFICATION_SCHEMA_VERSION || version === SUPPORTED_VERIFICATION_SCHEMA_VERSION; }
export function hasFollowupCoverage(version:unknown):boolean { return version===VERIFICATION_SCHEMA_VERSION || hasHandledVerification(version); }
export type VerificationSchemaVersion = typeof SUPPORTED_VERIFICATION_SCHEMA_VERSION | typeof HANDLED_VERIFICATION_SCHEMA_VERSION | typeof VERIFICATION_SCHEMA_VERSION | typeof ATOMIC_VERIFICATION_SCHEMA_VERSION | typeof LEGACY_VERIFICATION_SCHEMA_VERSION;
export type ExtractionStagePromptVersion = typeof RETRIEVED_COMPARISON_PROMPT_VERSION | typeof MATCHED_COMPARISON_PROMPT_VERSION | typeof VALUE_CHANGE_PROMPT_VERSION | typeof SUPPORTED_COMPARISON_PROMPT_VERSION | typeof SCOPED_COMPARISON_PROMPT_VERSION | typeof CROSS_CONVERSATION_PROMPT_VERSION | typeof PARTIAL_COMPARISON_PROMPT_VERSION | typeof CROSS_FILE_CLAIM_EXTRACTION_PROMPT_VERSION | typeof DIFF_CLAIM_EXTRACTION_PROMPT_VERSION | typeof CHRONOLOGICAL_CLAIM_EXTRACTION_PROMPT_VERSION | typeof STRICT_HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION | typeof HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION | typeof LEGACY_TWO_STAGE_EXTRACTION_PROMPT_VERSION | typeof LEGACY_VERIFICATION_PROMPT_VERSION | typeof ATOMIC_TASK_CLAIM_EXTRACTION_PROMPT_VERSION | typeof COVERAGE_CLAIM_EXTRACTION_PROMPT_VERSION | typeof SERVICE_ACTION_CLAIM_EXTRACTION_PROMPT_VERSION | typeof MATERIAL_CLAIM_EXTRACTION_PROMPT_VERSION | typeof CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION | typeof SHORT_REFERENCE_CLAIM_EXTRACTION_PROMPT_VERSION | typeof TWO_STAGE_EXTRACTION_PROMPT_VERSION;
export const EXTRACTION_RETENTION_POLICY = "explicit-followups.v1" as const;

export function inventoryContractForRun(params: Record<string, unknown>): {schemaVersion: InventorySchemaVersion; promptVersion: ExtractionStagePromptVersion; candidateLimit: 24 | 64} {
  const promptVersion = params.inventory_prompt_version ?? LEGACY_TWO_STAGE_EXTRACTION_PROMPT_VERSION;
  if (promptVersion !== RETRIEVED_COMPARISON_PROMPT_VERSION && promptVersion !== MATCHED_COMPARISON_PROMPT_VERSION && promptVersion !== VALUE_CHANGE_PROMPT_VERSION && promptVersion !== SUPPORTED_COMPARISON_PROMPT_VERSION && promptVersion !== SCOPED_COMPARISON_PROMPT_VERSION && promptVersion !== CROSS_CONVERSATION_PROMPT_VERSION && promptVersion !== PARTIAL_COMPARISON_PROMPT_VERSION && promptVersion !== CROSS_FILE_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== DIFF_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== CHRONOLOGICAL_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== STRICT_HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== LEGACY_TWO_STAGE_EXTRACTION_PROMPT_VERSION && promptVersion !== ATOMIC_TASK_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== COVERAGE_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== SERVICE_ACTION_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== MATERIAL_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== SHORT_REFERENCE_CLAIM_EXTRACTION_PROMPT_VERSION && promptVersion !== TWO_STAGE_EXTRACTION_PROMPT_VERSION) throw new Error("Unsupported frozen inventory prompt.");
  const modern = (promptVersion === RETRIEVED_COMPARISON_PROMPT_VERSION || promptVersion === MATCHED_COMPARISON_PROMPT_VERSION) || promptVersion === VALUE_CHANGE_PROMPT_VERSION || promptVersion === SUPPORTED_COMPARISON_PROMPT_VERSION || promptVersion === SCOPED_COMPARISON_PROMPT_VERSION || promptVersion === CROSS_CONVERSATION_PROMPT_VERSION || promptVersion === PARTIAL_COMPARISON_PROMPT_VERSION || promptVersion === CROSS_FILE_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === DIFF_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === CHRONOLOGICAL_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === STRICT_HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === COVERAGE_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === SERVICE_ACTION_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === MATERIAL_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === SHORT_REFERENCE_CLAIM_EXTRACTION_PROMPT_VERSION || promptVersion === TWO_STAGE_EXTRACTION_PROMPT_VERSION;
  const schemaVersion = modern ? INVENTORY_SCHEMA_VERSION : LEGACY_INVENTORY_SCHEMA_VERSION;
  const candidateLimit = modern ? 64 : 24;
  if (params.inventory_schema_version !== undefined && params.inventory_schema_version !== schemaVersion) throw new Error("Unsupported frozen inventory schema.");
  if (params.inventory_candidate_limit !== undefined && params.inventory_candidate_limit !== candidateLimit) throw new Error("Unsupported frozen inventory limit.");
  return {schemaVersion, promptVersion, candidateLimit};
}

export function verificationContractForRun(params: Record<string, unknown>): {schemaVersion: VerificationSchemaVersion; promptVersion: ExtractionStagePromptVersion; claimLimit: 24 | 64} {
  const version = params.verification_schema_version ?? LEGACY_VERIFICATION_SCHEMA_VERSION;
  if (version !== SUPPORTED_VERIFICATION_SCHEMA_VERSION && version !== HANDLED_VERIFICATION_SCHEMA_VERSION && version !== LEGACY_VERIFICATION_SCHEMA_VERSION && version !== ATOMIC_VERIFICATION_SCHEMA_VERSION && version !== VERIFICATION_SCHEMA_VERSION) throw new Error("Unsupported frozen verification schema.");
  const promptVersion = params.verification_prompt_version ?? (version === SUPPORTED_VERIFICATION_SCHEMA_VERSION ? SUPPORTED_COMPARISON_PROMPT_VERSION : version === HANDLED_VERIFICATION_SCHEMA_VERSION ? HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION : version === LEGACY_VERIFICATION_SCHEMA_VERSION ? LEGACY_TWO_STAGE_EXTRACTION_PROMPT_VERSION : version === ATOMIC_VERIFICATION_SCHEMA_VERSION ? LEGACY_VERIFICATION_PROMPT_VERSION : VERIFICATION_PROMPT_VERSION);
  const allowed: readonly unknown[] = version === SUPPORTED_VERIFICATION_SCHEMA_VERSION ? [SUPPORTED_COMPARISON_PROMPT_VERSION, VALUE_CHANGE_PROMPT_VERSION, MATCHED_COMPARISON_PROMPT_VERSION, RETRIEVED_COMPARISON_PROMPT_VERSION] : version === HANDLED_VERIFICATION_SCHEMA_VERSION ? [HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION,STRICT_HANDLED_CLAIM_EXTRACTION_PROMPT_VERSION,CHRONOLOGICAL_CLAIM_EXTRACTION_PROMPT_VERSION,DIFF_CLAIM_EXTRACTION_PROMPT_VERSION,CROSS_FILE_CLAIM_EXTRACTION_PROMPT_VERSION,PARTIAL_COMPARISON_PROMPT_VERSION,CROSS_CONVERSATION_PROMPT_VERSION,SCOPED_COMPARISON_PROMPT_VERSION] : version === LEGACY_VERIFICATION_SCHEMA_VERSION ? [LEGACY_TWO_STAGE_EXTRACTION_PROMPT_VERSION] : version === ATOMIC_VERIFICATION_SCHEMA_VERSION ? [LEGACY_VERIFICATION_PROMPT_VERSION, ATOMIC_TASK_CLAIM_EXTRACTION_PROMPT_VERSION] : [COVERAGE_CLAIM_EXTRACTION_PROMPT_VERSION, SERVICE_ACTION_CLAIM_EXTRACTION_PROMPT_VERSION, MATERIAL_CLAIM_EXTRACTION_PROMPT_VERSION, CONCRETE_TASK_CLAIM_EXTRACTION_PROMPT_VERSION, SHORT_REFERENCE_CLAIM_EXTRACTION_PROMPT_VERSION, VERIFICATION_PROMPT_VERSION];
  if (!allowed.includes(promptVersion)) throw new Error("Unsupported frozen verification prompt.");
  const claimLimit = hasFollowupCoverage(version) ? 64 : 24;
  if (params.final_claim_limit !== undefined && params.final_claim_limit !== claimLimit) throw new Error("Unsupported frozen final claim limit.");
  if (params.retention_policy !== undefined && params.retention_policy !== EXTRACTION_RETENTION_POLICY) throw new Error("Unsupported frozen retention policy.");
  return {schemaVersion: version, promptVersion: promptVersion as ExtractionStagePromptVersion, claimLimit};
}

export const TWO_STAGE_EXTRACTION_LIMITS = {
  inventoryCandidates: 64,
  finalClaims: 64,
  dispositionReasonLength: MODEL_CONTRACT_LIMITS.explanationLength,
  qualityFlags: 64,
  draftLinks: 64,
} as const;

export function inventoryCandidateLimit(version: InventorySchemaVersion): 24 | 64 {
  return version === INVENTORY_SCHEMA_VERSION ? 64 : 24;
}
export function verificationClaimLimit(version: VerificationSchemaVersion): 24 | 64 {
  return hasFollowupCoverage(version) ? 64 : 24;
}

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
  schema_version: InventorySchemaVersion;
  event_id: string;
  candidates: InventoryCandidate[];
};

export type InventoryDispositionOutcome =
  | "already_handled"
  | "included"
  | "merged"
  | "duplicate"
  | "unsupported"
  | "lower_priority";

export type InventoryDisposition = {
  inventory_key: string;
  handled_ref?: HandledFollowupRef | null;
  outcome: InventoryDispositionOutcome;
  final_claim_keys: string[];
  reason: string;
};

export type DraftLinkType = "same" | "changed" | "conflicting" | "possibly_answered";

export type DraftLinkCandidate = {
  alignment?: {same_subject: boolean; same_dimension: boolean; comparable_scope: boolean; conclusion_supported: boolean};
  final_claim_key: string;
  target_draft_claim_id: string;
  target_draft_claim_version_id: string;
  type: DraftLinkType;
  reason: string;
  confidence: number;
};

export type VerificationOutput = {
  schema_version: VerificationSchemaVersion;
  same_intent_groups?: SameIntentGroupProposal[];
  event_id: string;
  scenario_assessment: ExtractClaimsOutput["scenario_assessment"];
  claims: ExtractClaimsOutput["claims"];
  candidate_dispositions: InventoryDisposition[];
  draft_link_candidates: DraftLinkCandidate[];
  quality_review: {
    unresolved_conflict_keys: string[];
    compound_claim_keys: string[];
    reaffirmed_issue_claim_keys: string[];
  };
};

export interface TwoStageModelProvider extends ModelProvider {
  summarizeEvent(input: ContextPack, options?: ModelStageRequestOptions): Promise<{
    output: EventSummaryOutput;
    usage: ModelUsage;
  }>;
  /** 单个阅读视图。返回的仍是完整信封形状，只有自己那个字段有内容。 */
  summarizeReadingView(
    kind: "chapters" | "speakers" | "key_points" | "overview",
    input: ContextPack,
    upstream: { chapters?: unknown[]; speaker_summaries?: unknown[]; key_points?: unknown[] },
    options?: ModelStageRequestOptions,
  ): Promise<{
    output: EventSummaryOutput;
    usage: ModelUsage;
  }>;
  refineTranscript(input: ContextPack, options?: ModelStageRequestOptions): Promise<{
    output: ReadableTranscriptOutput;
    usage: ModelUsage;
  }>;
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
  onOutputRepair?: (repairs: string[]) => Promise<void>;
  extractionPromptVersion?: ExtractionStagePromptVersion;
  workflowNarrativePromptVersion?: WorkflowNarrativePromptVersion;
  verificationSchemaVersion?: VerificationSchemaVersion;
  signal?: AbortSignal;
  idempotencyKey?: string;
  promptCacheKey?: string;
  qualityFeedback?: string[];
  /**
   * A previously-created OpenAI background Response. When present, the
   * provider retrieves this Response instead of creating another one.
   */
  resumeProviderResponseId?: string;
  /**
   * 恢复后台响应时的卡住预算（毫秒）。超过仍未开始出结果就取消并要求重发。
   * 阅读产物用五分钟，抽取阶段用自己的超时。
   */
  backgroundStallMs?: number;
  backgroundQueueBudgetMs?: number;
  /**
   * Called as soon as OpenAI returns a durable Response ID, before a queued or
   * in-progress result is yielded back to the job runner.
   */
  onProviderResponse?: (response: {
    id: string;
    status: string;
  }) => Promise<void>;
};

export type FinalExtractClaimsOutput = Omit<ExtractClaimsOutput, "schema_version"> & {
  schema_version: typeof CLAIM_EXTRACTION_SCHEMA_VERSION;
};

export type ContractValidation<T> = {
  valid: boolean;
  issues: ModelContractIssue[];
  output: T | null;
  /** 校验前做过的确定性修复，供上层记成警告，不静默吞掉。 */
  repairs?: string[];
};

export type VerificationEscalationReason =
  | "metric_unit_mismatch"
  | "comparison_scope_mismatch"
  | "verification_contract_invalid"
  | "critical_evidence_invalid"
  | "inventory_candidate_unmapped"
  | "critical_candidate_dropped"
  | "supported_followup_dropped"
  | "low_confidence_relation"
  | "unresolved_conflict"
  | "compound_claim"
  | "reaffirmed_issue";

export type VerificationEscalation = {
  comparisonIssues: ComparisonQualityIssue[];
  required: boolean;
  reasons: VerificationEscalationReason[];
  unmappedInventoryKeys: string[];
  droppedCriticalInventoryKeys: string[];
  droppedFollowUpInventoryKeys: string[];
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
  if (value.schema_version !== INVENTORY_SCHEMA_VERSION && value.schema_version !== LEGACY_INVENTORY_SCHEMA_VERSION) {
    issues.push({ path: "$.schema_version", message: "Unsupported inventory schema version." });
  }
  boundedString(value.event_id, "$.event_id", issues, MODEL_CONTRACT_LIMITS.identifierLength);
  const candidateLimit = inventoryCandidateLimit(value.schema_version as InventorySchemaVersion);
  if (!Array.isArray(value.candidates) || value.candidates.length > candidateLimit) {
    issues.push({
      path: "$.candidates",
      message: `Candidates must be an array with at most ${candidateLimit} items.`,
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

/**
 * 校验前的确定性修复。
 *
 * 线上两次 MODEL_OUTPUT_INVALID 都不是内容判断错误，是模型把表格填错了：
 * 同一个 inventory_key 列了两遍，或者给了结构化不确定性却把
 * needs_additional_evidence 留成 false。这类自相矛盾能机械消解，不值得
 * 整份丢掉再花一次钱重跑。修复一律取保守的那一边，并把动作记下来。
 *
 * 只修可机械验证的结构。内容层面的问题（漏掉候选、矛盾没解决）交给
 * assessVerificationEscalation，那边本来就在看。
 */
export function repairVerificationOutput(value: unknown, context?: ContextPack): { value: unknown; repairs: string[] } {
  if (!record(value)) return { value, repairs: [] };
  const repairs: string[] = [];
  const repaired: Record<string, unknown> = { ...value };

  // A verifier may use an inventory key in a final-claim quality flag. Resolve
  // only its explicit, unambiguous disposition; never discard the warning or
  // infer a target from similar text. All factual references remain untouched.
  if (value.schema_version === "claim-verification.v8" && record(value.quality_review) &&
      Array.isArray(value.claims) && Array.isArray(value.candidate_dispositions)) {
    const finalKeys = new Set(value.claims.flatMap(claim => record(claim) && typeof claim.client_claim_key === "string" ? [claim.client_claim_key] : []));
    const dispositions = value.candidate_dispositions;
    const quality = { ...value.quality_review };
    for (const field of ["compound_claim_keys", "reaffirmed_issue_claim_keys"] as const) {
      const flags = quality[field];
      if (!Array.isArray(flags)) continue;
      quality[field] = flags.flatMap(key => {
        if (typeof key !== "string" || finalKeys.has(key)) return [key];
        const matches = dispositions.filter(item => record(item) && item.inventory_key === key);
        const match = matches.length === 1 ? matches[0] : null;
        if (!record(match) || !["included", "merged"].includes(String(match.outcome)) ||
            !Array.isArray(match.final_claim_keys) || !match.final_claim_keys.length ||
            !match.final_claim_keys.every(ref => typeof ref === "string" && finalKeys.has(ref))) return [key];
        repairs.push(`mapped ${field} inventory key ${key} to ${match.final_claim_keys.join(", ")}`);
        return match.final_claim_keys;
      });
    }
    repaired.quality_review = quality;
  }

  if (Array.isArray(value.candidate_dispositions)) {
    const seen = new Set<string>();
    const kept = value.candidate_dispositions.filter((disposition) => {
      if (!record(disposition) || typeof disposition.inventory_key !== "string") return true;
      // 保留先出现的那条。两条不一致时不去猜哪条对；留下的结果照样
      // 要过下面的完整校验，内容层面的问题也照样会被升级判断看到。
      if (seen.has(disposition.inventory_key)) {
        repairs.push(`dropped duplicate disposition for ${disposition.inventory_key}`);
        return false;
      }
      seen.add(disposition.inventory_key);
      return true;
    });
    if (kept.length !== value.candidate_dispositions.length) repaired.candidate_dispositions = kept;
  }

  if (Array.isArray(value.claims)) {
    let changed = false;
    const targets=new Map((context?.verified_context.active_claims ?? []).map(c=>[c.claimId,c]));
    const claims = value.claims.map((claim) => {
      if (!record(claim)) return claim;
      const target=typeof claim.reaffirmed_target_claim_id==='string'?targets.get(claim.reaffirmed_target_claim_id):undefined;
      const original=target?.normalizedValue, returned=claim.normalized_value;
      // workflow_kind is a server-owned discriminator. Restore only the
      // observed answer/completion mix-up; every factual field stays exact.
      if(claim.disposition==='reaffirmed' && target && claim.reaffirmed_target_version_id===target.claimVersionId &&
        claim.type==='next_action' && target.type==='next_action' && claim.statement===target.statement &&
        record(original) && record(returned) && original.workflow_kind==='completion' && returned.workflow_kind==='answer' &&
        Object.keys(original).length===3 && Object.keys(returned).length===3 && original.status==='completed' &&
        returned.status===original.status && typeof original.completed_action_claim_id==='string' &&
        returned.completed_action_claim_id===original.completed_action_claim_id) {
        changed=true;
        repairs.push(`restored completion workflow kind for ${claim.client_claim_key}`);
        return {...claim,normalized_value:{...returned,workflow_kind:'completion'}};
      }
      // 给了不确定性就是需要补证据，模型把标志位留成 false 属于自相矛盾。
      // true 是保守的一边：它只会让这条进人工核对，不会让它更容易通过。
      if (claim.uncertainty != null && claim.needs_additional_evidence !== true) {
        changed = true;
        const key = typeof claim.client_claim_key === "string" ? claim.client_claim_key : "claim";
        repairs.push(`set needs_additional_evidence for ${key}`);
        return { ...claim, needs_additional_evidence: true };
      }
      return claim;
    });
    if (changed) repaired.claims = claims;
  }

  return { value: repaired, repairs };
}

export function validateVerificationOutput(
  rawValue: unknown,
  inventory: InventoryOutput,
  context?: ContextPack,
): ContractValidation<VerificationOutput> {
  const issues: ModelContractIssue[] = [];
  if (!record(rawValue)) return { valid: false, issues: [{ path: "$", message: "Expected an object." }], output: null };
  const { value: repairedValue, repairs } = repairVerificationOutput(rawValue, context);
  const value = repairedValue as Record<string, unknown>;
  const legacy=value.schema_version===LEGACY_VERIFICATION_SCHEMA_VERSION;
  const claimLimit = verificationClaimLimit(value.schema_version as VerificationSchemaVersion);
  exactKeys(value, ["schema_version", "event_id", "scenario_assessment", "claims", "candidate_dispositions", "draft_link_candidates", "quality_review", ...(legacy?[]:["same_intent_groups"])], "$", issues);
  if(!legacy)issues.push(...sameIntentGroupIssues(value.same_intent_groups));
  if (value.schema_version !== SUPPORTED_VERIFICATION_SCHEMA_VERSION && value.schema_version !== HANDLED_VERIFICATION_SCHEMA_VERSION && value.schema_version !== VERIFICATION_SCHEMA_VERSION && value.schema_version !== ATOMIC_VERIFICATION_SCHEMA_VERSION && !legacy) {
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
  }, context, {maxClaims: claimLimit});
  issues.push(...claimValidation.issues.filter((issue) => !issue.path.startsWith("$.schema_version")));
  if (context?.project.scenario === null && value.scenario_assessment === null) {
    issues.push({ path: "$.scenario_assessment", message: "An unassessed project requires two or three scenario candidates." });
  }
  if (context?.project.scenario !== null && value.scenario_assessment !== null) {
    issues.push({ path: "$.scenario_assessment", message: "A project with a confirmed scenario must not be reassessed." });
  }
  const claims = Array.isArray(value.claims) ? value.claims : [];
  const finalKeys = new Set<string>();
  const newFinalKeys = new Set<string>();
  claims.forEach((claim, index) => {
    if (!record(claim) || typeof claim.client_claim_key !== "string") return;
    if (finalKeys.has(claim.client_claim_key)) {
      issues.push({ path: `$.claims[${index}].client_claim_key`, message: "Duplicate final claim key." });
    }
    finalKeys.add(claim.client_claim_key);
    if (claim.disposition === "new") newFinalKeys.add(claim.client_claim_key);
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
    exactKeys(disposition, ["inventory_key", "outcome", "final_claim_keys", "reason",...(hasHandledVerification(value.schema_version) && "handled_ref" in disposition?["handled_ref"]:[])], path, issues);
    boundedString(disposition.inventory_key, `${path}.inventory_key`, issues, MODEL_CONTRACT_LIMITS.identifierLength);
    boundedString(disposition.reason, `${path}.reason`, issues, TWO_STAGE_EXTRACTION_LIMITS.dispositionReasonLength);
    if (!DISPOSITION_OUTCOMES.has(disposition.outcome as InventoryDispositionOutcome) && !(hasHandledVerification(value.schema_version) && disposition.outcome==="already_handled")) {
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
      claimLimit,
    );
    references.forEach((key, refIndex) => {
      if (!finalKeys.has(key)) issues.push({ path: `${path}.final_claim_keys[${refIndex}]`, message: "Unknown final claim key." });
    });
    if (disposition.outcome === "already_handled") {
      const candidate=inventory.candidates.find(c=>c.inventory_key===disposition.inventory_key);
      if(!candidate || !validHandledFollowup(candidate,disposition.handled_ref,context)) issues.push({path:`${path}.handled_ref`,message:"Handled candidate must reference an exact current closure of the same item and source."});
    } else if(disposition.handled_ref != null) issues.push({path:`${path}.handled_ref`,message:"Only an already handled candidate may carry closure proof."});
    const retained = disposition.outcome === "included" || disposition.outcome === "merged";
    if (retained && references.length !== 1) {
      issues.push({ path: `${path}.final_claim_keys`, message: "Included or merged candidates must map to exactly one final claim." });
    }
    if (!retained && references.length !== 0) {
      issues.push({ path: `${path}.final_claim_keys`, message: "Dropped candidates cannot map to a final claim." });
    }
    });
  }
  // 漏掉某个候选的处置不在这里硬拒绝。assessVerificationEscalation 本来就
  // 把它算作 inventory_candidate_unmapped，关键候选还会进
  // droppedCriticalInventoryKeys。在校验层整份丢掉，等于让升级路径永远
  // 看不到这个信号，同一件事被两套机制处理，结果是重跑而不是重核。
  const unmappedCandidateKeys = inventory.candidates
    .filter((candidate) => !mappedKeys.has(candidate.inventory_key))
    .map((candidate) => candidate.inventory_key);

  const availableDraftTargets = new Map(
    (context?.draft_context?.claims ?? []).map((claim) => [claim.claimId, claim]),
  );
  if (!Array.isArray(value.draft_link_candidates) || value.draft_link_candidates.length > claimLimit) {
    issues.push({
      path: "$.draft_link_candidates",
      message: `Expected an array with at most ${claimLimit} draft links.`,
    });
  } else {
    const seenDraftLinks = new Set<string>();
    value.draft_link_candidates.forEach((link, index) => {
      const path = `$.draft_link_candidates[${index}]`;
      if (!record(link)) {
        issues.push({ path, message: "Expected an object." });
        return;
      }
      exactKeys(link, ["final_claim_key", "target_draft_claim_id", "target_draft_claim_version_id", "type", "reason", "confidence", ...(value.schema_version === SUPPORTED_VERIFICATION_SCHEMA_VERSION ? ["alignment"] : [])], path, issues);
      if (value.schema_version === SUPPORTED_VERIFICATION_SCHEMA_VERSION) {
        const keys = ["same_subject", "same_dimension", "comparable_scope", "conclusion_supported"];
        if (!record(link.alignment)) issues.push({path: `${path}.alignment`, message: "Comparison alignment is required."});
        else {
          exactKeys(link.alignment, keys, `${path}.alignment`, issues);
          for (const key of keys) if (typeof link.alignment[key] !== "boolean") issues.push({path: `${path}.alignment.${key}`, message: "Expected a boolean."});
        }
      }
      boundedString(link.final_claim_key, `${path}.final_claim_key`, issues, MODEL_CONTRACT_LIMITS.identifierLength);
      boundedString(link.target_draft_claim_id, `${path}.target_draft_claim_id`, issues, MODEL_CONTRACT_LIMITS.identifierLength);
      boundedString(link.target_draft_claim_version_id, `${path}.target_draft_claim_version_id`, issues, MODEL_CONTRACT_LIMITS.identifierLength);
      boundedString(link.reason, `${path}.reason`, issues, MODEL_CONTRACT_LIMITS.explanationLength);
      if (!new Set<DraftLinkType>(["same", "changed", "conflicting", "possibly_answered"]).has(link.type as DraftLinkType)) {
        issues.push({ path: `${path}.type`, message: "Unsupported draft link type." });
      }
      if (typeof link.confidence !== "number" || !Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1) {
        issues.push({ path: `${path}.confidence`, message: "Expected a confidence from 0 to 1." });
      }
      if (typeof link.final_claim_key === "string" && !finalKeys.has(link.final_claim_key)) {
        issues.push({ path: `${path}.final_claim_key`, message: "Unknown final claim key." });
      } else if (typeof link.final_claim_key === "string" && !newFinalKeys.has(link.final_claim_key)) {
        issues.push({ path: `${path}.final_claim_key`, message: "A draft link must originate from a new final claim." });
      }
      const target = typeof link.target_draft_claim_id === "string"
        ? availableDraftTargets.get(link.target_draft_claim_id)
        : undefined;
      if (!target || target.claimVersionId !== link.target_draft_claim_version_id) {
        issues.push({ path: `${path}.target_draft_claim_id`, message: "Draft link target is not present in draft_context." });
      }
      const uniqueKey = `${link.final_claim_key}\u0000${link.target_draft_claim_id}\u0000${link.type}`;
      if (seenDraftLinks.has(uniqueKey)) issues.push({ path, message: "Duplicate draft link candidate." });
      seenDraftLinks.add(uniqueKey);
    });
  }

  if (!record(value.quality_review)) {
    issues.push({ path: "$.quality_review", message: "Expected an object." });
  } else {
    exactKeys(value.quality_review, ["unresolved_conflict_keys", "compound_claim_keys", "reaffirmed_issue_claim_keys"], "$.quality_review", issues);
    boundedUniqueStrings(value.quality_review.unresolved_conflict_keys, "$.quality_review.unresolved_conflict_keys", issues, claimLimit);
    for (const field of ["compound_claim_keys", "reaffirmed_issue_claim_keys"] as const) {
      const refs = boundedUniqueStrings(value.quality_review[field], `$.quality_review.${field}`, issues, claimLimit);
      refs.forEach((key, index) => {
        if (!finalKeys.has(key)) issues.push({ path: `$.quality_review.${field}[${index}]`, message: "Unknown final claim key." });
      });
    }
  }

  const allRepairs = unmappedCandidateKeys.length
    ? [...repairs, `left ${unmappedCandidateKeys.length} inventory candidate(s) unmapped for the escalation assessment`]
    : repairs;
  return { valid: issues.length === 0, issues, output: issues.length ? null : value as VerificationOutput, repairs: allRepairs };
}

export function toFinalExtractClaimsOutput(verification: VerificationOutput): FinalExtractClaimsOutput {
  return {
    schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION,
    event_id: verification.event_id,
    scenario_assessment: verification.scenario_assessment,
    claims: verification.claims,
  };
}

/**
 * 只有这些理由时不值得多跑一趟复核。
 *
 * 复合结论（一条里塞了两件事）实测六次复核里只有两次被拆得更好，其余没改善或
 * 输出无效，且从没补回过一条事实；每次却要多等一两分钟。它们本来就进人工核对，
 * 人在屏幕上看得见、改得了。所以只因为这个就不复核，改记一条提示。
 * 丢了关键事实、有没对上的清单、有冲突、低置信关系、重复确认有问题，照旧复核。
 */
export const REVIEW_ONLY_ESCALATION_REASONS: ReadonlySet<VerificationEscalationReason> = new Set(["compound_claim"]);

export function assessVerificationEscalation(
  inventory: InventoryOutput,
  verification: unknown,
  context?: ContextPack,
  scopedComparisons = false,
): VerificationEscalation {
  const validation = validateVerificationOutput(verification, inventory, context);
  const reasons = new Set<VerificationEscalationReason>();
  const comparisonIssues = scopedComparisons && validation.output
    ? comparisonQualityIssues(validation.output.claims, validation.output.draft_link_candidates, context) : [];
  comparisonIssues.forEach(issue => reasons.add(issue.reason));
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

  // Detect a fact that would disappear at persistence before choosing the paid
  // verification result. A paraphrased quotation is not source evidence.
  const invalidEvidenceKeys = new Set<string>();
  if (validation.output && context?.new_event.transcript_segments.length) {
    const segments = new Map(context.new_event.transcript_segments.map(segment=>[segment.id,segment]));
    for (const claim of validation.output.claims) {
      if(claim.disposition==='reaffirmed')continue;
      const direct=claim.evidence.filter(e=>e.evidence_role==='direct');
      if(direct.length && direct.every(e=>{
        if(e.kind!=='text' && e.kind!=='transcript')return false;
        return !recoverTranscriptEvidence(e.segment_ids,e.quote_hint,segments,{
          expectedEventId:context.new_event.event_id,
          allowedSegmentIds:new Set(context.new_event.transcript_segments.filter(segment=>segment.assetVersionId===e.asset_version_id).map(segment=>segment.id)),
          kind:e.kind,
        }).valid;
      }))invalidEvidenceKeys.add(claim.client_claim_key);
    }
  }
  const droppedCriticalInventoryKeys = inventory.candidates
    .filter((candidate) => {
      const disposition=dispositionByKey.get(candidate.inventory_key);
      const outcome = disposition?.outcome;
      const finalKeys=disposition?.final_claim_keys;
      if(candidate.critical && Array.isArray(finalKeys) && finalKeys.some(key=>typeof key==='string' && invalidEvidenceKeys.has(key))) {
        reasons.add('critical_evidence_invalid');
        return true;
      }
      return candidate.critical && outcome !== "included" && outcome !== "merged" && !(hasHandledVerification(value.schema_version) && outcome==="already_handled" && validHandledFollowup(candidate,dispositionByKey.get(candidate.inventory_key)?.handled_ref,context));
    })
    .map((candidate) => candidate.inventory_key);
  if (droppedCriticalInventoryKeys.length) reasons.add("critical_candidate_dropped");
  const droppedFollowUpInventoryKeys = hasFollowupCoverage(value.schema_version)
    ? inventory.candidates.filter(candidate => (candidate.type === "open_question" || candidate.type === "next_action") && ["lower_priority", undefined].includes(dispositionByKey.get(candidate.inventory_key)?.outcome as "lower_priority" | undefined)).map(candidate => candidate.inventory_key)
    : [];
  if (droppedFollowUpInventoryKeys.length) reasons.add("supported_followup_dropped");

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
    comparisonIssues,
    required: [...reasons].some((reason) => !REVIEW_ONLY_ESCALATION_REASONS.has(reason)),
    reasons: [...reasons],
    unmappedInventoryKeys,
    droppedCriticalInventoryKeys,
    droppedFollowUpInventoryKeys,
    lowConfidenceRelationClaimKeys: [...new Set(lowConfidenceRelationClaimKeys)],
  };
}

function reviewIssueVector(
  output: VerificationOutput,
  assessment: VerificationEscalation,
): number[] {
  // Lexicographic priority. Coverage loss comes first: a dropped critical fact
  // is invisible to the reviewer and unrecoverable, whereas a compound or
  // questionable-reaffirmed claim is still on screen and editable.
  return [
    assessment.droppedCriticalInventoryKeys.length,
    assessment.comparisonIssues.length,
    assessment.droppedFollowUpInventoryKeys.length,
    assessment.unmappedInventoryKeys.length,
    output.quality_review.unresolved_conflict_keys.length,
    assessment.lowConfidenceRelationClaimKeys.length,
    output.quality_review.compound_claim_keys.length +
      output.quality_review.reaffirmed_issue_claim_keys.length,
  ];
}

/** Keep an already proven display link when review merely annotates the same
 * proposition. Never carry a relation across a changed value or rewritten claim. */
export function retainSupportedComparisonLinks(base: VerificationOutput, reviewed: VerificationOutput, context: ContextPack): VerificationOutput {
  const normalize=(text:string)=>text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
  const segments=new Map(context.new_event.transcript_segments.map(segment=>[segment.id,segment]));
  const hasEvidence=(claim:VerificationOutput['claims'][number])=>claim.evidence.some(e=>(e.kind==='text'||e.kind==='transcript') && e.evidence_role==='direct' && recoverTranscriptEvidence(e.segment_ids,e.quote_hint,segments,{expectedEventId:context.new_event.event_id,allowedSegmentIds:new Set(context.new_event.transcript_segments.filter(s=>s.assetVersionId===e.asset_version_id).map(s=>s.id)),kind:e.kind}).valid);
  const links=[...reviewed.draft_link_candidates];
  for(const link of base.draft_link_candidates){
    if(link.confidence < 0.85 || !context.draft_context.claims.some(target=>target.claimId===link.target_draft_claim_id && target.claimVersionId===link.target_draft_claim_version_id && target.eventId!==context.new_event.event_id))continue;
    if(links.some(saved=>saved.final_claim_key===link.final_claim_key && saved.target_draft_claim_version_id===link.target_draft_claim_version_id))continue;
    const before=base.claims.find(c=>c.client_claim_key===link.final_claim_key),after=reviewed.claims.find(c=>c.client_claim_key===link.final_claim_key);
    if(!before || !after || before.disposition!=='new' || after.disposition!=='new' || !hasEvidence(before) || !hasEvidence(after))continue;
    if(!link.alignment || Object.values(link.alignment).some(value=>!value) || comparisonQualityIssues([before],[link],context).length || comparisonQualityIssues([after],[link],context).length)continue;
    const oldValue=before.normalized_value??{},newValue=after.normalized_value??{};
    if(Object.entries(oldValue).some(([key,value])=>newValue[key]!==value))continue;
    let reviewedText=normalize(after.statement);
    for(const key of ['horizon','date','time']){
      if(oldValue[key]===undefined && typeof newValue[key]==='string'){
        const value=normalize(String(newValue[key]));
        const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        reviewedText=reviewedText.replace(new RegExp(`\\b(?:around |on |by )?${escaped}\\b`,'g'),' ').replace(/\s+/g,' ').trim();
      }
    }
    if(normalize(before.statement)!==reviewedText)continue;
    const refs=(claim:typeof before)=>JSON.stringify(claim.evidence.filter(e=>e.evidence_role==='direct').map(e=>[e.asset_version_id,[...('segment_ids' in e ? e.segment_ids : [])].sort()]).sort());
    if(refs(before)!==refs(after))continue;
    links.push(link);
  }
  return {...reviewed,draft_link_candidates:links};
}

export function selectPreferredVerificationForReview(
  inventory: InventoryOutput,
  base: VerificationOutput,
  candidate: VerificationOutput,
  context?: ContextPack,
  scopedComparisons = false,
  preserveSupportedLinks = false,
): VerificationSelection {
  const baseAssessment = assessVerificationEscalation(inventory, base, context, scopedComparisons);
  const candidateAssessment = assessVerificationEscalation(inventory, candidate, context, scopedComparisons);
  const baseVector = reviewIssueVector(base, baseAssessment);
  const candidateVector = reviewIssueVector(candidate, candidateAssessment);
  let candidateIsBetter = false;
  for (let index = 0; index < candidateVector.length; index += 1) {
    if (candidateVector[index] === baseVector[index]) continue;
    candidateIsBetter = candidateVector[index] < baseVector[index];
    break;
  }

  const selectedCandidate = candidateIsBetter && preserveSupportedLinks && context ? retainSupportedComparisonLinks(base,candidate,context) : candidate;
  return candidateIsBetter
    ? { output: selectedCandidate, assessment: assessVerificationEscalation(inventory,selectedCandidate,context,scopedComparisons), selected: "candidate" }
    : { output: base, assessment: baseAssessment, selected: "base" };
}

/** Known omissions are derived from the paid candidate/disposition ledger. */
export function verificationCoverageWarnings(inventory: InventoryOutput, verification: VerificationOutput): Array<Record<string, unknown>> {
  const warnings: Array<Record<string, unknown>> = [];
  const dispositions = new Map(verification.candidate_dispositions.map(item => [item.inventory_key, item]));
  for (const candidate of inventory.candidates) {
    const disposition = dispositions.get(candidate.inventory_key);
    if (!disposition || disposition.outcome === "lower_priority") warnings.push({
      code: "MODEL_CANDIDATE_OMITTED", inventory_key: candidate.inventory_key,
      statement: candidate.statement, type: candidate.type,
      outcome: disposition ? "lower_priority" : "unmapped",
      reason: disposition?.reason ?? "No final disposition was returned for this source-supported candidate.",
    });
  }
  if (inventory.schema_version === INVENTORY_SCHEMA_VERSION && inventory.candidates.length >= 64) warnings.push({code: "MODEL_INVENTORY_LIMIT_REACHED", limit: 64, observed: inventory.candidates.length});
  if (hasFollowupCoverage(verification.schema_version) && verification.claims.length >= 64) warnings.push({code: "MODEL_FINAL_CLAIM_LIMIT_REACHED", limit: 64, observed: verification.claims.length});
  const followups = hasFollowupCoverage(verification.schema_version) ? inventory.candidates.filter(candidate => (candidate.type === "open_question" || candidate.type === "next_action") && (!dispositions.has(candidate.inventory_key) || dispositions.get(candidate.inventory_key)?.outcome === "lower_priority")).map(candidate => candidate.inventory_key) : [];
  if (followups.length) warnings.push({code: "MODEL_SUPPORTED_FOLLOWUP_OMITTED", inventory_keys: followups});
  return warnings;
}
