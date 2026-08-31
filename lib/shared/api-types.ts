export type ProjectScenarioStatus =
  | "unassessed"
  | "assessing"
  | "pending_confirmation"
  | "confirmed";

export type MaterialStatus = "draft" | "ready" | "archived";
export type AssetKind = "transcript" | "photo" | "pdf" | "text" | "audio";
export type AssetProcessingStatus =
  | "uploading"
  | "parsing"
  | "ready"
  | "failed";
export type ExtractionRunStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "completed_with_warnings"
  | "failed"
  | "cancelled";
export type ExtractionModelStageName = "inventory" | "verify" | "verify_escalated";
export type ExtractionModelStageStatus = "processing" | "succeeded" | "failed";
export type TranscriptionRunStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled";
export type EventAiArtifactKind = "summary" | "readable_transcript";
export type EventAiArtifactRunStatus = "queued" | "processing" | "succeeded" | "failed";
export type ClaimReviewStatus = "pending" | "verified" | "rejected";
export type ClaimLifecycleStatus =
  | "active"
  | "superseded"
  | "resolved"
  | "withdrawn";
export type ReviewSessionStatus = "active" | "completed" | "abandoned";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "INVALID_JSON"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNAUTHORIZED"
  | "PROJECT_SCOPE_VIOLATION"
  | "ASSET_UNSUPPORTED_FORMAT"
  | "ASSET_TOO_LARGE"
  | "TOO_MANY_IMAGES"
  | "IMAGE_CONVERSION_FAILED"
  | "TRANSCRIPT_PARSE_FAILED"
  | "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED"
  | "TRANSCRIPTION_TIMEOUT"
  | "TRANSCRIPTION_OUTPUT_INVALID"
  | "AUDIO_TRANSCRIPTION_FAILED"
  | "EVENT_NOT_READY"
  | "MODEL_PROVIDER_NOT_CONFIGURED"
  | "MODEL_TIMEOUT"
  | "MODEL_OUTPUT_INVALID"
  | "EVIDENCE_VALIDATION_FAILED"
  | "EVIDENCE_SUPPORT_REQUIRED"
  | "EVIDENCE_REVIEW_REQUIRED"
  | "RELATION_REVIEW_REQUIRED"
  | "RELATION_REVIEW_INVALID"
  | "RUN_BUDGET_EXCEEDED"
  | "WORKSPACE_RUN_LIMIT"
  | "QUEUE_NOT_CONFIGURED"
  | "QUEUE_DISPATCH_DELAYED"
  | "SCENARIO_CONFIRMATION_REQUIRED"
  | "SCENARIO_VERSION_CONFLICT"
  | "CLAIM_VERSION_CONFLICT"
  | "CLAIM_STATE_CONFLICT"
  | "REVIEW_SESSION_CONFLICT"
  | "DRAFT_ASSESSMENT_CONFLICT"
  | "RUN_STATE_CONFLICT"
  | "EVIDENCE_SCOPE_INVALID"
  | "GLOSSARY_VERSION_CONFLICT"
  | "GLOSSARY_DUPLICATE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "R2_BINDING_UNAVAILABLE"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export type ApiSuccess<T> = {
  data: T;
  request_id: string;
};

export type ApiErrorResponse = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  request_id: string;
};

export type ProjectRecord = {
  id: string;
  workspace_id: string;
  name: string;
  scenario: string | null;
  scenario_status: ProjectScenarioStatus;
  scenario_candidates: ScenarioCandidate[];
  scenario_version: number;
  locale: string;
  ledger_version: number;
  context_version: number;
  event_count: number;
  pending_claim_count: number;
  pending_occurrence_count: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectDeletePreviewRecord = {
  project_id: string;
  project_name: string;
  event_count: number;
  material_count: number;
  pending_count: number;
  active_job_count: number;
  can_delete: boolean;
};

export type EventAiArtifactRunRecord = {
  id: string;
  project_id: string;
  event_id: string;
  extraction_run_id: string;
  kind: EventAiArtifactKind;
  status: EventAiArtifactRunStatus;
  provider: string;
  model: string;
  reasoning_effort: string;
  prompt_version: string;
  schema_version: string;
  attempt_no: number;
  provider_request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  error_code: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EventAiArtifactRecord = {
  id: string;
  project_id: string;
  event_id: string;
  run_id: string;
  kind: EventAiArtifactKind;
  artifact_version: number;
  input_hash: string;
  content: unknown;
  derived_asset_id: string | null;
  derived_asset_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type GlossaryCategory =
  | "general"
  | "person"
  | "company"
  | "industry_term"
  | "material"
  | "property";

export type GlossaryEntryRecord = {
  id: string;
  project_id: string;
  canonical_value: string;
  variants: string[];
  category: GlossaryCategory;
  source_type: "manual" | "verified_claim";
  source_label: string | null;
  source_claim_id: string | null;
  source_claim_version_id: string | null;
  is_active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};

export type CreateGlossaryEntryRequest = {
  canonical_value: string;
  variants: string[];
  category: GlossaryCategory;
};

export type UpdateGlossaryEntryRequest = CreateGlossaryEntryRequest & {
  base_version: number;
  is_active: boolean;
};

export type DeleteGlossaryEntryRequest = {
  base_version: number;
};

export type ListGlossaryEntriesResponse = ApiSuccess<{
  glossary_entries: GlossaryEntryRecord[];
}>;

export type GlossaryEntryResponse = ApiSuccess<{
  glossary_entry: GlossaryEntryRecord;
}>;

export type ScenarioCandidate = {
  scenario: string;
  confidence: number;
  reason: string;
};

export type EventRecord = {
  id: string;
  project_id: string;
  event_type: "meeting" | "showing" | "estimate" | "walkthrough";
  title: string;
  occurred_at: string;
  sequence_no: number;
  material_status: MaterialStatus;
  active_run_id: string | null;
  pending_claim_count: number;
  pending_occurrence_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ReviewSessionRecord = {
  id: string;
  project_id: string;
  actor_id: string;
  status: ReviewSessionStatus;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  initial_pending_claim_count: number;
  initial_pending_occurrence_count: number;
  remaining_pending_claim_count: number;
  remaining_pending_occurrence_count: number;
  outcome: {
    confirmed_claim_count: number;
    edited_claim_count: number;
    rejected_claim_count: number;
    human_added_claim_count: number;
    confirmed_occurrence_count: number;
    rejected_occurrence_count: number;
    accepted_relation_count: number;
    rejected_relation_count: number;
  };
  created_at: string;
  updated_at: string;
};

export type GetReviewSessionResponse = ApiSuccess<{
  review_session: ReviewSessionRecord | null;
}>;

export type ReviewSessionResponse = ApiSuccess<{
  review_session: ReviewSessionRecord;
}>;

export type AssetVersionRecord = {
  id: string;
  asset_id: string;
  version_no: number;
  content_sha256: string;
  mime_type: string;
  size_bytes: number;
  parser_version: string | null;
  r2_original_key: string;
  r2_model_key: string | null;
  derived_from_asset_version_id: string | null;
  transform: Record<string, unknown> | null;
  finalized_at: string;
};

export type AssetRecord = {
  id: string;
  project_id: string;
  event_id: string;
  kind: AssetKind;
  filename: string;
  current_version_id: string | null;
  processing_status: AssetProcessingStatus;
  captured_at: string | null;
  metadata: Record<string, unknown>;
  version?: AssetVersionRecord | null;
  created_at: string;
  updated_at: string;
};

export type TranscriptImportItemRecord = {
  id: string;
  import_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  upload_status: "pending" | "uploaded" | "failed" | "finalized";
  content_url: string;
  content_sha256: string | null;
  error_code: string | null;
};

export type TranscriptImportRecord = {
  id: string;
  project_id: string;
  status: "open" | "finalized" | "failed" | "expired";
  item_count: number;
  expires_at: string;
  items: TranscriptImportItemRecord[];
  created_at: string;
};

export type ExtractionRunRecord = {
  id: string;
  project_id: string;
  event_id: string;
  status: ExtractionRunStatus;
  idempotency_key: string;
  input_hash: string;
  input_asset_version_ids: string[];
  context_version: number;
  provider: string | null;
  model: string | null;
  prompt_version: string;
  schema_version: string;
  error_code: string | null;
  pipeline_stage: ExtractionModelStageName | null;
  processing_attempt_no: number;
  dispatch_attempt_no: number;
  created_at: string;
  queued_at: string | null;
  first_queued_at: string | null;
  current_queued_at: string | null;
  started_at: string | null;
  first_started_at: string | null;
  current_started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  stages: ExtractionModelStageTimingRecord[];
};

// Safe, compact stage telemetry for the normal Run endpoint. The full debug
// record remains restricted to the debug endpoint because it can contain
// validated model output and provider correlation details.
export type ExtractionModelStageTimingRecord = {
  stage: ExtractionModelStageName;
  status: ExtractionModelStageStatus;
  attempt: number;
  reasoning_effort: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
};

export type ExtractionModelStageRecord = {
  id: string;
  run_id: string;
  stage: ExtractionModelStageName;
  attempt: number;
  provider: string;
  model: string;
  reasoning_effort: string;
  prompt_version: string;
  schema_version: string;
  status: ExtractionModelStageStatus;
  input_hash: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  estimated_cost_usd: number | null;
  provider_request_id: string | null;
  validated_output: unknown | null;
  error_code: string | null;
  error_details: unknown | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type ExtractionModelStageDebugRecord = Omit<
  ExtractionModelStageRecord,
  "run_id"
>;

export type ExtractionRunDebugRecord = Record<string, unknown> & {
  stages: ExtractionModelStageDebugRecord[];
  artifact_runs: EventAiArtifactRunRecord[];
};

export type TranscriptionSegmentRecord = {
  id: string;
  ordinal: number;
  speaker: string;
  start_ms: number;
  end_ms: number;
  text: string;
};

export type TranscriptionRunRecord = {
  id: string;
  project_id: string;
  event_id: string;
  audio_asset_id: string;
  audio_asset_version_id: string;
  status: TranscriptionRunStatus;
  provider: string;
  model: string;
  response_format: "diarized_json";
  orchestration_mode: "single" | "chunked" | "chunk";
  parent_run_id: string | null;
  chunk_index: number | null;
  chunk_start_ms: number | null;
  chunk_end_ms: number | null;
  chunk_count: number | null;
  completed_chunk_count: number;
  derived_transcript_asset_id: string | null;
  derived_transcript_asset_version_id: string | null;
  segment_count: number | null;
  duration_ms: number | null;
  provider_request_id: string | null;
  error_code: string | null;
  error_details: unknown | null;
  processing_attempt_no: number;
  dispatch_attempt_no: number;
  created_at: string;
  queued_at: string | null;
  first_queued_at: string | null;
  current_queued_at: string | null;
  started_at: string | null;
  first_started_at: string | null;
  current_started_at: string | null;
  finished_at: string | null;
  segments?: TranscriptionSegmentRecord[];
  segments_provisional?: boolean;
  stable_until_ms?: number;
  chunks?: Array<{
    id: string;
    index: number;
    start_ms: number;
    end_ms: number;
    status: TranscriptionRunStatus;
    processing_attempt_no: number;
    error_code: string | null;
  }>;
};

export type ClaimRecord = {
  id: string;
  project_id: string;
  event_id: string;
  extraction_run_id: string;
  source: "ai" | "human" | "occurrence_conversion";
  type: string;
  materiality: "high" | "medium" | "low";
  confidence: number | null;
  needs_additional_evidence: boolean;
  review_status: ClaimReviewStatus;
  lifecycle_status: ClaimLifecycleStatus;
  current_version: {
    id: string;
    version_no: number;
    statement: string;
    normalized_value: unknown;
    uncertainty: unknown;
    source: "ai" | "human";
  };
  relations_for_review: ClaimRelationForReviewRecord[];
  evidence_ref_ids: string[];
  batch_review_attested: boolean;
  created_at: string;
  updated_at: string;
};

export type EventTranscriptSegmentRecord = {
  id: string;
  event_id: string;
  asset_version_id: string;
  ordinal: number;
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
};

export type CreateManualClaimRequest = {
  statement: string;
  type:
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
    | "next_action"
    | "material"
    | "measurement"
    | "other";
  segment_ids: string[];
};

export type AiDraftAssessmentRecord = {
  id: string;
  project_id: string;
  event_id: string;
  extraction_run_id: string;
  assessment: "basically_usable" | "needs_review";
  created_at: string;
};

export type ClaimRelationForReviewRecord = {
  id: string;
  type: "supersedes" | "contradicts" | "resolves" | "informed_by";
  status: "proposed" | "active";
  target_claim_id: string;
  target_claim_version_id: string;
  target_statement: string;
  reason: string | null;
  confidence: number | null;
};

export type OccurrenceCandidateRecord = {
  id: string;
  project_id: string;
  event_id: string;
  extraction_run_id: string;
  target_claim_id: string;
  target_claim_version_id: string;
  target_statement: string;
  target_type: string;
  proposed_statement: string | null;
  proposed_type: string | null;
  status: "pending" | "confirmed" | "rejected" | "converted";
  evidence: Array<{
    kind: "transcript" | "text" | "photo" | "document";
    asset_version_id: string;
    asset_id: string | null;
    asset_view_url: string | null;
    segment_ids: string[];
    quote_raw: string | null;
    start_ms: number | null;
    end_ms: number | null;
    page_number: number | null;
    bbox: [number, number, number, number] | null;
    observation: string | null;
    evidence_role: "direct" | "corroborating" | "contextual";
  }>;
  base_version_id: string;
  created_at: string;
};

export type ClaimVerdictAction = "confirm" | "reject" | "edit";

export type ClaimVerdictRequest = {
  action: ClaimVerdictAction;
  base_version_id: string;
  explanation?: string;
  retain_relation_ids?: string[];
  edit?: {
    statement: string;
    type: string;
    normalized_value: Record<string, unknown> | null;
    needs_additional_evidence: boolean;
    uncertainty: {
      reason: string;
      alternatives: string[];
      question: string;
    } | null;
    retain_relation_ids: string[];
    evidence_ref_ids?: string[];
    retain_existing_evidence?: boolean;
    secondary_evidence_note?: string;
  };
};

export type ClaimVerdictResponse = ApiSuccess<{
  claim: ClaimRecord;
  verdict_id: string;
}>;

export type ClaimEvidenceReviewAttestationRequest = {
  base_version_id: string;
};

export type ClaimEvidenceReviewAttestationResponse = ApiSuccess<{
  claim: ClaimRecord;
}>;

export type OccurrenceConversionClaimInput = {
  statement: string;
  type:
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
    | "next_action"
    | "material"
    | "measurement"
    | "other";
};

export type OccurrenceVerdictRequest =
  | {
      action: "confirm" | "reject";
      target_base_version_id: string;
    }
  | {
      action: "convert_to_new_claim";
      target_base_version_id: string;
      new_claims: OccurrenceConversionClaimInput[];
    };

export type OccurrenceVerdictResponse = ApiSuccess<{
  occurrence_verdict: {
    candidate_id: string;
    verdict_id: string;
    status: "confirm" | "reject" | "converted";
    converted_claims: ClaimRecord[];
  };
}>;

export type WithdrawClaimRequest = {
  base_version_id: string;
  explanation?: string;
};

export type ManualRelationType =
  | "supersedes"
  | "contradicts"
  | "resolves"
  | "informed_by";

export type ManualRelationTargetRecord = {
  claim_id: string;
  claim_version_id: string;
  type: OccurrenceConversionClaimInput["type"];
  statement: string;
  event_id: string;
  event_title: string;
  occurred_at: string;
  has_uncertainty: boolean;
};

export type CreateManualRelationRequest = {
  project_id: string;
  base_context_version: number;
  source_claim_id: string;
  source_claim_version_id: string;
  target_claim_id: string;
  target_claim_version_id: string;
  type: ManualRelationType;
  reason: string;
};

export type CreateManualRelationResponse = ApiSuccess<{
  relation: {
    relation_id: string;
    verdict_id: string;
    status: "active";
    type: ManualRelationType;
    source_claim_version_id: string;
    target_claim_version_id: string;
  };
}>;

export type BatchClaimVerdictRequest = {
  verdicts: Array<{
    claim_id: string;
    action: "confirm" | "reject";
    base_version_id: string;
    explanation?: string;
  }>;
};

export type VerifiedViewType =
  | "folder-summary"
  | "timeline"
  | "decisions"
  | "preferences"
  | "open-questions"
  | "risks";

export type VerifiedViewResponse = {
  project_id: string;
  view_type: VerifiedViewType;
  ledger_version: number;
  scenario_version: number;
  generated_at: string;
  items: Array<Record<string, unknown>>;
  empty_reason: string | null;
};

export type TimelineMomentRecord = {
  id: string;
  kind: "new" | "updated" | "resolved" | "contradicted" | "reaffirmed" | "withdrawn";
  eventId: string;
  eventSequenceNo: number;
  eventOccurredAt: string;
  displayText: string;
  transcriptStartMs: number | null;
  transcriptEndMs: number | null;
  evidence: Array<{
    evidenceRefId: string;
    kind: "transcript" | "text" | "photo" | "document" | "user_note";
    speaker: string | null;
    startMs: number | null;
    endMs: number | null;
    quoteRaw: string | null;
  }>;
  before: {
    claimId: string;
    claimVersionId: string;
    statement: string;
    evidenceRefIds: string[];
  } | null;
  after: {
    claimId: string;
    claimVersionId: string;
    statement: string;
    evidenceRefIds: string[];
  } | null;
  relationId: string | null;
  occurrenceId: string | null;
  withdrawVerdictId: string | null;
};

export type TimelineEventGroupRecord = {
  event: {
    id: string;
    projectId: string;
    title: string;
    occurredAt: string;
    sequenceNo: number;
  };
  summary: string;
  moments: TimelineMomentRecord[];
  /** Legacy fields retained while the UI migrates to moments. */
  claims: unknown[];
  deltas: unknown[];
};

export type PreferenceViewItemRecord = {
  claimId: string;
  claimVersionId: string;
  eventId: string;
  lifecycleStatus: ClaimLifecycleStatus;
  isCurrent: boolean;
  statement: string;
  currentValue: Record<string, unknown> | null;
  conditions: Array<string | number | boolean>;
  decisionPerson: string | null;
  decisionPeople: string[];
  firstSeen: {
    eventId: string;
    eventSequenceNo: number;
    eventOccurredAt: string;
    evidenceRefIds: string[];
  } | null;
  lastSeen: {
    eventId: string;
    eventSequenceNo: number;
    eventOccurredAt: string;
    evidenceRefIds: string[];
  } | null;
  history: Array<{
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
  }>;
  evidenceRefIds: string[];
};

export type TimelineViewResponse = ApiSuccess<{ view: TimelineEventGroupRecord[] }>;
export type PreferencesViewResponse = ApiSuccess<{ view: PreferenceViewItemRecord[] }>;

export type CreateProjectRequest = {
  name: string;
  locale?: string;
  profile?: "real_estate_buyer_journey";
};
export type CreateProjectResponse = ApiSuccess<{ project: ProjectRecord }>;
export type ListProjectsResponse = ApiSuccess<{ projects: ProjectRecord[] }>;
export type GetProjectResponse = ApiSuccess<{ project: ProjectRecord }>;
export type ListDeletedProjectsResponse = ApiSuccess<{ projects: ProjectRecord[] }>;
export type ProjectDeletePreviewResponse = ApiSuccess<{ preview: ProjectDeletePreviewRecord }>;
export type ProjectMutationResponse = ApiSuccess<{ project: ProjectRecord }>;
export type DraftMemoryRecord = {
  claim_id: string;
  claim_version_id: string;
  event_id: string;
  event_title: string;
  event_sequence_no: number;
  type: string;
  statement: string;
  confidence: number;
  evidence_ref_ids: string[];
  created_at: string;
};
export type DraftLinkRecord = {
  id: string;
  source_claim_id: string;
  target_draft_claim_id: string;
  type: "same" | "changed" | "conflicting" | "possibly_answered";
  reason: string;
  confidence: number;
  status: "proposed" | "inactive" | "accepted" | "rejected";
  source_statement: string;
  target_statement: string;
  source_review_status: string;
  target_review_status: string;
};
export type DraftMemoryResponse = ApiSuccess<{
  draft_memory: {
    claims: DraftMemoryRecord[];
    links: DraftLinkRecord[];
  };
}>;
export type DraftLinkVerdictResponse = ApiSuccess<{
  draft_link: {
    draftLinkId: string;
    status: "accepted" | "rejected";
    formalRelationId: string | null;
  };
}>;
export type ProjectActionRecord = {
  claim_id: string;
  claim_version_id: string;
  statement: string;
  owner: string | null;
  due_at: string | null;
  event_id: string;
  event_title: string;
  status: "ai_suggested" | "confirmed" | "completed" | "not_adopted";
  evidence_ref_ids: string[];
  completed_by_claim_id: string | null;
};
export type ProjectActionsResponse = ApiSuccess<{ actions: ProjectActionRecord[] }>;
export type CompleteProjectActionResponse = ApiSuccess<{
  completion: { actionClaimId: string; completionClaimId: string };
}>;
export type PermanentProjectDeleteResponse = ApiSuccess<{ project_id: string; permanently_deleted: true }>;

export type CreateEventRequest = {
  event_type: EventRecord["event_type"];
  title: string;
  occurred_at: string;
  metadata?: Record<string, unknown>;
};
export type CreateEventResponse = ApiSuccess<{ event: EventRecord }>;
export type ListEventsResponse = ApiSuccess<{ events: EventRecord[] }>;
export type GetEventResponse = ApiSuccess<{
  event: EventRecord;
  assets: AssetRecord[];
}>;

export type CreateTranscriptImportRequest = {
  files: Array<{ filename: string; mime_type: string; size_bytes: number }>;
};
export type CreateTranscriptImportResponse = ApiSuccess<{
  transcript_import: TranscriptImportRecord;
}>;
export type FinalizeTranscriptImportRequest = {
  ordered_items: Array<{
    item_id: string;
    occurred_at: string;
    title?: string;
    event_type?: EventRecord["event_type"];
  }>;
};
export type FinalizeTranscriptImportResponse = ApiSuccess<{
  transcript_import: TranscriptImportRecord;
  events: EventRecord[];
}>;

export type CreateExtractionRunRequest = { asset_version_ids: string[] };
export type CreateExtractionRunResponse = ApiSuccess<{
  run: ExtractionRunRecord;
}>;
export type GetExtractionRunResponse = ApiSuccess<{
  run: ExtractionRunRecord;
}>;
export type EventAiArtifactsResponse = ApiSuccess<{
  runs: EventAiArtifactRunRecord[];
  artifacts: EventAiArtifactRecord[];
}>;

export type WorkflowDisplayStatus =
  | "waiting_material"
  | "transcribing"
  | "ready"
  | "queued"
  | "inventory"
  | "verify"
  | "verify_escalated"
  | "waiting_scenario"
  | "waiting_review"
  | "complete"
  | "needs_attention";

/**
 * Stable list-level state for one Event. This is derived by the workflow
 * snapshot query, so the selected Event and every unselected Event consume the
 * same server-owned counts and job states.
 */
export type WorkflowEventStatusSummaryRecord = {
  material_count: number;
  material_ready_count: number;
  material_processing_count: number;
  material_failed_count: number;
  transcription_status: TranscriptionRunStatus | null;
  extraction_status: ExtractionRunStatus | null;
  pending_count: number;
  candidate_count: number;
  summary_status: EventAiArtifactRunStatus | null;
  readable_transcript_status: EventAiArtifactRunStatus | null;
};

export type WorkflowSnapshotRecord = {
  project: ProjectRecord;
  workflow: {
    phase:
      | "empty"
      | "waiting_material"
      | "ready"
      | "running"
      | "empty_output"
      | "waiting_scenario"
      | "waiting_review"
      | "draft_ready"
      | "partially_reviewed"
      | "complete";
    total: number;
    completed: number;
    trust_state: "draft_ready" | "partially_reviewed" | "trusted";
    pending_total: number;
    current_position: number;
    current_event_id: string | null;
    current_run_id: string | null;
    next_action: {
      kind:
        | "add_material"
        | "start_analysis"
        | "wait"
        | "inspect_material"
        | "confirm_scenario"
        | "review"
        | "open_draft"
        | "open_brief";
      event_id: string | null;
      run_id: string | null;
      requires_user_confirmation: boolean;
    };
  };
  events: Array<{
    id: string;
    title: string;
    occurred_at: string;
    sequence_no: number;
    material_status: MaterialStatus;
    display_status: WorkflowDisplayStatus;
    status_summary: WorkflowEventStatusSummaryRecord;
    materials: {
      total: number;
      ready: number;
      processing: number;
      failed: number;
    };
    transcription: {
      run_id: string;
      status: TranscriptionRunStatus;
      error_code: string | null;
      processing_attempt_no: number;
      dispatch_attempt_no: number;
    } | null;
    extraction: {
      run_id: string;
      status: ExtractionRunStatus;
      stage: ExtractionModelStageName | null;
      error_code: string | null;
      processing_attempt_no: number;
      dispatch_attempt_no: number;
      created_at: string;
      queued_at: string | null;
      first_queued_at: string | null;
      current_queued_at: string | null;
      started_at: string | null;
      first_started_at: string | null;
      current_started_at: string | null;
      finished_at: string | null;
      updated_at: string;
    } | null;
    ai_artifacts: {
      summary: EventAiArtifactRunRecord | null;
      readable_transcript: EventAiArtifactRunRecord | null;
    };
    pending_claim_count: number;
    pending_occurrence_count: number;
    candidate_count: number;
  }>;
};

export type GetWorkflowSnapshotResponse = ApiSuccess<{
  workflow_snapshot: WorkflowSnapshotRecord;
}>;
export type CreateTranscriptionRunResponse = ApiSuccess<{
  transcription_run: TranscriptionRunRecord;
}>;
export type GetTranscriptionRunResponse = ApiSuccess<{
  transcription_run: TranscriptionRunRecord;
}>;
export type GetRunClaimsResponse = ApiSuccess<{
  run: ExtractionRunRecord;
  claims: ClaimRecord[];
  occurrence_candidates: OccurrenceCandidateRecord[];
}>;

export type GetVerifiedViewResponse = ApiSuccess<{
  view: VerifiedViewResponse;
}>;

export type ScenarioVerdictRequest = {
  scenario_version: number;
  scenario: string;
  source: "candidate" | "manual";
};

export type ScenarioVerdictResponse = ApiSuccess<{ project: ProjectRecord }>;

export type AssetInitRequest = {
  kind: AssetKind;
  filename: string;
  mime_type: string;
  size_bytes: number;
  captured_at?: string;
  metadata?: Record<string, unknown>;
};

export type AssetResponse = ApiSuccess<{
  asset: AssetRecord;
  content_url?: string;
}>;

export type EvidenceRefResponse = ApiSuccess<{
  evidence_ref: Record<string, unknown>;
}>;

export type EvidenceContextSegmentRecord = {
  id: string;
  event_id: string;
  asset_version_id: string;
  ordinal: number;
  speaker: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string;
};

export type EvidenceContextRecord = {
  evidence_ref_id: string;
  project_id: string;
  event_id: string;
  claim_version_id: string;
  kind: string;
  evidence_role: string;
  asset_version_id: string | null;
  asset_id: string | null;
  filename: string | null;
  target: {
    segment_ids: string[];
    quote_raw: string | null;
    start_ms: number | null;
    end_ms: number | null;
    page_number: number | null;
    bbox: [number, number, number, number] | null;
    observation: string | null;
  };
  context: {
    before: EvidenceContextSegmentRecord[];
    target: EvidenceContextSegmentRecord[];
    after: EvidenceContextSegmentRecord[];
  };
  asset_view_url: string | null;
  audio: {
    asset_id: string;
    filename: string | null;
    view_url: string;
    start_ms: number | null;
  } | null;
};

export type EvidenceContextResponse = ApiSuccess<{
  evidence_context: EvidenceContextRecord;
}>;

export type GapCheckResponse = ApiSuccess<{
  gap_check: Record<string, unknown>;
}>;

export type NextMeetingAgendaResponse = ApiSuccess<{
  agenda: { items: Array<Record<string, unknown>> };
}>;

export type BriefCardResponse = ApiSuccess<{
  brief_card: Record<string, unknown>;
}>;
