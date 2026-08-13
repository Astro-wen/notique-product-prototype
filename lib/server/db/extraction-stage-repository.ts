import { getD1 } from "@/db";
import { extractionModelStageRecord } from "@/lib/server/db/records";
import type {
  ExtractionModelStageDebugRecord,
  ExtractionModelStageName,
  ExtractionModelStageRecord,
  ExtractionModelStageStatus,
  ExtractionModelStageTimingRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

const MAX_VALIDATED_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_DETAILS_BYTES = 64 * 1024;
const TERMINAL_STAGE_STATUS = new Set<ExtractionModelStageStatus>(["succeeded"]);
const SENSITIVE_DEBUG_KEYS = new Set([
  "api_key",
  "authorization",
  "cookie",
  "credentials",
  "idempotency_key",
  "internal_job_token",
  "r2_model_key",
  "r2_original_key",
  "refresh_token",
  "access_token",
  "secret",
  "storage_key",
]);

export type UpsertExtractionModelStageInput = {
  runId: string;
  stage: ExtractionModelStageName;
  attempt?: number;
  provider: string;
  model: string;
  reasoningEffort: string;
  promptVersion: string;
  schemaVersion: string;
  status: ExtractionModelStageStatus;
  inputHash: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  estimatedCostUsd?: number | null;
  providerRequestId?: string | null;
  validatedOutput?: unknown;
  errorCode?: string | null;
  errorDetails?: unknown;
  startedAt?: string;
  finishedAt?: string | null;
  durationMs?: number | null;
};

function id(): string {
  return `emst_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

function boundedJson(value: unknown, maxBytes: number, label: string): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label} must be JSON serializable.`);
  if (new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte persistence limit.`);
  }
  return json;
}

function assertNonnegative(value: number | null | undefined, label: string): void {
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be a nonnegative number.`);
  }
}

function assertImmutableMatch(
  existing: ExtractionModelStageRecord,
  input: UpsertExtractionModelStageInput,
): void {
  const immutable = [
    ["provider", existing.provider, input.provider],
    ["model", existing.model, input.model],
    ["reasoning_effort", existing.reasoning_effort, input.reasoningEffort],
    ["prompt_version", existing.prompt_version, input.promptVersion],
    ["schema_version", existing.schema_version, input.schemaVersion],
    ["input_hash", existing.input_hash, input.inputHash],
  ] as const;
  const mismatch = immutable.find(([, stored, incoming]) => stored !== incoming);
  if (mismatch) {
    throw new Error(
      `EXTRACTION_STAGE_INPUT_CONFLICT: ${mismatch[0]} differs for ` +
        `${input.runId}/${input.stage}/${input.attempt ?? 1}.`,
    );
  }
}

function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MAX_DEPTH]";
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk|gh[opurs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDebugValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_DEBUG_KEYS.has(key.toLowerCase())
      ? "[REDACTED]"
      : sanitizeDebugValue(child, depth + 1);
  }
  return output;
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

export async function getExtractionModelStage(
  runId: string,
  stage: ExtractionModelStageName,
  attempt = 1,
): Promise<ExtractionModelStageRecord | null> {
  const row = await first(
    `SELECT * FROM extraction_model_stages
      WHERE run_id = ? AND stage = ? AND attempt = ?`,
    [runId, stage, attempt],
  );
  return row ? extractionModelStageRecord(row) : null;
}

export async function getLatestExtractionModelStage(
  runId: string,
  stage: ExtractionModelStageName,
): Promise<ExtractionModelStageRecord | null> {
  const row = await first(
    `SELECT * FROM extraction_model_stages
      WHERE run_id = ? AND stage = ?
      ORDER BY attempt DESC LIMIT 1`,
    [runId, stage],
  );
  return row ? extractionModelStageRecord(row) : null;
}

export async function supersedeProcessingExtractionModelStage(
  runId: string,
  stage: ExtractionModelStageName,
  beforeAttempt: number,
  timestamp = now(),
): Promise<void> {
  await getD1()
    .prepare(
      `UPDATE extraction_model_stages
          SET status = 'failed', finished_at = ?,
              duration_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
              validated_output_json = NULL,
              error_code = 'STAGE_ATTEMPT_SUPERSEDED',
              error_details_json = '{"reason":"worker_recovery"}', updated_at = ?
        WHERE run_id = ? AND stage = ? AND status = 'processing'
          AND attempt < ?`,
    )
    .bind(timestamp, timestamp, timestamp, runId, stage, beforeAttempt)
    .run();
}

export async function upsertExtractionModelStage(
  input: UpsertExtractionModelStageInput,
): Promise<ExtractionModelStageRecord> {
  const attempt = input.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Extraction model stage attempt must be a positive integer.");
  }
  for (const [label, value] of [
    ["runId", input.runId],
    ["provider", input.provider],
    ["model", input.model],
    ["reasoningEffort", input.reasoningEffort],
    ["promptVersion", input.promptVersion],
    ["schemaVersion", input.schemaVersion],
    ["inputHash", input.inputHash],
  ] as const) {
    if (!value.trim()) throw new Error(`${label} is required for an extraction model stage.`);
  }
  assertNonnegative(input.inputTokens, "inputTokens");
  assertNonnegative(input.outputTokens, "outputTokens");
  assertNonnegative(input.cachedTokens, "cachedTokens");
  assertNonnegative(input.estimatedCostUsd, "estimatedCostUsd");
  assertNonnegative(input.durationMs, "durationMs");
  if (input.status === "succeeded" && input.validatedOutput == null) {
    throw new Error("A succeeded extraction model stage requires validatedOutput.");
  }
  if (input.status === "failed" && !input.errorCode?.trim()) {
    throw new Error("A failed extraction model stage requires errorCode.");
  }

  const existing = await getExtractionModelStage(input.runId, input.stage, attempt);
  if (existing) {
    assertImmutableMatch(existing, input);
    if (TERMINAL_STAGE_STATUS.has(existing.status)) return existing;
  }

  const validatedOutputJson =
    input.status === "succeeded"
      ? boundedJson(input.validatedOutput, MAX_VALIDATED_OUTPUT_BYTES, "validatedOutput")
      : null;
  const errorDetailsJson = boundedJson(
    input.errorDetails,
    MAX_ERROR_DETAILS_BYTES,
    "errorDetails",
  );
  const timestamp = now();
  const startedAt = input.startedAt ?? existing?.started_at ?? timestamp;
  const finishedAt = input.status === "processing" ? null : input.finishedAt ?? timestamp;
  const durationMs = input.status === "processing" ? null : input.durationMs ?? null;

  await getD1()
    .prepare(
      `INSERT INTO extraction_model_stages (
         id, run_id, stage, attempt, provider, model, reasoning_effort,
         prompt_version, schema_version, status, input_hash, input_tokens,
         output_tokens, cached_tokens, estimated_cost_usd, provider_request_id,
         validated_output_json, error_code, error_details_json, started_at,
         finished_at, duration_ms, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, stage, attempt) DO UPDATE SET
         status = excluded.status,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cached_tokens = excluded.cached_tokens,
         estimated_cost_usd = excluded.estimated_cost_usd,
         provider_request_id = COALESCE(
           excluded.provider_request_id,
           extraction_model_stages.provider_request_id
         ),
         validated_output_json = excluded.validated_output_json,
         error_code = excluded.error_code,
         error_details_json = excluded.error_details_json,
         started_at = CASE
           WHEN excluded.status = 'processing' THEN excluded.started_at
           ELSE extraction_model_stages.started_at
         END,
         finished_at = excluded.finished_at,
         duration_ms = excluded.duration_ms,
         updated_at = excluded.updated_at
       WHERE extraction_model_stages.status <> 'succeeded'
         AND extraction_model_stages.provider = excluded.provider
         AND extraction_model_stages.model = excluded.model
         AND extraction_model_stages.reasoning_effort = excluded.reasoning_effort
         AND extraction_model_stages.prompt_version = excluded.prompt_version
         AND extraction_model_stages.schema_version = excluded.schema_version
         AND extraction_model_stages.input_hash = excluded.input_hash`,
    )
    .bind(
      id(),
      input.runId,
      input.stage,
      attempt,
      input.provider,
      input.model,
      input.reasoningEffort,
      input.promptVersion,
      input.schemaVersion,
      input.status,
      input.inputHash,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cachedTokens ?? null,
      input.estimatedCostUsd ?? null,
      input.providerRequestId ?? null,
      validatedOutputJson,
      input.status === "failed" ? input.errorCode : null,
      errorDetailsJson,
      startedAt,
      finishedAt,
      durationMs,
      timestamp,
      timestamp,
    )
    .run();

  const saved = await getExtractionModelStage(input.runId, input.stage, attempt);
  if (!saved) throw new Error("Extraction model stage was not persisted.");
  assertImmutableMatch(saved, input);
  return saved;
}

export async function listExtractionModelStageDebug(
  runId: string,
  workspaceId: string,
): Promise<ExtractionModelStageDebugRecord[]> {
  const result = await getD1()
    .prepare(
      `SELECT s.*
         FROM extraction_model_stages s
         JOIN extraction_runs r ON r.id = s.run_id
        WHERE s.run_id = ? AND r.workspace_id = ?
        ORDER BY CASE s.stage
          WHEN 'inventory' THEN 1 WHEN 'verify' THEN 2 ELSE 3 END,
          s.attempt ASC`,
    )
    .bind(runId, workspaceId)
    .all<Row>();
  return (result.results ?? []).map((row) => {
    const persisted = extractionModelStageRecord(row);
    const record: Partial<ExtractionModelStageRecord> = { ...persisted };
    delete record.run_id;
    const validatedOutputBytes = new TextEncoder().encode(
      String(row.validated_output_json ?? ""),
    ).byteLength;
    const errorDetailsBytes = new TextEncoder().encode(
      String(row.error_details_json ?? ""),
    ).byteLength;
    return {
      ...record,
      validated_output:
        validatedOutputBytes <= MAX_VALIDATED_OUTPUT_BYTES
          ? sanitizeDebugValue(persisted.validated_output)
          : "[OMITTED_OVERSIZE]",
      error_details:
        errorDetailsBytes <= MAX_ERROR_DETAILS_BYTES
          ? sanitizeDebugValue(persisted.error_details)
          : "[OMITTED_OVERSIZE]",
    } as ExtractionModelStageDebugRecord;
  });
}

export async function listExtractionModelStageTimings(
  runId: string,
  workspaceId: string,
): Promise<ExtractionModelStageTimingRecord[]> {
  const result = await getD1()
    .prepare(
      `SELECT s.stage, s.status, s.attempt, s.reasoning_effort,
              s.input_tokens, s.output_tokens, s.cached_tokens,
              s.started_at, s.finished_at, s.duration_ms
         FROM extraction_model_stages s
         JOIN extraction_runs r ON r.id = s.run_id
        WHERE s.run_id = ? AND r.workspace_id = ?
        ORDER BY CASE s.stage
          WHEN 'inventory' THEN 1 WHEN 'verify' THEN 2 ELSE 3 END,
          s.attempt ASC`,
    )
    .bind(runId, workspaceId)
    .all<Row>();
  return (result.results ?? []).map((row) => ({
    stage: String(row.stage) as ExtractionModelStageTimingRecord["stage"],
    status: String(row.status) as ExtractionModelStageTimingRecord["status"],
    attempt: Number(row.attempt),
    reasoning_effort: String(row.reasoning_effort),
    input_tokens: row.input_tokens == null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens == null ? null : Number(row.output_tokens),
    cached_tokens: row.cached_tokens == null ? null : Number(row.cached_tokens),
    started_at: String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
  }));
}
