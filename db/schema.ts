import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () =>
  text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`);
const updatedAt = () =>
  text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// A mutation guard exists only for the duration of a D1 batch. Inserting 0
// violates the CHECK constraint and rolls the whole batch back, which gives
// optimistic-concurrency writes an atomic compare-and-set failure path.
export const mutationGuards = sqliteTable(
  "mutation_guards",
  {
    id: text("id").primaryKey(),
    guardValue: integer("guard_value").notNull(),
    createdAt: createdAt(),
  },
  (table) => [check("ck_mutation_guards_true", sql`${table.guardValue} = 1`)],
);

// Human review endpoints write one row in the same atomic D1 batch as the
// domain mutation. It makes network retries safe and detects reuse of a key
// with a different request instead of applying a second decision.
export const mutationReplays = sqliteTable(
  "mutation_replays",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    endpointScope: text("endpoint_scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_mutation_replays_scope_key").on(
      table.workspaceId,
      table.actorId,
      table.endpointScope,
      table.idempotencyKey,
    ),
    index("idx_mutation_replays_created").on(table.createdAt),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scenario: text("scenario"),
    scenarioStatus: text("scenario_status", {
      enum: ["unassessed", "assessing", "pending_confirmation", "confirmed"],
    })
      .notNull()
      .default("unassessed"),
    scenarioCandidatesJson: text("scenario_candidates_json").notNull().default("[]"),
    scenarioAssessmentRunId: text("scenario_assessment_run_id"),
    scenarioVersion: integer("scenario_version").notNull().default(0),
    scenarioLeaseExpiresAt: text("scenario_lease_expires_at"),
    scenarioAssessmentAttempt: integer("scenario_assessment_attempt").notNull().default(0),
    scenarioConfirmedBy: text("scenario_confirmed_by"),
    scenarioConfirmedAt: text("scenario_confirmed_at"),
    locale: text("locale").notNull().default("en-US"),
    ledgerVersion: integer("ledger_version").notNull().default(0),
    contextVersion: integer("context_version").notNull().default(0),
    nextEventSequence: integer("next_event_sequence").notNull().default(1),
    deletedAt: text("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_projects_workspace_updated").on(table.workspaceId, table.updatedAt),
    index("idx_projects_workspace_active").on(table.workspaceId, table.deletedAt),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventType: text("event_type", {
      enum: ["meeting", "showing", "estimate", "walkthrough"],
    }).notNull(),
    title: text("title").notNull(),
    occurredAt: text("occurred_at").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    materialStatus: text("material_status", {
      enum: ["draft", "ready", "archived"],
    })
      .notNull()
      .default("draft"),
    activeRunId: text("active_run_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_events_project_sequence").on(table.projectId, table.sequenceNo),
    index("idx_events_workspace_project").on(table.workspaceId, table.projectId),
    index("idx_events_project_occurred").on(table.projectId, table.occurredAt),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["transcript", "photo", "pdf", "text", "audio"],
    }).notNull(),
    filename: text("filename").notNull(),
    currentVersionId: text("current_version_id"),
    capturedAt: text("captured_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    processingStatus: text("processing_status", {
      enum: ["uploading", "parsing", "ready", "failed"],
    })
      .notNull()
      .default("uploading"),
    stagedR2Key: text("staged_r2_key"),
    stagedSha256: text("staged_sha256"),
    stagedMimeType: text("staged_mime_type"),
    stagedSizeBytes: integer("staged_size_bytes"),
    failureCode: text("failure_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_assets_event_status").on(table.eventId, table.processingStatus),
    index("idx_assets_workspace_project").on(table.workspaceId, table.projectId),
  ],
);

export const assetVersions = sqliteTable(
  "asset_versions",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    contentSha256: text("content_sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    parserVersion: text("parser_version"),
    r2OriginalKey: text("r2_original_key").notNull(),
    r2ModelKey: text("r2_model_key"),
    modelDerivativeSha256: text("model_derivative_sha256"),
    derivedFromAssetVersionId: text("derived_from_asset_version_id"),
    transformJson: text("transform_json"),
    finalizedAt: text("finalized_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_asset_versions_asset_version").on(table.assetId, table.versionNo),
    uniqueIndex("uq_asset_versions_r2_key").on(table.r2OriginalKey),
    index("idx_asset_versions_asset_hash").on(table.assetId, table.contentSha256),
  ],
);

export const textSegments = sqliteTable(
  "text_segments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    eventId: text("event_id").notNull(),
    assetId: text("asset_id").notNull(),
    assetVersionId: text("asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    speaker: text("speaker"),
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
    parserVersion: text("parser_version").notNull(),
    textRaw: text("text_raw").notNull(),
    textNormalized: text("text_normalized").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_text_segments_asset_version_ordinal").on(
      table.assetVersionId,
      table.ordinal,
    ),
    index("idx_text_segments_event_ordinal").on(table.eventId, table.ordinal),
    index("idx_text_segments_project_event").on(table.projectId, table.eventId),
  ],
);

export const transcriptImports = sqliteTable(
  "transcript_imports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "finalized", "failed", "expired"] })
      .notNull()
      .default("open"),
    itemCount: integer("item_count").notNull(),
    expiresAt: text("expires_at").notNull(),
    finalizedAt: text("finalized_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_transcript_imports_project_status").on(table.projectId, table.status),
  ],
);

export const transcriptImportItems = sqliteTable(
  "transcript_import_items",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => transcriptImports.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadStatus: text("upload_status", {
      enum: ["pending", "uploaded", "failed", "finalized"],
    })
      .notNull()
      .default("pending"),
    r2Key: text("r2_key"),
    contentSha256: text("content_sha256"),
    uploadedSizeBytes: integer("uploaded_size_bytes"),
    errorCode: text("error_code"),
    eventId: text("event_id"),
    assetId: text("asset_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_transcript_import_items_import").on(table.importId),
    uniqueIndex("uq_transcript_import_items_event").on(table.eventId),
    uniqueIndex("uq_transcript_import_items_asset").on(table.assetId),
  ],
);

export const extractionRuns = sqliteTable(
  "extraction_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: [
        "queued",
        "processing",
        "succeeded",
        "completed_with_warnings",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    inputSnapshotHash: text("input_snapshot_hash").notNull(),
    inputManifestJson: text("input_manifest_json").notNull(),
    contextVersion: integer("context_version").notNull(),
    contextSnapshotHash: text("context_snapshot_hash").notNull(),
    provider: text("provider"),
    model: text("model"),
    modelParamsJson: text("model_params_json").notNull().default("{}"),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    attemptNo: integer("attempt_no").notNull().default(1),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    queuedAt: text("queued_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    imageUnits: integer("image_units"),
    estimatedCostUsd: real("estimated_cost_usd"),
    providerRequestId: text("provider_request_id"),
    validatedOutputJson: text("validated_output_json"),
    errorCode: text("error_code"),
    errorDetailsJson: text("error_details_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_extraction_runs_event_idempotency").on(
      table.eventId,
      table.idempotencyKey,
    ),
    index("idx_extraction_runs_project_status").on(table.projectId, table.status),
    index("idx_extraction_runs_event_created").on(table.eventId, table.createdAt),
    index("idx_extraction_runs_lease").on(table.status, table.leaseExpiresAt),
  ],
);

export const queueOutbox = sqliteTable(
  "queue_outbox",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => extractionRuns.id, { onDelete: "cascade" }),
    payloadHash: text("payload_hash").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    sentAt: text("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_queue_outbox_run").on(table.runId),
    index("idx_queue_outbox_dispatch").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const transcriptionRuns = sqliteTable(
  "transcription_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    audioAssetId: text("audio_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    audioAssetVersionId: text("audio_asset_version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["queued", "processing", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    responseFormat: text("response_format").notNull().default("diarized_json"),
    requestTimeoutMs: integer("request_timeout_ms").notNull(),
    stagedResultR2Key: text("staged_result_r2_key"),
    stagedResultSha256: text("staged_result_sha256"),
    derivedTranscriptAssetId: text("derived_transcript_asset_id"),
    derivedTranscriptAssetVersionId: text("derived_transcript_asset_version_id"),
    segmentCount: integer("segment_count"),
    durationMs: integer("duration_ms"),
    providerRequestId: text("provider_request_id"),
    attemptNo: integer("attempt_no").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    errorCode: text("error_code"),
    errorDetailsJson: text("error_details_json"),
    queuedAt: text("queued_at"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_transcription_runs_audio_idempotency").on(
      table.audioAssetVersionId,
      table.idempotencyKey,
    ),
    index("idx_transcription_runs_workspace_status").on(
      table.workspaceId,
      table.status,
    ),
    index("idx_transcription_runs_event_created").on(
      table.eventId,
      table.createdAt,
    ),
    index("idx_transcription_runs_lease").on(table.status, table.leaseExpiresAt),
  ],
);

export const transcriptionQueueOutbox = sqliteTable(
  "transcription_queue_outbox",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => transcriptionRuns.id, { onDelete: "cascade" }),
    payloadHash: text("payload_hash").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    sentAt: text("sent_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_transcription_queue_outbox_run").on(table.runId),
    index("idx_transcription_queue_outbox_dispatch").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
  ],
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    eventId: text("event_id").notNull(),
    extractionRunId: text("extraction_run_id")
      .notNull()
      .references(() => extractionRuns.id, { onDelete: "cascade" }),
    clientClaimKey: text("client_claim_key").notNull(),
    type: text("type").notNull(),
    materiality: text("materiality", { enum: ["high", "medium", "low"] }).notNull(),
    confidence: real("confidence"),
    needsAdditionalEvidence: integer("needs_additional_evidence", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    reviewStatus: text("review_status", {
      enum: ["pending", "verified", "rejected"],
    })
      .notNull()
      .default("pending"),
    lifecycleStatus: text("lifecycle_status", {
      enum: ["active", "superseded", "resolved", "withdrawn"],
    })
      .notNull()
      .default("active"),
    currentVersionId: text("current_version_id"),
    firstEventId: text("first_event_id").notNull(),
    source: text("source", { enum: ["ai", "human", "occurrence_conversion"] })
      .notNull()
      .default("ai"),
    openedAt: text("opened_at"),
    lastRepeatedAt: text("last_repeated_at"),
    repeatCount: integer("repeat_count").notNull().default(0),
    resolvedAt: text("resolved_at"),
    withdrawReason: text("withdraw_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("uq_claims_run_client_key").on(
      table.extractionRunId,
      table.clientClaimKey,
    ),
    index("idx_claims_project_review_lifecycle").on(
      table.projectId,
      table.reviewStatus,
      table.lifecycleStatus,
    ),
    index("idx_claims_run_review").on(table.extractionRunId, table.reviewStatus),
    index("idx_claims_project_type").on(table.projectId, table.type),
  ],
);

export const claimVersions = sqliteTable(
  "claim_versions",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    statement: text("statement").notNull(),
    normalizedValueJson: text("normalized_value_json"),
    uncertaintyJson: text("uncertainty_json"),
    source: text("source", { enum: ["ai", "human"] }).notNull(),
    createdBy: text("created_by"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_claim_versions_claim_version").on(table.claimId, table.versionNo),
    index("idx_claim_versions_claim_created").on(table.claimId, table.createdAt),
  ],
);

export const evidenceRefs = sqliteTable(
  "evidence_refs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    eventId: text("event_id").notNull(),
    claimVersionId: text("claim_version_id")
      .notNull()
      .references(() => claimVersions.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["transcript", "text", "photo", "document", "user_note"],
    }).notNull(),
    assetVersionId: text("asset_version_id"),
    userNoteId: text("user_note_id"),
    segmentIdsJson: text("segment_ids_json"),
    quoteRaw: text("quote_raw"),
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
    pageNumber: integer("page_number"),
    bboxJson: text("bbox_json"),
    observation: text("observation"),
    evidenceRole: text("evidence_role", {
      enum: ["direct", "corroborating", "contextual"],
    }).notNull(),
    provenanceGrade: text("provenance_grade", {
      enum: ["primary", "secondary"],
    }).notNull(),
    structuralValidationStatus: text("structural_validation_status", {
      enum: ["valid", "invalid"],
    }).notNull(),
    semanticSupportVerdict: text("semantic_support_verdict", {
      enum: [
        "fully_supports",
        "partially_supports",
        "does_not_support",
        "unreviewed",
      ],
    })
      .notNull()
      .default("unreviewed"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_evidence_refs_claim_version").on(table.claimVersionId),
    index("idx_evidence_refs_asset_version").on(table.assetVersionId),
    index("idx_evidence_refs_project_event").on(table.projectId, table.eventId),
  ],
);

// Batch confirmation is intentionally stricter than an ordinary verdict. A
// reviewer must explicitly attest that they inspected the evidence for this
// exact immutable Claim Version before it can be selected in a bulk action.
// Keeping the attestation per actor and version makes the gate auditable and
// prevents a later version from inheriting an earlier review.
export const claimEvidenceReviewAttestations = sqliteTable(
  "claim_evidence_review_attestations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    claimVersionId: text("claim_version_id")
      .notNull()
      .references(() => claimVersions.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_claim_evidence_review_actor_version").on(
      table.workspaceId,
      table.actorId,
      table.claimId,
      table.claimVersionId,
    ),
    index("idx_claim_evidence_review_version").on(
      table.claimVersionId,
      table.actorId,
    ),
  ],
);

export const verdicts = sqliteTable(
  "verdicts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id, { onDelete: "cascade" }),
    action: text("action", { enum: ["confirm", "reject", "edit", "withdraw"] })
      .notNull(),
    baseVersionId: text("base_version_id").notNull(),
    newVersionId: text("new_version_id"),
    userId: text("user_id").notNull(),
    explanation: text("explanation"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_verdicts_claim_base_action").on(
      table.claimId,
      table.baseVersionId,
      table.action,
    ),
    index("idx_verdicts_claim_created").on(table.claimId, table.createdAt),
  ],
);

export const userNotes = sqliteTable(
  "user_notes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    claimId: text("claim_id").notNull(),
    verdictId: text("verdict_id").notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("idx_user_notes_claim").on(table.claimId)],
);

export const claimRelations = sqliteTable(
  "claim_relations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    type: text("type", {
      enum: ["supersedes", "contradicts", "resolves", "informed_by"],
    }).notNull(),
    sourceClaimVersionId: text("source_claim_version_id").notNull(),
    targetClaimVersionId: text("target_claim_version_id").notNull(),
    contextVersion: integer("context_version").notNull(),
    replacesRelationId: text("replaces_relation_id"),
    status: text("status", { enum: ["proposed", "active", "inactive", "rejected"] })
      .notNull()
      .default("proposed"),
    contradictionStatus: text("contradiction_status", {
      enum: ["open", "resolved"],
    }),
    resolvedAt: text("resolved_at"),
    resolvedByVerdictId: text("resolved_by_verdict_id"),
    resolvedByRelationId: text("resolved_by_relation_id"),
    reason: text("reason"),
    confidence: real("confidence"),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_claim_relations_project_status").on(table.projectId, table.status),
    index("idx_claim_relations_source_status").on(
      table.sourceClaimVersionId,
      table.status,
    ),
    index("idx_claim_relations_target_status").on(
      table.targetClaimVersionId,
      table.status,
    ),
  ],
);

export const relationVerdicts = sqliteTable(
  "relation_verdicts",
  {
    id: text("id").primaryKey(),
    relationId: text("relation_id")
      .notNull()
      .references(() => claimRelations.id, { onDelete: "cascade" }),
    action: text("action", { enum: ["confirm", "reject", "resolve"] }).notNull(),
    baseRelationStatus: text("base_relation_status").notNull(),
    winningClaimVersionId: text("winning_claim_version_id"),
    evidenceSelectionJson: text("evidence_selection_json"),
    secondaryEvidenceNote: text("secondary_evidence_note"),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("idx_relation_verdicts_relation").on(table.relationId)],
);

export const claimOccurrenceCandidates = sqliteTable(
  "claim_occurrence_candidates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    projectId: text("project_id").notNull(),
    targetClaimId: text("target_claim_id").notNull(),
    targetClaimVersionId: text("target_claim_version_id").notNull(),
    eventId: text("event_id").notNull(),
    extractionRunId: text("extraction_run_id").notNull(),
    evidenceRefJson: text("evidence_ref_json").notNull(),
    status: text("status", { enum: ["pending", "confirmed", "rejected", "converted"] })
      .notNull()
      .default("pending"),
    baseVersionId: text("base_version_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("idx_occurrence_candidates_run_status").on(
      table.extractionRunId,
      table.status,
    ),
  ],
);

export const occurrenceVerdicts = sqliteTable(
  "occurrence_verdicts",
  {
    id: text("id").primaryKey(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => claimOccurrenceCandidates.id, { onDelete: "cascade" }),
    action: text("action", {
      enum: ["confirm", "reject", "convert_to_new_claim"],
    }).notNull(),
    targetBaseVersionId: text("target_base_version_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("idx_occurrence_verdicts_candidate").on(table.candidateId)],
);

export const claimOccurrences = sqliteTable(
  "claim_occurrences",
  {
    id: text("id").primaryKey(),
    claimId: text("claim_id").notNull(),
    claimVersionId: text("claim_version_id").notNull(),
    eventId: text("event_id").notNull(),
    evidenceRefId: text("evidence_ref_id").notNull(),
    occurrenceVerdictId: text("occurrence_verdict_id").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_claim_occurrences_verdict").on(table.occurrenceVerdictId),
    index("idx_claim_occurrences_claim_event").on(table.claimId, table.eventId),
  ],
);

export const scenarioVerdicts = sqliteTable(
  "scenario_verdicts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    scenarioVersion: integer("scenario_version").notNull(),
    scenario: text("scenario").notNull(),
    source: text("source", { enum: ["candidate", "manual"] }).notNull(),
    userId: text("user_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("idx_scenario_verdicts_project_version").on(
    table.projectId,
    table.scenarioVersion,
  )],
);

export const contextSnapshots = sqliteTable(
  "context_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    extractionRunId: text("extraction_run_id").notNull(),
    contextVersion: integer("context_version").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_context_snapshots_run").on(table.extractionRunId),
    index("idx_context_snapshots_project_version").on(
      table.projectId,
      table.contextVersion,
    ),
  ],
);

export const glossaryEntries = sqliteTable(
  "glossary_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    canonicalValue: text("canonical_value").notNull(),
    aliasesJson: text("aliases_json").notNull().default("[]"),
    sourceClaimId: text("source_claim_id").notNull(),
    sourceClaimVersionId: text("source_claim_version_id").notNull(),
    category: text("category", {
      enum: ["general", "person", "company", "industry_term", "material", "property"],
    }).notNull().default("general"),
    sourceType: text("source_type", { enum: ["manual", "verified_claim"] })
      .notNull()
      .default("manual"),
    sourceLabel: text("source_label"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_glossary_entries_project").on(table.projectId),
    index("idx_glossary_entries_project_active").on(
      table.projectId,
      table.isActive,
      table.deletedAt,
    ),
  ],
);

export const glossaryEntryAudits = sqliteTable(
  "glossary_entry_audits",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    entryId: text("entry_id").notNull(),
    action: text("action", { enum: ["create", "update", "deactivate", "activate", "delete"] })
      .notNull(),
    baseVersion: integer("base_version"),
    resultVersion: integer("result_version").notNull(),
    actorId: text("actor_id").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("idx_glossary_entry_audits_entry").on(table.entryId, table.createdAt),
    index("idx_glossary_entry_audits_project").on(table.projectId, table.createdAt),
  ],
);

export const viewSnapshots = sqliteTable(
  "view_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    ledgerVersion: integer("ledger_version").notNull(),
    scenarioVersion: integer("scenario_version").notNull(),
    viewType: text("view_type").notNull(),
    builderVersion: text("builder_version").notNull(),
    locale: text("locale").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    schemaVersion: text("schema_version"),
    snapshotJson: text("snapshot_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_view_snapshots_cache_key").on(
      table.projectId,
      table.ledgerVersion,
      table.scenarioVersion,
      table.viewType,
      table.builderVersion,
      table.locale,
    ),
    index("idx_view_snapshots_project_type").on(table.projectId, table.viewType),
  ],
);

export const gapChecks = sqliteTable(
  "gap_checks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    ledgerVersion: integer("ledger_version").notNull(),
    scenarioVersion: integer("scenario_version").notNull(),
    overlayVersion: text("overlay_version").notNull(),
    missingSlotsJson: text("missing_slots_json").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("uq_gap_checks_cache_key").on(
      table.projectId,
      table.ledgerVersion,
      table.scenarioVersion,
      table.overlayVersion,
    ),
  ],
);
