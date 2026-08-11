export type ClaimReviewStatus = "pending" | "verified" | "rejected";
export type ClaimLifecycleStatus =
  | "active"
  | "superseded"
  | "resolved"
  | "withdrawn";

export type ClaimType =
  | "budget"
  | "preference"
  | "requirement"
  | "decision"
  | "concern"
  | "risk"
  | "open_question"
  | "person_role"
  | "timing"
  | "property_fact"
  | "material"
  | "measurement"
  | "other";

export type EvidenceRole = "direct" | "corroborating" | "contextual";
export type SemanticSupportVerdict =
  | "fully_supports"
  | "partially_supports"
  | "does_not_support"
  | "unreviewed";

export type TranscriptSegment = {
  id: string;
  assetVersionId: string;
  eventId: string;
  ordinal: number;
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  textRaw: string;
  textNormalized: string;
  parserVersion: string;
};

export type TranscriptEvidencePart = {
  segmentId: string;
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  textRaw: string;
};

export type CanonicalTranscriptEvidence = {
  valid: true;
  kind: "transcript" | "text";
  assetVersionId: string;
  segmentIds: string[];
  quoteRaw: string;
  startMs: number | null;
  endMs: number | null;
  parts: TranscriptEvidencePart[];
  matchMode: "exact" | "normalized";
};

export type InvalidEvidence = {
  valid: false;
  code:
    | "EVIDENCE_ID_INVALID"
    | "EVIDENCE_SCOPE_INVALID"
    | "EVIDENCE_SEGMENT_ORDER_INVALID"
    | "EVIDENCE_QUOTE_MISMATCH"
    | "EVIDENCE_QUOTE_AMBIGUOUS";
  message: string;
};

export type ClaimVersionRecord = {
  id: string;
  claimId: string;
  versionNo: number;
  statement: string;
  normalizedValue: Record<string, unknown> | null;
  uncertainty: {
    reason: string;
    alternatives: string[];
    question: string;
  } | null;
  source: "ai" | "user_edit";
  evidenceRefIds: string[];
  createdAt: string;
};

export type ClaimRecord = {
  id: string;
  projectId: string;
  eventId: string;
  type: ClaimType;
  reviewStatus: ClaimReviewStatus;
  lifecycleStatus: ClaimLifecycleStatus;
  currentVersionId: string;
  materiality: "high" | "medium" | "low";
  confidenceBp: number;
  needsAdditionalEvidence: boolean;
  openedAt: string | null;
  lastRepeatedAt: string | null;
  repeatCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ClaimWithVersion = ClaimRecord & {
  version: ClaimVersionRecord;
};

export type RelationType =
  | "supersedes"
  | "contradicts"
  | "resolves"
  | "informed_by";

export type ClaimRelation = {
  id: string;
  projectId: string;
  sourceClaimId: string;
  sourceClaimVersionId: string;
  targetClaimId: string;
  targetClaimVersionId: string;
  type: RelationType;
  status: "proposed" | "active" | "inactive" | "rejected";
  contradictionStatus: "open" | "resolved" | null;
  createdAt: string;
};

export type WithdrawRecord = {
  id: string;
  claimId: string;
  claimVersionId: string;
  createdAt: string;
};

export type EventRecord = {
  id: string;
  projectId: string;
  title: string;
  occurredAt: string;
  sequenceNo: number;
};

export type ProjectScenario = {
  status: "unassessed" | "assessing" | "pending_confirmation" | "confirmed";
  value: string | null;
  version: number;
};

export type ProjectLedger = {
  projectId: string;
  locale: string;
  scenario: ProjectScenario;
  claims: ClaimWithVersion[];
  claimVersions: ClaimVersionRecord[];
  relations: ClaimRelation[];
  withdraws: WithdrawRecord[];
  events: EventRecord[];
};

export type ApiErrorCode =
  | "INVALID_ARGUMENT"
  | "ASSET_UNSUPPORTED_FORMAT"
  | "ASSET_TOO_LARGE"
  | "TOO_MANY_IMAGES"
  | "IMAGE_CONVERSION_FAILED"
  | "TRANSCRIPT_PARSE_FAILED"
  | "EVENT_NOT_READY"
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_TIMEOUT"
  | "MODEL_OUTPUT_INVALID"
  | "EVIDENCE_VALIDATION_FAILED"
  | "EVIDENCE_SUPPORT_REQUIRED"
  | "RUN_BUDGET_EXCEEDED"
  | "WORKSPACE_RUN_LIMIT"
  | "SCENARIO_CONFIRMATION_REQUIRED"
  | "SCENARIO_VERSION_CONFLICT"
  | "QUEUE_DISPATCH_DELAYED"
  | "CLAIM_VERSION_CONFLICT"
  | "PROJECT_SCOPE_VIOLATION"
  | "INTERNAL_ERROR";

export type ApiErrorEnvelope = {
  error: {
    code: ApiErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
    details?: Record<string, unknown>;
  };
};
