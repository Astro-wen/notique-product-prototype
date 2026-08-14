import type { ClaimWithVersion, ProjectLedger, TranscriptSegment } from "./types";

export const CONTEXT_PACK_SCHEMA_VERSION = "context-pack.v2" as const;

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
  evidenceRefIds: string[];
};

export type ContextPackAsset = {
  assetVersionId: string;
  mimeType: string;
  modelUrl: string;
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
  };
  new_event: {
    event_id: string;
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
}): ContextPack {
  const event = input.ledger.events.find((candidate) => candidate.id === input.eventId);
  if (!event) throw new Error("CONTEXT_EVENT_OUTSIDE_PROJECT");
  if (input.transcriptSegments.some((segment) => segment.eventId !== input.eventId)) {
    throw new Error("CONTEXT_SEGMENT_OUTSIDE_EVENT");
  }

  const verified = input.ledger.claims.filter((claim) => claim.reviewStatus === "verified");
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
        .map(contextClaim),
      recent_history: history.map(contextClaim),
      open_questions: openQuestions.map(contextClaim),
      active_risks: activeRisks.map(contextClaim),
    },
    new_event: {
      event_id: input.eventId,
      transcript_segments: input.transcriptSegments.map((segment) => ({ ...segment })),
      readable_transcript_segments: [],
      photos: [...(input.photos ?? [])],
      documents: [...(input.documents ?? [])],
    },
  };
}
