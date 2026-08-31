import type {
  BatchClaimVerdictRequest,
  AssetInitRequest,
  AssetResponse,
  AiDraftAssessmentRecord,
  ApiSuccess,
  ClaimRecord,
  ClaimEvidenceReviewAttestationResponse,
  ClaimVerdictRequest,
  ClaimVerdictResponse,
  CreateManualClaimRequest,
  CreateManualRelationRequest,
  CreateManualRelationResponse,
  CreateEventRequest,
  CreateEventResponse,
  CreateExtractionRunResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateTranscriptImportRequest,
  CreateTranscriptImportResponse,
  FinalizeTranscriptImportRequest,
  FinalizeTranscriptImportResponse,
  GetEventResponse,
  ExtractionRunDebugRecord,
  EventTranscriptSegmentRecord,
  EvidenceContextRecord,
  EvidenceContextResponse,
  GetExtractionRunResponse,
  GetProjectResponse,
  GetWorkflowSnapshotResponse,
  GetReviewSessionResponse,
  GetRunClaimsResponse,
  GetTranscriptionRunResponse,
  CreateTranscriptionRunResponse,
  GetVerifiedViewResponse,
  GlossaryCategory,
  GlossaryEntryRecord,
  GlossaryEntryResponse,
  ListEventsResponse,
  ListGlossaryEntriesResponse,
  ListProjectsResponse,
  ListDeletedProjectsResponse,
  ProjectDeletePreviewResponse,
  ProjectMutationResponse,
  DraftMemoryResponse,
  DraftLinkVerdictResponse,
  ProjectActionsResponse,
  CompleteProjectActionResponse,
  PermanentProjectDeleteResponse,
  EventAiArtifactsResponse,
  EventAiArtifactRecord,
  EventAiArtifactRunRecord,
  ManualRelationTargetRecord,
  ManualRelationType,
  OccurrenceCandidateRecord,
  OccurrenceConversionClaimInput,
  OccurrenceVerdictResponse,
  ScenarioVerdictRequest,
  ScenarioVerdictResponse,
  ReviewSessionResponse,
  WithdrawClaimRequest,
  WorkflowEventStatusSummaryRecord,
  WorkflowSnapshotRecord,
} from "../lib/shared/api-types";

export type Id = string;

export type OccurrenceCandidate = OccurrenceCandidateRecord;
export type OccurrenceNewClaim = OccurrenceConversionClaimInput;
export type GlossaryEntry = GlossaryEntryRecord;
export type GlossaryEntryCategory = GlossaryCategory;
export type RelationTarget = ManualRelationTargetRecord;
export type RelationType = ManualRelationType;
export type TranscriptSegment = EventTranscriptSegmentRecord;
export type AiDraftAssessment = AiDraftAssessmentRecord;
export type WorkflowEventStatusSummary = {
  materialCount: number;
  materialReadyCount: number;
  materialProcessingCount: number;
  materialFailedCount: number;
  transcriptionStatus: WorkflowEventStatusSummaryRecord["transcription_status"];
  extractionStatus: WorkflowEventStatusSummaryRecord["extraction_status"];
  pendingCount: number;
  candidateCount: number;
  summaryStatus: WorkflowEventStatusSummaryRecord["summary_status"];
  readableTranscriptStatus: WorkflowEventStatusSummaryRecord["readable_transcript_status"];
};
export type WorkflowEventSummary = WorkflowSnapshotRecord["events"][number] & {
  statusSummary: WorkflowEventStatusSummary;
};
export type WorkflowSnapshot = Omit<WorkflowSnapshotRecord, "project" | "events"> & {
  project: Project;
  events: WorkflowEventSummary[];
};
export type EventAiArtifactRun = EventAiArtifactRunRecord;
export type EventAiArtifact = EventAiArtifactRecord;
export type ProjectDeletePreview = ProjectDeletePreviewResponse["data"]["preview"];
export type DraftMemory = DraftMemoryResponse["data"]["draft_memory"];
export type ProjectAction = ProjectActionsResponse["data"]["actions"][number];

export type RunReview = {
  claims: Claim[];
  occurrenceCandidates: OccurrenceCandidate[];
};

export type RunDebug = {
  requestId: string;
  data: ExtractionRunDebugRecord;
};

export type ApiIssue = {
  code: string;
  message: string;
  requestId?: string;
  status: number;
  details?: unknown;
};

export class ApiClientError extends Error implements ApiIssue {
  code: string;
  requestId?: string;
  status: number;
  details?: unknown;

  constructor(issue: ApiIssue) {
    super(issue.message);
    this.name = "ApiClientError";
    this.code = issue.code;
    this.requestId = issue.requestId;
    this.status = issue.status;
    this.details = issue.details;
  }
}

export type ScenarioCandidate = {
  key: string;
  label: string;
  confidence?: number;
  description?: string;
};

export type Project = {
  id: Id;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  eventCount?: number;
  pendingCount?: number;
  pendingClaimCount: number;
  pendingOccurrenceCount: number;
  ledgerVersion: number;
  contextVersion: number;
  scenarioStatus?: "unassessed" | "assessing" | "pending_confirmation" | "confirmed";
  scenarioVersion?: number;
  scenario?: { key: string; label: string };
  scenarioCandidates?: ScenarioCandidate[];
  deletedAt?: string;
};

export type ReviewSession = {
  id: Id;
  projectId: Id;
  status: "active" | "completed" | "abandoned";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  initialPendingClaimCount: number;
  initialPendingOccurrenceCount: number;
  remainingPendingClaimCount: number;
  remainingPendingOccurrenceCount: number;
  outcome: {
    confirmedClaimCount: number;
    editedClaimCount: number;
    rejectedClaimCount: number;
    humanAddedClaimCount: number;
    confirmedOccurrenceCount: number;
    rejectedOccurrenceCount: number;
    acceptedRelationCount: number;
    rejectedRelationCount: number;
  };
};

export type Asset = {
  id: Id;
  versionId?: Id;
  filename: string;
  kind?: string;
  contentType?: string;
  sizeBytes?: number;
  status?: string;
  metadata: Record<string, unknown>;
  transform?: Record<string, unknown>;
};

export type TranscriptionRun = {
  id: Id;
  eventId: Id;
  audioAssetId: Id;
  status: string;
  model: string;
  orchestrationMode: "single" | "chunked" | "chunk";
  parentRunId?: Id;
  chunkIndex?: number;
  chunkStartMs?: number;
  chunkEndMs?: number;
  chunkCount?: number;
  completedChunkCount: number;
  derivedTranscriptAssetId?: Id;
  segmentCount?: number;
  durationMs?: number;
  createdAt?: string;
  queuedAt?: string;
  firstQueuedAt?: string;
  currentQueuedAt?: string;
  startedAt?: string;
  firstStartedAt?: string;
  currentStartedAt?: string;
  processingAttemptNo?: number;
  dispatchAttemptNo?: number;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  segments: Array<{
    id: Id;
    ordinal: number;
    speaker: string;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  chunks: Array<{
    id: Id;
    index: number;
    startMs: number;
    endMs: number;
    status: string;
    processingAttemptNo: number;
    errorCode?: string;
  }>;
};

export type ExtractionRun = {
  id: Id;
  eventId?: Id;
  idempotencyKey?: string;
  inputAssetVersionIds?: string[];
  status: string;
  warningCount?: number;
  claimCount?: number;
  errorCode?: string;
  errorMessage?: string;
  pipelineStage?: "inventory" | "verify" | "verify_escalated";
  createdAt?: string;
  queuedAt?: string;
  firstQueuedAt?: string;
  currentQueuedAt?: string;
  startedAt?: string;
  firstStartedAt?: string;
  currentStartedAt?: string;
  processingAttemptNo?: number;
  dispatchAttemptNo?: number;
  finishedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  stages: Array<{
    stage: "inventory" | "verify" | "verify_escalated";
    status: "processing" | "succeeded" | "failed";
    attempt: number;
    reasoningEffort: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
  }>;
};

export type Event = {
  id: Id;
  projectId?: Id;
  title: string;
  eventType?: string;
  occurredAt?: string;
  createdAt?: string;
  status?: string;
  pendingClaimCount: number;
  pendingOccurrenceCount: number;
  assets: Asset[];
  latestRun?: ExtractionRun;
  latestRunId?: Id;
};

export type EvidenceRef = {
  id: Id;
  kind: string;
  role?: string;
  quote?: string;
  speaker?: string;
  timestampStart?: string | number;
  timestampEnd?: string | number;
  filename?: string;
  page?: number;
  imageUrl?: string;
  viewUrl?: string;
  caption?: string;
  assetId?: Id;
  eventId?: Id;
  segmentIds: Id[];
  audioUrl?: string;
};

export type EvidenceContext = EvidenceContextRecord;

export type Claim = {
  id: Id;
  versionId: Id;
  runId?: Id;
  source: "ai" | "human" | "occurrence_conversion";
  eventId?: Id;
  eventTitle?: string;
  type: string;
  statement: string;
  normalizedValue: Record<string, unknown> | null;
  needsAdditionalEvidence: boolean;
  uncertainty?: unknown;
  confidence?: number;
  reviewStatus: string;
  lifecycle?: string;
  evidenceCount?: number;
  evidenceRefs: EvidenceRef[];
  evidenceRefIds: Id[];
  relationsForReview: ClaimRelationForReview[];
  batchReviewAttested: boolean;
  createdAt?: string;
};

export type ClaimRelationForReview = {
  id: Id;
  type: "supersedes" | "contradicts" | "resolves" | "informed_by";
  status: "proposed" | "active";
  targetClaimId: Id;
  targetClaimVersionId: Id;
  targetStatement: string;
  reason?: string;
  confidence?: number;
};

export type ClaimEditSubmission = {
  statement: string;
  type: string;
  normalizedValue: Record<string, unknown> | null;
  needsAdditionalEvidence: boolean;
  uncertainty: {
    reason: string;
    alternatives: string[];
    question: string;
  } | null;
  retainRelationIds: string[];
  evidenceRefIds: string[];
  secondaryEvidenceNote?: string;
};

export type ImportItem = {
  id: Id;
  uploadUrl?: string;
};

export type ImportSession = {
  id: Id;
  items: ImportItem[];
};

export type ProjectViewName =
  | "client-progress"
  | "actions"
  | "folder-summary"
  | "timeline"
  | "decisions"
  | "preferences"
  | "open-questions"
  | "risks"
  | "gap-check"
  | "next-meeting-agenda"
  | "brief-card";

type BatchClaimVerdictResponse = ApiSuccess<{
  verdicts: Array<{ claim: ClaimRecord; verdict_id: string }>;
}>;

type WithdrawClaimResponse = ApiSuccess<{
  claim: ClaimRecord;
  verdict_id: string;
}>;

type RelationVerdictResponse = ApiSuccess<{
  relation_verdict: {
    relation_id: string;
    verdict_id: string;
    status: "resolved";
  };
}>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pick<T>(object: JsonRecord, keys: string[], fallback?: T): T | undefined {
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return fallback;
}

function unwrap(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.data !== undefined) return value.data;
  return value;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeScenarioCandidate(value: unknown): ScenarioCandidate | null {
  if (!isRecord(value)) return null;
  const key = asString(pick(value, ["key", "scenario", "scenario_key", "slug", "id"]));
  if (!key) return null;
  return {
    key,
    label: asString(pick(value, ["label", "name", "scenario_label"]), key.replaceAll("_", " ")),
    confidence: asNumber(pick(value, ["confidence", "score"])),
    description: asString(pick(value, ["description", "reason"]), undefined as unknown as string) || undefined,
  };
}

export function normalizeProject(value: unknown): Project {
  const source = isRecord(unwrap(value)) ? (unwrap(value) as JsonRecord) : {};
  const scenarioValue = pick<unknown>(source, ["scenario", "confirmed_scenario"]);
  const scenario = isRecord(scenarioValue)
    ? {
        key: asString(pick(scenarioValue, ["key", "scenario", "slug", "id"])),
        label: asString(pick(scenarioValue, ["label", "name"])),
      }
    : typeof scenarioValue === "string"
      ? { key: scenarioValue, label: scenarioValue.replaceAll("_", " ") }
      : undefined;
  const rawCandidates = pick<unknown[]>(source, ["scenario_candidates", "scenarioCandidates", "candidates"], []) ?? [];
  const pendingClaimCount = asNumber(pick(source, ["pending_claim_count", "pendingClaimCount"])) ?? 0;
  const pendingOccurrenceCount = asNumber(pick(source, ["pending_occurrence_count", "pendingOccurrenceCount"])) ?? 0;
  return {
    id: asString(pick(source, ["id", "project_id", "projectId"])),
    name: asString(pick(source, ["name", "title"]), "Untitled project"),
    description: asString(pick(source, ["description"]), undefined as unknown as string) || undefined,
    createdAt: asString(pick(source, ["created_at", "createdAt"]), undefined as unknown as string) || undefined,
    updatedAt: asString(pick(source, ["updated_at", "updatedAt"]), undefined as unknown as string) || undefined,
    eventCount: asNumber(pick(source, ["event_count", "eventCount", "events_count"])),
    pendingCount: pendingClaimCount + pendingOccurrenceCount,
    pendingClaimCount,
    pendingOccurrenceCount,
    ledgerVersion: asNumber(pick(source, ["ledger_version", "ledgerVersion"])) ?? 0,
    contextVersion: asNumber(pick(source, ["context_version", "contextVersion"])) ?? 0,
    scenarioStatus: pick(source, ["scenario_status", "scenarioStatus"]),
    scenarioVersion: asNumber(pick(source, ["scenario_version", "scenarioVersion"])),
    scenario: scenario?.key ? { key: scenario.key, label: scenario.label || scenario.key } : undefined,
    scenarioCandidates: rawCandidates.map(normalizeScenarioCandidate).filter((item): item is ScenarioCandidate => Boolean(item)),
    deletedAt: asString(pick(source, ["deleted_at", "deletedAt"]), undefined as unknown as string) || undefined,
  };
}

function normalizeReviewSession(value: unknown): ReviewSession | null {
  if (!isRecord(value)) return null;
  const id = asString(pick(value, ["id"]));
  const projectId = asString(pick(value, ["project_id", "projectId"]));
  const status = asString(pick(value, ["status"]));
  const startedAt = asString(pick(value, ["started_at", "startedAt"]));
  if (
    !id ||
    !projectId ||
    !startedAt ||
    !["active", "completed", "abandoned"].includes(status)
  ) return null;
  return {
    id,
    projectId,
    status: status as ReviewSession["status"],
    startedAt,
    completedAt: asString(
      pick(value, ["completed_at", "completedAt"]),
      undefined as unknown as string,
    ) || undefined,
    durationMs: asNumber(pick(value, ["duration_ms", "durationMs"])),
    initialPendingClaimCount:
      asNumber(pick(value, ["initial_pending_claim_count", "initialPendingClaimCount"])) ?? 0,
    initialPendingOccurrenceCount:
      asNumber(
        pick(value, ["initial_pending_occurrence_count", "initialPendingOccurrenceCount"]),
      ) ?? 0,
    remainingPendingClaimCount:
      asNumber(
        pick(value, ["remaining_pending_claim_count", "remainingPendingClaimCount"]),
      ) ?? 0,
    remainingPendingOccurrenceCount:
      asNumber(
        pick(value, [
          "remaining_pending_occurrence_count",
          "remainingPendingOccurrenceCount",
        ]),
      ) ?? 0,
    outcome: {
      confirmedClaimCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["confirmed_claim_count", "confirmedClaimCount"])) ?? 0,
      editedClaimCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["edited_claim_count", "editedClaimCount"])) ?? 0,
      rejectedClaimCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["rejected_claim_count", "rejectedClaimCount"])) ?? 0,
      humanAddedClaimCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["human_added_claim_count", "humanAddedClaimCount"])) ?? 0,
      confirmedOccurrenceCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["confirmed_occurrence_count", "confirmedOccurrenceCount"])) ?? 0,
      rejectedOccurrenceCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["rejected_occurrence_count", "rejectedOccurrenceCount"])) ?? 0,
      acceptedRelationCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["accepted_relation_count", "acceptedRelationCount"])) ?? 0,
      rejectedRelationCount: asNumber(pick(isRecord(value.outcome) ? value.outcome : {}, ["rejected_relation_count", "rejectedRelationCount"])) ?? 0,
    },
  };
}

function normalizeAsset(value: unknown): Asset | null {
  if (!isRecord(value)) return null;
  const rawVersion = pick<unknown>(value, ["version", "current_version"]);
  const version = isRecord(rawVersion) ? rawVersion : value;
  const id = asString(pick(value, ["id", "asset_id", "assetId"]));
  if (!id) return null;
  return {
    id,
    versionId: asString(pick(value, ["current_version_id", "version_id", "asset_version_id", "versionId"]), undefined as unknown as string) || asString(pick(version, ["id"]), undefined as unknown as string) || undefined,
    filename: asString(pick(value, ["filename", "name"]), "Untitled file"),
    kind: asString(pick(value, ["kind", "asset_kind", "type"]), undefined as unknown as string) || undefined,
    contentType: asString(pick(value, ["content_type", "mime_type", "contentType"]), undefined as unknown as string) || asString(pick(version, ["mime_type"]), undefined as unknown as string) || undefined,
    sizeBytes: asNumber(pick(value, ["size_bytes", "sizeBytes", "size"])) ?? asNumber(pick(version, ["size_bytes"])),
    status: asString(pick(value, ["status", "processing_status"]), undefined as unknown as string) || undefined,
    metadata: isRecord(pick(value, ["metadata"]))
      ? pick(value, ["metadata"]) as Record<string, unknown>
      : {},
    transform: isRecord(pick(version, ["transform"]))
      ? pick(version, ["transform"]) as Record<string, unknown>
      : undefined,
  };
}

function normalizeTranscriptionRun(value: unknown): TranscriptionRun {
  const source = isRecord(unwrap(value)) ? unwrap(value) as JsonRecord : {};
  const segments = Array.isArray(source.segments) ? source.segments : [];
  const errorDetails = isRecord(source.error_details) ? source.error_details : {};
  const chunks = Array.isArray(source.chunks) ? source.chunks : [];
  return {
    id: asString(pick(source, ["id", "run_id"])),
    eventId: asString(pick(source, ["event_id"])),
    audioAssetId: asString(pick(source, ["audio_asset_id"])),
    status: asString(pick(source, ["status"]), "unknown"),
    model: asString(pick(source, ["model"])),
    orchestrationMode: asString(
      pick(source, ["orchestration_mode", "orchestrationMode"]),
      "single",
    ) as TranscriptionRun["orchestrationMode"],
    parentRunId: asString(pick(source, ["parent_run_id", "parentRunId"]), undefined as unknown as string) || undefined,
    chunkIndex: asNumber(pick(source, ["chunk_index", "chunkIndex"])),
    chunkStartMs: asNumber(pick(source, ["chunk_start_ms", "chunkStartMs"])),
    chunkEndMs: asNumber(pick(source, ["chunk_end_ms", "chunkEndMs"])),
    chunkCount: asNumber(pick(source, ["chunk_count", "chunkCount"])),
    completedChunkCount: asNumber(pick(source, ["completed_chunk_count", "completedChunkCount"])) ?? 0,
    derivedTranscriptAssetId: asString(
      pick(source, ["derived_transcript_asset_id"]),
      undefined as unknown as string,
    ) || undefined,
    segmentCount: asNumber(pick(source, ["segment_count"])),
    durationMs: asNumber(pick(source, ["duration_ms"])),
    createdAt: asString(pick(source, ["created_at", "createdAt"]), undefined as unknown as string) || undefined,
    queuedAt: asString(pick(source, ["queued_at", "queuedAt"]), undefined as unknown as string) || undefined,
    firstQueuedAt: asString(pick(source, ["first_queued_at", "firstQueuedAt"]), undefined as unknown as string) || undefined,
    currentQueuedAt: asString(pick(source, ["current_queued_at", "currentQueuedAt"]), undefined as unknown as string) || undefined,
    startedAt: asString(pick(source, ["started_at", "startedAt"]), undefined as unknown as string) || undefined,
    firstStartedAt: asString(pick(source, ["first_started_at", "firstStartedAt"]), undefined as unknown as string) || undefined,
    currentStartedAt: asString(pick(source, ["current_started_at", "currentStartedAt"]), undefined as unknown as string) || undefined,
    processingAttemptNo: asNumber(pick(source, ["processing_attempt_no", "processingAttemptNo"])),
    dispatchAttemptNo: asNumber(pick(source, ["dispatch_attempt_no", "dispatchAttemptNo"])),
    finishedAt: asString(pick(source, ["finished_at", "finishedAt"]), undefined as unknown as string) || undefined,
    errorCode: asString(pick(source, ["error_code"]), undefined as unknown as string) || undefined,
    errorMessage: asString(
      pick(errorDetails, ["message"]),
      undefined as unknown as string,
    ) || undefined,
    segments: segments.flatMap((item): TranscriptionRun["segments"] => {
      if (!isRecord(item)) return [];
      const id = asString(pick(item, ["id"]));
      if (!id) return [];
      return [{
        id,
        ordinal: asNumber(pick(item, ["ordinal"])) ?? 0,
        speaker: asString(pick(item, ["speaker"]), "Speaker"),
        startMs: asNumber(pick(item, ["start_ms"])) ?? 0,
        endMs: asNumber(pick(item, ["end_ms"])) ?? 0,
        text: asString(pick(item, ["text"])),
      }];
    }),
    chunks: chunks.flatMap((item): TranscriptionRun["chunks"] => {
      if (!isRecord(item)) return [];
      const id = asString(pick(item, ["id"]));
      const index = asNumber(pick(item, ["index", "chunk_index"]));
      if (!id || index === undefined) return [];
      return [{
        id,
        index,
        startMs: asNumber(pick(item, ["start_ms", "startMs", "chunk_start_ms"])) ?? 0,
        endMs: asNumber(pick(item, ["end_ms", "endMs", "chunk_end_ms"])) ?? 0,
        status: asString(pick(item, ["status"]), "unknown"),
        processingAttemptNo: asNumber(pick(item, ["processing_attempt_no", "attempt_no"])) ?? 0,
        errorCode: asString(pick(item, ["error_code", "errorCode"]), undefined as unknown as string) || undefined,
      }];
    }),
  };
}

export function normalizeRun(value: unknown): ExtractionRun {
  const source = isRecord(unwrap(value)) ? (unwrap(value) as JsonRecord) : {};
  const stages = (pick<unknown[]>(source, ["stages", "stage_timings", "stageTimings"], []) ?? [])
    .flatMap((item): ExtractionRun["stages"] => {
      if (!isRecord(item)) return [];
      const stage = asString(pick(item, ["stage"]));
      if (stage !== "inventory" && stage !== "verify" && stage !== "verify_escalated") return [];
      const status = asString(pick(item, ["status"]));
      if (status !== "processing" && status !== "succeeded" && status !== "failed") return [];
      const startedAt = asString(pick(item, ["started_at", "startedAt"]));
      if (!startedAt) return [];
      return [{
        stage,
        status,
        attempt: asNumber(pick(item, ["attempt"])) ?? 1,
        reasoningEffort: asString(pick(item, ["reasoning_effort", "reasoningEffort"]), "unknown"),
        inputTokens: asNumber(pick(item, ["input_tokens", "inputTokens"])),
        outputTokens: asNumber(pick(item, ["output_tokens", "outputTokens"])),
        cachedTokens: asNumber(pick(item, ["cached_tokens", "cachedTokens"])),
        startedAt,
        finishedAt: asString(pick(item, ["finished_at", "finishedAt"]), undefined as unknown as string) || undefined,
        durationMs: asNumber(pick(item, ["duration_ms", "durationMs"])),
      }];
    });
  return {
    id: asString(pick(source, ["id", "run_id", "runId"])),
    eventId: asString(pick(source, ["event_id", "eventId"]), undefined as unknown as string) || undefined,
    idempotencyKey: asString(pick(source, ["idempotency_key", "idempotencyKey"]), undefined as unknown as string) || undefined,
    inputAssetVersionIds: (pick<unknown[]>(source, ["input_asset_version_ids", "inputAssetVersionIds"], []) ?? [])
      .filter((item): item is string => typeof item === "string" && Boolean(item)),
    status: asString(pick(source, ["status"]), "unknown").toLowerCase(),
    warningCount: asNumber(pick(source, ["warning_count", "warningCount"])),
    claimCount: asNumber(pick(source, ["claim_count", "claimCount"])),
    errorCode: asString(pick(source, ["error_code", "errorCode"]), undefined as unknown as string) || undefined,
    errorMessage: asString(pick(source, ["error_message", "errorMessage"]), undefined as unknown as string) || undefined,
    pipelineStage: asString(
      pick(source, ["pipeline_stage", "pipelineStage"]),
      undefined as unknown as string,
    ) as ExtractionRun["pipelineStage"],
    createdAt: asString(pick(source, ["created_at", "createdAt"]), undefined as unknown as string) || undefined,
    queuedAt: asString(pick(source, ["queued_at", "queuedAt"]), undefined as unknown as string) || undefined,
    firstQueuedAt: asString(pick(source, ["first_queued_at", "firstQueuedAt"]), undefined as unknown as string) || undefined,
    currentQueuedAt: asString(pick(source, ["current_queued_at", "currentQueuedAt"]), undefined as unknown as string) || undefined,
    startedAt: asString(pick(source, ["started_at", "startedAt"]), undefined as unknown as string) || undefined,
    firstStartedAt: asString(pick(source, ["first_started_at", "firstStartedAt"]), undefined as unknown as string) || undefined,
    currentStartedAt: asString(pick(source, ["current_started_at", "currentStartedAt"]), undefined as unknown as string) || undefined,
    processingAttemptNo: asNumber(pick(source, ["processing_attempt_no", "processingAttemptNo"])),
    dispatchAttemptNo: asNumber(pick(source, ["dispatch_attempt_no", "dispatchAttemptNo"])),
    finishedAt: asString(pick(source, ["finished_at", "finishedAt"]), undefined as unknown as string) || undefined,
    updatedAt: asString(pick(source, ["updated_at", "updatedAt"]), undefined as unknown as string) || undefined,
    completedAt: asString(
      pick(source, ["finished_at", "finishedAt", "completed_at", "completedAt"]),
      undefined as unknown as string,
    ) || undefined,
    stages,
  };
}

export function normalizeEvent(value: unknown): Event {
  const source = isRecord(unwrap(value)) ? (unwrap(value) as JsonRecord) : {};
  const rawAssets = pick<unknown[]>(source, ["assets", "sources"], []) ?? [];
  const runValue = pick<unknown>(source, ["latest_run", "latestRun", "extraction_run"]);
  return {
    id: asString(pick(source, ["id", "event_id", "eventId"])),
    projectId: asString(pick(source, ["project_id", "projectId"]), undefined as unknown as string) || undefined,
    title: asString(pick(source, ["title", "name"]), "Untitled event"),
    eventType: asString(pick(source, ["event_type", "eventType", "type"]), undefined as unknown as string) || undefined,
    occurredAt: asString(pick(source, ["occurred_at", "occurredAt", "event_time"]), undefined as unknown as string) || undefined,
    createdAt: asString(pick(source, ["created_at", "createdAt"]), undefined as unknown as string) || undefined,
    status: asString(pick(source, ["status", "material_status", "materialStatus", "processing_status"]), undefined as unknown as string) || undefined,
    pendingClaimCount: asNumber(pick(source, ["pending_claim_count", "pendingClaimCount"])) ?? 0,
    pendingOccurrenceCount: asNumber(pick(source, ["pending_occurrence_count", "pendingOccurrenceCount"])) ?? 0,
    assets: rawAssets.map(normalizeAsset).filter((item): item is Asset => Boolean(item)),
    latestRun: runValue ? normalizeRun(runValue) : undefined,
    latestRunId: asString(pick(source, ["active_run_id", "latest_run_id", "latestRunId", "extraction_run_id"]), undefined as unknown as string) || undefined,
  };
}

function normalizeEvidence(value: unknown): EvidenceRef | null {
  if (!isRecord(value)) return null;
  const id = asString(pick(value, ["id", "evidence_ref_id", "evidenceRefId"]));
  if (!id) return null;
  const rawStart = pick<unknown>(value, ["timestamp_start", "timestampStart", "start_time", "start_ms"]);
  const rawEnd = pick<unknown>(value, ["timestamp_end", "timestampEnd", "end_time", "end_ms"]);
  const normalizeTime = (time: unknown, fromMilliseconds: boolean): string | number | undefined => {
    if (typeof time === "number" && Number.isFinite(time)) return fromMilliseconds ? time / 1000 : time;
    return typeof time === "string" && time ? time : undefined;
  };
  const viewUrl = asString(pick(value, ["asset_view_url", "view_url"]), undefined as unknown as string) || undefined;
  const kind = asString(pick(value, ["kind", "evidence_kind", "type"]), "unknown");
  return {
    id,
    kind,
    role: asString(pick(value, ["role", "support_role", "evidence_role"]), undefined as unknown as string) || undefined,
    quote: asString(pick(value, ["quote", "exact_quote", "quote_raw", "text"]), undefined as unknown as string) || undefined,
    speaker: asString(pick(value, ["speaker"]), undefined as unknown as string) || undefined,
    timestampStart: normalizeTime(rawStart, value.start_ms !== undefined),
    timestampEnd: normalizeTime(rawEnd, value.end_ms !== undefined),
    filename: asString(pick(value, ["filename", "file_name"]), undefined as unknown as string) || undefined,
    page: asNumber(pick(value, ["page", "page_number"])),
    imageUrl: asString(pick(value, ["image_url", "imageUrl", "url"]), undefined as unknown as string) || (kind === "photo" ? viewUrl : undefined),
    viewUrl,
    caption: asString(pick(value, ["caption", "description", "observation"]), undefined as unknown as string) || undefined,
    assetId: asString(pick(value, ["asset_id", "assetId"]), undefined as unknown as string) || undefined,
    eventId: asString(pick(value, ["event_id", "eventId"]), undefined as unknown as string) || undefined,
    segmentIds: (pick<unknown[]>(value, ["segment_ids", "segmentIds"], []) ?? []).map((item) => asString(item)).filter(Boolean),
    audioUrl: asString(pick(value, ["audio_view_url", "audioUrl"]), undefined as unknown as string) || undefined,
  };
}

export function normalizeClaim(value: unknown): Claim {
  const source = isRecord(unwrap(value)) ? (unwrap(value) as JsonRecord) : {};
  const versionValue = pick<unknown>(source, ["current_version", "version", "claim_version"]);
  const version = isRecord(versionValue) ? versionValue : source;
  const rawEvidence = pick<unknown[]>(source, ["evidence_refs", "evidenceRefs", "evidence"], []) ?? [];
  const rawIds = pick<unknown[]>(source, ["evidence_ref_ids", "evidenceRefIds"], []) ?? [];
  const refs = rawEvidence.map(normalizeEvidence).filter((item): item is EvidenceRef => Boolean(item));
  const rawRelations = pick<unknown[]>(source, ["relations_for_review", "relationsForReview"], []) ?? [];
  const relationsForReview = rawRelations.flatMap((item): ClaimRelationForReview[] => {
    if (!isRecord(item)) return [];
    const id = asString(pick(item, ["id", "relation_id"]));
    const relationType = asString(pick(item, ["type"]));
    const status = asString(pick(item, ["status"]));
    const targetClaimId = asString(pick(item, ["target_claim_id", "targetClaimId"]));
    const targetClaimVersionId = asString(pick(item, ["target_claim_version_id", "targetClaimVersionId"]));
    if (
      !id ||
      !["supersedes", "contradicts", "resolves", "informed_by"].includes(relationType) ||
      !["proposed", "active"].includes(status) ||
      !targetClaimId ||
      !targetClaimVersionId
    ) return [];
    return [{
      id,
      type: relationType as ClaimRelationForReview["type"],
      status: status as ClaimRelationForReview["status"],
      targetClaimId,
      targetClaimVersionId,
      targetStatement: asString(pick(item, ["target_statement", "targetStatement"]), "原记录"),
      reason: asString(pick(item, ["reason"]), undefined as unknown as string) || undefined,
      confidence: asNumber(pick(item, ["confidence"])) ?? undefined,
    }];
  });
  const normalizedValue = pick(version, ["normalized_value", "normalizedValue"]);
  return {
    id: asString(pick(source, ["id", "claim_id", "claimId"])),
    versionId: asString(pick(version, ["id", "version_id", "claim_version_id", "versionId"])),
    runId: asString(pick(source, ["run_id", "runId", "extraction_run_id"]), undefined as unknown as string) || undefined,
    source: asString(pick(source, ["source"]), "ai") as Claim["source"],
    eventId: asString(pick(source, ["event_id", "eventId"]), undefined as unknown as string) || undefined,
    eventTitle: asString(pick(source, ["event_title", "eventTitle"]), undefined as unknown as string) || undefined,
    type: asString(pick(source, ["type", "claim_type", "claimType"]), "fact"),
    statement: asString(pick(version, ["statement", "text", "value"]), ""),
    normalizedValue: isRecord(normalizedValue) ? normalizedValue : null,
    needsAdditionalEvidence: Boolean(pick(source, ["needs_additional_evidence", "needsAdditionalEvidence"])),
    uncertainty: pick(version, ["uncertainty", "ambiguity", "needs_more_evidence"]),
    confidence: asNumber(pick(source, ["confidence", "score"])) ?? (() => {
      const basisPoints = asNumber(pick(source, ["confidenceBp", "confidence_bp"]));
      return basisPoints == null ? undefined : basisPoints / 10_000;
    })(),
    reviewStatus: asString(pick(source, ["review_status", "reviewStatus", "status"]), "pending").toLowerCase(),
    lifecycle: asString(pick(source, ["lifecycle", "lifecycle_status", "lifecycleStatus"]), undefined as unknown as string) || undefined,
    evidenceCount: asNumber(pick(source, ["evidence_count", "evidenceCount"])),
    evidenceRefs: refs,
    evidenceRefIds: (rawIds.length ? rawIds : pick<unknown[]>(version, ["evidenceRefIds", "evidence_ref_ids"], []) ?? []).map((item) => asString(item)).filter(Boolean),
    relationsForReview,
    batchReviewAttested: Boolean(pick(source, ["batch_review_attested", "batchReviewAttested"])),
    createdAt: asString(pick(source, ["created_at", "createdAt"]), undefined as unknown as string) || undefined,
  };
}

function requestIdFrom(headers: Headers, body: unknown): string | undefined {
  const header = headers.get("x-request-id");
  if (header) return header;
  if (isRecord(body)) return asString(pick(body, ["request_id", "requestId"]), undefined as unknown as string) || undefined;
  return undefined;
}

function issueFrom(status: number, headers: Headers, body: unknown): ApiIssue {
  const error = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  return {
    status,
    code: asString(pick(error, ["code", "error_code", "type"]), status === 404 ? "NOT_FOUND" : status === 503 ? "SERVICE_UNAVAILABLE" : "REQUEST_FAILED"),
    message: asString(pick(error, ["message", "error", "detail"]), status === 404 ? "The requested record was not found." : status === 503 ? "The service is not configured or temporarily unavailable." : `Request failed (${status}).`),
    requestId: requestIdFrom(headers, body),
    details: pick(error, ["details", "meta"]),
  };
}

function invalidContract(message: string): never {
  throw new ApiClientError({
    status: 502,
    code: "INVALID_API_RESPONSE",
    message,
  });
}

function requireId<T extends { id: string }>(value: T, label: string): T {
  if (!value.id) invalidContract(`The server returned an invalid ${label} response.`);
  return value;
}

export function normalizeWorkflowEventSummary(
  event: WorkflowSnapshotRecord["events"][number],
): WorkflowEventSummary {
  const summary = event.status_summary;
  if (!summary) invalidContract("The workflow snapshot is missing an Event status summary.");
  const numericFields = [
    summary.material_count,
    summary.material_ready_count,
    summary.material_processing_count,
    summary.material_failed_count,
    summary.pending_count,
    summary.candidate_count,
  ];
  if (numericFields.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    invalidContract("The workflow snapshot contains an invalid Event status count.");
  }
  const transcriptionStatus = event.transcription?.status ?? null;
  const extractionStatus = event.extraction?.status ?? null;
  const summaryStatus = event.ai_artifacts.summary?.status ?? null;
  const readableTranscriptStatus = event.ai_artifacts.readable_transcript?.status ?? null;
  if (
    summary.material_count !== event.materials.total ||
    summary.material_ready_count !== event.materials.ready ||
    summary.material_processing_count !== event.materials.processing ||
    summary.material_failed_count !== event.materials.failed ||
    summary.transcription_status !== transcriptionStatus ||
    summary.extraction_status !== extractionStatus ||
    summary.pending_count !== event.pending_claim_count + event.pending_occurrence_count ||
    summary.candidate_count !== event.candidate_count ||
    summary.summary_status !== summaryStatus ||
    summary.readable_transcript_status !== readableTranscriptStatus
  ) {
    invalidContract("The workflow snapshot returned conflicting Event states.");
  }
  return {
    ...event,
    statusSummary: {
      materialCount: summary.material_count,
      materialReadyCount: summary.material_ready_count,
      materialProcessingCount: summary.material_processing_count,
      materialFailedCount: summary.material_failed_count,
      transcriptionStatus: summary.transcription_status,
      extractionStatus: summary.extraction_status,
      pendingCount: summary.pending_count,
      candidateCount: summary.candidate_count,
      summaryStatus: summary.summary_status,
      readableTranscriptStatus: summary.readable_transcript_status,
    },
  };
}

function dataValue(body: unknown, keys: string[]): unknown {
  const data = unwrap(body);
  if (!isRecord(data)) invalidContract("The server returned an invalid success envelope.");
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) return data[key];
  }
  invalidContract(`The server response is missing ${keys[0]}.`);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  headers.set("accept", "application/json");
  // A stalled read used to leave the entire workspace in a loading state with
  // no recovery path. Large Blob uploads intentionally keep their own lifetime;
  // all control-plane requests get a bounded wait and a user-retryable error.
  const shouldTimeOut = !(init.body instanceof Blob) && !(init.body instanceof ArrayBuffer);
  const controller = shouldTimeOut ? new AbortController() : null;
  const upstreamSignal = init.signal;
  let timedOut = false;
  const forwardAbort = () => controller?.abort(upstreamSignal?.reason);
  if (controller && upstreamSignal) {
    if (upstreamSignal.aborted) forwardAbort();
    else upstreamSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  const timeout = controller ? globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 25_000) : null;
  try {
    const response = await fetch(path, {
      ...init,
      headers,
      signal: controller?.signal ?? init.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json().catch(() => null) : await response.text().catch(() => "");
    if (!response.ok) throw new ApiClientError(issueFrom(response.status, response.headers, body));
    return body as T;
  } catch (error) {
    if (timedOut) {
      throw new ApiClientError({
        status: 0,
        code: "REQUEST_TIMEOUT",
        message: "读取时间过长。内容已经保留，可以重试这一部分。",
      });
    }
    throw error;
  } finally {
    if (timeout != null) globalThis.clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", forwardAbort);
  }
}

const UPLOAD_STALL_TIMEOUT_MS = 120_000;
const UPLOAD_HEARTBEAT_INTERVAL_MS = 60_000;

async function uploadBlob(
  path: string,
  body: Blob,
  contentType: string,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new ApiClientError({
      status: 0,
      code: "UPLOAD_ABORTED",
      message: "上传已取消。文件没有被当作已完成材料。",
    });
  }
  if (typeof XMLHttpRequest === "undefined") {
    await request<unknown>(path, {
      method: "PUT",
      headers: { "content-type": contentType },
      body,
      signal,
    });
    onProgress?.(body.size, body.size);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let stalled = false;
    let stallTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
    const abort = () => xhr.abort();
    const cleanup = () => {
      if (stallTimer != null) globalThis.clearTimeout(stallTimer);
      stallTimer = null;
      signal?.removeEventListener("abort", abort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const resetStallTimer = () => {
      if (stallTimer != null) globalThis.clearTimeout(stallTimer);
      stallTimer = globalThis.setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL_TIMEOUT_MS);
    };
    xhr.open("PUT", path, true);
    // A fixed total timeout would kill a healthy 100 MiB upload on a slow
    // connection. Stop only when no byte-level progress or response arrives.
    xhr.timeout = 0;
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (progress) => {
      resetStallTimer();
      const total = progress.lengthComputable ? progress.total : body.size;
      onProgress?.(Math.min(progress.loaded, total), total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(() => {
          onProgress?.(body.size, body.size);
          resolve();
        });
        return;
      }
      const headers = new Headers();
      const requestId = xhr.getResponseHeader("x-request-id");
      if (requestId) headers.set("x-request-id", requestId);
      let responseBody: unknown = xhr.responseText;
      try { responseBody = JSON.parse(xhr.responseText); } catch { /* keep text */ }
      finish(() => reject(new ApiClientError(issueFrom(xhr.status, headers, responseBody))));
    };
    xhr.onerror = () => {
      finish(() => reject(new ApiClientError({
        status: 0,
        code: "UPLOAD_NETWORK_ERROR",
        message: "上传连接中断。文件没有被当作已完成材料，可以重新选择后继续。",
      })));
    };
    xhr.ontimeout = () => {
      finish(() => reject(new ApiClientError({
        status: 0,
        code: "UPLOAD_TIMEOUT",
        message: "文件上传等待过久，已停止这次等待。文件没有被当作已完成材料，可以重试。",
      })));
    };
    xhr.onabort = () => {
      finish(() => reject(new ApiClientError({
        status: 0,
        code: stalled ? "UPLOAD_TIMEOUT" : "UPLOAD_ABORTED",
        message: stalled
          ? "上传超过 2 分钟没有任何进度，已停止等待。文件没有被当作已完成材料，可以重试。"
          : "上传已取消。文件没有被当作已完成材料。",
      })));
    };
    signal?.addEventListener("abort", abort, { once: true });
    onProgress?.(0, body.size);
    resetStallTimer();
    xhr.send(body);
  });
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

async function renewAssetUploadLease(assetId: Id): Promise<void> {
  await request<unknown>(
    `/api/v1/assets/${encodeURIComponent(assetId)}/heartbeat`,
    { method: "POST", body: jsonBody({}) },
  );
}

export const api = {
  async listProjects(): Promise<Project[]> {
    const body = await request<ListProjectsResponse>("/api/v1/projects", { cache: "no-store" });
    return body.data.projects.map((item) => requireId(normalizeProject(item), "project"));
  },

  async createProject(input: {
    name: string;
    description?: string;
    profile?: "real_estate_buyer_journey";
  }, idempotencyKey: string): Promise<Project> {
    const payload: CreateProjectRequest = { name: input.name, profile: input.profile };
    const body = await request<CreateProjectResponse>("/api/v1/projects", { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: jsonBody(payload) });
    return requireId(normalizeProject(body.data.project), "project");
  },

  async getProject(projectId: Id): Promise<Project> {
    const body = await request<GetProjectResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}`, { cache: "no-store" });
    return requireId(normalizeProject(body.data.project), "project");
  },

  async listDeletedProjects(): Promise<Project[]> {
    const body = await request<ListDeletedProjectsResponse>("/api/v1/projects/trash", { cache: "no-store" });
    return body.data.projects.map((item) => requireId(normalizeProject(item), "project"));
  },

  async getProjectDeletePreview(projectId: Id) {
    const body = await request<ProjectDeletePreviewResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/delete-preview`,
      { cache: "no-store" },
    );
    return body.data.preview;
  },

  async moveProjectToTrash(projectId: Id, idempotencyKey: string): Promise<Project> {
    const body = await request<ProjectMutationResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
    });
    return requireId(normalizeProject(body.data.project), "project");
  },

  async restoreProject(projectId: Id, idempotencyKey: string): Promise<Project> {
    const body = await request<ProjectMutationResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/restore`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: "{}",
    });
    return requireId(normalizeProject(body.data.project), "project");
  },

  async permanentlyDeleteProject(projectId: Id, confirmName: string, idempotencyKey: string): Promise<void> {
    const body = await request<PermanentProjectDeleteResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/permanent`,
      {
        method: "DELETE",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({ confirm_name: confirmName }),
      },
    );
    if (body.data.project_id !== projectId || body.data.permanently_deleted !== true) {
      invalidContract("The server returned an invalid permanent deletion result.");
    }
  },

  async getEventAiArtifacts(eventId: Id, signal?: AbortSignal): Promise<{
    runs: EventAiArtifactRunRecord[];
    artifacts: EventAiArtifactRecord[];
  }> {
    const body = await request<EventAiArtifactsResponse>(
      `/api/v1/events/${encodeURIComponent(eventId)}/ai-artifacts`,
      { cache: "no-store", signal },
    );
    return body.data;
  },

  async retryEventAiArtifact(
    eventId: Id,
    kind: EventAiArtifactRunRecord["kind"],
    idempotencyKey: string,
  ): Promise<EventAiArtifactRunRecord> {
    const body = await request<ApiSuccess<{ artifact_run: EventAiArtifactRunRecord }>>(
      `/api/v1/events/${encodeURIComponent(eventId)}/ai-artifacts/${encodeURIComponent(kind)}/retry`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    );
    return body.data.artifact_run;
  },

  async getWorkflowSnapshot(projectId: Id, signal?: AbortSignal): Promise<WorkflowSnapshot> {
    const body = await request<GetWorkflowSnapshotResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/workflow-snapshot`,
      { cache: "no-store", signal },
    );
    const snapshot = body.data.workflow_snapshot;
    return {
      ...snapshot,
      project: requireId(normalizeProject(snapshot.project), "project"),
      events: snapshot.events.map(normalizeWorkflowEventSummary),
    };
  },

  async getDraftMemory(projectId: Id, signal?: AbortSignal): Promise<DraftMemory> {
    const body = await request<DraftMemoryResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/draft-memory`,
      { cache: "no-store", signal },
    );
    return body.data.draft_memory;
  },

  async getProjectActions(projectId: Id, signal?: AbortSignal): Promise<ProjectAction[]> {
    const body = await request<ProjectActionsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/actions`,
      { cache: "no-store", signal },
    );
    return body.data.actions;
  },

  async decideDraftLink(
    linkId: Id,
    action: "accept" | "reject",
    baseContextVersion: number,
    idempotencyKey: string,
  ) {
    const body = await request<DraftLinkVerdictResponse>(
      `/api/v1/draft-links/${encodeURIComponent(linkId)}/verdict`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({ action, base_context_version: baseContextVersion }),
      },
    );
    return body.data.draft_link;
  },

  async completeProjectAction(claimId: Id, idempotencyKey: string) {
    const body = await request<CompleteProjectActionResponse>(
      `/api/v1/actions/${encodeURIComponent(claimId)}/complete`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    );
    return body.data.completion;
  },

  async getReviewSession(projectId: Id): Promise<ReviewSession | null> {
    const body = await request<GetReviewSessionResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/review-session`,
      { cache: "no-store" },
    );
    if (body.data.review_session === null) return null;
    const session = normalizeReviewSession(body.data.review_session);
    if (!session) invalidContract("The server returned an invalid review timing session.");
    return session;
  },

  async startReviewSession(
    projectId: Id,
    idempotencyKey: string,
  ): Promise<ReviewSession> {
    const body = await request<ReviewSessionResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/review-sessions`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    );
    const session = normalizeReviewSession(body.data.review_session);
    if (!session) invalidContract("The server returned an invalid started review session.");
    return session;
  },

  async completeReviewSession(
    sessionId: Id,
    idempotencyKey: string,
  ): Promise<ReviewSession> {
    const body = await request<ReviewSessionResponse>(
      `/api/v1/review-sessions/${encodeURIComponent(sessionId)}/complete`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: "{}",
      },
    );
    const session = normalizeReviewSession(body.data.review_session);
    if (!session) invalidContract("The server returned an invalid completed review session.");
    return session;
  },

  async listGlossary(projectId: Id): Promise<GlossaryEntry[]> {
    const body = await request<ListGlossaryEntriesResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/glossary`,
      { cache: "no-store" },
    );
    if (!Array.isArray(body.data.glossary_entries)) {
      invalidContract("The server returned an invalid glossary list.");
    }
    return body.data.glossary_entries;
  },

  async createGlossary(
    projectId: Id,
    input: { canonicalValue: string; variants: string[]; category: GlossaryCategory },
    idempotencyKey: string,
  ): Promise<GlossaryEntry> {
    const body = await request<GlossaryEntryResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/glossary`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({
          canonical_value: input.canonicalValue,
          variants: input.variants,
          category: input.category,
        }),
      },
    );
    return body.data.glossary_entry;
  },

  async updateGlossary(
    entry: GlossaryEntry,
    input: {
      canonicalValue: string;
      variants: string[];
      category: GlossaryCategory;
      isActive: boolean;
    },
    idempotencyKey: string,
  ): Promise<GlossaryEntry> {
    const body = await request<GlossaryEntryResponse>(
      `/api/v1/glossary/${encodeURIComponent(entry.id)}`,
      {
        method: "PUT",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({
          base_version: entry.version,
          canonical_value: input.canonicalValue,
          variants: input.variants,
          category: input.category,
          is_active: input.isActive,
        }),
      },
    );
    return body.data.glossary_entry;
  },

  async deleteGlossary(entry: GlossaryEntry, idempotencyKey: string): Promise<void> {
    const body = await request<GlossaryEntryResponse>(
      `/api/v1/glossary/${encodeURIComponent(entry.id)}`,
      {
        method: "DELETE",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({ base_version: entry.version }),
      },
    );
    if (body.data.glossary_entry.id !== entry.id) {
      invalidContract("The server returned an invalid deleted glossary entry.");
    }
  },

  async listEvents(projectId: Id): Promise<Event[]> {
    const body = await request<ListEventsResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/events`, { cache: "no-store" });
    return body.data.events.map((item) => requireId(normalizeEvent(item), "event"));
  },

  async createEvent(projectId: Id, input: { title: string; event_type: string; occurred_at?: string }, idempotencyKey: string): Promise<Event> {
    const payload: CreateEventRequest = {
      title: input.title,
      event_type: input.event_type as CreateEventRequest["event_type"],
      occurred_at: input.occurred_at || new Date().toISOString(),
    };
    const body = await request<CreateEventResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/events`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: jsonBody(payload) });
    return requireId(normalizeEvent(body.data.event), "event");
  },

  async getEvent(eventId: Id): Promise<Event> {
    const body = await request<GetEventResponse>(`/api/v1/events/${encodeURIComponent(eventId)}`, { cache: "no-store" });
    const event = requireId(normalizeEvent(body.data.event), "event");
    event.assets = body.data.assets.map(normalizeAsset).filter((item): item is Asset => Boolean(item));
    return event;
  },

  async listEventTranscriptSegments(eventId: Id, signal?: AbortSignal): Promise<TranscriptSegment[]> {
    const body = await request<ApiSuccess<{ segments: TranscriptSegment[] }>>(
      `/api/v1/events/${encodeURIComponent(eventId)}/transcript-segments`,
      { cache: "no-store", signal },
    );
    if (!Array.isArray(body.data.segments)) {
      invalidContract("The server returned an invalid Transcript segment list.");
    }
    return body.data.segments;
  },

  async createManualClaim(
    eventId: Id,
    input: CreateManualClaimRequest,
    idempotencyKey: string,
  ): Promise<Claim> {
    const body = await request<ApiSuccess<{ claim: ClaimRecord }>>(
      `/api/v1/events/${encodeURIComponent(eventId)}/manual-claims`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody(input),
      },
    );
    return requireId(normalizeClaim(body.data.claim), "manual Claim");
  },

  async beginTranscriptImport(projectId: Id, files: File[], idempotencyKey: string): Promise<ImportSession> {
    const payload: CreateTranscriptImportRequest = {
      files: files.map((file) => ({ filename: file.name, mime_type: file.type || "text/plain", size_bytes: file.size })),
    };
    const body = await request<CreateTranscriptImportResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/transcript-imports`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: jsonBody(payload),
    });
    const transcriptImport = body.data.transcript_import;
    return {
      id: transcriptImport.id,
      items: transcriptImport.items.map((item) => ({ id: item.id, uploadUrl: item.content_url })),
    };
  },

  async uploadTranscriptItem(
    session: ImportSession,
    item: ImportItem,
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = item.uploadUrl || `/api/v1/transcript-imports/${encodeURIComponent(session.id)}/items/${encodeURIComponent(item.id)}/content`;
    await uploadBlob(url, file, file.type || "text/plain", onProgress, signal);
  },

  async finalizeTranscriptImport(sessionId: Id, orderedItems: Array<{ item_id: Id; title: string; occurred_at?: string; event_type: string }>): Promise<Event[]> {
    const payload: FinalizeTranscriptImportRequest = {
      ordered_items: orderedItems.map((item) => ({
        item_id: item.item_id,
        title: item.title,
        occurred_at: item.occurred_at || new Date().toISOString(),
        event_type: item.event_type as CreateEventRequest["event_type"],
      })),
    };
    const body = await request<FinalizeTranscriptImportResponse>(`/api/v1/transcript-imports/${encodeURIComponent(sessionId)}/finalize`, {
      method: "POST",
      body: jsonBody(payload),
    });
    return body.data.events.map((item) => requireId(normalizeEvent(item), "event"));
  },

  async initAsset(
    eventId: Id,
    input: { kind: string; filename: string; content_type: string; size_bytes: number; metadata?: Record<string, unknown> },
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<{ assetId: Id; uploadUrl?: string; status?: string }> {
    const payload: AssetInitRequest = {
      kind: input.kind as AssetInitRequest["kind"],
      filename: input.filename,
      mime_type: input.content_type,
      size_bytes: input.size_bytes,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    let body: AssetResponse;
    try {
      body = await request<AssetResponse>(`/api/v1/events/${encodeURIComponent(eventId)}/assets/init`, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new ApiClientError({
          status: 0,
          code: "UPLOAD_ABORTED",
          message: "上传已取消。文件没有被当作已完成材料。",
        });
      }
      throw error;
    }
    const source = body.data.asset;
    const asset = normalizeAsset(source);
    const result = {
      assetId: asset?.id || source.id,
      uploadUrl: body.data.content_url,
      status: asset?.status,
    };
    if (!result.assetId) invalidContract("The server response is missing asset_id.");
    return result;
  },

  async uploadAsset(
    assetId: Id,
    uploadUrl: string | undefined,
    body: Blob,
    contentType: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let heartbeatInFlight = false;
    const heartbeat = globalThis.setInterval(() => {
      if (heartbeatInFlight || signal?.aborted) return;
      heartbeatInFlight = true;
      // The byte upload remains authoritative. A transient control-plane
      // heartbeat failure must not interrupt a healthy transfer; another pulse
      // arrives well before the server's abandoned-upload lease expires.
      void renewAssetUploadLease(assetId)
        .catch(() => undefined)
        .finally(() => { heartbeatInFlight = false; });
    }, UPLOAD_HEARTBEAT_INTERVAL_MS);
    try {
      await uploadBlob(
        uploadUrl || `/api/v1/assets/${encodeURIComponent(assetId)}/content`,
        body,
        contentType,
        onProgress,
        signal,
      );
    } finally {
      globalThis.clearInterval(heartbeat);
    }
  },

  async heartbeatAssetUpload(assetId: Id): Promise<void> {
    await renewAssetUploadLease(assetId);
  },

  async abortAsset(assetId: Id): Promise<Asset> {
    const body = await request<unknown>(
      `/api/v1/assets/${encodeURIComponent(assetId)}/abort`,
      { method: "POST", body: jsonBody({}) },
    );
    const result = normalizeAsset(dataValue(body, ["asset"]));
    if (!result?.id) invalidContract("The server returned an invalid aborted asset.");
    return result;
  },

  async downloadAsset(assetId: Id): Promise<Blob> {
    const response = await fetch(`/api/v1/assets/${encodeURIComponent(assetId)}/evidence-view`, {
      cache: "no-store",
    });
    if (!response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => "");
      throw new ApiClientError(issueFrom(response.status, response.headers, body));
    }
    return response.blob();
  },

  async finalizeAsset(assetId: Id): Promise<Asset> {
    const body = await request<unknown>(`/api/v1/assets/${encodeURIComponent(assetId)}/finalize`, { method: "POST", body: jsonBody({}) });
    const result = normalizeAsset(dataValue(body, ["asset"]));
    if (!result?.id) invalidContract("The server returned an invalid finalized asset.");
    return result;
  },

  async startTranscription(
    assetId: Id,
    idempotencyKey: string,
    chunks: Array<{ assetId: Id; index: number; startMs: number; endMs: number }> = [],
  ): Promise<TranscriptionRun> {
    const body = await request<CreateTranscriptionRunResponse>(
      `/api/v1/assets/${encodeURIComponent(assetId)}/transcription-runs`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({
          ...(chunks.length
            ? {
                chunks: chunks.map((chunk) => ({
                  asset_id: chunk.assetId,
                  index: chunk.index,
                  start_ms: chunk.startMs,
                  end_ms: chunk.endMs,
                })),
              }
            : {}),
        }),
      },
    );
    return requireId(
      normalizeTranscriptionRun(body.data.transcription_run),
      "transcription run",
    );
  },

  async getTranscriptionRun(runId: Id): Promise<TranscriptionRun> {
    const body = await request<GetTranscriptionRunResponse>(
      `/api/v1/transcription-runs/${encodeURIComponent(runId)}`,
      { cache: "no-store" },
    );
    return requireId(
      normalizeTranscriptionRun(body.data.transcription_run),
      "transcription run",
    );
  },

  async retryFailedTranscriptionChunks(runId: Id, idempotencyKey: string): Promise<TranscriptionRun> {
    const body = await request<GetTranscriptionRunResponse>(
      `/api/v1/transcription-runs/${encodeURIComponent(runId)}/retry-failed-chunks`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({}),
      },
    );
    return requireId(
      normalizeTranscriptionRun(body.data.transcription_run),
      "transcription run",
    );
  },

  async startExtraction(eventId: Id, assetVersionIds: Id[], idempotencyKey: string): Promise<ExtractionRun> {
    const body = await request<CreateExtractionRunResponse>(`/api/v1/events/${encodeURIComponent(eventId)}/extraction-runs`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: jsonBody({ asset_version_ids: assetVersionIds }),
    });
    return requireId(normalizeRun(body.data.run), "extraction run");
  },

  async kickDispatcher(target?: {
    kind: "extraction" | "transcription" | "artifact";
    runId: Id;
  }): Promise<void> {
    await request<unknown>("/api/v1/jobs/dispatch", {
      method: "POST",
      ...(target
        ? { body: jsonBody({ kind: target.kind, run_id: target.runId }) }
        : {}),
    });
  },

  async getRun(runId: Id): Promise<ExtractionRun> {
    const body = await request<GetExtractionRunResponse>(`/api/v1/extraction-runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
    return requireId(normalizeRun(body.data.run), "extraction run");
  },

  async getAiDraftAssessment(runId: Id): Promise<AiDraftAssessment | null> {
    const body = await request<ApiSuccess<{ assessment: AiDraftAssessment | null }>>(
      `/api/v1/extraction-runs/${encodeURIComponent(runId)}/draft-assessment`,
      { cache: "no-store" },
    );
    return body.data.assessment;
  },

  async recordAiDraftAssessment(
    runId: Id,
    assessment: AiDraftAssessment["assessment"],
    idempotencyKey: string,
  ): Promise<AiDraftAssessment> {
    const body = await request<ApiSuccess<{ assessment: AiDraftAssessment }>>(
      `/api/v1/extraction-runs/${encodeURIComponent(runId)}/draft-assessment`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({ assessment }),
      },
    );
    if (!body.data.assessment?.id) {
      invalidContract("The server returned an invalid AI draft assessment.");
    }
    return body.data.assessment;
  },

  async getRunDebug(runId: Id): Promise<RunDebug> {
    const body = await request<ApiSuccess<{ debug: ExtractionRunDebugRecord }>>(
      `/api/v1/extraction-runs/${encodeURIComponent(runId)}/debug`,
      { cache: "no-store" },
    );
    if (
      !isRecord(body.data.debug) ||
      !Array.isArray(body.data.debug.stages) ||
      !Array.isArray(body.data.debug.artifact_runs) ||
      !body.request_id
    ) {
      invalidContract("The server returned an invalid run debug response.");
    }
    return { requestId: body.request_id, data: body.data.debug };
  },

  async getRunClaims(runId: Id): Promise<Claim[]> {
    const body = await request<GetRunClaimsResponse>(`/api/v1/extraction-runs/${encodeURIComponent(runId)}/claims`, { cache: "no-store" });
    return body.data.claims.map((item) => requireId(normalizeClaim(item), "claim"));
  },

  async getRunReview(runId: Id): Promise<RunReview> {
    const body = await request<GetRunClaimsResponse>(`/api/v1/extraction-runs/${encodeURIComponent(runId)}/claims`, { cache: "no-store" });
    if (!Array.isArray(body.data.claims) || !Array.isArray(body.data.occurrence_candidates)) {
      invalidContract("The server returned an invalid run review response.");
    }
    const occurrenceCandidates = body.data.occurrence_candidates;
    for (const candidate of occurrenceCandidates) {
      if (
        !candidate.id ||
        !candidate.target_claim_id ||
        !candidate.target_claim_version_id ||
        !candidate.base_version_id ||
        !Array.isArray(candidate.evidence)
      ) {
        invalidContract("The server returned an invalid occurrence candidate.");
      }
    }
    return {
      claims: body.data.claims.map((item) => requireId(normalizeClaim(item), "claim")),
      occurrenceCandidates,
    };
  },

  async getClaimHistory(claimId: Id, signal?: AbortSignal): Promise<unknown> {
    return unwrap(await request<unknown>(`/api/v1/claims/${encodeURIComponent(claimId)}/history`, { cache: "no-store", signal }));
  },

  async getEvidence(refId: Id, signal?: AbortSignal): Promise<EvidenceRef> {
    const body = await request<unknown>(`/api/v1/evidence-refs/${encodeURIComponent(refId)}`, { cache: "no-store", signal });
    const result = normalizeEvidence(dataValue(body, ["evidence_ref", "evidence"]));
    if (!result) throw new ApiClientError({ status: 502, code: "INVALID_EVIDENCE_RESPONSE", message: "The server returned an invalid evidence record." });
    return result;
  },

  async getEvidenceContext(refId: Id, signal?: AbortSignal): Promise<EvidenceContext> {
    const body = await request<EvidenceContextResponse>(
      `/api/v1/evidence-refs/${encodeURIComponent(refId)}/context`,
      { cache: "no-store", signal },
    );
    const result = body.data.evidence_context;
    if (
      !result ||
      result.evidence_ref_id !== refId ||
      !Array.isArray(result.context?.before) ||
      !Array.isArray(result.context?.target) ||
      !Array.isArray(result.context?.after)
    ) {
      invalidContract("The server returned an invalid Evidence context response.");
    }
    return result;
  },

  async saveVerdict(claim: Claim, action: "confirm" | "reject" | "edit", input: { idempotencyKey: string; reason?: string; retainRelationIds?: string[]; edit?: ClaimEditSubmission }): Promise<Claim> {
    if (action === "edit" && !input.edit) {
      throw new ApiClientError({
        status: 400,
        code: "INVALID_EDIT_REQUEST",
        message: "An edit must explicitly review its structured value, uncertainty, relations, and evidence.",
      });
    }
    if (action === "confirm" && !Array.isArray(input.retainRelationIds)) {
      throw new ApiClientError({
        status: 400,
        code: "RELATION_REVIEW_REQUIRED",
        message: "Every proposed relationship must be accepted or rejected before confirmation.",
      });
    }
    const edit = input.edit;
    const payload: ClaimVerdictRequest = {
      action,
      base_version_id: claim.versionId,
      explanation: input?.reason || undefined,
      ...(action === "confirm" ? { retain_relation_ids: input.retainRelationIds! } : {}),
      ...(action === "edit" ? {
        edit: {
          statement: edit!.statement,
          type: edit!.type,
          normalized_value: edit!.normalizedValue,
          needs_additional_evidence: edit!.needsAdditionalEvidence,
          uncertainty: edit!.uncertainty,
          retain_relation_ids: edit!.retainRelationIds,
          evidence_ref_ids: edit!.evidenceRefIds,
          retain_existing_evidence: false,
          secondary_evidence_note: edit!.secondaryEvidenceNote || undefined,
        },
      } : {}),
    };
    const body = await request<ClaimVerdictResponse>(`/api/v1/claims/${encodeURIComponent(claim.id)}/verdicts`, {
      method: "POST",
      headers: { "idempotency-key": input.idempotencyKey },
      body: jsonBody(payload),
    });
    return requireId(normalizeClaim(body.data.claim), "claim verdict");
  },

  async attestEvidenceReview(claim: Claim, idempotencyKey: string): Promise<Claim> {
    const body = await request<ClaimEvidenceReviewAttestationResponse>(
      `/api/v1/claims/${encodeURIComponent(claim.id)}/evidence-review-attestations`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({ base_version_id: claim.versionId }),
      },
    );
    return requireId(normalizeClaim(body.data.claim), "Claim evidence review attestation");
  },

  async batchConfirm(claims: Claim[], idempotencyKey: string): Promise<Claim[]> {
    const payload: BatchClaimVerdictRequest = {
      verdicts: claims.map((claim) => ({ claim_id: claim.id, action: "confirm", base_version_id: claim.versionId })),
    };
    const body = await request<BatchClaimVerdictResponse>("/api/v1/claims/batch-verdicts", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: jsonBody(payload),
    });
    if (!Array.isArray(body.data.verdicts) || body.data.verdicts.length !== claims.length) {
      invalidContract("The server returned an incomplete batch verdict response.");
    }
    return body.data.verdicts.map((item) => requireId(normalizeClaim(item.claim), "batch claim verdict"));
  },

  async withdrawClaim(claim: Claim, idempotencyKey: string, reason?: string): Promise<Claim> {
    const payload: WithdrawClaimRequest = { base_version_id: claim.versionId, explanation: reason };
    const body = await request<WithdrawClaimResponse>(`/api/v1/claims/${encodeURIComponent(claim.id)}/withdraw`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: jsonBody(payload),
    });
    return requireId(normalizeClaim(body.data.claim), "withdrawn claim");
  },

  async saveOccurrenceVerdict(
    candidate: OccurrenceCandidate,
    action: "confirm" | "reject",
    idempotencyKey: string,
  ): Promise<void> {
    const body = await request<OccurrenceVerdictResponse>(
      `/api/v1/occurrence-candidates/${encodeURIComponent(candidate.id)}/verdicts`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({
          action,
          target_base_version_id: candidate.base_version_id,
        }),
      },
    );
    const result = body.data.occurrence_verdict;
    if (
      !result ||
      result.candidate_id !== candidate.id ||
      result.status !== action ||
      !result.verdict_id ||
      !Array.isArray(result.converted_claims)
    ) {
      invalidContract("The server returned an invalid occurrence verdict response.");
    }
  },

  async convertOccurrenceToClaims(
    candidate: OccurrenceCandidate,
    newClaims: OccurrenceConversionClaimInput[],
    idempotencyKey: string,
  ): Promise<Claim[]> {
    const body = await request<OccurrenceVerdictResponse>(
      `/api/v1/occurrence-candidates/${encodeURIComponent(candidate.id)}/verdicts`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({
          action: "convert_to_new_claim",
          target_base_version_id: candidate.base_version_id,
          new_claims: newClaims,
        }),
      },
    );
    const result = body.data.occurrence_verdict;
    if (
      !result ||
      result.candidate_id !== candidate.id ||
      result.status !== "converted" ||
      !result.verdict_id ||
      !Array.isArray(result.converted_claims) ||
      result.converted_claims.length !== newClaims.length
    ) {
      invalidContract("The server returned an invalid occurrence conversion response.");
    }
    return result.converted_claims.map((claim) =>
      requireId(normalizeClaim(claim), "converted occurrence claim"),
    );
  },

  async resolveContradiction(
    input: {
      relationId: string;
      sourceClaimVersionId: string;
      targetClaimVersionId: string;
      winningClaimVersionId: string;
      explanation: string;
    },
    idempotencyKey: string,
  ): Promise<void> {
    const body = await request<RelationVerdictResponse>(
      `/api/v1/claim-relations/${encodeURIComponent(input.relationId)}/resolve`,
      {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: jsonBody({
          base_relation_status: "active",
          source_claim_version_id: input.sourceClaimVersionId,
          target_claim_version_id: input.targetClaimVersionId,
          winning_claim_version_id: input.winningClaimVersionId,
          explanation: input.explanation,
        }),
      },
    );
    const result = body.data.relation_verdict;
    if (
      !result ||
      result.relation_id !== input.relationId ||
      result.status !== "resolved" ||
      !result.verdict_id
    ) {
      invalidContract("The server returned an invalid contradiction verdict response.");
    }
  },

  async listRelationTargets(projectId: Id): Promise<RelationTarget[]> {
    const body = await request<ApiSuccess<{ relation_targets: RelationTarget[] }>>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/relation-targets`,
      { cache: "no-store" },
    );
    if (!Array.isArray(body.data.relation_targets)) {
      invalidContract("The server returned invalid relation targets.");
    }
    return body.data.relation_targets;
  },

  async createManualRelation(
    input: CreateManualRelationRequest,
    idempotencyKey: string,
  ): Promise<CreateManualRelationResponse["data"]["relation"]> {
    const body = await request<CreateManualRelationResponse>("/api/v1/claim-relations", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: jsonBody(input),
    });
    const relation = body.data.relation;
    if (
      !relation?.relation_id ||
      !relation.verdict_id ||
      relation.status !== "active" ||
      relation.source_claim_version_id !== input.source_claim_version_id ||
      relation.target_claim_version_id !== input.target_claim_version_id
    ) {
      invalidContract("The server returned an invalid manual relationship.");
    }
    return relation;
  },

  async confirmScenario(project: Project, scenarioKey: string, idempotencyKey: string, customLabel?: string): Promise<Project> {
    const payload: ScenarioVerdictRequest = {
      scenario_version: project.scenarioVersion ?? 0,
      scenario: customLabel?.trim() || scenarioKey,
      source: customLabel?.trim() ? "manual" : "candidate",
    };
    const body = await request<ScenarioVerdictResponse>(`/api/v1/projects/${encodeURIComponent(project.id)}/scenario-verdict`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: jsonBody(payload),
    });
    return requireId(normalizeProject(body.data.project), "scenario verdict");
  },

  async getView(projectId: Id, view: ProjectViewName, signal?: AbortSignal): Promise<unknown> {
    const path = view.startsWith("folder-") || ["timeline", "decisions", "preferences", "open-questions", "risks"].includes(view)
      ? `/api/v1/projects/${encodeURIComponent(projectId)}/views/${view}`
      : `/api/v1/projects/${encodeURIComponent(projectId)}/${view}`;
    const body = await request<GetVerifiedViewResponse | unknown>(path, { cache: "no-store", signal });
    return dataValue(body, ["view", "gap_check", "agenda", "brief_card"]);
  },
};

export function toIssue(error: unknown): ApiIssue {
  if (error instanceof ApiClientError) return error;
  if (error instanceof Error) return { code: "NETWORK_ERROR", message: error.message || "Unable to reach the server.", status: 0 };
  return { code: "UNKNOWN_ERROR", message: "Something went wrong.", status: 0 };
}
