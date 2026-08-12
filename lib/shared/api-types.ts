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
  context_version: number;
  provider: string | null;
  model: string | null;
  prompt_version: string;
  schema_version: string;
  error_code: string | null;
  pipeline_stage: ExtractionModelStageName | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
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
  derived_transcript_asset_id: string | null;
  derived_transcript_asset_version_id: string | null;
  segment_count: number | null;
  duration_ms: number | null;
  provider_request_id: string | null;
  error_code: string | null;
  error_details: unknown | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  segments?: TranscriptionSegmentRecord[];
};

export type ClaimRecord = {
  id: string;
  project_id: string;
  event_id: string;
  extraction_run_id: string;
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

export type CreateProjectRequest = { name: string; locale?: string };
export type CreateProjectResponse = ApiSuccess<{ project: ProjectRecord }>;
export type ListProjectsResponse = ApiSuccess<{ projects: ProjectRecord[] }>;
export type GetProjectResponse = ApiSuccess<{ project: ProjectRecord }>;

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

export type GapCheckResponse = ApiSuccess<{
  gap_check: Record<string, unknown>;
}>;

export type NextMeetingAgendaResponse = ApiSuccess<{
  agenda: { items: Array<Record<string, unknown>> };
}>;

export type BriefCardResponse = ApiSuccess<{
  brief_card: Record<string, unknown>;
}>;
