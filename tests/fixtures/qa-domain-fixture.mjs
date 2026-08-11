const createdAt = "2026-08-01T10:00:00.000Z";

function version(claimId, statement, evidenceRefIds = []) {
  return {
    id: `${claimId}-v1`,
    claimId,
    versionNo: 1,
    statement,
    normalizedValue: null,
    uncertainty: null,
    source: "ai",
    evidenceRefIds,
    createdAt,
  };
}

function claim({
  id,
  type,
  statement,
  reviewStatus = "verified",
  lifecycleStatus = "active",
  eventId = "event-1",
  evidenceRefIds = [`evidence-${id}`],
  openedAt = null,
  lastRepeatedAt = null,
  repeatCount = 0,
}) {
  const currentVersion = version(id, statement, evidenceRefIds);
  return {
    id,
    projectId: "project-1",
    eventId,
    type,
    reviewStatus,
    lifecycleStatus,
    currentVersionId: currentVersion.id,
    materiality: "high",
    confidenceBp: 9000,
    needsAdditionalEvidence: false,
    openedAt,
    lastRepeatedAt,
    repeatCount,
    createdAt,
    updatedAt: createdAt,
    version: currentVersion,
  };
}

export const transcriptSegments = [
  {
    id: "seg-1",
    assetVersionId: "asset-version-1",
    eventId: "event-1",
    ordinal: 1,
    speaker: "Buyer",
    startMs: 12_000,
    endMs: 16_000,
    textRaw: "Our cap is 1.15 million, not 1.5.",
    textNormalized: "Our cap is 1.15 million, not 1.5.",
    parserVersion: "qa-parser.v1",
  },
  {
    id: "seg-2",
    assetVersionId: "asset-version-1",
    eventId: "event-1",
    ordinal: 2,
    speaker: "Buyer",
    startMs: 16_000,
    endMs: 19_000,
    textRaw: "We need a quiet area",
    textNormalized: "We need a quiet area",
    parserVersion: "qa-parser.v1",
  },
  {
    id: "seg-3",
    assetVersionId: "asset-version-1",
    eventId: "event-1",
    ordinal: 3,
    speaker: "Partner",
    startMs: 19_000,
    endMs: 21_000,
    textRaw: "next month.",
    textNormalized: "next month.",
    parserVersion: "qa-parser.v1",
  },
  {
    id: "seg-ambiguous",
    assetVersionId: "asset-version-1",
    eventId: "event-1",
    ordinal: 4,
    speaker: "Buyer",
    startMs: 22_000,
    endMs: 25_000,
    textRaw: "Budget is 1.5M. Budget is 1.5M.",
    textNormalized: "Budget is 1.5M. Budget is 1.5M.",
    parserVersion: "qa-parser.v1",
  },
  {
    id: "seg-other-event",
    assetVersionId: "asset-version-2",
    eventId: "event-2",
    ordinal: 1,
    speaker: "Buyer",
    startMs: 3_000,
    endMs: 5_000,
    textRaw: "This belongs to another event.",
    textNormalized: "This belongs to another event.",
    parserVersion: "qa-parser.v1",
  },
];

export const baseLedger = {
  projectId: "project-1",
  locale: "en-US",
  ledgerVersion: 7,
  contextVersion: 4,
  scenario: {
    status: "confirmed",
    value: "RE Buyer Journey",
    version: 1,
  },
  events: [
    {
      id: "event-1",
      projectId: "project-1",
      title: "Showing 1",
      occurredAt: "2026-08-01T09:00:00.000Z",
      sequenceNo: 1,
    },
    {
      id: "event-2",
      projectId: "project-1",
      title: "Showing 2",
      occurredAt: "2026-08-03T09:00:00.000Z",
      sequenceNo: 2,
    },
  ],
  claims: [
    claim({
      id: "claim-budget-current",
      type: "budget",
      statement: "The confirmed budget cap is $1.15M.",
    }),
    claim({
      id: "claim-decision",
      type: "decision",
      statement: "The buyer chose to continue with the Oak listing.",
    }),
    claim({
      id: "claim-preference",
      type: "preference",
      statement: "The buyer prefers a quiet area.",
    }),
    claim({
      id: "claim-question",
      type: "open_question",
      statement: "Who is the final decision maker?",
    }),
    claim({
      id: "claim-risk",
      type: "risk",
      statement: "Financing approval is not yet documented.",
    }),
    claim({
      id: "claim-budget-old",
      type: "budget",
      statement: "The previous budget cap was $1.0M.",
      lifecycleStatus: "superseded",
    }),
    claim({
      id: "claim-question-resolved",
      type: "open_question",
      statement: "Is the commute limit 30 minutes?",
      lifecycleStatus: "resolved",
    }),
    claim({
      id: "claim-withdrawn",
      type: "risk",
      statement: "The buyer will not consider townhomes.",
      lifecycleStatus: "withdrawn",
    }),
    claim({
      id: "claim-pending",
      type: "budget",
      statement: "The budget increased to $1.5M.",
      reviewStatus: "pending",
      eventId: "event-2",
    }),
    claim({
      id: "claim-rejected",
      type: "preference",
      statement: "The buyer requires a swimming pool.",
      reviewStatus: "rejected",
      eventId: "event-2",
    }),
  ],
  relations: [
    {
      id: "relation-budget",
      projectId: "project-1",
      sourceClaimId: "claim-budget-current",
      sourceClaimVersionId: "claim-budget-current-v1",
      targetClaimId: "claim-budget-old",
      targetClaimVersionId: "claim-budget-old-v1",
      type: "supersedes",
      status: "active",
      contradictionStatus: null,
      createdAt,
    },
    {
      id: "relation-risk",
      projectId: "project-1",
      sourceClaimId: "claim-risk",
      sourceClaimVersionId: "claim-risk-v1",
      targetClaimId: "claim-budget-current",
      targetClaimVersionId: "claim-budget-current-v1",
      type: "informed_by",
      status: "active",
      contradictionStatus: null,
      createdAt,
    },
    {
      id: "relation-withdrawn",
      projectId: "project-1",
      sourceClaimId: "claim-withdrawn",
      sourceClaimVersionId: "claim-withdrawn-v1",
      targetClaimId: "claim-risk",
      targetClaimVersionId: "claim-risk-v1",
      type: "contradicts",
      status: "active",
      contradictionStatus: "open",
      createdAt,
    },
  ],
  withdraws: [
    {
      id: "withdraw-1",
      claimId: "claim-withdrawn",
      claimVersionId: "claim-withdrawn-v1",
      createdAt,
    },
  ],
};

export function cloneLedger() {
  const ledger = structuredClone(baseLedger);
  ledger.claimVersions = ledger.claims.map((claim) => claim.version);
  return ledger;
}

export const unassessedScenario = {
  status: "unassessed",
  scenario: null,
  scenarioVersion: 0,
  contextVersion: 0,
  leaseEventId: null,
  leaseOwner: null,
  leaseExpiresAtMs: null,
};
