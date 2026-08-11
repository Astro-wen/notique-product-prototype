import type {
  ClaimRelation,
  ClaimWithVersion,
  ProjectLedger,
  WithdrawRecord,
} from "./types";

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
  const relatedVersions = new Set<string>();
  const deltas: TimelineDelta[] = [];

  for (const relation of ledger.relations) {
    const delta = relationDelta(relation, claimById, versionById);
    if (!delta) continue;
    if (delta.type === "withdrawn" || delta.type === "new") continue;
    relatedVersions.add(delta.afterClaimVersionId);
    deltas.push(delta);
  }
  for (const withdraw of ledger.withdraws) {
    const delta = withdrawDelta(withdraw, claimById, versionById);
    if (!delta) continue;
    if (delta.type !== "withdrawn") continue;
    relatedVersions.add(delta.claimVersionId);
    deltas.push(delta);
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
  }

  const eventById = new Map(ledger.events.map((event) => [event.id, event]));
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

export function buildPreferences(ledger: ProjectLedger) {
  return timelineVerifiedClaims(ledger.claims)
    .filter(
      (claim) =>
        claim.lifecycleStatus !== "withdrawn" &&
        (claim.type === "preference" || claim.type === "requirement"),
    )
    .map((claim) => ({
      claimId: claim.id,
      claimVersionId: claim.version.id,
      eventId: claim.eventId,
      lifecycleStatus: claim.lifecycleStatus,
      statement: claim.version.statement,
      evidenceRefIds: claim.version.evidenceRefIds,
    }));
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
  if (ledger.scenario.status !== "confirmed" || ledger.scenario.value !== "re_buyer_journey") {
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
  const items: AgendaItem[] = gap.missingSlots.map((slot) => ({
    id: `agenda_gap_${gapCheckId}_${slot}`,
    sourceKind: "gap",
    slot,
    gapCheckId,
  }));
  for (const question of buildOpenQuestions(ledger)) {
    items.push({
      id: `agenda_question_${question.claimVersionId}`,
      sourceKind: "open_question",
      claimVersionId: question.claimVersionId,
      statement: question.statement,
      evidenceRefIds: question.evidenceRefIds,
    });
  }
  for (const contradiction of buildRisks(ledger).contradictions) {
    items.push({
      id: `agenda_contradiction_${contradiction.relationId}`,
      sourceKind: "contradiction",
      ...contradiction,
    });
  }
  return items;
}

export function buildDeterministicBrief(ledger: ProjectLedger) {
  const current = currentVerifiedClaims(ledger.claims);
  const changes = buildTimeline(ledger).flatMap((event) => event.deltas).slice(-2).reverse();
  const agenda = buildNextMeetingAgenda(ledger).slice(0, 2);
  const risk = current.find((claim) => claim.type === "risk" || claim.type === "concern") ?? null;
  const state = current[0] ?? null;
  const slots = [state, ...changes, ...agenda, risk];
  return {
    stateClaimId: state?.id ?? null,
    deltaItemIds: changes.map((item) => item.id),
    agendaItemIds: agenda.map((item) => item.id),
    riskClaimId: risk?.id ?? null,
    missingSlotCount: slots.filter((item) => item == null).length + Math.max(0, 2 - changes.length) + Math.max(0, 2 - agenda.length),
    source: "deterministic_fallback" as const,
  };
}
