import type {
  ClaimRecord,
  ClaimRelation,
  ClaimType,
  ClaimVersionRecord,
  ClaimWithVersion,
} from "./types";

export const CLAIM_TYPE_VALUES = [
  "budget", "preference", "requirement", "decision", "concern", "risk",
  "open_question", "person_role", "timing", "property_fact", "next_action", "material",
  "measurement", "other",
] as const satisfies readonly ClaimType[];

const CLAIM_TYPE_SET = new Set<string>(CLAIM_TYPE_VALUES);

export class DomainConflictError extends Error {
  readonly code: "CLAIM_VERSION_CONFLICT" | "INVALID_STATE_TRANSITION" | "SCENARIO_VERSION_CONFLICT";

  constructor(
    code: DomainConflictError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DomainConflictError";
    this.code = code;
  }
}

export type ClaimVerdictInput =
  | { action: "confirm"; baseVersionId: string }
  | { action: "reject"; baseVersionId: string }
  | {
      action: "edit";
      baseVersionId: string;
      nextVersion: ClaimVersionRecord;
      secondaryEvidenceNote?: string | null;
    }
  | { action: "withdraw"; baseVersionId: string };

export type ClaimVerdictResult = {
  claim: ClaimWithVersion;
  invalidateRelationVersionIds: string[];
  contextChanged: boolean;
};

export type ExplicitClaimEditProjection = {
  type: ClaimType;
  normalizedValue: Record<string, unknown> | null;
  needsAdditionalEvidence: boolean;
  uncertainty: {
    reason: string;
    alternatives: string[];
    question: string;
  } | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A factual edit replaces the whole human-readable and machine-readable
 * projection. Hidden fields may never fall through to the previous version.
 */
export function validateExplicitClaimEditProjection(input: {
  type: unknown;
  normalizedValue: unknown;
  needsAdditionalEvidence: unknown;
  uncertainty: unknown;
}): ExplicitClaimEditProjection {
  if (typeof input.type !== "string" || !CLAIM_TYPE_SET.has(input.type.trim())) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "Edited claim type must be one of the supported Claim types.",
    );
  }
  if (input.normalizedValue !== null && !isRecord(input.normalizedValue)) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "Edited normalized value must be an object or null.",
    );
  }
  if (typeof input.needsAdditionalEvidence !== "boolean") {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "Edited evidence requirement must be reviewed explicitly.",
    );
  }
  if (input.uncertainty !== null) {
    if (!isRecord(input.uncertainty)) {
      throw new DomainConflictError(
        "INVALID_STATE_TRANSITION",
        "Edited uncertainty must be reviewed explicitly.",
      );
    }
    const alternatives = input.uncertainty.alternatives;
    if (
      typeof input.uncertainty.reason !== "string" ||
      typeof input.uncertainty.question !== "string" ||
      !Array.isArray(alternatives) ||
      alternatives.some((item) => typeof item !== "string")
    ) {
      throw new DomainConflictError(
        "INVALID_STATE_TRANSITION",
        "Edited uncertainty has an invalid shape.",
      );
    }
  }
  if (input.uncertainty !== null && input.needsAdditionalEvidence !== true) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "A structured uncertainty must keep the additional-evidence requirement.",
    );
  }
  return {
    type: input.type.trim() as ClaimType,
    normalizedValue: input.normalizedValue,
    needsAdditionalEvidence: input.needsAdditionalEvidence,
    uncertainty: input.uncertainty as ExplicitClaimEditProjection["uncertainty"],
  };
}

export function planRelationCarryForward<T extends { id: string }>(
  eligibleRelations: readonly T[],
  retainedRelationIds: readonly string[],
): { retained: T[]; removed: T[] } {
  if (new Set(retainedRelationIds).size !== retainedRelationIds.length) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "A relation can be reviewed only once.",
    );
  }
  const eligible = new Map(eligibleRelations.map((relation) => [relation.id, relation]));
  for (const relationId of retainedRelationIds) {
    if (!eligible.has(relationId)) {
      throw new DomainConflictError(
        "INVALID_STATE_TRANSITION",
        "A retained relation is no longer eligible for this claim version.",
      );
    }
  }
  const retainedSet = new Set(retainedRelationIds);
  return {
    retained: eligibleRelations.filter((relation) => retainedSet.has(relation.id)),
    removed: eligibleRelations.filter((relation) => !retainedSet.has(relation.id)),
  };
}

function requireVersion(claim: ClaimWithVersion, baseVersionId: string) {
  if (claim.currentVersionId !== baseVersionId || claim.version.id !== baseVersionId) {
    throw new DomainConflictError(
      "CLAIM_VERSION_CONFLICT",
      "The claim changed after this review screen was loaded.",
    );
  }
}

function requirePending(claim: ClaimWithVersion, action: string) {
  if (claim.reviewStatus !== "pending") {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      `${action} only applies to a pending claim.`,
    );
  }
}

export function applyClaimVerdict(
  source: ClaimWithVersion,
  input: ClaimVerdictInput,
  now: string,
): ClaimVerdictResult {
  requireVersion(source, input.baseVersionId);

  if (input.action === "confirm") {
    requirePending(source, "Confirm");
    if (!source.version.evidenceRefIds.length) {
      throw new DomainConflictError(
        "INVALID_STATE_TRANSITION",
        "A claim without evidence cannot be confirmed.",
      );
    }
    return {
      claim: {
        ...source,
        reviewStatus: "verified",
        lifecycleStatus: "active",
        updatedAt: now,
      },
      invalidateRelationVersionIds: [],
      contextChanged: true,
    };
  }

  if (input.action === "reject") {
    requirePending(source, "Reject");
    return {
      claim: { ...source, reviewStatus: "rejected", updatedAt: now },
      invalidateRelationVersionIds: [],
      contextChanged: false,
    };
  }

  if (input.action === "withdraw") {
    if (source.reviewStatus !== "verified" || source.lifecycleStatus === "withdrawn") {
      throw new DomainConflictError(
        "INVALID_STATE_TRANSITION",
        "Withdraw only applies to a verified claim that has not already been withdrawn.",
      );
    }
    return {
      claim: { ...source, lifecycleStatus: "withdrawn", updatedAt: now },
      invalidateRelationVersionIds: [source.currentVersionId],
      contextChanged: true,
    };
  }

  if (
    (source.reviewStatus !== "pending" && source.reviewStatus !== "verified") ||
    source.lifecycleStatus === "withdrawn"
  ) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "Edit only applies to a pending or verified claim that has not been withdrawn.",
    );
  }

  if (!input.nextVersion.statement.trim()) {
    throw new DomainConflictError("INVALID_STATE_TRANSITION", "Edited statement cannot be empty.");
  }
  if (
    input.nextVersion.statement.trim() !== source.version.statement.trim() &&
    input.nextVersion.evidenceRefIds.length === 0 &&
    !input.secondaryEvidenceNote?.trim()
  ) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "A factual edit needs selected evidence or an explicit secondary evidence note.",
    );
  }
  if (
    input.nextVersion.claimId !== source.id ||
    input.nextVersion.versionNo !== source.version.versionNo + 1 ||
    input.nextVersion.source !== "user_edit"
  ) {
    throw new DomainConflictError(
      "INVALID_STATE_TRANSITION",
      "Edited version identity or version number is invalid.",
    );
  }

  return {
    claim: {
      ...source,
      reviewStatus: "verified",
      lifecycleStatus: "active",
      currentVersionId: input.nextVersion.id,
      version: input.nextVersion,
      updatedAt: now,
    },
    invalidateRelationVersionIds: [source.currentVersionId],
    contextChanged: true,
  };
}

export function recalculateLifecycle(
  claim: ClaimRecord,
  relations: readonly ClaimRelation[],
): ClaimRecord {
  if (claim.lifecycleStatus === "withdrawn") return claim;
  const incoming = relations.filter(
    (relation) =>
      relation.status === "active" &&
      relation.targetClaimId === claim.id &&
      relation.targetClaimVersionId === claim.currentVersionId,
  );
  if (incoming.some((relation) => relation.type === "supersedes")) {
    return { ...claim, lifecycleStatus: "superseded" };
  }
  if (incoming.some((relation) => relation.type === "resolves")) {
    return { ...claim, lifecycleStatus: "resolved" };
  }
  return { ...claim, lifecycleStatus: "active" };
}

export type ScenarioLease = {
  status: "unassessed" | "assessing" | "pending_confirmation" | "confirmed";
  scenarioVersion: number;
  assessmentRunId: string | null;
  leaseExpiresAt: string | null;
  assessmentAttempt: number;
  scenario: string | null;
};

export function acquireScenarioLease(
  state: ScenarioLease,
  input: { runId: string; now: string; expiresAt: string },
): ScenarioLease {
  if (state.status === "confirmed" || state.status === "pending_confirmation") {
    throw new DomainConflictError(
      "SCENARIO_VERSION_CONFLICT",
      "Scenario assessment is already complete or awaiting confirmation.",
    );
  }
  const existingExpiry = state.leaseExpiresAt ? Date.parse(state.leaseExpiresAt) : 0;
  const now = Date.parse(input.now);
  if (
    state.status === "assessing" &&
    state.assessmentRunId !== input.runId &&
    Number.isFinite(existingExpiry) &&
    existingExpiry > now
  ) {
    throw new DomainConflictError(
      "SCENARIO_VERSION_CONFLICT",
      "Another run currently owns the scenario assessment lease.",
    );
  }
  return {
    ...state,
    status: "assessing",
    assessmentRunId: input.runId,
    leaseExpiresAt: input.expiresAt,
    assessmentAttempt: state.assessmentAttempt + 1,
  };
}

export function releaseScenarioLease(state: ScenarioLease, runId: string): ScenarioLease {
  if (state.status !== "assessing" || state.assessmentRunId !== runId) return state;
  return {
    ...state,
    status: "unassessed",
    assessmentRunId: null,
    leaseExpiresAt: null,
  };
}

export function confirmScenario(
  state: ScenarioLease,
  input: { scenarioVersion: number; scenario: string },
): ScenarioLease {
  if (
    state.status !== "pending_confirmation" ||
    state.scenarioVersion !== input.scenarioVersion ||
    !input.scenario.trim()
  ) {
    throw new DomainConflictError(
      "SCENARIO_VERSION_CONFLICT",
      "Scenario candidates changed. Refresh before confirming.",
    );
  }
  return {
    ...state,
    status: "confirmed",
    scenario: input.scenario.trim(),
    scenarioVersion: state.scenarioVersion + 1,
    assessmentRunId: null,
    leaseExpiresAt: null,
  };
}
