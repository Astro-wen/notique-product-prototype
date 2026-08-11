import type {
  AssetRecord,
  AssetVersionRecord,
  ClaimRecord,
  ClaimRelationForReviewRecord,
  EventRecord,
  ExtractionRunRecord,
  ProjectRecord,
  ScenarioCandidate,
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

export function extractionRunRecord(row: Row): ExtractionRunRecord {
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
    created_at: text(row, "created_at"),
    queued_at: nullableText(row, "queued_at"),
    started_at: nullableText(row, "started_at"),
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
