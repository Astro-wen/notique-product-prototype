import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireScenarioLease,
  applyClaimVerdict,
  confirmScenario,
  DomainConflictError,
  planRelationCarryForward,
  releaseScenarioLease,
  validateExplicitClaimEditProjection,
} from "../lib/domain/claim-state.ts";
import { buildContextPack } from "../lib/domain/context-pack.ts";
import { canonicalizeTranscriptEvidence } from "../lib/domain/evidence.ts";
import {
  EXTRACTION_RUN_LEASE_MS,
  MAX_AI_TIMEOUT_MS,
  normalizeAiTimeoutMs,
  normalizeOpenAiReasoningEffort,
  normalizeVerifierReasoningEffort,
  outboxLeaseDurationMs,
} from "../lib/domain/model-config.ts";
import {
  buildDecisionLog,
  buildFolderSummary,
  buildOpenQuestions,
  buildPreferences,
  buildRisks,
  buildTimeline,
} from "../lib/domain/views.ts";
import {
  cloneLedger,
  transcriptSegments,
} from "./fixtures/qa-domain-fixture.mjs";

const NOW = "2026-08-10T12:00:00.000Z";

test("Luna uses xhigh for inventory and high for verification without max", () => {
  assert.equal(normalizeOpenAiReasoningEffort(undefined), "xhigh");
  assert.equal(normalizeOpenAiReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeOpenAiReasoningEffort("max"), "xhigh");
  assert.equal(normalizeVerifierReasoningEffort(undefined), "high");
  assert.equal(normalizeVerifierReasoningEffort("max"), "high");
});

function segmentMap(segments = transcriptSegments) {
  return new Map(segments.map((segment) => [segment.id, segment]));
}

function canonicalize(segmentIds, quoteHint, options = {}) {
  return canonicalizeTranscriptEvidence(
    segmentIds,
    quoteHint,
    segmentMap(),
    {
      expectedEventId: "event-1",
      allowedSegmentIds: new Set([
        "seg-1",
        "seg-2",
        "seg-3",
        "seg-ambiguous",
        "unknown",
        ...((options.allowedSegmentIds && [...options.allowedSegmentIds]) ?? []),
      ]),
      ...options,
    },
  );
}

function expectConflict(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DomainConflictError);
    assert.equal(error.code, code);
    return true;
  });
}

function nextVersion(source, overrides = {}) {
  return {
    ...source.version,
    id: `${source.id}-v${source.version.versionNo + 1}`,
    versionNo: source.version.versionNo + 1,
    source: "user_edit",
    createdAt: NOW,
    ...overrides,
  };
}

test("canonical evidence copies the exact source quote and source timestamps", () => {
  const result = canonicalize(
    ["seg-1"],
    "Our cap is 1.15 million, not 1.5.",
  );

  assert.equal(result.valid, true);
  assert.equal(result.matchMode, "exact");
  assert.equal(result.quoteRaw, "Our cap is 1.15 million, not 1.5.");
  assert.equal(result.startMs, 12_000);
  assert.equal(result.endMs, 16_000);
  assert.deepEqual(result.parts.map((part) => part.segmentId), ["seg-1"]);
});

test("normalized quote matching changes whitespace and punctuation but preserves raw text", () => {
  const result = canonicalize(
    ["seg-1"],
    "cap is 1.15 million not 1.5",
  );

  assert.equal(result.valid, true);
  assert.equal(result.matchMode, "normalized");
  assert.equal(result.quoteRaw, "cap is 1.15 million, not 1.5");
});

test("normalization never removes a semantic symbol such as a currency sign", () => {
  const currencySegment = {
    ...transcriptSegments[0],
    id: "seg-currency",
    textRaw: "The approved cap is $1.15M.",
    textNormalized: "The approved cap is $1.15M.",
  };
  const result = canonicalizeTranscriptEvidence(
    [currencySegment.id],
    "The approved cap is 1.15M",
    segmentMap([currencySegment]),
    {
      expectedEventId: "event-1",
      allowedSegmentIds: new Set([currencySegment.id]),
    },
  );

  assert.equal(result.valid, false);
  assert.equal(result.code, "EVIDENCE_QUOTE_MISMATCH");
});

test("multi-segment evidence preserves speaker boundaries", () => {
  const result = canonicalize(
    ["seg-2", "seg-3"],
    "We need a quiet area next month",
  );

  assert.equal(result.valid, true);
  assert.equal(result.matchMode, "normalized");
  assert.deepEqual(result.parts.map((part) => part.speaker), ["Buyer", "Partner"]);
  assert.equal(result.startMs, 16_000);
  assert.equal(result.endMs, 21_000);
});

test("canonical evidence rejects ambiguous, missing, reordered, and out-of-scope pointers", () => {
  assert.equal(
    canonicalize(["seg-ambiguous"], "Budget is 1.5M").code,
    "EVIDENCE_QUOTE_AMBIGUOUS",
  );
  assert.equal(
    canonicalize(["unknown"], "anything").code,
    "EVIDENCE_ID_INVALID",
  );
  assert.equal(
    canonicalize(["seg-3", "seg-2"], "anything").code,
    "EVIDENCE_SEGMENT_ORDER_INVALID",
  );
  assert.equal(
    canonicalizeTranscriptEvidence(
      ["seg-other-event"],
      "another event",
      segmentMap(),
      {
        expectedEventId: "event-1",
        allowedSegmentIds: new Set(["seg-other-event"]),
      },
    ).code,
    "EVIDENCE_SCOPE_INVALID",
  );
  assert.equal(
    canonicalize(["seg-1"], "The budget is definitely 1.5M").code,
    "EVIDENCE_QUOTE_MISMATCH",
  );
});

test("verified context excludes pending, rejected, and withdrawn claims and glossary sources", () => {
  const ledger = cloneLedger();
  const pack = buildContextPack({
    ledger,
    contextVersion: 4,
    eventId: "event-1",
    transcriptSegments: transcriptSegments.filter((segment) => segment.eventId === "event-1"),
    glossary: [
      {
        term: "current",
        meaning: "allowed",
        claimVersionId: "claim-budget-current-v1",
      },
      {
        term: "pending",
        meaning: "blocked",
        claimVersionId: "claim-pending-v1",
      },
      {
        term: "withdrawn",
        meaning: "blocked",
        claimVersionId: "claim-withdrawn-v1",
      },
      {
        term: "Nina Patel",
        meaning: "Nena Patel, Nina P.",
        category: "person",
        sourceKind: "manual",
        claimVersionId: null,
      },
      {
        term: "unverified derived term",
        meaning: "blocked",
        category: "general",
        sourceKind: "verified_claim",
        claimVersionId: null,
      },
    ],
  });
  const activeIds = pack.verified_context.active_claims.map((claim) => claim.claimId);
  const historyIds = pack.verified_context.recent_history.map((claim) => claim.claimId);

  assert.ok(activeIds.includes("claim-budget-current"));
  assert.ok(!activeIds.includes("claim-pending"));
  assert.ok(!activeIds.includes("claim-rejected"));
  assert.ok(!activeIds.includes("claim-withdrawn"));
  assert.deepEqual(historyIds.sort(), ["claim-budget-old", "claim-question-resolved"]);
  assert.deepEqual(pack.verified_context.glossary.map((entry) => entry.term), [
    "current",
    "Nina Patel",
  ]);
  assert.equal(pack.verified_context.glossary[1].sourceKind, "manual");

  const currentSections = [
    ...pack.verified_context.active_claims,
    ...pack.verified_context.open_questions,
    ...pack.verified_context.active_risks,
  ];
  const currentIds = currentSections.map((claim) => claim.claimId);
  assert.deepEqual(
    [...currentIds].sort(),
    [
      "claim-budget-current",
      "claim-decision",
      "claim-preference",
      "claim-question",
      "claim-risk",
    ],
  );
  assert.equal(new Set(currentIds).size, currentIds.length);
  assert.deepEqual(
    pack.verified_context.open_questions.map((claim) => claim.claimId),
    ["claim-question"],
  );
  assert.deepEqual(
    pack.verified_context.active_risks.map((claim) => claim.claimId),
    ["claim-risk"],
  );
});

test("long model timeouts remain inside the Run lease and extend the Outbox lease", () => {
  assert.equal(MAX_AI_TIMEOUT_MS, 540_000);
  assert.ok(MAX_AI_TIMEOUT_MS < EXTRACTION_RUN_LEASE_MS);
  assert.equal(normalizeAiTimeoutMs("540000"), 540_000);
  assert.equal(normalizeAiTimeoutMs("600000"), 540_000);
  assert.equal(normalizeAiTimeoutMs("not-a-number"), 90_000);
  assert.equal(outboxLeaseDurationMs(540_000, 3), 1_680_000);
  assert.ok(outboxLeaseDurationMs(540_000, 3) < EXTRACTION_RUN_LEASE_MS);
  assert.equal(outboxLeaseDurationMs(90_000), 150_000);
});

test("formal current views exclude pending, rejected, and withdrawn claims", () => {
  const ledger = cloneLedger();
  ledger.claims.push(
    {
      ...structuredClone(ledger.claims.find((claim) => claim.id === "claim-withdrawn")),
      id: "claim-withdrawn-decision",
      type: "decision",
      currentVersionId: "claim-withdrawn-decision-v1",
      version: {
        ...structuredClone(ledger.claims.find((claim) => claim.id === "claim-withdrawn").version),
        id: "claim-withdrawn-decision-v1",
        claimId: "claim-withdrawn-decision",
      },
    },
    {
      ...structuredClone(ledger.claims.find((claim) => claim.id === "claim-withdrawn")),
      id: "claim-withdrawn-preference",
      type: "preference",
      currentVersionId: "claim-withdrawn-preference-v1",
      version: {
        ...structuredClone(ledger.claims.find((claim) => claim.id === "claim-withdrawn").version),
        id: "claim-withdrawn-preference-v1",
        claimId: "claim-withdrawn-preference",
      },
    },
  );

  assert.ok(
    buildFolderSummary(ledger).currentClaims.every(
      (claim) => claim.reviewStatus === "verified" && claim.lifecycleStatus === "active",
    ),
  );
  assert.ok(buildOpenQuestions(ledger).every((item) => item.claimId !== "claim-pending"));
  assert.ok(buildRisks(ledger).claims.every((claim) => claim.id !== "claim-withdrawn"));
  assert.ok(buildDecisionLog(ledger).every((item) => item.lifecycleStatus !== "withdrawn"));
  assert.ok(buildPreferences(ledger).every((item) => item.lifecycleStatus !== "withdrawn"));

  const timeline = buildTimeline(ledger);
  const historicalClaimIds = timeline.flatMap((group) => group.claims.map((claim) => claim.id));
  assert.ok(!historicalClaimIds.includes("claim-pending"));
  assert.ok(!historicalClaimIds.includes("claim-rejected"));
  assert.ok(historicalClaimIds.includes("claim-withdrawn"));
  assert.ok(
    timeline.flatMap((group) => group.deltas).some(
      (delta) => delta.type === "withdrawn" && delta.claimVersionId === "claim-withdrawn-v1",
    ),
  );
});

test("confirm and reject require a pending claim and the current base version", () => {
  const ledger = cloneLedger();
  const pending = ledger.claims.find((claim) => claim.id === "claim-pending");
  const confirmed = applyClaimVerdict(
    pending,
    { action: "confirm", baseVersionId: pending.currentVersionId },
    NOW,
  );
  assert.equal(confirmed.claim.reviewStatus, "verified");
  assert.equal(confirmed.claim.lifecycleStatus, "active");
  assert.equal(confirmed.contextChanged, true);

  const rejected = applyClaimVerdict(
    pending,
    { action: "reject", baseVersionId: pending.currentVersionId },
    NOW,
  );
  assert.equal(rejected.claim.reviewStatus, "rejected");
  assert.equal(rejected.contextChanged, false);

  const verified = ledger.claims.find((claim) => claim.id === "claim-budget-current");
  expectConflict(
    () => applyClaimVerdict(verified, { action: "reject", baseVersionId: verified.currentVersionId }, NOW),
    "INVALID_STATE_TRANSITION",
  );
  expectConflict(
    () => applyClaimVerdict(pending, { action: "confirm", baseVersionId: "stale-version" }, NOW),
    "CLAIM_VERSION_CONFLICT",
  );
});

test("edit only accepts pending or verified claims that have not been withdrawn", () => {
  const ledger = cloneLedger();
  const rejected = ledger.claims.find((claim) => claim.id === "claim-rejected");
  const withdrawn = ledger.claims.find((claim) => claim.id === "claim-withdrawn");

  for (const source of [rejected, withdrawn]) {
    expectConflict(
      () => applyClaimVerdict(
        source,
        {
          action: "edit",
          baseVersionId: source.currentVersionId,
          nextVersion: nextVersion(source, {
            statement: `${source.version.statement} corrected`,
            evidenceRefIds: ["evidence-user-correction"],
          }),
        },
        NOW,
      ),
      "INVALID_STATE_TRANSITION",
    );
  }
});

test("fact-changing edit needs new evidence and invalidates relations bound to the old version", () => {
  const source = cloneLedger().claims.find((claim) => claim.id === "claim-budget-current");
  expectConflict(
    () => applyClaimVerdict(
      source,
      {
        action: "edit",
        baseVersionId: source.currentVersionId,
        nextVersion: nextVersion(source, {
          statement: "The confirmed budget cap is $1.5M.",
          evidenceRefIds: [],
        }),
      },
      NOW,
    ),
    "INVALID_STATE_TRANSITION",
  );

  const edited = applyClaimVerdict(
    source,
    {
      action: "edit",
      baseVersionId: source.currentVersionId,
      nextVersion: nextVersion(source, {
        statement: "The confirmed budget cap is $1.5M.",
        evidenceRefIds: ["evidence-user-correction"],
      }),
    },
    NOW,
  );
  assert.equal(edited.claim.version.versionNo, 2);
  assert.equal(edited.claim.version.source, "user_edit");
  assert.deepEqual(edited.invalidateRelationVersionIds, ["claim-budget-current-v1"]);
});

test("edit structure is explicit and cannot inherit a hidden normalized value", () => {
  assert.deepEqual(
    validateExplicitClaimEditProjection({
      type: "budget",
      normalizedValue: null,
      needsAdditionalEvidence: false,
      uncertainty: null,
    }),
    { type: "budget", normalizedValue: null, needsAdditionalEvidence: false, uncertainty: null },
  );
  expectConflict(
    () => validateExplicitClaimEditProjection({
      type: "budget",
      normalizedValue: undefined,
      needsAdditionalEvidence: false,
      uncertainty: null,
    }),
    "INVALID_STATE_TRANSITION",
  );
  expectConflict(
    () => validateExplicitClaimEditProjection({
      type: "budget",
      normalizedValue: null,
      needsAdditionalEvidence: false,
      uncertainty: undefined,
    }),
    "INVALID_STATE_TRANSITION",
  );
  expectConflict(
    () => validateExplicitClaimEditProjection({
      type: "budegt",
      normalizedValue: null,
      needsAdditionalEvidence: false,
      uncertainty: null,
    }),
    "INVALID_STATE_TRANSITION",
  );
  expectConflict(
    () => validateExplicitClaimEditProjection({
      type: "budget",
      normalizedValue: null,
      needsAdditionalEvidence: undefined,
      uncertainty: null,
    }),
    "INVALID_STATE_TRANSITION",
  );
  expectConflict(
    () => validateExplicitClaimEditProjection({
      type: "budget",
      normalizedValue: null,
      needsAdditionalEvidence: false,
      uncertainty: {
        reason: "Two readings remain plausible.",
        alternatives: ["6500", "6050"],
        question: "Which amount is correct?",
      },
    }),
    "INVALID_STATE_TRANSITION",
  );
});

test("relation carry-forward keeps only relations the reviewer selected", () => {
  const relations = [{ id: "rel-1" }, { id: "rel-2" }];
  const plan = planRelationCarryForward(relations, ["rel-2"]);
  assert.deepEqual(plan.retained.map((item) => item.id), ["rel-2"]);
  assert.deepEqual(plan.removed.map((item) => item.id), ["rel-1"]);
  expectConflict(
    () => planRelationCarryForward(relations, ["rel-2", "rel-2"]),
    "INVALID_STATE_TRANSITION",
  );
  expectConflict(
    () => planRelationCarryForward(relations, ["rel-missing"]),
    "INVALID_STATE_TRANSITION",
  );
});

test("withdraw removes a verified claim from current context and requests relation invalidation", () => {
  const ledger = cloneLedger();
  const source = ledger.claims.find((claim) => claim.id === "claim-budget-current");
  const result = applyClaimVerdict(
    source,
    { action: "withdraw", baseVersionId: source.currentVersionId },
    NOW,
  );
  assert.equal(result.claim.lifecycleStatus, "withdrawn");
  assert.deepEqual(result.invalidateRelationVersionIds, ["claim-budget-current-v1"]);
  assert.equal(result.contextChanged, true);
  expectConflict(
    () => applyClaimVerdict(result.claim, { action: "withdraw", baseVersionId: result.claim.currentVersionId }, NOW),
    "INVALID_STATE_TRANSITION",
  );
});

test("scenario assessment lease has one owner and can be released after failure", () => {
  const unassessed = {
    status: "unassessed",
    scenarioVersion: 0,
    assessmentRunId: null,
    leaseExpiresAt: null,
    assessmentAttempt: 0,
    scenario: null,
  };
  const first = acquireScenarioLease(unassessed, {
    runId: "run-a",
    now: "2026-08-10T12:00:00.000Z",
    expiresAt: "2026-08-10T12:05:00.000Z",
  });
  const replay = acquireScenarioLease(first, {
    runId: "run-a",
    now: "2026-08-10T12:01:00.000Z",
    expiresAt: "2026-08-10T12:06:00.000Z",
  });
  assert.equal(replay.status, "assessing");
  assert.equal(replay.assessmentRunId, "run-a");
  expectConflict(
    () => acquireScenarioLease(first, {
      runId: "run-b",
      now: "2026-08-10T12:01:00.000Z",
      expiresAt: "2026-08-10T12:06:00.000Z",
    }),
    "SCENARIO_VERSION_CONFLICT",
  );
  assert.equal(releaseScenarioLease(first, "run-b"), first);
  assert.equal(releaseScenarioLease(first, "run-a").status, "unassessed");
});

test("scenario confirmation requires pending confirmation and current scenario version", () => {
  const pending = {
    status: "pending_confirmation",
    scenarioVersion: 3,
    assessmentRunId: "run-a",
    leaseExpiresAt: null,
    assessmentAttempt: 1,
    scenario: null,
  };
  expectConflict(
    () => confirmScenario(pending, { scenarioVersion: 2, scenario: "re_buyer_journey" }),
    "SCENARIO_VERSION_CONFLICT",
  );
  const confirmed = confirmScenario(pending, {
    scenarioVersion: 3,
    scenario: "re_buyer_journey",
  });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.scenario, "re_buyer_journey");
  assert.equal(confirmed.scenarioVersion, 4);
});
