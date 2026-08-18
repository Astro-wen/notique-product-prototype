import type {
  AssetRecord,
  AssetVersionRecord,
  ClaimRecord,
  ClaimRelationForReviewRecord,
  EventRecord,
  ExtractionRunRecord,
  ExtractionModelStageRecord,
  ProjectRecord,
  ScenarioCandidate,
  TranscriptionRunRecord,
  TranscriptImportItemRecord,
  TranscriptImportRecord,
} from "@/lib/shared/api-types";
import { parseJson } from "@/lib/server/http/api";

type Row = Record<string, unknown>;

const text = (row: Row, key: string): string => String(row[key] ?? "");
const nullableText = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : String(row[key]);
const integer = (row: Row, key: string): number => Number(row[key] ?? 0);

export function projectRecord(row: Row): ProjectRecord {
  return {
    id: text(row, "id"),
    workspace_id: text(row, "workspace_id"),
    name: text(row, "name"),
    scenario: nullableText(row, "scenario"),
    scenario_status: text(row, "scenario_status") as ProjectRecord["scenario_status"],
    scenario_candidates: parseJson<ScenarioCandidate[]>(
      nullableText(row, "scenario_candidates_json"),
      [],
    ),
    scenario_version: integer(row, "scenario_version"),
    locale: text(row, "locale"),
    ledger_version: integer(row, "ledger_version"),
    context_version: integer(row, "context_version"),
    event_count: integer(row, "event_count"),
    pending_claim_count: integer(row, "pending_claim_count"),
    pending_occurrence_count: integer(row, "pending_occurrence_count"),
    deleted_at: nullableText(row, "deleted_at"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
}

export function eventRecord(row: Row): EventRecord {
  return {
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    event_type: text(row, "event_type") as EventRecord["event_type"],
    title: text(row, "title"),
    occurred_at: text(row, "occurred_at"),
    sequence_no: integer(row, "sequence_no"),
    material_status: text(row, "material_status") as EventRecord["material_status"],
    active_run_id: nullableText(row, "active_run_id"),
    pending_claim_count: integer(row, "pending_claim_count"),
    pending_occurrence_count: integer(row, "pending_occurrence_count"),
    metadata: parseJson<Record<string, unknown>>(nullableText(row, "metadata_json"), {}),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
}

export function assetVersionRecord(row: Row): AssetVersionRecord | null {
  const id = nullableText(row, "version_id");
  if (!id) return null;
  return {
    id,
    asset_id: text(row, "id"),
    version_no: integer(row, "version_no"),
    content_sha256: text(row, "content_sha256"),
    mime_type: text(row, "version_mime_type"),
    size_bytes: integer(row, "version_size_bytes"),
    parser_version: nullableText(row, "parser_version"),
    r2_original_key: text(row, "r2_original_key"),
    r2_model_key: nullableText(row, "r2_model_key"),
    derived_from_asset_version_id: nullableText(row, "derived_from_asset_version_id"),
    transform: parseJson<Record<string, unknown> | null>(
      nullableText(row, "transform_json"),
      null,
    ),
    finalized_at: text(row, "finalized_at"),
  };
}

export function assetRecord(row: Row): AssetRecord {
  return {
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    event_id: text(row, "event_id"),
    kind: text(row, "kind") as AssetRecord["kind"],
    filename: text(row, "filename"),
    current_version_id: nullableText(row, "current_version_id"),
    processing_status: text(row, "processing_status") as AssetRecord["processing_status"],
    captured_at: nullableText(row, "captured_at"),
    metadata: parseJson<Record<string, unknown>>(nullableText(row, "metadata_json"), {}),
    version: assetVersionRecord(row),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
}

export function transcriptImportItemRecord(row: Row): TranscriptImportItemRecord {
  const importId = text(row, "import_id");
  const id = text(row, "id");
  return {
    id,
    import_id: importId,
    filename: text(row, "filename"),
    mime_type: text(row, "mime_type"),
    size_bytes: integer(row, "size_bytes"),
    upload_status: text(row, "upload_status") as TranscriptImportItemRecord["upload_status"],
    content_url: `/api/v1/transcript-imports/${encodeURIComponent(importId)}/items/${encodeURIComponent(id)}/content`,
    content_sha256: nullableText(row, "content_sha256"),
    error_code: nullableText(row, "error_code"),
  };
}

export function transcriptImportRecord(
  row: Row,
  items: TranscriptImportItemRecord[],
): TranscriptImportRecord {
  return {
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    status: text(row, "status") as TranscriptImportRecord["status"],
    item_count: integer(row, "item_count"),
    expires_at: text(row, "expires_at"),
    items,
    created_at: text(row, "created_at"),
  };
}

export function extractionRunRecord(
  row: Row,
  stages: ExtractionRunRecord["stages"] = [],
): ExtractionRunRecord {
  return {
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    event_id: text(row, "event_id"),
    status: text(row, "status") as ExtractionRunRecord["status"],
    idempotency_key: text(row, "idempotency_key"),
    input_hash: text(row, "input_hash"),
    context_version: integer(row, "context_version"),
    provider: nullableText(row, "provider"),
    model: nullableText(row, "model"),
    prompt_version: text(row, "prompt_version"),
    schema_version: text(row, "schema_version"),
    error_code: nullableText(row, "error_code"),
    pipeline_stage: nullableText(row, "pipeline_stage") as ExtractionRunRecord["pipeline_stage"],
    processing_attempt_no: integer(row, "attempt_no"),
    dispatch_attempt_no: integer(row, "dispatch_attempt_no"),
    created_at: text(row, "created_at"),
    queued_at: nullableText(row, "queued_at"),
    first_queued_at: nullableText(row, "first_queued_at"),
    current_queued_at: nullableText(row, "current_queued_at"),
    started_at: nullableText(row, "started_at"),
    first_started_at: nullableText(row, "first_started_at"),
    current_started_at: nullableText(row, "current_started_at"),
    finished_at: nullableText(row, "finished_at"),
    updated_at: text(row, "updated_at"),
    stages,
  };
}

export function extractionModelStageRecord(row: Row): ExtractionModelStageRecord {
  const nullableInteger = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : integer(row, key);
  const nullableNumber = (key: string): number | null =>
    row[key] === null || row[key] === undefined ? null : Number(row[key]);
  return {
    id: text(row, "id"),
    run_id: text(row, "run_id"),
    stage: text(row, "stage") as ExtractionModelStageRecord["stage"],
    attempt: integer(row, "attempt"),
    provider: text(row, "provider"),
    model: text(row, "model"),
    reasoning_effort: text(row, "reasoning_effort"),
    prompt_version: text(row, "prompt_version"),
    schema_version: text(row, "schema_version"),
    status: text(row, "status") as ExtractionModelStageRecord["status"],
    input_hash: text(row, "input_hash"),
    input_tokens: nullableInteger("input_tokens"),
    output_tokens: nullableInteger("output_tokens"),
    cached_tokens: nullableInteger("cached_tokens"),
    estimated_cost_usd: nullableNumber("estimated_cost_usd"),
    provider_request_id: nullableText(row, "provider_request_id"),
    validated_output: parseJson<unknown>(nullableText(row, "validated_output_json"), null),
    error_code: nullableText(row, "error_code"),
    error_details: parseJson<unknown>(nullableText(row, "error_details_json"), null),
    started_at: text(row, "started_at"),
    finished_at: nullableText(row, "finished_at"),
    duration_ms: nullableInteger("duration_ms"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
}

export function transcriptionRunRecord(row: Row): TranscriptionRunRecord {
  return {
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    event_id: text(row, "event_id"),
    audio_asset_id: text(row, "audio_asset_id"),
    audio_asset_version_id: text(row, "audio_asset_version_id"),
    status: text(row, "status") as TranscriptionRunRecord["status"],
    provider: text(row, "provider"),
    model: text(row, "model"),
    response_format: "diarized_json",
    orchestration_mode: (nullableText(row, "orchestration_mode") ?? "single") as TranscriptionRunRecord["orchestration_mode"],
    parent_run_id: nullableText(row, "parent_run_id"),
    chunk_index: row.chunk_index === null || row.chunk_index === undefined ? null : integer(row, "chunk_index"),
    chunk_start_ms: row.chunk_start_ms === null || row.chunk_start_ms === undefined ? null : integer(row, "chunk_start_ms"),
    chunk_end_ms: row.chunk_end_ms === null || row.chunk_end_ms === undefined ? null : integer(row, "chunk_end_ms"),
    chunk_count: row.chunk_count === null || row.chunk_count === undefined ? null : integer(row, "chunk_count"),
    completed_chunk_count: row.completed_chunk_count === null || row.completed_chunk_count === undefined
      ? 0
      : integer(row, "completed_chunk_count"),
    derived_transcript_asset_id: nullableText(row, "derived_transcript_asset_id"),
    derived_transcript_asset_version_id: nullableText(
      row,
      "derived_transcript_asset_version_id",
    ),
    segment_count:
      row.segment_count === null || row.segment_count === undefined
        ? null
        : integer(row, "segment_count"),
    duration_ms:
      row.duration_ms === null || row.duration_ms === undefined
        ? null
        : integer(row, "duration_ms"),
    provider_request_id: nullableText(row, "provider_request_id"),
    error_code: nullableText(row, "error_code"),
    error_details: parseJson<unknown>(nullableText(row, "error_details_json"), null),
    processing_attempt_no: integer(row, "attempt_no"),
    dispatch_attempt_no: integer(row, "dispatch_attempt_no"),
    created_at: text(row, "created_at"),
    queued_at: nullableText(row, "queued_at"),
    first_queued_at: nullableText(row, "first_queued_at"),
    current_queued_at: nullableText(row, "current_queued_at"),
    started_at: nullableText(row, "started_at"),
    first_started_at: nullableText(row, "first_started_at"),
    current_started_at: nullableText(row, "current_started_at"),
    finished_at: nullableText(row, "finished_at"),
  };
}

export function claimRecord(
  row: Row,
  evidenceRefIds: string[],
  relationsForReview: ClaimRelationForReviewRecord[] = [],
  batchReviewAttested = Boolean(row.batch_review_attested),
): ClaimRecord {
  return {
    id: text(row, "id"),
    project_id: text(row, "project_id"),
    event_id: text(row, "event_id"),
    extraction_run_id: text(row, "extraction_run_id"),
    source: text(row, "source") as ClaimRecord["source"],
    type: text(row, "type"),
    materiality: text(row, "materiality") as ClaimRecord["materiality"],
    confidence:
      row.confidence === null || row.confidence === undefined
        ? null
        : Number(row.confidence),
    needs_additional_evidence: Boolean(row.needs_additional_evidence),
    review_status: text(row, "review_status") as ClaimRecord["review_status"],
    lifecycle_status: text(row, "lifecycle_status") as ClaimRecord["lifecycle_status"],
    current_version: {
      id: text(row, "current_version_id"),
      version_no: integer(row, "version_no"),
      statement: text(row, "statement"),
      normalized_value: parseJson<unknown>(nullableText(row, "normalized_value_json"), null),
      uncertainty: parseJson<unknown>(nullableText(row, "uncertainty_json"), null),
      source: text(row, "version_source") as "ai" | "human",
    },
    relations_for_review: relationsForReview,
    evidence_ref_ids: evidenceRefIds,
    batch_review_attested: batchReviewAttested,
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at"),
  };
}
