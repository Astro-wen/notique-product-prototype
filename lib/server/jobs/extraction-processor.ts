import { getBindings, getD1, getEvidenceBucket } from "@/db";
import { buildContextPack, type ContextPack, type ContextPackAsset } from "@/lib/domain/context-pack";
import {
  DEFAULT_MAX_RUN_IMAGE_BYTES,
  isSupportedModelImageMime,
} from "@/lib/domain/asset-policy";
import {
  EXTRACTION_RUN_LEASE_MS,
  normalizeVerifierReasoningEffort,
} from "@/lib/domain/model-config";
import { EXTRACTION_STAGE_STALE_AFTER_MS } from "@/lib/domain/run-timing";
import {
  canonicalizeTranscriptEvidence,
  validateDocumentPage,
  validatePhotoBbox,
} from "@/lib/domain/evidence";
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  CLAIM_EXTRACTION_SCHEMA_VERSION,
  validateExtractClaimsOutput,
  type ExtractClaimsOutput,
  type ModelEvidence,
  type ModelUsage,
} from "@/lib/domain/model-contract";
import type { ClaimWithVersion, TranscriptSegment } from "@/lib/domain/types";
import {
  INVENTORY_SCHEMA_VERSION,
  TWO_STAGE_EXTRACTION_PROMPT_VERSION,
  VERIFICATION_SCHEMA_VERSION,
  assessVerificationEscalation,
  selectPreferredVerificationForReview,
  toFinalExtractClaimsOutput,
  validateInventoryOutput,
  validateVerificationOutput,
  type InventoryOutput,
  type VerificationOutput,
} from "@/lib/domain/two-stage-extraction";
import {
  createModelProvider,
  isModelProviderNotConfigured,
  ModelOutputInvalidError,
  ModelProviderRequestError,
  ModelTimeoutError,
} from "@/lib/server/ai/model-provider";
import { loadProjectLedger } from "@/lib/server/db/ledger-repository";
import {
  getExtractionModelStage,
  upsertExtractionModelStage,
} from "@/lib/server/db/extraction-stage-repository";
import { parseJson } from "@/lib/server/http/api";
import { sha256Hex } from "@/lib/server/storage/keys";

type Row = Record<string, unknown>;

type RunManifestItem = {
  asset_version_id: string;
  sha256: string;
  parser_version: string | null;
  kind: "transcript" | "photo" | "pdf" | "text";
};

type PreparedEvidence = {
  kind: "transcript" | "text" | "photo" | "document";
  assetVersionId: string;
  segmentIdsJson: string | null;
  quoteRaw: string | null;
  startMs: number | null;
  endMs: number | null;
  pageNumber: number | null;
  bboxJson: string | null;
  observation: string | null;
  evidenceRole: "direct" | "corroborating" | "contextual";
};

type PreparedNewClaim = {
  model: ExtractClaimsOutput["claims"][number];
  claimId: string;
  versionId: string;
  evidence: PreparedEvidence[];
  relations: ExtractClaimsOutput["claims"][number]["relations"];
};

type PreparedOccurrence = {
  candidateId: string;
  model: ExtractClaimsOutput["claims"][number];
  target: ClaimWithVersion;
  evidence: PreparedEvidence[];
};

export type ExtractionProcessResult = {
  runId: string;
  status:
    | "already_terminal"
    | "lease_not_acquired"
    | "succeeded"
    | "completed_with_warnings"
    | "deferred"
    | "failed";
  persistedClaims: number;
  occurrenceCandidates: number;
  warningCount: number;
  errorCode?: string;
};

const TERMINAL_RUN_STATES = new Set([
  "succeeded",
  "completed_with_warnings",
  "failed",
  "cancelled",
]);

const MAX_VALIDATED_OUTPUT_BYTES = 1024 * 1024;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

function plusMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function all(sql: string, bindings: unknown[]): Promise<Row[]> {
  return (await getD1().prepare(sql).bind(...bindings).all<Row>()).results ?? [];
}

async function hashText(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value).buffer);
}

function configuredInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function sanitizedIssue(value: unknown): Record<string, unknown> {
  if (value instanceof ModelOutputInvalidError) {
    return { issues: value.issues.slice(0, 25) };
  }
  if (value instanceof ModelProviderRequestError) {
    return { provider_status: value.status };
  }
  if (value instanceof Error) return { error_name: value.name };
  return { error_name: "UnknownError" };
}

function errorCode(error: unknown): string {
  if (isModelProviderNotConfigured(error)) return "MODEL_PROVIDER_NOT_CONFIGURED";
  if (error instanceof ModelTimeoutError) return "MODEL_TIMEOUT";
  if (error instanceof ModelOutputInvalidError) return "MODEL_OUTPUT_INVALID";
  if (error instanceof ModelProviderRequestError) return "MODEL_PROVIDER_REQUEST_FAILED";
  if (error instanceof ProcessingFault) return error.code;
  return "INTERNAL_ERROR";
}

function isTransientModelError(error: unknown): boolean {
  if (error instanceof ModelTimeoutError) return true;
  return error instanceof ModelProviderRequestError &&
    (error.status === null || error.status === 408 || error.status === 429 || error.status >= 500);
}

class ProcessingFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProcessingFault";
  }
}

type StageName = "inventory" | "verify" | "verify_escalated";

function aggregateUsage(usages: ModelUsage[]): ModelUsage {
  const sum = (key: "inputTokens" | "outputTokens" | "cachedTokens") => {
    const values = usages.map((usage) => usage[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cachedTokens: sum("cachedTokens"),
    providerRequestId: usages.at(-1)?.providerRequestId ?? null,
  };
}

function stageUsage(row: {
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  provider_request_id: string | null;
}): ModelUsage {
  return {
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    providerRequestId: row.provider_request_id,
  };
}

async function runModelStage<T>(input: {
  run: Row;
  stage: StageName;
  provider: string;
  model: string;
  reasoningEffort: string;
  promptVersion: string;
  schemaVersion: string;
  inputHash: string;
  details?: Record<string, unknown>;
  validate: (value: unknown) => T | null;
  invoke: (idempotencyKey: string) => Promise<{ output: T; usage: ModelUsage }>;
}): Promise<{ output: T; usage: ModelUsage; reused: boolean }> {
  const existing = await getExtractionModelStage(String(input.run.id), input.stage, 1);
  if (existing?.status === "succeeded") {
    const output = input.validate(existing.validated_output);
    if (!output) {
      throw new ProcessingFault(
        "MODEL_OUTPUT_INVALID",
        `Persisted ${input.stage} output no longer matches its frozen contract.`,
      );
    }
    return { output, usage: stageUsage(existing), reused: true };
  }
  const startedAt = now();
  await upsertExtractionModelStage({
    runId: String(input.run.id),
    stage: input.stage,
    attempt: 1,
    provider: input.provider,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    status: "processing",
    inputHash: input.inputHash,
    errorDetails: input.details,
    startedAt,
  });
  try {
    const result = await input.invoke(`notique:${input.run.id}:${input.stage}:1`);
    const finishedAt = now();
    await upsertExtractionModelStage({
      runId: String(input.run.id),
      stage: input.stage,
      attempt: 1,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion,
      status: "succeeded",
      inputHash: input.inputHash,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      providerRequestId: result.usage.providerRequestId,
      validatedOutput: result.output,
      errorDetails: input.details,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    });
    return { ...result, reused: false };
  } catch (error) {
    const finishedAt = now();
    const usage = error instanceof ModelOutputInvalidError ? error.usage : null;
    await upsertExtractionModelStage({
      runId: String(input.run.id),
      stage: input.stage,
      attempt: 1,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion,
      status: "failed",
      inputHash: input.inputHash,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      providerRequestId: usage?.providerRequestId ?? null,
      errorCode: errorCode(error),
      errorDetails: { ...input.details, ...sanitizedIssue(error) },
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    });
    throw error;
  }
}

function rowToSegment(row: Row): TranscriptSegment {
  return {
    id: String(row.id),
    assetVersionId: String(row.asset_version_id),
    eventId: String(row.event_id),
    ordinal: Number(row.ordinal),
    speaker: row.speaker == null ? null : String(row.speaker),
    startMs: row.start_ms == null ? null : Number(row.start_ms),
    endMs: row.end_ms == null ? null : Number(row.end_ms),
    parserVersion: String(row.parser_version),
    textRaw: String(row.text_raw),
    textNormalized: String(row.text_normalized),
  };
}

function contextSnapshotView(input: ContextPack): ContextPack {
  return {
    ...input,
    new_event: {
      ...input.new_event,
      photos: input.new_event.photos.map((photo) => ({
        ...photo,
        modelUrl: `[asset-version:${photo.assetVersionId}]`,
      })),
      documents: input.new_event.documents.map((document) => ({
        ...document,
        modelUrl: `[asset-version:${document.assetVersionId}]`,
      })),
    },
  };
}

async function acquireRunLease(runId: string, owner: string, timestamp: string): Promise<Row | null> {
  const db = getD1();
  const guardId = id("guard");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM extraction_runs WHERE id = ? AND status = 'queued'
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, runId, timestamp),
      db
        .prepare(
          `UPDATE extraction_runs
              SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .bind(
          owner,
          plusMilliseconds(timestamp, EXTRACTION_RUN_LEASE_MS),
          timestamp,
          timestamp,
          runId,
        ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    return null;
  }
  return first(`SELECT * FROM extraction_runs WHERE id = ? AND lease_owner = ?`, [runId, owner]);
}

async function loadContextInput(run: Row): Promise<{
  contextPack: ContextPack;
  manifestRows: Row[];
  segments: TranscriptSegment[];
  contextSnapshotHash: string;
  inputSnapshotHash: string;
  imageUnits: number;
}> {
  const manifest = parseJson<RunManifestItem[]>(String(run.input_manifest_json), []);
  if (!manifest.length || new Set(manifest.map((item) => item.asset_version_id)).size !== manifest.length) {
    throw new ProcessingFault("MODEL_OUTPUT_INVALID", "Run manifest is invalid.");
  }
  const versionIds = manifest.map((item) => item.asset_version_id);
  const placeholders = versionIds.map(() => "?").join(",");
  const manifestRows = await all(
    `SELECT av.*, a.kind, a.filename, a.event_id, a.project_id, a.workspace_id,
            a.metadata_json
       FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
      WHERE av.id IN (${placeholders}) AND a.workspace_id = ?
        AND a.project_id = ? AND a.event_id = ?`,
    [...versionIds, run.workspace_id, run.project_id, run.event_id],
  );
  if (manifestRows.length !== versionIds.length) {
    throw new ProcessingFault("PROJECT_SCOPE_VIOLATION", "Run manifest references unavailable material.");
  }
  const byVersion = new Map(manifestRows.map((row) => [String(row.id), row]));
  for (const item of manifest) {
    const row = byVersion.get(item.asset_version_id);
    if (!row || String(row.content_sha256) !== item.sha256 || String(row.kind) !== item.kind) {
      throw new ProcessingFault("MODEL_OUTPUT_INVALID", "Run material no longer matches its manifest.");
    }
  }

  const segmentRows = await all(
    `SELECT * FROM text_segments
      WHERE workspace_id = ? AND project_id = ? AND event_id = ?
        AND asset_version_id IN (${placeholders})
      ORDER BY asset_version_id, ordinal`,
    [run.workspace_id, run.project_id, run.event_id, ...versionIds],
  );
  const segments = segmentRows.map(rowToSegment);
  const bindings = getBindings();
  const maxImages = configuredInteger(bindings.MAX_RUN_IMAGE_UNITS, 12);
  const photoRows = manifestRows.filter((row) => String(row.kind) === "photo");
  if (photoRows.length > maxImages) {
    throw new ProcessingFault("TOO_MANY_IMAGES", "Run contains more images than the configured limit.", {
      max_images: maxImages,
      image_count: photoRows.length,
    });
  }
  const maxRunImageBytes = configuredInteger(
    bindings.MAX_RUN_IMAGE_BYTES,
    DEFAULT_MAX_RUN_IMAGE_BYTES,
  );
  const totalImageBytes = photoRows.reduce(
    (total, row) => total + Number(row.size_bytes ?? 0),
    0,
  );
  if (totalImageBytes > maxRunImageBytes) {
    throw new ProcessingFault(
      "ASSET_TOO_LARGE",
      "Combined image size exceeds the extraction limit.",
      {
        image_count: photoRows.length,
        total_image_bytes: totalImageBytes,
        max_total_image_bytes: maxRunImageBytes,
      },
    );
  }
  const documents = manifestRows.filter((row) => String(row.kind) === "pdf");
  if (documents.length) {
    throw new ProcessingFault(
      "DOCUMENT_PROVIDER_ADAPTER_NOT_CONFIGURED",
      "PDF extraction requires a provider-specific canonical page adapter.",
    );
  }
  const bucket = getEvidenceBucket();
  const scope = { workspaceId: String(run.workspace_id), actorId: "system:notique-extraction" };
  // These inputs are independent. Loading photos serially made the visible
  // "preparing facts" phase grow with every image even before the model ran.
  // Fetch R2 objects, verified context, and glossary in parallel while
  // preserving the manifest order in Promise.all's result.
  const photosPromise = Promise.all(photoRows.map(async (row): Promise<ContextPackAsset> => {
    const mimeType = String(row.mime_type);
    if (!isSupportedModelImageMime(mimeType)) {
      throw new ProcessingFault(
        "IMAGE_CONVERSION_FAILED",
        "Photo must be JPEG, PNG, or WebP. HEIC/HEIF conversion is not available in this POC.",
        { asset_version_id: row.id },
      );
    }
    const modelKey = row.r2_model_key ? String(row.r2_model_key) : String(row.r2_original_key);
    const object = await bucket.get(modelKey);
    if (!object) {
      throw new ProcessingFault("EVENT_NOT_READY", "A model input image is missing.", {
        asset_version_id: row.id,
      });
    }
    return {
      assetVersionId: String(row.id),
      mimeType,
      modelUrl: `data:${mimeType};base64,${arrayBufferToBase64(await object.arrayBuffer())}`,
    };
  }));
  const ledgerPromise = loadProjectLedger(scope, String(run.project_id));
  const glossaryRowsPromise = all(
    `SELECT ge.canonical_value, ge.aliases_json, ge.category, ge.source_type,
            ge.source_claim_version_id
       FROM glossary_entries ge
       JOIN projects p ON p.id = ge.project_id
      WHERE ge.project_id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
        AND ge.is_active = 1 AND ge.deleted_at IS NULL
        AND (
          ge.source_type = 'manual' OR (
            ge.source_type = 'verified_claim' AND EXISTS (
              SELECT 1 FROM claims c
              JOIN claim_versions cv ON cv.id = c.current_version_id
               WHERE cv.id = ge.source_claim_version_id
                 AND c.project_id = ge.project_id
                 AND c.review_status = 'verified'
                 AND c.lifecycle_status <> 'withdrawn'
            )
          )
        )`,
    [run.project_id, run.workspace_id],
  );
  const [photos, ledger, glossaryRows] = await Promise.all([
    photosPromise,
    ledgerPromise,
    glossaryRowsPromise,
  ]);
  const glossary = glossaryRows.flatMap((row) => {
    const canonical = String(row.canonical_value).trim();
    if (!canonical) return [];
    return [{
      term: canonical,
      meaning: parseJson<string[]>(String(row.aliases_json ?? "[]"), []).join(", ") || canonical,
      category: String(row.category ?? "general"),
      sourceKind: String(row.source_type ?? "manual") as "manual" | "verified_claim",
      claimVersionId:
        String(row.source_type ?? "manual") === "verified_claim"
          ? String(row.source_claim_version_id)
          : null,
    }];
  });
  const contextPack = buildContextPack({
    ledger,
    contextVersion: Number(run.context_version),
    eventId: String(run.event_id),
    transcriptSegments: segments,
    photos,
    documents: [],
    glossary,
  });
  const snapshotContext = contextSnapshotView(contextPack);
  const contextSnapshotJson = JSON.stringify(snapshotContext);
  const maxInputTokens = configuredInteger(bindings.MAX_RUN_INPUT_TOKENS, 120_000);
  const estimatedTextTokens = Math.ceil(
    JSON.stringify({
      ...contextPack,
      new_event: {
        ...contextPack.new_event,
        photos: contextPack.new_event.photos.map((photo) => ({ ...photo, modelUrl: "[image]" })),
      },
    }).length / 4,
  );
  if (estimatedTextTokens > maxInputTokens) {
    throw new ProcessingFault("RUN_BUDGET_EXCEEDED", "Run exceeds the configured input budget.", {
      estimated_input_tokens: estimatedTextTokens,
      max_input_tokens: maxInputTokens,
    });
  }
  return {
    contextPack,
    manifestRows,
    segments,
    contextSnapshotHash: await hashText(contextSnapshotJson),
    inputSnapshotHash: await hashText(
      JSON.stringify({
        context: snapshotContext,
        manifest: manifest.map((item) => ({
          asset_version_id: item.asset_version_id,
          sha256: item.sha256,
          parser_version: item.parser_version,
          kind: item.kind,
        })),
        provider: run.provider,
        model: run.model,
        prompt_version: run.prompt_version,
        schema_version: run.schema_version,
      }),
    ),
    imageUnits: photos.length,
  };
}

async function persistContextSnapshot(
  run: Row,
  owner: string,
  contextPack: ContextPack,
  contextSnapshotHash: string,
  inputSnapshotHash: string,
  imageUnits: number,
): Promise<void> {
  const timestamp = now();
  const db = getD1();
  const guardId = id("guard");
  await db.batch([
    db
      .prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM extraction_runs
            WHERE id = ? AND status = 'processing' AND lease_owner = ?
              AND context_version = ?
         ) AND EXISTS (
           SELECT 1 FROM projects
            WHERE id = ? AND workspace_id = ? AND context_version = ?
         ) THEN 1 ELSE 0 END, ?`,
      )
      .bind(
        guardId,
        run.id,
        owner,
        run.context_version,
        run.project_id,
        run.workspace_id,
        run.context_version,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO context_snapshots
         (id, project_id, extraction_run_id, context_version, snapshot_hash,
          snapshot_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(extraction_run_id) DO NOTHING`,
      )
      .bind(
        id("ctx"),
        run.project_id,
        run.id,
        run.context_version,
        contextSnapshotHash,
        JSON.stringify(contextSnapshotView(contextPack)),
        timestamp,
      ),
    db
      .prepare(
        `UPDATE extraction_runs
            SET context_snapshot_hash = ?, input_snapshot_hash = ?, image_units = ?,
                updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(contextSnapshotHash, inputSnapshotHash, imageUnits, timestamp, run.id, owner),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
}

function prepareEvidence(
  evidence: ModelEvidence[],
  run: Row,
  manifestRows: Row[],
  segments: TranscriptSegment[],
  warnings: Array<Record<string, unknown>>,
): PreparedEvidence[] {
  const manifestById = new Map(manifestRows.map((row) => [String(row.id), row]));
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const prepared: PreparedEvidence[] = [];
  for (const item of evidence) {
    const asset = manifestById.get(item.asset_version_id);
    if (!asset || String(asset.event_id) !== String(run.event_id)) {
      warnings.push({ code: "EVIDENCE_SCOPE_INVALID", asset_version_id: item.asset_version_id });
      continue;
    }
    if (item.kind === "transcript" || item.kind === "text") {
      if (String(asset.kind) !== item.kind && !(item.kind === "text" && String(asset.kind) === "transcript")) {
        warnings.push({ code: "EVIDENCE_KIND_INVALID", asset_version_id: item.asset_version_id });
        continue;
      }
      const canonical = canonicalizeTranscriptEvidence(
        item.segment_ids,
        item.quote_hint,
        segmentById,
        {
          expectedEventId: String(run.event_id),
          allowedSegmentIds: new Set(
            segments
              .filter((segment) => segment.assetVersionId === item.asset_version_id)
              .map((segment) => segment.id),
          ),
          kind: item.kind,
        },
      );
      if (!canonical.valid) {
        warnings.push({ code: canonical.code, asset_version_id: item.asset_version_id });
        continue;
      }
      if (canonical.assetVersionId !== item.asset_version_id) {
        warnings.push({ code: "EVIDENCE_SCOPE_INVALID", asset_version_id: item.asset_version_id });
        continue;
      }
      prepared.push({
        kind: item.kind,
        assetVersionId: canonical.assetVersionId,
        segmentIdsJson: JSON.stringify(canonical.segmentIds),
        quoteRaw: canonical.quoteRaw,
        startMs: canonical.startMs,
        endMs: canonical.endMs,
        pageNumber: null,
        bboxJson: null,
        observation: null,
        evidenceRole: item.evidence_role,
      });
      continue;
    }
    if (item.kind === "photo") {
      if (String(asset.kind) !== "photo" || item.bbox_norm !== null && !validatePhotoBbox(item.bbox_norm)) {
        warnings.push({ code: "EVIDENCE_PHOTO_INVALID", asset_version_id: item.asset_version_id });
        continue;
      }
      prepared.push({
        kind: "photo",
        assetVersionId: item.asset_version_id,
        segmentIdsJson: null,
        quoteRaw: null,
        startMs: null,
        endMs: null,
        pageNumber: null,
        bboxJson: item.bbox_norm === null ? null : JSON.stringify(item.bbox_norm),
        observation: item.observation,
        evidenceRole: item.evidence_role,
      });
      continue;
    }
    if (item.kind !== "document") {
      warnings.push({ code: "EVIDENCE_KIND_INVALID", asset_version_id: item.asset_version_id });
      continue;
    }
    const metadata = parseJson<Record<string, unknown>>(String(asset.metadata_json ?? "{}"), {});
    const pageCount = Number.isSafeInteger(metadata.page_count) ? Number(metadata.page_count) : null;
    if (String(asset.kind) !== "pdf" || !validateDocumentPage(item.page_number, pageCount)) {
      warnings.push({ code: "EVIDENCE_DOCUMENT_INVALID", asset_version_id: item.asset_version_id });
      continue;
    }
    prepared.push({
      kind: "document",
      assetVersionId: item.asset_version_id,
      segmentIdsJson: null,
      quoteRaw: item.quote_hint,
      startMs: null,
      endMs: null,
      pageNumber: item.page_number,
      bboxJson: null,
      observation: item.observation,
      evidenceRole: item.evidence_role,
    });
  }
  return prepared;
}

function prepareCandidates(
  output: ExtractClaimsOutput,
  run: Row,
  manifestRows: Row[],
  segments: TranscriptSegment[],
  ledgerClaims: ClaimWithVersion[],
) {
  const warnings: Array<Record<string, unknown>> = [];
  const newClaims: PreparedNewClaim[] = [];
  const occurrences: PreparedOccurrence[] = [];
  const activeVerified = new Map(
    ledgerClaims
      .filter((claim) => claim.reviewStatus === "verified" && claim.lifecycleStatus === "active")
      .map((claim) => [claim.id, claim]),
  );
  const contextVerified = new Map(
    ledgerClaims
      .filter(
        (claim) =>
          claim.reviewStatus === "verified" &&
          claim.lifecycleStatus !== "withdrawn",
      )
      .map((claim) => [claim.id, claim]),
  );
  const clientKeys = new Set<string>();
  for (const model of output.claims) {
    if (clientKeys.has(model.client_claim_key)) {
      warnings.push({ code: "DUPLICATE_CLIENT_CLAIM_KEY", client_claim_key: model.client_claim_key });
      continue;
    }
    clientKeys.add(model.client_claim_key);
    if (model.disposition === "duplicate") continue;
    const evidence = prepareEvidence(model.evidence, run, manifestRows, segments, warnings);
    if (!evidence.length) {
      warnings.push({ code: "CLAIM_WITHOUT_VALID_EVIDENCE", client_claim_key: model.client_claim_key });
      continue;
    }
    const hasMaterialEvidence = evidence.some(
      (item) => item.evidenceRole === "direct" || item.evidenceRole === "corroborating",
    );
    if (
      !hasMaterialEvidence &&
      model.type !== "open_question" &&
      !model.needs_additional_evidence
    ) {
      warnings.push({ code: "CONTEXTUAL_EVIDENCE_ONLY", client_claim_key: model.client_claim_key });
      continue;
    }
    if (model.disposition === "reaffirmed") {
      const target = model.reaffirmed_target_claim_id
        ? activeVerified.get(model.reaffirmed_target_claim_id)
        : undefined;
      if (
        !target ||
        target.currentVersionId !== model.reaffirmed_target_version_id ||
        target.projectId !== String(run.project_id)
      ) {
        warnings.push({ code: "REAFFIRMED_TARGET_CONFLICT", client_claim_key: model.client_claim_key });
        continue;
      }
      occurrences.push({ candidateId: id("ocand"), model, target, evidence });
      continue;
    }
    const relationKeys = new Set<string>();
    const lifecycleTargets = new Set<string>();
    const relations = model.relations.filter((relation) => {
      const target = relation.type === "informed_by"
        ? contextVerified.get(relation.target_claim_id)
        : activeVerified.get(relation.target_claim_id);
      const key = `${relation.type}:${relation.target_claim_id}:${relation.target_claim_version_id}`;
      if (
        !target ||
        target.currentVersionId !== relation.target_claim_version_id ||
        relationKeys.has(key)
      ) {
        warnings.push({ code: "RELATION_TARGET_CONFLICT", client_claim_key: model.client_claim_key });
        return false;
      }
      if (
        relation.type === "resolves" &&
        target.type !== "open_question" &&
        target.type !== "risk" &&
        target.type !== "concern" &&
        target.type !== "requirement" &&
        target.version.uncertainty === null
      ) {
        warnings.push({
          code: "RELATION_SEMANTICS_INVALID",
          client_claim_key: model.client_claim_key,
          relation_type: relation.type,
          target_claim_id: relation.target_claim_id,
        });
        return false;
      }
      if (
        relation.type === "supersedes" ||
        relation.type === "contradicts" ||
        relation.type === "resolves"
      ) {
        if (lifecycleTargets.has(relation.target_claim_id)) {
          warnings.push({
            code: "RELATION_LIFECYCLE_CONFLICT",
            client_claim_key: model.client_claim_key,
            target_claim_id: relation.target_claim_id,
          });
          return false;
        }
        lifecycleTargets.add(relation.target_claim_id);
      }
      relationKeys.add(key);
      return true;
    });
    newClaims.push({
      model,
      claimId: id("clm"),
      versionId: id("cv"),
      evidence,
      relations,
    });
  }
  return { newClaims, occurrences, warnings };
}

function evidenceInsertStatement(
  db: D1Database,
  run: Row,
  claimVersionId: string,
  evidence: PreparedEvidence,
  timestamp: string,
) {
  return db
    .prepare(
      `INSERT INTO evidence_refs (
        id, workspace_id, project_id, event_id, claim_version_id, kind,
        asset_version_id, segment_ids_json, quote_raw, start_ms, end_ms,
        page_number, bbox_json, observation, evidence_role, provenance_grade,
        structural_validation_status, semantic_support_verdict, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'primary',
                'valid', 'unreviewed', ?)`,
    )
    .bind(
      id("evr"),
      run.workspace_id,
      run.project_id,
      run.event_id,
      claimVersionId,
      evidence.kind,
      evidence.assetVersionId,
      evidence.segmentIdsJson,
      evidence.quoteRaw,
      evidence.startMs,
      evidence.endMs,
      evidence.pageNumber,
      evidence.bboxJson,
      evidence.observation,
      evidence.evidenceRole,
      timestamp,
    );
}

async function persistModelOutput(
  run: Row,
  owner: string,
  output: ExtractClaimsOutput,
  contextPack: ContextPack,
  manifestRows: Row[],
  segments: TranscriptSegment[],
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    providerRequestId: string | null;
  },
  pipelineWarnings: Array<Record<string, unknown>> = [],
): Promise<ExtractionProcessResult> {
  const validatedOutputJson = JSON.stringify(output);
  const validatedOutputBytes = new TextEncoder().encode(validatedOutputJson).byteLength;
  if (validatedOutputBytes > MAX_VALIDATED_OUTPUT_BYTES) {
    throw new ProcessingFault(
      "MODEL_OUTPUT_INVALID",
      "Validated model output exceeds the persistence limit.",
      {
        max_bytes: MAX_VALIDATED_OUTPUT_BYTES,
        actual_bytes: validatedOutputBytes,
      },
    );
  }
  const ledger = await loadProjectLedger(
    { workspaceId: String(run.workspace_id), actorId: "system:notique-extraction" },
    String(run.project_id),
  );
  const prepared = prepareCandidates(output, run, manifestRows, segments, ledger.claims);
  prepared.warnings.unshift(...pipelineWarnings);
  const intended = output.claims.filter((claim) => claim.disposition !== "duplicate").length;
  if (intended > 0 && prepared.newClaims.length + prepared.occurrences.length === 0) {
    throw new ProcessingFault(
      "EVIDENCE_VALIDATION_FAILED",
      "No reviewable candidate retained valid evidence.",
      { warning_count: prepared.warnings.length },
    );
  }
  const projectRow = await first(
    `SELECT * FROM projects WHERE id = ? AND workspace_id = ?`,
    [run.project_id, run.workspace_id],
  );
  if (!projectRow || Number(projectRow.context_version) !== Number(run.context_version)) {
    throw new ProcessingFault("CLAIM_VERSION_CONFLICT", "Project context changed during extraction.");
  }
  const needsScenario =
    String(projectRow.scenario_status) === "assessing" &&
    String(projectRow.scenario_assessment_run_id) === String(run.id);
  if (needsScenario && !output.scenario_assessment) {
    throw new ProcessingFault("MODEL_OUTPUT_INVALID", "First-event extraction omitted scenario candidates.");
  }
  if (!needsScenario && output.scenario_assessment !== null) {
    throw new ProcessingFault(
      "MODEL_OUTPUT_INVALID",
      "Extraction returned scenario candidates for a project with a confirmed scenario.",
    );
  }
  const timestamp = now();
  const db = getD1();
  const guardId = id("guard");
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM extraction_runs r
           JOIN projects p ON p.id = r.project_id AND p.workspace_id = r.workspace_id
          WHERE r.id = ? AND r.status = 'processing' AND r.lease_owner = ?
            AND p.context_version = r.context_version
            AND NOT EXISTS (SELECT 1 FROM claims WHERE extraction_run_id = r.id)
            AND NOT EXISTS (
              SELECT 1 FROM claim_occurrence_candidates WHERE extraction_run_id = r.id
            )
            ${needsScenario
              ? "AND p.scenario_status = 'assessing' AND p.scenario_assessment_run_id = r.id"
              : ""}
         ) THEN 1 ELSE 0 END, ?`,
      )
      .bind(guardId, run.id, owner, timestamp),
  ];
  for (const candidate of prepared.newClaims) {
    statements.push(
      db
        .prepare(
          `INSERT INTO claims (
            id, workspace_id, project_id, event_id, extraction_run_id,
            client_claim_key, type, materiality, confidence,
            needs_additional_evidence, review_status, lifecycle_status,
            current_version_id, first_event_id, source, opened_at,
            repeat_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'active', ?, ?, 'ai', ?, 0, ?, ?)`,
        )
        .bind(
          candidate.claimId,
          run.workspace_id,
          run.project_id,
          run.event_id,
          run.id,
          candidate.model.client_claim_key,
          candidate.model.type,
          candidate.model.materiality,
          candidate.model.confidence,
          candidate.model.needs_additional_evidence ? 1 : 0,
          candidate.versionId,
          run.event_id,
          candidate.model.type === "open_question" ? timestamp : null,
          timestamp,
          timestamp,
        ),
      db
        .prepare(
          `INSERT INTO claim_versions (
            id, claim_id, version_no, statement, normalized_value_json,
            uncertainty_json, source, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, 'ai', ?)`,
        )
        .bind(
          candidate.versionId,
          candidate.claimId,
          candidate.model.statement,
          candidate.model.normalized_value === null
            ? null
            : JSON.stringify(candidate.model.normalized_value),
          candidate.model.uncertainty === null
            ? null
            : JSON.stringify(candidate.model.uncertainty),
          timestamp,
        ),
      ...candidate.evidence.map((evidence) =>
        evidenceInsertStatement(db, run, candidate.versionId, evidence, timestamp),
      ),
      ...candidate.relations.map((relation) =>
        db
          .prepare(
            `INSERT INTO claim_relations (
              id, workspace_id, project_id, type, source_claim_version_id,
              target_claim_version_id, context_version, status,
              contradiction_status, reason, confidence, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
          )
          .bind(
            id("rel"),
            run.workspace_id,
            run.project_id,
            relation.type,
            candidate.versionId,
            relation.target_claim_version_id,
            run.context_version,
            relation.type === "contradicts" ? "open" : null,
            relation.reason,
            relation.confidence,
            timestamp,
          ),
      ),
    );
  }
  for (const occurrence of prepared.occurrences) {
    statements.push(
      db
        .prepare(
          `INSERT INTO claim_occurrence_candidates (
            id, workspace_id, project_id, target_claim_id,
            target_claim_version_id, event_id, extraction_run_id,
            evidence_ref_json, status, base_version_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .bind(
          occurrence.candidateId,
          run.workspace_id,
          run.project_id,
          occurrence.target.id,
          occurrence.target.currentVersionId,
          run.event_id,
          run.id,
          JSON.stringify({
            schema_version: "occurrence-evidence.v1",
            statement: occurrence.model.statement,
            type: occurrence.model.type,
            evidence: occurrence.evidence,
          }),
          occurrence.target.currentVersionId,
          timestamp,
          timestamp,
        ),
    );
  }
  if (needsScenario) {
    statements.push(
      db
        .prepare(
          `UPDATE projects
              SET scenario_status = 'pending_confirmation',
                  scenario_candidates_json = ?, scenario_lease_expires_at = NULL,
                  updated_at = ?
            WHERE id = ? AND workspace_id = ? AND scenario_status = 'assessing'
              AND scenario_assessment_run_id = ? AND context_version = ?`,
        )
        .bind(
          JSON.stringify(output.scenario_assessment!.candidates),
          timestamp,
          run.project_id,
          run.workspace_id,
          run.id,
          run.context_version,
        ),
    );
  }
  const status = prepared.warnings.length ? "completed_with_warnings" : "succeeded";
  statements.push(
    db
      .prepare(
        `UPDATE extraction_runs
            SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
                provider_request_id = ?, validated_output_json = ?, error_code = NULL,
                error_details_json = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        status,
        timestamp,
        usage.inputTokens,
        usage.outputTokens,
        usage.cachedTokens,
        usage.providerRequestId,
        validatedOutputJson,
        prepared.warnings.length
          ? JSON.stringify({ warnings: prepared.warnings.slice(0, 50) })
          : null,
        timestamp,
        run.id,
        owner,
      ),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  );
  await db.batch(statements);
  return {
    runId: String(run.id),
    status,
    persistedClaims: prepared.newClaims.length,
    occurrenceCandidates: prepared.occurrences.length,
    warningCount: prepared.warnings.length,
  };
}

async function markRunFailed(
  run: Row,
  owner: string,
  error: unknown,
  completedUsage: ModelUsage | null = null,
): Promise<ExtractionProcessResult> {
  const code = errorCode(error);
  const timestamp = now();
  const db = getD1();
  const usage = completedUsage ?? (
    error instanceof ModelOutputInvalidError && error.usage ? error.usage : null
  );
  await db.batch([
    db
      .prepare(
        `UPDATE extraction_runs
            SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, input_tokens = COALESCE(?, input_tokens),
                output_tokens = COALESCE(?, output_tokens),
                cached_tokens = COALESCE(?, cached_tokens),
                provider_request_id = COALESCE(?, provider_request_id),
                error_code = ?, error_details_json = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        timestamp,
        usage?.inputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.cachedTokens ?? null,
        usage?.providerRequestId ?? null,
        code,
        JSON.stringify({ ...sanitizedIssue(error), ...(error instanceof ProcessingFault ? error.details : {}) }),
        timestamp,
        run.id,
        owner,
      ),
    db
      .prepare(
        `UPDATE projects
            SET scenario_status = 'unassessed', scenario_assessment_run_id = NULL,
                scenario_candidates_json = '[]', scenario_lease_expires_at = NULL,
                updated_at = ?
          WHERE id = ? AND workspace_id = ? AND scenario_status = 'assessing'
            AND scenario_assessment_run_id = ?`,
      )
      .bind(timestamp, run.project_id, run.workspace_id, run.id),
  ]);
  return {
    runId: String(run.id),
    status: "failed",
    persistedClaims: 0,
    occurrenceCandidates: 0,
    warningCount: 0,
    errorCode: code,
  };
}

async function deferRunForStageRetry(
  run: Row,
  owner: string,
  error: unknown,
  completedUsage: ModelUsage | null,
): Promise<ExtractionProcessResult> {
  const timestamp = now();
  const code = errorCode(error);
  await getD1().batch([
    getD1()
      .prepare(
        `UPDATE extraction_runs
            SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                started_at = NULL, finished_at = NULL,
                input_tokens = COALESCE(?, input_tokens),
                output_tokens = COALESCE(?, output_tokens),
                cached_tokens = COALESCE(?, cached_tokens),
                provider_request_id = COALESCE(?, provider_request_id),
                error_code = ?, error_details_json = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        completedUsage?.inputTokens ?? null,
        completedUsage?.outputTokens ?? null,
        completedUsage?.cachedTokens ?? null,
        completedUsage?.providerRequestId ?? null,
        code,
        JSON.stringify({ deferred_stage_retry: true, ...sanitizedIssue(error) }),
        timestamp,
        run.id,
        owner,
      ),
    getD1()
      .prepare(
        `UPDATE projects
            SET scenario_lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND scenario_status = 'assessing'
            AND scenario_assessment_run_id = ?`,
      )
      .bind(
        plusMilliseconds(timestamp, EXTRACTION_RUN_LEASE_MS + 5 * 60_000),
        timestamp,
        run.project_id,
        run.workspace_id,
        run.id,
      ),
  ]);
  return {
    runId: String(run.id),
    status: "deferred",
    persistedClaims: 0,
    occurrenceCandidates: 0,
    warningCount: 1,
    errorCode: code,
  };
}

export async function processExtractionRun(runId: string): Promise<ExtractionProcessResult> {
  const initial = await first(`SELECT * FROM extraction_runs WHERE id = ?`, [runId]);
  if (!initial) {
    throw new ProcessingFault("NOT_FOUND", "Extraction run does not exist.");
  }
  if (TERMINAL_RUN_STATES.has(String(initial.status))) {
    return {
      runId,
      status: "already_terminal",
      persistedClaims: 0,
      occurrenceCandidates: 0,
      warningCount: 0,
    };
  }
  const owner = `consumer_${crypto.randomUUID()}`;
  const leased = await acquireRunLease(runId, owner, now());
  if (!leased) {
    return {
      runId,
      status: "lease_not_acquired",
      persistedClaims: 0,
      occurrenceCandidates: 0,
      warningCount: 0,
    };
  }
  let completedUsage: ModelUsage | null = null;
  try {
    if (
      String(leased.prompt_version) !== CLAIM_EXTRACTION_PROMPT_VERSION ||
      String(leased.schema_version) !== CLAIM_EXTRACTION_SCHEMA_VERSION
    ) {
      throw new ProcessingFault(
        "STALE_MODEL_CONTRACT",
        "Extraction run was created for an older prompt or schema and must be submitted again.",
        {
          run_prompt_version: leased.prompt_version,
          run_schema_version: leased.schema_version,
          current_prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION,
          current_schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION,
        },
      );
    }
    const input = await loadContextInput(leased);
    await persistContextSnapshot(
      leased,
      owner,
      input.contextPack,
      input.contextSnapshotHash,
      input.inputSnapshotHash,
      input.imageUnits,
    );
    const frozenModelParams = parseJson<Record<string, unknown>>(
      String(leased.model_params_json ?? "{}"),
      {},
    );
    const providerName = String(leased.provider ?? "");
    const modelName = String(leased.model ?? "");
    const inventoryEffort =
      typeof frozenModelParams.reasoning_effort === "string"
        ? frozenModelParams.reasoning_effort
        : "xhigh";
    const verifierEffort = normalizeVerifierReasoningEffort(
      typeof frozenModelParams.verifier_reasoning_effort === "string"
        ? frozenModelParams.verifier_reasoning_effort
        : undefined,
    );
    const maxOutputTokens =
      typeof frozenModelParams.max_output_tokens === "number"
        ? frozenModelParams.max_output_tokens
        : undefined;
    const timeoutMs =
      typeof frozenModelParams.timeout_ms === "number"
        ? frozenModelParams.timeout_ms
        : undefined;
    const pipelineEnabled = frozenModelParams.two_pass_pipeline === true;
    let finalOutput: ExtractClaimsOutput;
    let finalUsage: ModelUsage;
    const pipelineWarnings: Array<Record<string, unknown>> = [];

    if (pipelineEnabled) {
      const inventoryProvider = createModelProvider(getBindings(), {
        provider: providerName,
        model: modelName,
        reasoningEffort: inventoryEffort,
        maxOutputTokens,
        timeoutMs,
      });
      const inventoryInputHash = await hashText(JSON.stringify({
        run_input_hash: leased.input_hash,
        context_snapshot_hash: input.contextSnapshotHash,
        stage: "inventory",
        prompt: TWO_STAGE_EXTRACTION_PROMPT_VERSION,
        schema: INVENTORY_SCHEMA_VERSION,
      }));
      const inventoryStage = await runModelStage<InventoryOutput>({
        run: leased,
        stage: "inventory",
        provider: providerName,
        model: modelName,
        reasoningEffort: inventoryEffort,
        promptVersion: `${TWO_STAGE_EXTRACTION_PROMPT_VERSION}:inventory`,
        schemaVersion: INVENTORY_SCHEMA_VERSION,
        inputHash: inventoryInputHash,
        validate: (value) => validateInventoryOutput(value).output,
        invoke: (idempotencyKey) => inventoryProvider.inventoryClaims(
          input.contextPack,
          { idempotencyKey, promptCacheKey: `notique:${leased.id}:two-stage` },
        ),
      });
      completedUsage = inventoryStage.usage;

      const verifyInputHash = await hashText(JSON.stringify({
        run_input_hash: leased.input_hash,
        context_snapshot_hash: input.contextSnapshotHash,
        inventory: inventoryStage.output,
        stage: "verify",
        prompt: TWO_STAGE_EXTRACTION_PROMPT_VERSION,
        schema: VERIFICATION_SCHEMA_VERSION,
      }));
      const verifierProvider = createModelProvider(getBindings(), {
        provider: providerName,
        model: modelName,
        reasoningEffort: verifierEffort,
        maxOutputTokens,
        timeoutMs,
      });
      let verifyStage: { output: VerificationOutput; usage: ModelUsage; reused: boolean } | null = null;
      let verificationFailure: unknown = null;
      try {
        verifyStage = await runModelStage<VerificationOutput>({
          run: leased,
          stage: "verify",
          provider: providerName,
          model: modelName,
          reasoningEffort: verifierEffort,
          promptVersion: `${TWO_STAGE_EXTRACTION_PROMPT_VERSION}:verify`,
          schemaVersion: VERIFICATION_SCHEMA_VERSION,
          inputHash: verifyInputHash,
          validate: (value) => validateVerificationOutput(
            value,
            inventoryStage.output,
            input.contextPack,
          ).output,
          invoke: (idempotencyKey) => verifierProvider.verifyClaims(
            input.contextPack,
            inventoryStage.output,
            { idempotencyKey, promptCacheKey: `notique:${leased.id}:two-stage` },
          ),
        });
      } catch (error) {
        if (!(error instanceof ModelOutputInvalidError)) throw error;
        verificationFailure = error;
      }
      const usages = [
        inventoryStage.usage,
        ...(verifyStage ? [verifyStage.usage] : []),
        ...(verificationFailure instanceof ModelOutputInvalidError && verificationFailure.usage
          ? [verificationFailure.usage]
          : []),
      ];
      completedUsage = aggregateUsage(usages);
      let acceptedVerification = verifyStage?.output ?? null;
      let assessment = assessVerificationEscalation(
        inventoryStage.output,
        acceptedVerification ?? {},
        input.contextPack,
      );
      if (assessment.required) {
        const escalatedProvider = createModelProvider(getBindings(), {
          provider: providerName,
          model: modelName,
          reasoningEffort: "xhigh",
          maxOutputTokens,
          timeoutMs,
        });
        const escalatedInputHash = await hashText(JSON.stringify({
          verify_input_hash: verifyInputHash,
          prior_verification: verifyStage?.output ?? null,
          prior_failure: verificationFailure ? sanitizedIssue(verificationFailure) : null,
          escalation_reasons: assessment.reasons,
          stage: "verify_escalated",
        }));
        try {
          const escalatedStage = await runModelStage<VerificationOutput>({
            run: leased,
            stage: "verify_escalated",
            provider: providerName,
            model: modelName,
            reasoningEffort: "xhigh",
            promptVersion: `${TWO_STAGE_EXTRACTION_PROMPT_VERSION}:verify_escalated`,
            schemaVersion: VERIFICATION_SCHEMA_VERSION,
          inputHash: escalatedInputHash,
          details: { escalation_reasons: assessment.reasons },
            validate: (value) => validateVerificationOutput(
              value,
              inventoryStage.output,
              input.contextPack,
            ).output,
            invoke: (idempotencyKey) => escalatedProvider.verifyClaims(
              input.contextPack,
              inventoryStage.output,
              {
                idempotencyKey,
                promptCacheKey: `notique:${leased.id}:two-stage`,
                qualityFeedback: [
                  ...assessment.reasons,
                  ...(assessment.droppedCriticalInventoryKeys.length
                    ? [`Dropped critical inventory keys: ${assessment.droppedCriticalInventoryKeys.join(", ")}`]
                    : []),
                  ...(assessment.lowConfidenceRelationClaimKeys.length
                    ? [`Low-confidence relation claim keys: ${assessment.lowConfidenceRelationClaimKeys.join(", ")}`]
                    : []),
                  "Do not solve coverage pressure by combining independent propositions; atomicity remains mandatory.",
                ],
              },
            ),
          });
          usages.push(escalatedStage.usage);
          if (acceptedVerification) {
            const selection = selectPreferredVerificationForReview(
              inventoryStage.output,
              acceptedVerification,
              escalatedStage.output,
              input.contextPack,
            );
            acceptedVerification = selection.output;
            assessment = selection.assessment;
            if (selection.selected === "base") {
              pipelineWarnings.push({
                code: "MODEL_ESCALATION_NOT_IMPROVED",
                fallback_stage: "verify",
              });
            }
          } else {
            acceptedVerification = escalatedStage.output;
            assessment = assessVerificationEscalation(
              inventoryStage.output,
              acceptedVerification,
              input.contextPack,
            );
          }
        } catch (error) {
          if (!(error instanceof ModelOutputInvalidError)) throw error;
          if (error.usage) usages.push(error.usage);
          completedUsage = aggregateUsage(usages);
          if (!acceptedVerification) throw error;
          pipelineWarnings.push({
            code: "MODEL_ESCALATION_OUTPUT_INVALID",
            details: sanitizedIssue(error),
            fallback_stage: "verify",
          });
        }
        completedUsage = aggregateUsage(usages);
      }
      if (!acceptedVerification) {
        throw verificationFailure ?? new ProcessingFault(
          "MODEL_OUTPUT_INVALID",
          "Verification did not produce a valid final output.",
        );
      }
      if (assessment.required) {
        pipelineWarnings.push({
          code: "MODEL_QUALITY_GATE_UNRESOLVED",
          reasons: assessment.reasons,
          unmapped_inventory_keys: assessment.unmappedInventoryKeys,
          dropped_critical_inventory_keys: assessment.droppedCriticalInventoryKeys,
          low_confidence_relation_claim_keys: assessment.lowConfidenceRelationClaimKeys,
        });
      }
      finalOutput = toFinalExtractClaimsOutput(acceptedVerification);
      finalUsage = completedUsage ?? aggregateUsage(usages);
    } else {
      const provider = createModelProvider(getBindings(), {
        provider: providerName,
        model: modelName,
        reasoningEffort: inventoryEffort,
        maxOutputTokens,
        timeoutMs,
      });
      const result = await provider.extractClaims(input.contextPack);
      completedUsage = result.usage;
      finalOutput = result.output;
      finalUsage = result.usage;
    }
    // Keep strict structural validation at the processor boundary. Context-sensitive target
    // drift is handled deterministically by prepareCandidates so one bad proposed relation
    // becomes a warning instead of destroying every otherwise valid Claim in the Run.
    const validated = validateExtractClaimsOutput(finalOutput, input.contextPack);
    if (!validated.valid || !validated.output) {
      throw new ModelOutputInvalidError(validated.issues, finalUsage);
    }
    if (validated.output.event_id !== String(leased.event_id)) {
      throw new ModelOutputInvalidError([
        { path: "$.event_id", message: "Model event ID does not match the leased run." },
      ], finalUsage);
    }
    return await persistModelOutput(
      leased,
      owner,
      validated.output,
      input.contextPack,
      input.manifestRows,
      input.segments,
      finalUsage,
      pipelineWarnings,
    );
  } catch (error) {
    const frozenModelParams = parseJson<Record<string, unknown>>(
      String(leased.model_params_json ?? "{}"),
      {},
    );
    if (frozenModelParams.two_pass_pipeline === true && isTransientModelError(error)) {
      return deferRunForStageRetry(leased, owner, error, completedUsage);
    }
    return markRunFailed(leased, owner, error, completedUsage);
  }
}

export async function failExpiredProcessingRuns(timestamp = now()): Promise<number> {
  const db = getD1();
  const staleStageCutoff = new Date(
    Date.parse(timestamp) - EXTRACTION_STAGE_STALE_AFTER_MS,
  ).toISOString();
  const scenarioLeaseExpiresAt = plusMilliseconds(
    timestamp,
    EXTRACTION_RUN_LEASE_MS + 5 * 60_000,
  );
  const [requeued, , , failed] = await db.batch([
    db.prepare(
      `UPDATE extraction_runs
          SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
              started_at = NULL, finished_at = NULL,
              error_code = 'MODEL_TIMEOUT',
              error_details_json = '{"reason":"stale_model_stage","retryable":true}',
              updated_at = ?
        WHERE status = 'processing'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            OR EXISTS (
              SELECT 1 FROM extraction_model_stages s
               WHERE s.run_id = extraction_runs.id
                 AND s.status = 'processing' AND s.started_at <= ?
            )
          )
          AND COALESCE(json_extract(model_params_json, '$.two_pass_pipeline'), 0) = 1
          AND COALESCE(json_extract(model_params_json, '$.reasoning_effort'), '') IN ('xhigh', 'high')
          AND EXISTS (
            SELECT 1 FROM queue_outbox o
             WHERE o.run_id = extraction_runs.id AND o.attempt < 3
          )`,
    ).bind(timestamp, timestamp, staleStageCutoff),
    db.prepare(
      `UPDATE queue_outbox
          SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, last_error_code = 'STALE_MODEL_STAGE', updated_at = ?
        WHERE status = 'sending' AND attempt < 3
          AND run_id IN (
            SELECT id FROM extraction_runs
             WHERE status = 'queued' AND error_code = 'MODEL_TIMEOUT'
               AND json_extract(error_details_json, '$.reason') = 'stale_model_stage'
          )`,
    ).bind(timestamp, timestamp),
    db.prepare(
      `UPDATE projects
          SET scenario_lease_expires_at = ?, updated_at = ?
        WHERE scenario_status = 'assessing'
          AND scenario_assessment_run_id IN (
            SELECT id FROM extraction_runs WHERE status = 'queued'
          )`,
    ).bind(scenarioLeaseExpiresAt, timestamp),
    db.prepare(
      `UPDATE extraction_runs
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              finished_at = ?, error_code = 'MODEL_TIMEOUT',
              error_details_json = '{"reason":"stale_model_stage","retryable":false}', updated_at = ?
        WHERE status = 'processing'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
            OR (
              COALESCE(json_extract(model_params_json, '$.two_pass_pipeline'), 0) = 1
              AND EXISTS (
                SELECT 1 FROM extraction_model_stages s
                 WHERE s.run_id = extraction_runs.id
                   AND s.status = 'processing' AND s.started_at <= ?
              )
            )
          )`,
    ).bind(timestamp, timestamp, timestamp, staleStageCutoff),
  ]);
  await db
    .prepare(
      `UPDATE queue_outbox
          SET status = 'sent', sent_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = 'STALE_MODEL_STAGE', updated_at = ?
        WHERE status = 'sending' AND run_id IN (
          SELECT id FROM extraction_runs
           WHERE status = 'failed' AND error_code = 'MODEL_TIMEOUT'
             AND json_extract(error_details_json, '$.reason') = 'stale_model_stage'
        )`,
    )
    .bind(timestamp, timestamp)
    .run();
  await db
    .prepare(
      `UPDATE projects
          SET scenario_status = 'unassessed', scenario_assessment_run_id = NULL,
              scenario_candidates_json = '[]', scenario_lease_expires_at = NULL,
              updated_at = ?
        WHERE scenario_status = 'assessing' AND scenario_lease_expires_at <= ?
          AND EXISTS (
            SELECT 1 FROM extraction_runs r
             WHERE r.id = projects.scenario_assessment_run_id AND r.status = 'failed'
          )`,
    )
    .bind(timestamp, timestamp)
    .run();
  return Number(requeued.meta.changes ?? 0) + Number(failed.meta.changes ?? 0);
}
