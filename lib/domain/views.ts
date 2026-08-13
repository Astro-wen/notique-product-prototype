import type {
  ClaimRelation,
  ClaimWithVersion,
  ProjectLedger,
  VerifiedEvidenceRef,
  WithdrawRecord,
} from "./types";

export const SCENARIO_SEMANTIC_KINDS = {
  realEstateBuyerJourney: "real_estate_buyer_journey",
  unclassified: "unclassified",
} as const;

export type ScenarioSemanticKind =
  (typeof SCENARIO_SEMANTIC_KINDS)[keyof typeof SCENARIO_SEMANTIC_KINDS];

function normalizeScenario(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[_/\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REAL_ESTATE_BUYER_ALIASES = new Set([
  "re buyer journey",
  "real estate buyer journey",
  "residential buyer journey",
]);

const ENGLISH_BUYER_ROLE = [
  /\bhome\s*buyers?\b/,
  /\bbuyers?\b/,
  /\b(?:home|house|property)\s+(?:purchase|purchasing)\b/,
  /\b(?:buying|purchasing)\s+(?:(?:a|the|their|his|her|our|your)\s+(?:home|house|property)|(?:homes|houses|properties))\b/,
];

const ENGLISH_REAL_ESTATE_CONTEXT = [
  /\breal estate\b/,
  /\bresidential\s+(?:home|property)\b/,
  /\b(?:home|house|property)\s+(?:search|showing|purchase|purchasing)\b/,
  /\b(?:buying|purchasing)\s+(?:(?:a|the|their|his|her|our|your)\s+(?:home|house|property)|(?:homes|houses|properties))\b/,
];

const ENGLISH_JOURNEY_STAGE = [
  /\bjourney\b/,
  /\bsearch\b/,
  /\bshowings?\b/,
  /\b(?:pre\s+)?offers?\b/,
  /\bpurchas(?:e|ing)\b/,
  /\bclosing\b/,
];

const CHINESE_BUYER_ROLE = [/(?:购房者|置业者|房产买家|买房|购房|置业)/u];
const CHINESE_REAL_ESTATE_CONTEXT = [
  /(?:房地产|房产|住宅|房屋|楼盘).{0,8}(?:搜索|筛选|搜房|看房|购房|买房|置业|出价)/u,
  /(?:搜索|筛选|搜房|看房|购房|买房|置业|出价).{0,8}(?:房地产|房产|住宅|房屋|楼盘)/u,
];
const CHINESE_JOURNEY_STAGE = [/(?:旅程|流程|搜索|筛选|搜房|看房|出价|购房|买房|置业|成交)/u];

function matchesEveryConcept(value: string, concepts: readonly RegExp[][]) {
  return concepts.every((patterns) => patterns.some((pattern) => pattern.test(value)));
}

/**
 * Classifies only scenario semantics that have domain behavior today. Unknown
 * user-confirmed text stays unclassified so a coincidental keyword cannot turn
 * on a domain-specific gap check.
 */
export function classifyScenarioSemanticKind(
  scenario: string | null | undefined,
): ScenarioSemanticKind {
  if (typeof scenario !== "string") return SCENARIO_SEMANTIC_KINDS.unclassified;
  const normalized = normalizeScenario(scenario);
  if (!normalized) return SCENARIO_SEMANTIC_KINDS.unclassified;
  if (REAL_ESTATE_BUYER_ALIASES.has(normalized)) {
    return SCENARIO_SEMANTIC_KINDS.realEstateBuyerJourney;
  }

  if (
    matchesEveryConcept(normalized, [
      ENGLISH_BUYER_ROLE,
      ENGLISH_REAL_ESTATE_CONTEXT,
      ENGLISH_JOURNEY_STAGE,
    ]) ||
    matchesEveryConcept(normalized, [
      CHINESE_BUYER_ROLE,
      CHINESE_REAL_ESTATE_CONTEXT,
      CHINESE_JOURNEY_STAGE,
    ])
  ) {
    return SCENARIO_SEMANTIC_KINDS.realEstateBuyerJourney;
  }
  return SCENARIO_SEMANTIC_KINDS.unclassified;
}

const MATERIALITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

function byImportanceThenTime(a: ClaimWithVersion, b: ClaimWithVersion) {
  const materiality = MATERIALITY_ORDER[a.materiality] - MATERIALITY_ORDER[b.materiality];
  if (materiality) return materiality;
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function currentVerifiedClaims(claims: readonly ClaimWithVersion[]) {
  return claims
    .filter(
      (claim) => claim.reviewStatus === "verified" && claim.lifecycleStatus === "active",
    )
    .sort(byImportanceThenTime);
}

export function timelineVerifiedClaims(claims: readonly ClaimWithVersion[]) {
  return claims
    .filter((claim) => claim.reviewStatus === "verified")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function readableEventSummary(claims: readonly ClaimWithVersion[]): string {
  const statements = claims
    .filter((claim) => claim.lifecycleStatus !== "withdrawn")
    .slice()
    .sort(byImportanceThenTime)
    .slice(0, 2)
    .map((claim) => claim.version.statement.trim())
    .filter(Boolean)
    .map((statement) => /[.!?。！？]$/u.test(statement) ? statement : `${statement}。`);
  return statements.length ? statements.join(" ") : "本次沟通暂无已确认记录。";
}

export type TimelineDelta =
  | {
      id: string;
      type: "new";
      eventId: string;
      displayText: string;
      afterClaimVersionId: string;
    }
  | {
      id: string;
      type: "superseded" | "resolved" | "contradicted";
      eventId: string;
      displayText: string;
      beforeClaimVersionId: string;
      afterClaimVersionId: string;
      relationId: string;
    }
  | {
      id: string;
      type: "withdrawn";
      eventId: string;
      displayText: string;
      claimVersionId: string;
      withdrawVerdictId: string;
    };

export type TimelineMomentKind =
  | "new"
  | "updated"
  | "resolved"
  | "contradicted"
  | "reaffirmed"
  | "withdrawn";

export type TimelineMomentEndpoint = {
  claimId: string;
  claimVersionId: string;
  statement: string;
  evidenceRefIds: string[];
};

export type TimelineMomentEvidence = {
  evidenceRefId: string;
  kind: VerifiedEvidenceRef["kind"];
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  quoteRaw: string | null;
};

export type TimelineMoment = {
  id: string;
  kind: TimelineMomentKind;
  eventId: string;
  eventSequenceNo: number;
  eventOccurredAt: string;
  displayText: string;
  transcriptStartMs: number | null;
  transcriptEndMs: number | null;
  evidence: TimelineMomentEvidence[];
  before: TimelineMomentEndpoint | null;
  after: TimelineMomentEndpoint | null;
  relationId: string | null;
  occurrenceId: string | null;
  withdrawVerdictId: string | null;
};

function evidencePointers(
  refs: readonly VerifiedEvidenceRef[],
): TimelineMomentEvidence[] {
  return refs.map((ref) => ({
    evidenceRefId: ref.id,
    kind: ref.kind,
    speaker: ref.speakers[0] ?? null,
    startMs: ref.startMs,
    endMs: ref.endMs,
    quoteRaw: ref.quoteRaw,
  }));
}

function momentTimes(evidence: readonly TimelineMomentEvidence[]) {
  const starts = evidence
    .map((ref) => ref.startMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const ends = evidence
    .map((ref) => ref.endMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    transcriptStartMs: starts.length ? Math.min(...starts) : null,
    transcriptEndMs: ends.length ? Math.max(...ends) : null,
  };
}

function timelineEndpoint(
  claim: ClaimWithVersion,
  version: ClaimWithVersion["version"],
): TimelineMomentEndpoint {
  return {
    claimId: claim.id,
    claimVersionId: version.id,
    statement: version.statement,
    evidenceRefIds: [...version.evidenceRefIds],
  };
}

function relationDelta(
  relation: ClaimRelation,
  claimById: ReadonlyMap<string, ClaimWithVersion>,
  versionById: ReadonlyMap<string, ClaimWithVersion["version"]>,
): TimelineDelta | null {
  if (relation.status !== "active" && relation.status !== "inactive") return null;
  if (
    relation.type !== "supersedes" &&
    relation.type !== "resolves" &&
    relation.type !== "contradicts"
  ) return null;

  const afterClaim = claimById.get(relation.sourceClaimId);
  const beforeClaim = claimById.get(relation.targetClaimId);
  const afterVersion = versionById.get(relation.sourceClaimVersionId);
  const beforeVersion = versionById.get(relation.targetClaimVersionId);
  if (
    !afterClaim ||
    !beforeClaim ||
    !afterVersion ||
    !beforeVersion ||
    afterClaim.reviewStatus !== "verified" ||
    beforeClaim.reviewStatus !== "verified" ||
    afterVersion.claimId !== afterClaim.id ||
    beforeVersion.claimId !== beforeClaim.id
  ) {
    return null;
  }
  const type = relation.type === "supersedes"
    ? "superseded"
    : relation.type === "resolves"
      ? "resolved"
      : "contradicted";
  const verb = { superseded: "更新为", resolved: "解决为", contradicted: "与其矛盾" }[type];
  return {
    id: `delta_relation_${relation.id}`,
    type,
    eventId: afterClaim.eventId,
    displayText: `${beforeVersion.statement} ${verb} ${afterVersion.statement}`,
    beforeClaimVersionId: beforeVersion.id,
    afterClaimVersionId: afterVersion.id,
    relationId: relation.id,
  };
}

function withdrawDelta(
  withdraw: WithdrawRecord,
  claimById: ReadonlyMap<string, ClaimWithVersion>,
  versionById: ReadonlyMap<string, ClaimWithVersion["version"]>,
): TimelineDelta | null {
  const claim = claimById.get(withdraw.claimId);
  const version = versionById.get(withdraw.claimVersionId);
  if (
    !claim ||
    !version ||
    version.claimId !== claim.id ||
    claim.reviewStatus !== "verified" ||
    claim.lifecycleStatus !== "withdrawn"
  ) {
    return null;
  }
  return {
    id: `delta_withdraw_${withdraw.id}`,
    type: "withdrawn",
    eventId: claim.eventId,
    displayText: `已撤回：${version.statement}`,
    claimVersionId: version.id,
    withdrawVerdictId: withdraw.id,
  };
}

export function buildTimeline(ledger: ProjectLedger) {
  const verified = timelineVerifiedClaims(ledger.claims);
  const claimById = new Map(verified.map((claim) => [claim.id, claim]));
  const versionById = new Map(
    ledger.claimVersions.map((version) => [version.id, version]),
  );
  const eventById = new Map(ledger.events.map((event) => [event.id, event]));
  const evidenceByVersion = new Map<string, VerifiedEvidenceRef[]>();
  const evidenceById = new Map<string, VerifiedEvidenceRef>();
  for (const ref of ledger.evidenceRefs ?? []) {
    evidenceById.set(ref.id, ref);
    evidenceByVersion.set(ref.claimVersionId, [
      ...(evidenceByVersion.get(ref.claimVersionId) ?? []),
      ref,
    ]);
  }
  const relatedVersions = new Set<string>();
  const deltas: TimelineDelta[] = [];
  const moments: TimelineMoment[] = [];

  function appendMoment(
    input: Omit<
      TimelineMoment,
      "eventSequenceNo" | "eventOccurredAt" | "transcriptStartMs" | "transcriptEndMs"
    >,
  ) {
    const event = eventById.get(input.eventId);
    if (!event) {
      throw new Error("Verified timeline data references an Event outside the project ledger.");
    }
    moments.push({
      ...input,
      eventSequenceNo: event.sequenceNo,
      eventOccurredAt: event.occurredAt,
      ...momentTimes(input.evidence),
    });
  }

  for (const relation of ledger.relations) {
    const delta = relationDelta(relation, claimById, versionById);
    if (!delta) continue;
    if (delta.type === "withdrawn" || delta.type === "new") continue;
    relatedVersions.add(delta.afterClaimVersionId);
    deltas.push(delta);
    const afterClaim = claimById.get(relation.sourceClaimId)!;
    const beforeClaim = claimById.get(relation.targetClaimId)!;
    const afterVersion = versionById.get(relation.sourceClaimVersionId)!;
    const beforeVersion = versionById.get(relation.targetClaimVersionId)!;
    const evidence = evidencePointers(evidenceByVersion.get(afterVersion.id) ?? []);
    appendMoment({
      id: `moment_relation_${relation.id}`,
      kind: relation.type === "supersedes"
        ? "updated"
        : relation.type === "resolves"
          ? "resolved"
          : "contradicted",
      eventId: afterClaim.eventId,
      displayText: delta.displayText,
      evidence,
      before: timelineEndpoint(beforeClaim, beforeVersion),
      after: timelineEndpoint(afterClaim, afterVersion),
      relationId: relation.id,
      occurrenceId: null,
      withdrawVerdictId: null,
    });
  }
  for (const withdraw of ledger.withdraws) {
    const delta = withdrawDelta(withdraw, claimById, versionById);
    if (!delta) continue;
    if (delta.type !== "withdrawn") continue;
    relatedVersions.add(delta.claimVersionId);
    deltas.push(delta);
    const claim = claimById.get(withdraw.claimId)!;
    const version = versionById.get(withdraw.claimVersionId)!;
    appendMoment({
      id: `moment_withdraw_${withdraw.id}`,
      kind: "withdrawn",
      eventId: claim.eventId,
      displayText: delta.displayText,
      evidence: evidencePointers(evidenceByVersion.get(version.id) ?? []),
      before: timelineEndpoint(claim, version),
      after: null,
      relationId: null,
      occurrenceId: null,
      withdrawVerdictId: withdraw.id,
    });
  }
  for (const claim of verified) {
    if (relatedVersions.has(claim.version.id) || claim.lifecycleStatus === "withdrawn") continue;
    deltas.push({
      id: `delta_new_${claim.version.id}`,
      type: "new",
      eventId: claim.eventId,
      displayText: `新增：${claim.version.statement}`,
      afterClaimVersionId: claim.version.id,
    });
    appendMoment({
      id: `moment_new_${claim.version.id}`,
      kind: "new",
      eventId: claim.eventId,
      displayText: `新增：${claim.version.statement}`,
      evidence: evidencePointers(evidenceByVersion.get(claim.version.id) ?? []),
      before: null,
      after: timelineEndpoint(claim, claim.version),
      relationId: null,
      occurrenceId: null,
      withdrawVerdictId: null,
    });
  }
  for (const occurrence of ledger.occurrences ?? []) {
    const claim = claimById.get(occurrence.claimId);
    const version = versionById.get(occurrence.claimVersionId);
    const evidenceRef = evidenceById.get(occurrence.evidenceRefId);
    if (
      !claim ||
      !version ||
      version.claimId !== claim.id ||
      !evidenceRef ||
      evidenceRef.eventId !== occurrence.eventId
    ) continue;
    appendMoment({
      id: `moment_occurrence_${occurrence.id}`,
      kind: "reaffirmed",
      eventId: occurrence.eventId,
      displayText: `再次确认：${version.statement}`,
      evidence: evidencePointers([evidenceRef]),
      before: timelineEndpoint(claim, version),
      after: timelineEndpoint(claim, version),
      relationId: null,
      occurrenceId: occurrence.id,
      withdrawVerdictId: null,
    });
  }

  const groups = ledger.events
    .slice()
    .sort((a, b) => a.sequenceNo - b.sequenceNo)
    .map((event) => {
      const claims = verified.filter((claim) => claim.eventId === event.id);
      return {
        event,
        summary: readableEventSummary(claims),
        claims,
        deltas: deltas.filter((delta) => delta.eventId === event.id),
        moments: moments
          .filter((moment) => moment.eventId === event.id)
          .sort((left, right) =>
            (left.transcriptStartMs ?? Number.MAX_SAFE_INTEGER) -
              (right.transcriptStartMs ?? Number.MAX_SAFE_INTEGER) ||
            left.id.localeCompare(right.id),
          ),
      };
    });

  const orphanEventIds = new Set(
    verified.map((claim) => claim.eventId).filter((eventId) => !eventById.has(eventId)),
  );
  if (orphanEventIds.size) {
    throw new Error("Verified claims reference events outside the project ledger.");
  }
  return groups;
}

export function buildFolderSummary(ledger: ProjectLedger) {
  const current = currentVerifiedClaims(ledger.claims);
  const recentDeltas = buildTimeline(ledger)
    .flatMap((event) => event.deltas)
    .slice(-3)
    .reverse();
  return {
    projectId: ledger.projectId,
    scenario: ledger.scenario.status === "confirmed" ? ledger.scenario.value : null,
    currentClaims: current,
    recentDeltas,
    emptyReason: current.length ? null : "尚无已确认的当前记录。",
  };
}

export function buildDecisionLog(ledger: ProjectLedger) {
  return timelineVerifiedClaims(ledger.claims)
    .filter((claim) => claim.type === "decision" && claim.lifecycleStatus !== "withdrawn")
    .map((claim) => ({
      claimId: claim.id,
      claimVersionId: claim.version.id,
      eventId: claim.eventId,
      lifecycleStatus: claim.lifecycleStatus,
      statement: claim.version.statement,
      selectedOption: claim.version.normalizedValue?.selected_option ?? null,
      rejectedOptions: claim.version.normalizedValue?.rejected_options ?? [],
      reason: claim.version.normalizedValue?.reason ?? null,
      evidenceRefIds: claim.version.evidenceRefIds,
    }));
}

type NormalizedScalar = string | number | boolean;

export type PreferenceHistoryItem = {
  id: string;
  kind: "stated" | "updated" | "reaffirmed" | "withdrawn";
  claimId: string;
  claimVersionId: string;
  eventId: string;
  eventSequenceNo: number;
  eventOccurredAt: string;
  statement: string;
  normalizedValue: Record<string, unknown> | null;
  evidenceRefIds: string[];
  occurrenceId: string | null;
};

function normalizedKey(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function normalizedScalars(value: unknown): NormalizedScalar[] {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) return [value];
  if (Array.isArray(value)) return value.flatMap(normalizedScalars);
  return [];
}

function valuesForNormalizedKeys(
  normalizedValue: Record<string, unknown> | null,
  allowedKeys: ReadonlySet<string>,
) {
  if (!normalizedValue) return [];
  return Object.entries(normalizedValue).flatMap(([key, value]) =>
    allowedKeys.has(normalizedKey(key)) ? normalizedScalars(value) : [],
  );
}

const CONDITION_KEYS = new Set([
  "condition",
  "conditions",
  "precondition",
  "preconditions",
  "contingency",
  "contingencies",
  "onlyif",
  "dependson",
  "purchasecondition",
]);
const DECISION_PERSON_KEYS = new Set([
  "decisionperson",
  "decisionmaker",
  "decisionmakers",
  "approvedby",
  "owner",
]);

/**
 * Builds current preference records with their verified history. Structured
 * fields are copied only from normalized values already present in the Ledger.
 */
export function buildPreferences(ledger: ProjectLedger) {
  const preferences = timelineVerifiedClaims(ledger.claims).filter(
    (claim) => claim.type === "preference",
  );
  const claimById = new Map(preferences.map((claim) => [claim.id, claim]));
  const eventById = new Map(ledger.events.map((event) => [event.id, event]));
  const olderByNewer = new Map<string, string[]>();
  for (const relation of ledger.relations) {
    if (
      relation.type !== "supersedes" ||
      (relation.status !== "active" && relation.status !== "inactive") ||
      !claimById.has(relation.sourceClaimId) ||
      !claimById.has(relation.targetClaimId)
    ) continue;
    olderByNewer.set(relation.sourceClaimId, [
      ...(olderByNewer.get(relation.sourceClaimId) ?? []),
      relation.targetClaimId,
    ]);
  }

  function linkedHistory(root: ClaimWithVersion) {
    const result: ClaimWithVersion[] = [];
    const visited = new Set<string>();
    const visit = (claim: ClaimWithVersion) => {
      if (visited.has(claim.id)) return;
      visited.add(claim.id);
      for (const olderId of olderByNewer.get(claim.id) ?? []) {
        const older = claimById.get(olderId);
        if (older) visit(older);
      }
      result.push(claim);
    };
    visit(root);
    return result.sort((left, right) => {
      const leftEvent = eventById.get(left.eventId);
      const rightEvent = eventById.get(right.eventId);
      return (
        (leftEvent?.sequenceNo ?? Number.MAX_SAFE_INTEGER) -
          (rightEvent?.sequenceNo ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      );
    });
  }

  const roots = preferences
    .filter((claim) => claim.lifecycleStatus === "active")
    .slice()
    .sort(byImportanceThenTime);
  const included = new Set(roots.flatMap((root) => linkedHistory(root).map((claim) => claim.id)));
  roots.push(
    ...preferences.filter(
      (claim) => claim.lifecycleStatus !== "withdrawn" && !included.has(claim.id),
    ),
  );

  return roots.map((root) => {
    const linked = linkedHistory(root);
    const history: PreferenceHistoryItem[] = linked.map((claim, index) => {
      const event = eventById.get(claim.eventId);
      if (!event) throw new Error("Verified Preference references an Event outside the project ledger.");
      return {
        id: `preference_${claim.version.id}`,
        kind: claim.lifecycleStatus === "withdrawn"
          ? "withdrawn"
          : index === 0
            ? "stated"
            : "updated",
        claimId: claim.id,
        claimVersionId: claim.version.id,
        eventId: event.id,
        eventSequenceNo: event.sequenceNo,
        eventOccurredAt: event.occurredAt,
        statement: claim.version.statement,
        normalizedValue: claim.version.normalizedValue,
        evidenceRefIds: [...claim.version.evidenceRefIds],
        occurrenceId: null,
      };
    });
    const linkedIds = new Set(linked.map((claim) => claim.id));
    for (const occurrence of ledger.occurrences ?? []) {
      if (!linkedIds.has(occurrence.claimId)) continue;
      const claim = claimById.get(occurrence.claimId);
      const version = ledger.claimVersions.find(
        (candidate) => candidate.id === occurrence.claimVersionId,
      );
      const event = eventById.get(occurrence.eventId);
      if (!claim || !version || !event) continue;
      history.push({
        id: `preference_occurrence_${occurrence.id}`,
        kind: "reaffirmed",
        claimId: claim.id,
        claimVersionId: version.id,
        eventId: event.id,
        eventSequenceNo: event.sequenceNo,
        eventOccurredAt: event.occurredAt,
        statement: version.statement,
        normalizedValue: version.normalizedValue,
        evidenceRefIds: [occurrence.evidenceRefId],
        occurrenceId: occurrence.id,
      });
    }
    history.sort((left, right) =>
      left.eventSequenceNo - right.eventSequenceNo ||
      left.id.localeCompare(right.id),
    );

    const firstSeen = history[0] ?? null;
    const lastSeen = history.at(-1) ?? null;
    const conditions = valuesForNormalizedKeys(root.version.normalizedValue, CONDITION_KEYS);
    const decisionPeople = valuesForNormalizedKeys(
      root.version.normalizedValue,
      DECISION_PERSON_KEYS,
    ).map(String);
    return {
      claimId: root.id,
      claimVersionId: root.version.id,
      eventId: root.eventId,
      lifecycleStatus: root.lifecycleStatus,
      isCurrent: root.lifecycleStatus === "active",
      statement: root.version.statement,
      currentValue: root.version.normalizedValue,
      conditions,
      decisionPerson: decisionPeople[0] ?? null,
      decisionPeople,
      firstSeen: firstSeen && {
        eventId: firstSeen.eventId,
        eventSequenceNo: firstSeen.eventSequenceNo,
        eventOccurredAt: firstSeen.eventOccurredAt,
        evidenceRefIds: [...firstSeen.evidenceRefIds],
      },
      lastSeen: lastSeen && {
        eventId: lastSeen.eventId,
        eventSequenceNo: lastSeen.eventSequenceNo,
        eventOccurredAt: lastSeen.eventOccurredAt,
        evidenceRefIds: [...lastSeen.evidenceRefIds],
      },
      history,
      evidenceRefIds: [...root.version.evidenceRefIds],
    };
  });
}

export function buildOpenQuestions(ledger: ProjectLedger, asOf: Date = new Date()) {
  return currentVerifiedClaims(ledger.claims)
    .filter((claim) => claim.type === "open_question")
    .map((claim) => {
      const openedAt = claim.openedAt ?? claim.createdAt;
      const openDays = Math.max(
        0,
        Math.floor((asOf.getTime() - new Date(openedAt).getTime()) / 86_400_000),
      );
      return {
        claimId: claim.id,
        claimVersionId: claim.version.id,
        statement: claim.version.statement,
        openedAt,
        lastRepeatedAt: claim.lastRepeatedAt,
        repeatCount: claim.repeatCount,
        openDays: Number.isFinite(openDays) ? openDays : 0,
        evidenceRefIds: claim.version.evidenceRefIds,
      };
    });
}

function claimIsCurrentVerified(claim: ClaimWithVersion | undefined) {
  return claim?.reviewStatus === "verified" && claim.lifecycleStatus === "active";
}

export function buildRisks(ledger: ProjectLedger) {
  const current = currentVerifiedClaims(ledger.claims);
  const claimByVersion = new Map(ledger.claims.map((claim) => [claim.version.id, claim]));
  const contradictions = ledger.relations
    .filter(
      (relation) =>
        relation.type === "contradicts" &&
        relation.status === "active" &&
        relation.contradictionStatus === "open" &&
        claimIsCurrentVerified(claimByVersion.get(relation.sourceClaimVersionId)) &&
        claimIsCurrentVerified(claimByVersion.get(relation.targetClaimVersionId)),
    )
    .map((relation) => {
      const source = claimByVersion.get(relation.sourceClaimVersionId)!;
      const target = claimByVersion.get(relation.targetClaimVersionId)!;
      return {
        relationId: relation.id,
        sourceClaimId: source.id,
        targetClaimId: target.id,
        sourceClaimVersionId: source.version.id,
        targetClaimVersionId: target.version.id,
        sourceStatement: source.version.statement,
        targetStatement: target.version.statement,
        sourceEvidenceRefIds: [...source.version.evidenceRefIds],
        targetEvidenceRefIds: [...target.version.evidenceRefIds],
      };
    });
  return {
    claims: current.filter((claim) => claim.type === "risk" || claim.type === "concern"),
    contradictions,
  };
}

export const RE_BUYER_SLOTS = [
  "budget",
  "financing",
  "timeline",
  "decision_makers",
  "must_haves",
] as const;
export type ReBuyerSlot = (typeof RE_BUYER_SLOTS)[number];

function normalizedSlot(claim: ClaimWithVersion) {
  const value = claim.version.normalizedValue?.slot;
  return typeof value === "string" ? value : null;
}

function matchesSlot(claim: ClaimWithVersion, slot: ReBuyerSlot) {
  if (
    claim.type === "risk" ||
    claim.type === "concern" ||
    claim.type === "open_question"
  ) return false;
  const explicit = normalizedSlot(claim);
  if (explicit === slot) return true;
  if (slot === "budget") return claim.type === "budget";
  if (slot === "timeline") return claim.type === "timing";
  if (slot === "decision_makers") return claim.type === "person_role";
  if (slot === "must_haves") return claim.type === "requirement";
  if (slot === "financing") {
    return /financ|mortgage|pre.?approv|贷款|融资|按揭/i.test(claim.version.statement);
  }
  return false;
}

export function buildGapCheck(ledger: ProjectLedger) {
  if (
    ledger.scenario.status !== "confirmed" ||
    classifyScenarioSemanticKind(ledger.scenario.value) !==
      SCENARIO_SEMANTIC_KINDS.realEstateBuyerJourney
  ) {
    return {
      applicable: false as const,
      scenario: ledger.scenario.status === "confirmed" ? ledger.scenario.value : null,
      missingSlots: [] as ReBuyerSlot[],
      satisfied: {} as Partial<Record<ReBuyerSlot, string[]>>,
    };
  }
  const current = currentVerifiedClaims(ledger.claims);
  const satisfied: Partial<Record<ReBuyerSlot, string[]>> = {};
  for (const slot of RE_BUYER_SLOTS) {
    const matches = current.filter((claim) => matchesSlot(claim, slot)).map((claim) => claim.id);
    if (matches.length) satisfied[slot] = matches;
  }
  return {
    applicable: true as const,
    scenario: ledger.scenario.value,
    missingSlots: RE_BUYER_SLOTS.filter((slot) => !satisfied[slot]?.length),
    satisfied,
  };
}

export type AgendaItem =
  | { id: string; sourceKind: "gap"; slot: ReBuyerSlot; gapCheckId: string }
  | {
      id: string;
      sourceKind: "open_question";
      claimId: string;
      claimVersionId: string;
      statement: string;
      evidenceRefIds: string[];
    }
  | {
      id: string;
      sourceKind: "uncertainty";
      claimId: string;
      claimVersionId: string;
      statement: string;
      reason: string;
      alternatives: string[];
      evidenceRefIds: string[];
    }
  | {
      id: string;
      sourceKind: "evidence_gap";
      claimId: string;
      claimVersionId: string;
      statement: string;
      evidenceRefIds: string[];
    }
  | {
      id: string;
      sourceKind: "contradiction";
      relationId: string;
      sourceClaimId: string;
      targetClaimId: string;
      sourceClaimVersionId: string;
      targetClaimVersionId: string;
      sourceStatement: string;
      targetStatement: string;
      sourceEvidenceRefIds: string[];
      targetEvidenceRefIds: string[];
    };

export function buildNextMeetingAgenda(ledger: ProjectLedger): AgendaItem[] {
  const gap = buildGapCheck(ledger);
  const gapCheckId = `gap_${ledger.projectId}_${ledger.scenario.version}`;
  const items: AgendaItem[] = [];
  for (const contradiction of buildRisks(ledger).contradictions) {
    items.push({
      id: `agenda_contradiction_${contradiction.relationId}`,
      sourceKind: "contradiction",
      ...contradiction,
    });
  }
  for (const question of buildOpenQuestions(ledger)) {
    const claim = ledger.claims.find((candidate) => candidate.version.id === question.claimVersionId);
    if (!claim) continue;
    items.push({
      id: `agenda_question_${question.claimVersionId}`,
      sourceKind: "open_question",
      claimId: claim.id,
      claimVersionId: question.claimVersionId,
      statement: question.statement,
      evidenceRefIds: question.evidenceRefIds,
    });
  }
  for (const claim of currentVerifiedClaims(ledger.claims)) {
    if (claim.type === "open_question" || claim.version.uncertainty === null) continue;
    items.push({
      id: `agenda_uncertainty_${claim.version.id}`,
      sourceKind: "uncertainty",
      claimId: claim.id,
      claimVersionId: claim.version.id,
      statement: claim.version.uncertainty.question,
      reason: claim.version.uncertainty.reason,
      alternatives: [...claim.version.uncertainty.alternatives],
      evidenceRefIds: [...claim.version.evidenceRefIds],
    });
  }
  for (const claim of currentVerifiedClaims(ledger.claims)) {
    if (
      claim.type === "open_question" ||
      claim.version.uncertainty !== null ||
      !claim.needsAdditionalEvidence
    ) continue;
    items.push({
      id: `agenda_evidence_gap_${claim.version.id}`,
      sourceKind: "evidence_gap",
      claimId: claim.id,
      claimVersionId: claim.version.id,
      statement: `补充证据：${claim.version.statement}`,
      evidenceRefIds: [...claim.version.evidenceRefIds],
    });
  }
  items.push(...gap.missingSlots.map((slot) => ({
    id: `agenda_gap_${gapCheckId}_${slot}`,
    sourceKind: "gap" as const,
    slot,
    gapCheckId,
  })));
  return items;
}

export function buildDeterministicBrief(ledger: ProjectLedger) {
  const current = currentVerifiedClaims(ledger.claims);
  const changes = buildTimeline(ledger).flatMap((event) => event.deltas).slice(-2).reverse();
  const agenda = buildNextMeetingAgenda(ledger).slice(0, 2);
  const warning =
    current.find((claim) => claim.type === "risk" || claim.type === "concern") ??
    current.find(
      (claim) =>
        claim.type === "open_question" ||
        claim.needsAdditionalEvidence ||
        claim.version.uncertainty !== null,
    ) ??
    null;
  const state = current.find((claim) => claim.id !== warning?.id) ?? current[0] ?? null;
  const uniqueWarning = warning?.id === state?.id ? null : warning;
  const slots = [state, ...changes, ...agenda, uniqueWarning];
  return {
    stateClaimId: state?.id ?? null,
    deltaItemIds: changes.map((item) => item.id),
    agendaItemIds: agenda.map((item) => item.id),
    riskClaimId: uniqueWarning?.id ?? null,
    missingSlotCount: slots.filter((item) => item == null).length + Math.max(0, 2 - changes.length) + Math.max(0, 2 - agenda.length),
    source: "deterministic_fallback" as const,
  };
}
