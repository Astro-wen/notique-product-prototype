import type { ClaimWithVersion, ProjectLedger, TranscriptSegment } from "./types";
import { conversationTime } from './comparison-order.ts';

export const CONTEXT_PACK_SCHEMA_VERSION = "context-pack.v3" as const;

export type ContextClaim = {
  claimId: string;
  claimVersionId: string;
  type: ClaimWithVersion["type"];
  statement: string;
  normalizedValue: Record<string, unknown> | null;
  materiality: ClaimWithVersion["materiality"];
  lifecycleStatus: ClaimWithVersion["lifecycleStatus"];
  uncertainty: ClaimWithVersion["version"]["uncertainty"];
  openedAt: string | null;
  lastRepeatedAt: string | null;
  repeatCount: number;
  eventId: string;
  eventOccurredAt?: string | null;
  eventTitle?: string;
  evidenceRefIds: string[];
};

export type ContextPackAsset = {
  assetVersionId: string;
  mimeType: string;
  modelUrl: string;
};

/** Current, user-confirmed closure of an item from the very same source. */
export type ClosedFollowupContext = {
  claimId: string;
  claimVersionId: string;
  eventId: string;
  type: 'open_question' | 'next_action';
  statement: string;
  state: 'answered' | 'completed';
  closureRefs: Array<{claimId:string;claimVersionId:string;statement:string}>;
  sourceEvidence: Array<{assetVersionId:string;segmentIds:string[];quoteRaw:string}>;
};

/**
 * A prior unreviewed AI candidate. It may help the verifier notice continuity,
 * but it is deliberately weaker than ContextClaim: it has no lifecycle state
 * and cannot be cited as Evidence or used as a formal Relation target.
 */
export type DraftContextClaim = {
  /** Included only for scoped-comparison runs. */
  normalizedValue?: Record<string, unknown> | null;
  claimId: string;
  claimVersionId: string;
  eventId: string;
  eventSequenceNo: number;
  eventOccurredAt?: string | null;
  eventTitle?: string;
  type: ClaimWithVersion["type"];
  statement: string;
  confidence: number;
  evidenceRefIds: string[];
};

export type ReadableTranscriptContextSegment = {
  readableSegmentKey: string;
  sourceSegmentIds: string[];
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  readableText: string;
  requiresAttention: boolean;
};

export type ContextPack = {
  schema_version: typeof CONTEXT_PACK_SCHEMA_VERSION;
  project: {
    id: string;
    scenario: string | null;
    locale: string;
    context_version: number;
  };
  verified_context: {
    glossary: Array<{
      term: string;
      meaning: string;
      category: string;
      sourceKind: "manual" | "verified_claim";
      claimVersionId: string | null;
    }>;
    active_claims: ContextClaim[];
    recent_history: ContextClaim[];
    open_questions: ContextClaim[];
    active_risks: ContextClaim[];
    /** Only new v9.11 runs carry this field. Paid older inputs stay unchanged. */
    closed_followups?: ClosedFollowupContext[];
  };
  draft_context: {
    enabled: boolean;
    claims: DraftContextClaim[];
  };
  new_event: {
    event_id: string;
    occurred_at?: string | null;
    title?: string;
    transcript_segments: TranscriptSegment[];
    /**
     * Optional reading aid for the verification stage. It is never an
     * authoritative Evidence source; every final citation still resolves
     * against transcript_segments above.
     */
    readable_transcript_segments: ReadableTranscriptContextSegment[];
    photos: ContextPackAsset[];
    documents: ContextPackAsset[];
  };
};

function contextClaim(claim: ClaimWithVersion): ContextClaim {
  return {
    claimId: claim.id,
    claimVersionId: claim.version.id,
    type: claim.type,
    statement: claim.version.statement,
    normalizedValue: claim.version.normalizedValue,
    materiality: claim.materiality,
    lifecycleStatus: claim.lifecycleStatus,
    uncertainty: claim.version.uncertainty,
    openedAt: claim.openedAt,
    lastRepeatedAt: claim.lastRepeatedAt,
    repeatCount: claim.repeatCount,
    eventId: claim.eventId,
    evidenceRefIds: [...claim.version.evidenceRefIds],
  };
}

export function buildContextPack(input: {
  ledger: ProjectLedger;
  contextVersion: number;
  eventId: string;
  transcriptSegments: TranscriptSegment[];
  photos?: ContextPackAsset[];
  documents?: ContextPackAsset[];
  glossary?: Array<{
    term: string;
    meaning: string;
    category?: string;
    sourceKind?: "manual" | "verified_claim";
    claimVersionId: string | null;
  }>;
  draftClaims?: DraftContextClaim[];
  draftContextEnabled?: boolean;
  chronologyEnabled?: boolean;
  sourceIdentityEnabled?: boolean;
  dateReliabilityEnabled?: boolean;
}): ContextPack {
  const event = input.ledger.events.find((candidate) => candidate.id === input.eventId);
  if (!event) throw new Error("CONTEXT_EVENT_OUTSIDE_PROJECT");
  if (input.transcriptSegments.some((segment) => segment.eventId !== input.eventId)) {
    throw new Error("CONTEXT_SEGMENT_OUTSIDE_EVENT");
  }

  const verified = input.ledger.claims.filter((claim) => claim.reviewStatus === "verified");
  const eventTimes=new Map(input.ledger.events.map(item=>[item.id,input.dateReliabilityEnabled && conversationTime(item)===null ? null : item.occurredAt]));
  const eventTitles = new Map(input.ledger.events.map(item => [item.id, item.title]));
  const timedClaim = (claim: ClaimWithVersion): ContextClaim => ({
    ...contextClaim(claim),
    ...(input.chronologyEnabled === false ? {} : { eventOccurredAt: eventTimes.get(claim.eventId) ?? null }),
    ...(input.sourceIdentityEnabled ? { eventTitle: eventTitles.get(claim.eventId) ?? '' } : {}),
  });
  const active = verified.filter((claim) => claim.lifecycleStatus === "active");
  const openQuestions = active.filter((claim) => claim.type === "open_question");
  const activeRisks = active.filter(
    (claim) => claim.type === "risk" || claim.type === "concern",
  );
  const specializedActiveIds = new Set([
    ...openQuestions.map((claim) => claim.id),
    ...activeRisks.map((claim) => claim.id),
  ]);
  const history = verified.filter(
    (claim) => claim.lifecycleStatus === "superseded" || claim.lifecycleStatus === "resolved",
  );
  const allowedVersionIds = new Set(
    verified
      .filter((claim) => claim.lifecycleStatus !== "withdrawn")
      .map((claim) => claim.version.id),
  );
  const glossary = (input.glossary ?? [])
    .filter((entry) =>
      entry.sourceKind === "manual" ||
      (entry.claimVersionId !== null && allowedVersionIds.has(entry.claimVersionId)),
    )
    .map((entry) => ({
      term: entry.term,
      meaning: entry.meaning,
      category: entry.category ?? "general",
      sourceKind: entry.sourceKind ?? "verified_claim",
      claimVersionId: entry.claimVersionId,
    }));
  const orderedDraftClaims = [...(input.draftClaims ?? [])].map(claim => ({
    ...claim,
    eventOccurredAt: input.chronologyEnabled === false ? undefined : input.dateReliabilityEnabled && conversationTime({title:claim.eventTitle ?? eventTitles.get(claim.eventId) ?? '',occurredAt:claim.eventOccurredAt ?? eventTimes.get(claim.eventId) ?? ''})===null ? null : claim.eventOccurredAt ?? eventTimes.get(claim.eventId) ?? null,
    ...(input.sourceIdentityEnabled ? { eventTitle: claim.eventTitle ?? eventTitles.get(claim.eventId) ?? '' } : {}),
  }))
      .filter((claim) => claim.eventId !== input.eventId && claim.evidenceRefIds.length > 0)
      .sort((left, right) =>
        (Date.parse(left.eventOccurredAt ?? '') || left.eventSequenceNo) - (Date.parse(right.eventOccurredAt ?? '') || right.eventSequenceNo) ||
        left.claimVersionId.localeCompare(right.claimVersionId));
  const recentDraftEventIds = new Set(
    [...new Map(
      [...orderedDraftClaims]
        .reverse()
        .map((claim) => [claim.eventId, Date.parse(claim.eventOccurredAt ?? '') || claim.eventSequenceNo] as const),
    ).entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([eventId]) => eventId),
  );
  const draftClaims = input.draftContextEnabled === true
    ? orderedDraftClaims
      .filter((claim) => recentDraftEventIds.has(claim.eventId))
      .slice(-100)
      .map((claim) => ({ ...claim, evidenceRefIds: [...claim.evidenceRefIds] }))
    : [];

  return {
    schema_version: CONTEXT_PACK_SCHEMA_VERSION,
    project: {
      id: input.ledger.projectId,
      scenario:
        input.ledger.scenario.status === "confirmed" ? input.ledger.scenario.value : null,
      locale: input.ledger.locale,
      context_version: input.contextVersion,
    },
    verified_context: {
      glossary,
      // These three arrays partition the active Verified ledger. Keeping open
      // questions and risks in their named sections avoids sending identical
      // claim objects to the model twice.
      active_claims: active
        .filter((claim) => !specializedActiveIds.has(claim.id))
        .map(timedClaim),
      recent_history: history.map(timedClaim),
      open_questions: openQuestions.map(timedClaim),
      active_risks: activeRisks.map(timedClaim),
    },
    draft_context: {
      enabled: input.draftContextEnabled === true,
      claims: draftClaims,
    },
    new_event: {
      event_id: input.eventId,
      ...(input.chronologyEnabled===false?{}:{occurred_at:eventTimes.get(event.id) ?? null}),
      ...(input.sourceIdentityEnabled ? { title: event.title } : {}),
      transcript_segments: input.transcriptSegments.map((segment) => ({ ...segment })),
      readable_transcript_segments: [],
      photos: [...(input.photos ?? [])],
      documents: [...(input.documents ?? [])],
    },
  };
}
