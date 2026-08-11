import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireScenarioLease,
  applyClaimVerdict,
  confirmScenario,
  DomainConflictError,
  releaseScenarioLease,
} from "../../lib/domain/claim-state.ts";
import {
  canonicalizeTranscriptEvidence,
  validateDocumentPage,
  validatePhotoBbox,
} from "../../lib/domain/evidence.ts";
import { parseTranscript } from "../../lib/domain/transcript.ts";
import {
  buildDeterministicBrief,
  buildFolderSummary,
  buildGapCheck,
  buildNextMeetingAgenda,
  buildOpenQuestions,
  buildRisks,
  buildTimeline,
} from "../../lib/domain/views.ts";
import { buildContextPack } from "../../lib/domain/context-pack.ts";
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  decodeProviderNormalizedValues,
  MODEL_CONTRACT_LIMITS,
  UnconfiguredModelProvider,
  validateExtractClaimsOutput,
} from "../../lib/domain/model-contract.ts";

const NOW = "2026-08-10T12:00:00.000Z";

function claim({
  id,
  type = "other",
  reviewStatus = "verified",
  lifecycleStatus = "active",
  eventId = "event-1",
  statement = id,
  materiality = "medium",
  normalizedValue = null,
  evidenceRefIds = [`evidence-${id}`],
  openedAt = null,
  lastRepeatedAt = null,
  repeatCount = 0,
}) {
  const versionId = `${id}-v1`;
  return {
    id,
    projectId: "project-1",
    eventId,
    type,
    reviewStatus,
    lifecycleStatus,
    currentVersionId: versionId,
    materiality,
    confidenceBp: 8000,
    needsAdditionalEvidence: false,
    openedAt,
    lastRepeatedAt,
    repeatCount,
    createdAt: NOW,
    updatedAt: NOW,
    version: {
      id: versionId,
      claimId: id,
      versionNo: 1,
      statement,
      normalizedValue,
      uncertainty: null,
      source: "ai",
      evidenceRefIds,
      createdAt: NOW,
    },
  };
}

function ledger(overrides = {}) {
  const result = {
    projectId: "project-1",
    locale: "zh-CN",
    scenario: { status: "confirmed", value: "re_buyer_journey", version: 2 },
    claims: [],
    relations: [],
    withdraws: [],
    events: [
      {
        id: "event-1",
        projectId: "project-1",
        title: "First meeting",
        occurredAt: NOW,
        sequenceNo: 1,
      },
    ],
    ...overrides,
  };
  result.claimVersions ??= result.claims.map((item) => item.version);
  return result;
}

function validModelOutput() {
  return {
    schema_version: "claim-extraction.v1",
    event_id: "event-1",
    scenario_assessment: null,
    claims: [{
      client_claim_key: "claim-1",
      disposition: "new",
      reaffirmed_target_claim_id: null,
      reaffirmed_target_version_id: null,
      type: "budget",
      statement: "Budget is $1m.",
      normalized_value: { amount: 1_000_000 },
      materiality: "high",
      confidence: 0.9,
      needs_additional_evidence: false,
      uncertainty: null,
      evidence: [{
        kind: "transcript",
        asset_version_id: "asset-version-1",
        segment_ids: ["seg-1"],
        quote_hint: "Budget is $1m",
        evidence_role: "direct",
      }],
      relations: [],
    }],
  };
}

function contextPackWithTarget({
  claimId = "claim-existing",
  claimVersionId = "claim-existing-v1",
  type = "risk",
  statement = "The ceiling stain has an unknown cause and must be investigated before closing the drywall.",
  normalizedValue = { cause_status: "unknown", next_step: "investigate before closing drywall" },
  uncertainty = {
    reason: "The source of the moisture has not been identified.",
    alternatives: ["plumbing", "roof"],
    question: "What caused the ceiling stain?",
  },
} = {}) {
  return {
    schema_version: "context-pack.v2",
    project: { id: "project-1", scenario: "Kitchen renovation", locale: "en-US", context_version: 2 },
    verified_context: {
      glossary: [],
      active_claims: [],
      recent_history: [],
      open_questions: [],
      active_risks: [{
        claimId,
        claimVersionId,
        type,
        statement,
        normalizedValue,
        materiality: "high",
        lifecycleStatus: "active",
        uncertainty,
        openedAt: "2026-08-01T00:00:00.000Z",
        lastRepeatedAt: null,
        repeatCount: 0,
        eventId: "event-previous",
        evidenceRefIds: ["evidence-existing"],
      }],
    },
    new_event: {
      event_id: "event-1",
      transcript_segments: [],
      photos: [],
      documents: [],
    },
  };
}

function reaffirmedOutput(target = contextPackWithTarget().verified_context.active_risks[0]) {
  const output = validModelOutput();
  output.claims[0] = {
    ...output.claims[0],
    disposition: "reaffirmed",
    reaffirmed_target_claim_id: target.claimId,
    reaffirmed_target_version_id: target.claimVersionId,
    type: target.type,
    statement: target.statement,
    normalized_value: structuredClone(target.normalizedValue),
    relations: [],
  };
  return output;
}

test("parses SRT into stable canonical segments", () => {
  const input = `1\n00:00:01,000 --> 00:00:03,500\nBuyer: We can go up to $1.5 million.\n\n2\n00:00:04,000 --> 00:00:05,000\nAgent: Understood.\n`;
  const first = parseTranscript({
    assetVersionId: "asset-v1",
    eventId: "event-1",
    filename: "meeting.srt",
    content: input,
  });
  const second = parseTranscript({
    assetVersionId: "asset-v1",
    eventId: "event-1",
    filename: "meeting.srt",
    content: input,
  });
  assert.equal(first.length, 2);
  assert.equal(first[0].speaker, "Buyer");
  assert.equal(first[0].startMs, 1000);
  assert.equal(first[0].endMs, 3500);
  assert.deepEqual(
    first.map((item) => ({ id: item.id, ordinal: item.ordinal, textRaw: item.textRaw })),
    second.map((item) => ({ id: item.id, ordinal: item.ordinal, textRaw: item.textRaw })),
  );
});

test("does not mistake bracketed timestamps for JSON", () => {
  const segments = parseTranscript({
    assetVersionId: "asset-v2",
    eventId: "event-1",
    content: "[00:01] Maria: Need written approval.\n[00:04] Aaron: I will get it.",
  });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].speaker, "Maria");
  assert.equal(segments[0].startMs, 1000);
});

test("canonicalizes transcript evidence and preserves speaker parts", () => {
  const segments = parseTranscript({
    assetVersionId: "asset-v3",
    eventId: "event-1",
    content: "00:01 Buyer: We can go up to $1.5 million.\n00:04 Agent: Understood.",
  });
  const map = new Map(segments.map((segment) => [segment.id, segment]));
  const result = canonicalizeTranscriptEvidence(
    [segments[0].id],
    "We can go up to $1 5 million",
    map,
    { expectedEventId: "event-1", allowedSegmentIds: new Set(segments.map((item) => item.id)) },
  );
  assert.equal(result.valid, true);
  assert.equal(result.matchMode, "normalized");
  assert.equal(result.parts[0].speaker, "Buyer");
  assert.match(result.quoteRaw, /1\.5 million/);
});

test("rejects out-of-scope and ambiguous transcript evidence", () => {
  const segments = parseTranscript({
    assetVersionId: "asset-v4",
    eventId: "event-1",
    content: "Buyer: yes yes",
  });
  const map = new Map(segments.map((segment) => [segment.id, segment]));
  const scoped = canonicalizeTranscriptEvidence([segments[0].id], "yes", map, {
    expectedEventId: "event-1",
    allowedSegmentIds: new Set(),
  });
  assert.equal(scoped.valid, false);
  assert.equal(scoped.code, "EVIDENCE_SCOPE_INVALID");
  const ambiguous = canonicalizeTranscriptEvidence([segments[0].id], "yes", map, {
    expectedEventId: "event-1",
    allowedSegmentIds: new Set([segments[0].id]),
  });
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.code, "EVIDENCE_QUOTE_AMBIGUOUS");
});

test("validates image boxes and document pages deterministically", () => {
  assert.equal(validatePhotoBbox([0.1, 0.2, 0.8, 0.9]), true);
  assert.equal(validatePhotoBbox([0.8, 0.2, 0.1, 0.9]), false);
  assert.equal(validatePhotoBbox([0, 0, 1.01, 1]), false);
  assert.equal(validateDocumentPage(3, 3), true);
  assert.equal(validateDocumentPage(4, 3), false);
});

test("claim verdicts enforce evidence, versions, and legal transitions", () => {
  const pending = claim({ id: "budget", reviewStatus: "pending", type: "budget" });
  const confirmed = applyClaimVerdict(
    pending,
    { action: "confirm", baseVersionId: pending.currentVersionId },
    NOW,
  );
  assert.equal(confirmed.claim.reviewStatus, "verified");
  assert.equal(confirmed.contextChanged, true);

  assert.throws(
    () => applyClaimVerdict(confirmed.claim, { action: "reject", baseVersionId: confirmed.claim.currentVersionId }, NOW),
    DomainConflictError,
  );
  assert.throws(
    () => applyClaimVerdict(pending, { action: "confirm", baseVersionId: "stale" }, NOW),
    /changed after this review screen/,
  );

  const nextVersion = {
    ...pending.version,
    id: "budget-v2",
    versionNo: 2,
    statement: "Budget is $1.5M",
    evidenceRefIds: [],
    source: "user_edit",
  };
  assert.throws(
    () => applyClaimVerdict(pending, { action: "edit", baseVersionId: pending.currentVersionId, nextVersion }, NOW),
    /needs selected evidence/,
  );
  const edited = applyClaimVerdict(
    pending,
    {
      action: "edit",
      baseVersionId: pending.currentVersionId,
      nextVersion,
      secondaryEvidenceNote: "Customer corrected the amount after the meeting.",
    },
    NOW,
  );
  assert.equal(edited.claim.currentVersionId, "budget-v2");
  assert.deepEqual(edited.invalidateRelationVersionIds, ["budget-v1"]);

  const withdrawn = applyClaimVerdict(
    confirmed.claim,
    { action: "withdraw", baseVersionId: confirmed.claim.currentVersionId },
    NOW,
  );
  assert.equal(withdrawn.claim.lifecycleStatus, "withdrawn");
});

test("scenario assessment lease has a single owner and can recover", () => {
  const base = {
    status: "unassessed",
    scenarioVersion: 1,
    assessmentRunId: null,
    leaseExpiresAt: null,
    assessmentAttempt: 0,
    scenario: null,
  };
  const leased = acquireScenarioLease(base, {
    runId: "run-1",
    now: NOW,
    expiresAt: "2026-08-10T12:05:00.000Z",
  });
  assert.throws(
    () => acquireScenarioLease(leased, {
      runId: "run-2",
      now: "2026-08-10T12:01:00.000Z",
      expiresAt: "2026-08-10T12:06:00.000Z",
    }),
    /currently owns/,
  );
  const released = releaseScenarioLease(leased, "run-1");
  assert.equal(released.status, "unassessed");
  const confirmed = confirmScenario(
    { ...leased, status: "pending_confirmation", scenarioVersion: 2 },
    { scenarioVersion: 2, scenario: "re_buyer_journey" },
  );
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.scenarioVersion, 3);
});

test("formal views never leak pending, rejected, or withdrawn current facts", () => {
  const current = claim({ id: "current", type: "budget", materiality: "high" });
  const pending = claim({ id: "pending", reviewStatus: "pending", type: "risk" });
  const rejected = claim({ id: "rejected", reviewStatus: "rejected", type: "decision" });
  const withdrawn = claim({ id: "withdrawn", lifecycleStatus: "withdrawn", type: "preference" });
  const data = ledger({
    claims: [current, pending, rejected, withdrawn],
    withdraws: [
      { id: "withdraw-verdict-1", claimId: withdrawn.id, claimVersionId: withdrawn.version.id, createdAt: NOW },
    ],
  });
  const summary = buildFolderSummary(data);
  assert.deepEqual(summary.currentClaims.map((item) => item.id), ["current"]);
  const timelineIds = buildTimeline(data).flatMap((event) => event.claims.map((item) => item.id));
  assert.deepEqual(timelineIds.sort(), ["current", "withdrawn"]);
  assert.match(
    buildTimeline(data).flatMap((event) => event.deltas).find((delta) => delta.type === "withdrawn").displayText,
    /已撤回/,
  );
});

test("timeline event summary selects at most two important verified statements", () => {
  const data = ledger({
    claims: [
      claim({ id: "low", materiality: "low", statement: "The backsplash color was discussed." }),
      claim({ id: "medium", materiality: "medium", statement: "Move-in is in September" }),
      claim({ id: "high", materiality: "high", statement: "Budget cap is $1.15M." }),
      claim({ id: "pending-summary", reviewStatus: "pending", materiality: "high", statement: "Pending must stay hidden." }),
      claim({ id: "rejected-summary", reviewStatus: "rejected", materiality: "high", statement: "Rejected must stay hidden." }),
      claim({ id: "withdrawn-summary", lifecycleStatus: "withdrawn", materiality: "high", statement: "Withdrawn must stay hidden." }),
    ],
  });
  const [group] = buildTimeline(data);
  assert.equal(group.summary, "Budget cap is $1.15M. Move-in is in September。");
  assert.doesNotMatch(group.summary, /Pending|Rejected|Withdrawn|backsplash/i);
  assert.doesNotMatch(group.summary, /条已确认|高优先级/);
});

test("timeline keeps a relation that was valid before it became inactive", () => {
  const before = claim({
    id: "budget-before",
    type: "budget",
    lifecycleStatus: "superseded",
    statement: "Budget is $1.15M.",
  });
  const after = claim({
    id: "budget-after",
    type: "budget",
    statement: "Budget is $1.5M.",
  });
  const data = ledger({
    claims: [before, after],
    relations: [{
      id: "relation-1",
      projectId: "project-1",
      sourceClaimId: after.id,
      sourceClaimVersionId: after.version.id,
      targetClaimId: before.id,
      targetClaimVersionId: before.version.id,
      type: "supersedes",
      status: "inactive",
      contradictionStatus: null,
      createdAt: NOW,
    }],
  });

  const deltas = buildTimeline(data).flatMap((event) => event.deltas);
  assert.equal(deltas.some((delta) => delta.relationId === "relation-1"), true);
});

test("timeline resolves inactive relations through non-current claim versions", () => {
  const edited = claim({
    id: "budget-edited",
    type: "budget",
    statement: "Budget is now $1.5M.",
  });
  edited.version = {
    ...edited.version,
    id: "budget-edited-v2",
    versionNo: 2,
    statement: "Budget is now $1.5M.",
    source: "user_edit",
  };
  edited.currentVersionId = edited.version.id;
  const oldVersion = {
    ...edited.version,
    id: "budget-edited-v1",
    versionNo: 1,
    statement: "Budget was $1.15M.",
    source: "ai",
  };
  const replacement = claim({
    id: "budget-replacement",
    type: "budget",
    statement: "Budget increased to $1.3M.",
  });
  const data = ledger({
    claims: [edited, replacement],
    claimVersions: [oldVersion, edited.version, replacement.version],
    relations: [{
      id: "relation-old-version",
      projectId: "project-1",
      sourceClaimId: replacement.id,
      sourceClaimVersionId: replacement.version.id,
      targetClaimId: edited.id,
      targetClaimVersionId: oldVersion.id,
      type: "supersedes",
      status: "inactive",
      contradictionStatus: null,
      createdAt: NOW,
    }],
  });

  const delta = buildTimeline(data)
    .flatMap((event) => event.deltas)
    .find((item) => item.relationId === "relation-old-version");
  assert.ok(delta);
  assert.equal(delta.beforeClaimVersionId, "budget-edited-v1");
  assert.match(delta.displayText, /Budget was \$1\.15M/);
});

test("gap, agenda, risks, and brief use verified sources only", () => {
  const budget = claim({ id: "budget", type: "budget", materiality: "high" });
  const question = claim({
    id: "question",
    type: "open_question",
    statement: "Who is the final decision maker?",
    openedAt: "2026-08-01T00:00:00.000Z",
    lastRepeatedAt: "2026-08-08T00:00:00.000Z",
    repeatCount: 2,
  });
  const risk = claim({ id: "risk", type: "risk", statement: "Financing is not confirmed." });
  const pendingRisk = claim({ id: "pending-risk", type: "risk", reviewStatus: "pending" });
  const data = ledger({ claims: [budget, question, risk, pendingRisk] });
  const gap = buildGapCheck(data);
  assert.equal(gap.applicable, true);
  assert.equal(gap.missingSlots.includes("budget"), false);
  assert.equal(gap.missingSlots.includes("financing"), true);
  assert.equal(buildRisks(data).claims.some((item) => item.id === "pending-risk"), false);
  assert.equal(buildOpenQuestions(data, new Date("2026-08-10T00:00:00.000Z"))[0].openDays, 9);
  assert.equal(buildOpenQuestions(data, new Date("2026-08-10T00:00:00.000Z"))[0].repeatCount, 2);
  const agenda = buildNextMeetingAgenda(data);
  assert.equal(agenda.some((item) => item.sourceKind === "gap"), true);
  assert.equal(agenda.some((item) => item.sourceKind === "open_question"), true);
  const brief = buildDeterministicBrief(data);
  assert.equal(brief.stateClaimId, "budget");
  assert.equal(brief.riskClaimId, "risk");
  assert.equal(brief.deltaItemIds.length <= 2, true);
  assert.equal(brief.agendaItemIds.length <= 2, true);
});

test("risk and agenda contradictions expose both verified statements and evidence", () => {
  const source = claim({
    id: "budget-new",
    type: "budget",
    statement: "Budget is $1.3M.",
    evidenceRefIds: ["evidence-budget-new"],
  });
  const target = claim({
    id: "budget-old",
    type: "budget",
    statement: "Budget is $1.1M.",
    evidenceRefIds: ["evidence-budget-old"],
  });
  const data = ledger({
    claims: [source, target],
    relations: [{
      id: "relation-contradiction",
      projectId: "project-1",
      sourceClaimId: source.id,
      sourceClaimVersionId: source.version.id,
      targetClaimId: target.id,
      targetClaimVersionId: target.version.id,
      type: "contradicts",
      status: "active",
      contradictionStatus: "open",
      createdAt: NOW,
    }],
  });

  const contradiction = buildRisks(data).contradictions[0];
  assert.deepEqual(contradiction, {
    relationId: "relation-contradiction",
    sourceClaimId: "budget-new",
    targetClaimId: "budget-old",
    sourceClaimVersionId: "budget-new-v1",
    targetClaimVersionId: "budget-old-v1",
    sourceStatement: "Budget is $1.3M.",
    targetStatement: "Budget is $1.1M.",
    sourceEvidenceRefIds: ["evidence-budget-new"],
    targetEvidenceRefIds: ["evidence-budget-old"],
  });
  const agendaItem = buildNextMeetingAgenda(data).find(
    (item) => item.sourceKind === "contradiction",
  );
  assert.deepEqual(agendaItem, {
    id: "agenda_contradiction_relation-contradiction",
    sourceKind: "contradiction",
    ...contradiction,
  });
});

test("context pack is verified-only and never includes withdrawn claims", () => {
  const active = claim({ id: "active" });
  const pending = claim({ id: "pending", reviewStatus: "pending" });
  const rejected = claim({ id: "rejected", reviewStatus: "rejected" });
  const withdrawn = claim({ id: "withdrawn", lifecycleStatus: "withdrawn" });
  const resolved = claim({ id: "resolved", lifecycleStatus: "resolved" });
  const data = ledger({ claims: [active, pending, rejected, withdrawn, resolved] });
  const segment = {
    id: "seg-1",
    assetVersionId: "asset-version-1",
    eventId: "event-1",
    ordinal: 0,
    speaker: "Buyer",
    startMs: 0,
    endMs: 1000,
    textRaw: "Hello",
    textNormalized: "Hello",
    parserVersion: "transcript-parser.v1",
  };
  const pack = buildContextPack({
    ledger: data,
    contextVersion: 7,
    eventId: "event-1",
    transcriptSegments: [segment],
    glossary: [
      { term: "allowed", meaning: "yes", claimVersionId: active.version.id },
      { term: "blocked", meaning: "no", claimVersionId: pending.version.id },
    ],
  });
  assert.deepEqual(pack.verified_context.active_claims.map((item) => item.claimId), ["active"]);
  assert.deepEqual(pack.verified_context.recent_history.map((item) => item.claimId), ["resolved"]);
  assert.deepEqual(pack.verified_context.glossary.map((item) => item.term), ["allowed"]);
  assert.equal(pack.schema_version, "context-pack.v2");
  assert.deepEqual(pack.verified_context.active_claims[0].uncertainty, active.version.uncertainty);
  assert.equal(pack.verified_context.active_claims[0].lifecycleStatus, "active");
  assert.equal(pack.verified_context.active_claims[0].repeatCount, active.repeatCount);
});

test("model output contract rejects extra fields and invalid targets", () => {
  const valid = validModelOutput();
  assert.equal(validateExtractClaimsOutput(valid).valid, true);
  assert.equal(validateExtractClaimsOutput({ ...valid, invented: true }).valid, false);
  assert.equal(validateExtractClaimsOutput({
    ...valid,
    claims: [{ ...valid.claims[0], reaffirmed_target_claim_id: "claim-old" }],
  }).valid, false);
});

test("claim extraction prompt contract is v5", () => {
  assert.equal(CLAIM_EXTRACTION_PROMPT_VERSION, "claim-extraction-prompt.v5");
});

test("reaffirmed occurrences are exact target facts and never carry relations", () => {
  const context = contextPackWithTarget();
  const exact = reaffirmedOutput();
  assert.equal(validateExtractClaimsOutput(exact, context).valid, true);

  const relation = {
    type: "resolves",
    target_claim_id: "claim-question",
    target_claim_version_id: "claim-question-v1",
    reason: "A new answer resolves this question.",
    confidence: 0.99,
  };
  const withRelation = structuredClone(exact);
  withRelation.claims[0].relations = [relation];
  const relationResult = validateExtractClaimsOutput(withRelation, context);
  assert.equal(relationResult.valid, false);
  assert.equal(
    relationResult.issues.some((issue) =>
      issue.path === "$.claims[0].relations" && /cannot create claim relations/.test(issue.message)
    ),
    true,
  );

  const wrongVersion = structuredClone(exact);
  wrongVersion.claims[0].reaffirmed_target_version_id = "claim-existing-v0";
  assert.equal(validateExtractClaimsOutput(wrongVersion, context).valid, false);
});

test("relation validation uses exact current targets and mutually exclusive lifecycle semantics", () => {
  const context = contextPackWithTarget();
  const target = context.verified_context.active_risks[0];
  const relation = (type) => ({
    type,
    target_claim_id: target.claimId,
    target_claim_version_id: target.claimVersionId,
    reason: "The new event changes or closes the previous item.",
    confidence: 0.95,
  });

  const resolves = validModelOutput();
  resolves.claims[0].relations = [relation("resolves")];
  assert.equal(validateExtractClaimsOutput(resolves, context).valid, true);

  const missing = structuredClone(resolves);
  missing.claims[0].relations[0].target_claim_id = "claim-not-in-context";
  assert.equal(validateExtractClaimsOutput(missing, context).valid, false);

  const doubleLifecycle = structuredClone(resolves);
  doubleLifecycle.claims[0].relations.push(relation("supersedes"));
  const doubleResult = validateExtractClaimsOutput(doubleLifecycle, context);
  assert.equal(doubleResult.valid, false);
  assert.equal(
    doubleResult.issues.some((issue) => /more than one lifecycle relation/.test(issue.message)),
    true,
  );

  const preferenceContext = contextPackWithTarget({
    type: "preference",
    statement: "The client prefers matte white tile.",
    normalizedValue: { finish: "matte", color: "white" },
    uncertainty: null,
  });
  const invalidResolve = validModelOutput();
  invalidResolve.claims[0].relations = [{
    ...relation("resolves"),
    target_claim_id: preferenceContext.verified_context.active_risks[0].claimId,
    target_claim_version_id: preferenceContext.verified_context.active_risks[0].claimVersionId,
  }];
  const invalidResolveResult = validateExtractClaimsOutput(invalidResolve, preferenceContext);
  assert.equal(invalidResolveResult.valid, false);
  assert.equal(
    invalidResolveResult.issues.some((issue) => /Resolves requires/.test(issue.message)),
    true,
  );

  const historicalContext = structuredClone(context);
  historicalContext.verified_context.recent_history = [{ ...target, lifecycleStatus: "resolved" }];
  historicalContext.verified_context.active_risks = [];
  const historicalRelation = validModelOutput();
  historicalRelation.claims[0].relations = [relation("supersedes")];
  assert.equal(validateExtractClaimsOutput(historicalRelation, historicalContext).valid, false);
});

test("Event 3 mixed facts cannot be hidden inside reaffirmed occurrences", () => {
  const cases = [
    {
      target: {
        type: "risk",
        statement: "A ceiling stain is present, its cause is unknown, and the moisture source must be identified before drywall is closed.",
        normalizedValue: { observed_condition: "ceiling stain", cause_status: "unknown" },
      },
      mixedStatement: "A plumber found and replaced a loose supply connection; the area is dry and Aaron will recheck it before closing drywall.",
      mixedNormalizedValue: {
        cause: "loose supply connection",
        repair_status: "replaced",
        moisture_state: "dry",
        next_step: "recheck before closing drywall",
      },
    },
    {
      target: {
        type: "preference",
        statement: "Maria prefers matte white porcelain tile.",
        normalizedValue: { material: "porcelain tile", color: "white", finish: "matte" },
      },
      mixedStatement: "Daniel approved lot PZ-2408 and Aaron will purchase it after Maria signs the sample sheet.",
      mixedNormalizedValue: {
        material: "porcelain tile",
        color: "white",
        finish: "matte",
        approval_status: "approved",
        purchaser: "Aaron",
        purchase_condition: "after Maria signs the sample sheet",
      },
    },
    {
      target: {
        type: "timing",
        statement: "The planned start date is September 10.",
        normalizedValue: { start_date: "September 10" },
      },
      mixedStatement: "The start remains September 10, work will take five days, and the city inspection was requested for September 16.",
      mixedNormalizedValue: {
        start_date: "September 10",
        duration_working_days: 5,
        inspection_requested_date: "September 16",
      },
    },
  ];

  cases.forEach((item, index) => {
    const context = contextPackWithTarget({
      claimId: `target-${index}`,
      claimVersionId: `target-${index}-v1`,
      ...item.target,
    });
    const target = context.verified_context.active_risks[0];
    const output = reaffirmedOutput(target);
    output.claims[0].statement = item.mixedStatement;
    output.claims[0].normalized_value = item.mixedNormalizedValue;
    const result = validateExtractClaimsOutput(output, context);
    assert.equal(result.valid, false, `mixed reaffirmed case ${index + 1} must fail closed`);
    assert.deepEqual(
      result.issues
        .filter((issue) => issue.path.startsWith("$.claims[0]."))
        .map((issue) => issue.path)
        .sort(),
      ["$.claims[0].normalized_value", "$.claims[0].statement"],
    );
  });
});

test("scenario assessment accepts only two or three candidates", () => {
  const candidate = (index) => ({
    scenario: `Scenario ${index}`,
    confidence: 0.8,
    reason: `Reason ${index}`,
  });
  for (const count of [2, 3]) {
    const output = {
      ...validModelOutput(),
      scenario_assessment: { candidates: Array.from({ length: count }, (_, index) => candidate(index)) },
    };
    assert.equal(validateExtractClaimsOutput(output).valid, true, `${count} candidates must be accepted`);
  }
  for (const count of [0, 1, 4]) {
    const output = {
      ...validModelOutput(),
      scenario_assessment: { candidates: Array.from({ length: count }, (_, index) => candidate(index)) },
    };
    const validated = validateExtractClaimsOutput(output);
    assert.equal(validated.valid, false, `${count} candidates must be rejected`);
    assert.equal(
      validated.issues.some((issue) => issue.path === "$.scenario_assessment.candidates"),
      true,
    );
  }
});

test("strict normalized entry envelopes decode without overwriting duplicate keys", () => {
  const raw = validModelOutput();
  raw.claims[0].normalized_value = {
    entries: [
      { key: "amount", value: 1_000_000 },
      { key: "currency", value: "USD" },
    ],
  };
  const decoded = decodeProviderNormalizedValues(raw, true);
  assert.deepEqual(decoded.issues, []);
  assert.deepEqual(decoded.value.claims[0].normalized_value, {
    amount: 1_000_000,
    currency: "USD",
  });
  assert.equal(Array.isArray(raw.claims[0].normalized_value.entries), true, "raw output must not be mutated");

  const duplicate = validModelOutput();
  duplicate.claims[0].normalized_value = {
    entries: [
      { key: "amount", value: 1 },
      { key: "amount", value: 2 },
    ],
  };
  const rejected = decodeProviderNormalizedValues(duplicate, true);
  assert.equal(rejected.issues.some((issue) => /unique/.test(issue.message)), true);
  assert.equal(Array.isArray(rejected.value.claims[0].normalized_value.entries), true);

  const unwrapped = decodeProviderNormalizedValues(validModelOutput(), true);
  assert.equal(unwrapped.issues.length > 0, true, "strict provider output must use the entry envelope");
});

test("model output contract bounds every nested collection and free-text payload", () => {
  const base = validModelOutput();
  const claim = base.claims[0];
  const evidence = claim.evidence[0];
  const relation = {
    type: "informed_by",
    target_claim_id: "claim-old",
    target_claim_version_id: "claim-old-v1",
    reason: "Related context.",
    confidence: 0.8,
  };

  const invalidOutputs = [
    { ...base, claims: Array(MODEL_CONTRACT_LIMITS.claims + 1).fill(claim) },
    {
      ...base,
      claims: [{
        ...claim,
        evidence: Array(MODEL_CONTRACT_LIMITS.evidencePerClaim + 1).fill(evidence),
      }],
    },
    {
      ...base,
      claims: [{
        ...claim,
        relations: Array(MODEL_CONTRACT_LIMITS.relationsPerClaim + 1).fill(relation),
      }],
    },
    {
      ...base,
      claims: [{
        ...claim,
        evidence: [{
          ...evidence,
          segment_ids: Array(MODEL_CONTRACT_LIMITS.segmentIdsPerEvidence + 1).fill("seg-1"),
        }],
      }],
    },
    {
      ...base,
      claims: [{
        ...claim,
        statement: "x".repeat(MODEL_CONTRACT_LIMITS.statementLength + 1),
      }],
    },
    {
      ...base,
      claims: [{
        ...claim,
        normalized_value: {
          note: "x".repeat(MODEL_CONTRACT_LIMITS.normalizedValueJsonLength + 1),
        },
      }],
    },
    {
      ...base,
      claims: [{
        ...claim,
        uncertainty: {
          reason: "Ambiguous.",
          question: "Which is correct?",
          alternatives: Array(MODEL_CONTRACT_LIMITS.alternativesPerUncertainty + 1)
            .fill("option"),
        },
      }],
    },
  ];

  invalidOutputs.forEach((output, index) => {
    assert.equal(
      validateExtractClaimsOutput(output).valid,
      false,
      `unbounded model output case ${index + 1} must be rejected`,
    );
  });
});

test("unconfigured provider fails clearly without fabricating output", async () => {
  await assert.rejects(() => new UnconfiguredModelProvider().extractClaims(), {
    code: "MODEL_PROVIDER_NOT_CONFIGURED",
  });
});
