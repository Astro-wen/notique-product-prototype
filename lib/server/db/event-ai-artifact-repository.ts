import { getBindings, getD1, getEvidenceBucket } from "@/db";
import {
  EVENT_SUMMARY_PROMPT_VERSION,
  EVENT_SUMMARY_SCHEMA_VERSION,
  READABLE_TRANSCRIPT_PROMPT_VERSION,
  READABLE_TRANSCRIPT_SCHEMA_VERSION,
  type EventAiArtifactKind,
  type EventSummaryOutput,
  type ReadableTranscriptOutput,
  type ReadableTranscriptSourceChunk,
} from "@/lib/domain/event-ai-artifacts";
import type { ModelUsage } from "@/lib/domain/model-contract";
import type { TranscriptSegment } from "@/lib/domain/types";
import { normalizeVerifierReasoningEffort } from "@/lib/domain/model-config";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import { assetObjectKey, sha256Hex } from "@/lib/server/storage/keys";
import type {
  EventAiArtifactRecord,
  EventAiArtifactRunRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

type ArtifactRunManifestItem = {
  asset_version_id: string;
  sha256: string;
  parser_version: string | null;
  kind: "transcript" | "photo" | "pdf" | "text";
};

const ARTIFACT_MANIFEST_KINDS = new Set<ArtifactRunManifestItem["kind"]>([
  "transcript", "photo", "pdf", "text",
]);

// Summary and Readable Transcript jobs may read user-pasted text and raw
// transcripts, but never a readability artifact (or any source explicitly
// marked as excluded from analysis). Keep this boundary beside the query that
// supplies the provider and deterministic Summary quote resolver.
const RAW_ARTIFACT_SOURCE_ASSET_PREDICATE = `
  a.kind IN ('transcript', 'text')
  AND COALESCE(json_extract(a.metadata_json, '$.analysis_source'), 1) <> 0
  AND COALESCE(json_extract(a.metadata_json, '$.artifact_kind'), '') <> 'readable_transcript'
`;

export type EventAiArtifactChunkRecord = {
  id: string;
  artifact_run_id: string;
  chunk_index: number;
  input_hash: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  provider_request_id: string | null;
  validated_output_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  attempt_no: number;
  error_code: string | null;
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
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

function artifactChunkRecord(row: Row): EventAiArtifactChunkRecord {
  return {
    id: String(row.id),
    artifact_run_id: String(row.artifact_run_id),
    chunk_index: Number(row.chunk_index),
    input_hash: String(row.input_hash),
    status: String(row.status) as EventAiArtifactChunkRecord["status"],
    provider_request_id: row.provider_request_id == null ? null : String(row.provider_request_id),
    validated_output_json: row.validated_output_json == null ? null : String(row.validated_output_json),
    input_tokens: row.input_tokens == null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens == null ? null : Number(row.output_tokens),
    cached_tokens: row.cached_tokens == null ? null : Number(row.cached_tokens),
    attempt_no: Number(row.attempt_no ?? 0),
    error_code: row.error_code == null ? null : String(row.error_code),
  };
}

function runRecord(row: Row): EventAiArtifactRunRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    event_id: String(row.event_id),
    extraction_run_id: String(row.extraction_run_id),
    kind: String(row.kind) as EventAiArtifactRunRecord["kind"],
    status: String(row.status) as EventAiArtifactRunRecord["status"],
    provider: String(row.provider),
    model: String(row.model),
    reasoning_effort: String(row.reasoning_effort),
    prompt_version: String(row.prompt_version),
    schema_version: String(row.schema_version),
    attempt_no: Number(row.attempt_no ?? 0),
    provider_request_id: row.provider_request_id == null ? null : String(row.provider_request_id),
    input_tokens: row.input_tokens == null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens == null ? null : Number(row.output_tokens),
    cached_tokens: row.cached_tokens == null ? null : Number(row.cached_tokens),
    error_code: row.error_code == null ? null : String(row.error_code),
    queued_at: String(row.queued_at),
    started_at: row.started_at == null ? null : String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function artifactRecord(row: Row): EventAiArtifactRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    event_id: String(row.event_id),
    run_id: String(row.run_id),
    kind: String(row.kind) as EventAiArtifactRecord["kind"],
    artifact_version: Number(row.artifact_version),
    input_hash: String(row.input_hash),
    content: parseJson(String(row.content_json), null),
    derived_asset_id: row.derived_asset_id == null ? null : String(row.derived_asset_id),
    derived_asset_version_id: row.derived_asset_version_id == null ? null : String(row.derived_asset_version_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function sourceSegmentsForArtifactRun(runId: string): Promise<{
  run: Row;
  segments: TranscriptSegment[];
  locale: string;
  glossary: Array<{ term: string; meaning: string; category: string; claimVersionId: string | null }>;
}> {
  const run = await first(
    `SELECT ar.*, p.locale
       FROM event_ai_artifact_runs ar
       JOIN projects p ON p.id = ar.project_id
       JOIN extraction_runs er ON er.id = ar.extraction_run_id
        AND er.workspace_id = ar.workspace_id
        AND er.project_id = ar.project_id
        AND er.event_id = ar.event_id
      WHERE ar.id = ? AND p.workspace_id = ar.workspace_id
        AND p.deleted_at IS NULL`,
    [runId],
  );
  if (!run) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "AI artifact run was not found.");
  const parsedManifest = parseJson<unknown>(
    String(run.input_manifest_json ?? "[]"),
    [],
  );
  if (!Array.isArray(parsedManifest) || !parsedManifest.length) {
    throw new Error("ARTIFACT_INPUT_MANIFEST_INVALID");
  }
  const manifest: ArtifactRunManifestItem[] = parsedManifest.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("ARTIFACT_INPUT_MANIFEST_INVALID");
    }
    const item = candidate as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (
      keys.join("\u0000") !== ["asset_version_id", "kind", "parser_version", "sha256"].sort().join("\u0000") ||
      typeof item.asset_version_id !== "string" || !item.asset_version_id ||
      typeof item.sha256 !== "string" || !item.sha256 ||
      !(item.parser_version === null || typeof item.parser_version === "string") ||
      typeof item.kind !== "string" || !ARTIFACT_MANIFEST_KINDS.has(item.kind as ArtifactRunManifestItem["kind"])
    ) {
      throw new Error("ARTIFACT_INPUT_MANIFEST_INVALID");
    }
    return {
      asset_version_id: item.asset_version_id,
      sha256: item.sha256,
      parser_version: item.parser_version,
      kind: item.kind as ArtifactRunManifestItem["kind"],
    };
  });
  const allVersionIds = manifest.map((item) => item.asset_version_id);
  if (new Set(allVersionIds).size !== allVersionIds.length) {
    throw new Error("ARTIFACT_INPUT_MANIFEST_INVALID");
  }
  const expectedInputHash = await hashText(JSON.stringify({
    extraction_run_id: run.extraction_run_id,
    input_manifest: parsedManifest,
    kind: run.kind,
    provider: run.provider,
    model: run.model,
    effort: run.reasoning_effort,
    prompt: run.prompt_version,
    schema: run.schema_version,
  }));
  if (expectedInputHash !== String(run.input_hash)) {
    throw new Error("ARTIFACT_INPUT_HASH_CHANGED");
  }
  const manifestRows = await all(
    `SELECT av.id, av.content_sha256, av.parser_version, a.kind,
            a.metadata_json, a.workspace_id, a.project_id, a.event_id
       FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
      WHERE av.id IN (${allVersionIds.map(() => "?").join(",")})
        AND a.workspace_id = ? AND a.project_id = ? AND a.event_id = ?`,
    [...allVersionIds, run.workspace_id, run.project_id, run.event_id],
  );
  if (manifestRows.length !== allVersionIds.length) {
    throw new ApiFault(409, "PROJECT_SCOPE_VIOLATION", "AI artifact input references unavailable material.");
  }
  const rowByVersionId = new Map(manifestRows.map((row) => [String(row.id), row]));
  for (const item of manifest) {
    const row = rowByVersionId.get(item.asset_version_id);
    if (
      !row || String(row.content_sha256) !== item.sha256 ||
      String(row.kind) !== item.kind ||
      (row.parser_version == null ? null : String(row.parser_version)) !== item.parser_version
    ) {
      throw new Error("ARTIFACT_INPUT_MANIFEST_CHANGED");
    }
  }
  const rawManifest = manifest.filter((item) => item.kind === "transcript" || item.kind === "text");
  const versionIds = rawManifest.map((item) => item.asset_version_id);
  if (!versionIds.length) throw new Error("ARTIFACT_INPUT_MISSING_TRANSCRIPT");
  const rows = await all(
    `SELECT ts.*
       FROM text_segments ts
       JOIN assets a ON a.id = ts.asset_id
      WHERE ts.event_id = ? AND ts.workspace_id = ? AND ts.project_id = ?
        AND ts.asset_version_id IN (${versionIds.map(() => "?").join(",")})
        AND ${RAW_ARTIFACT_SOURCE_ASSET_PREDICATE}
      ORDER BY ts.asset_version_id, ts.ordinal`,
    [run.event_id, run.workspace_id, run.project_id, ...versionIds],
  );
  const segmentVersionIds = new Set(rows.map((row) => String(row.asset_version_id)));
  if (versionIds.some((versionId) => !segmentVersionIds.has(versionId))) {
    throw new Error("ARTIFACT_INPUT_MISSING_TRANSCRIPT");
  }
  const versionOrder = new Map(versionIds.map((versionId, index) => [versionId, index]));
  rows.sort((left, right) => {
    const versionDelta = (versionOrder.get(String(left.asset_version_id)) ?? Number.MAX_SAFE_INTEGER) -
      (versionOrder.get(String(right.asset_version_id)) ?? Number.MAX_SAFE_INTEGER);
    return versionDelta || Number(left.ordinal) - Number(right.ordinal);
  });
  const glossaryRows = await all(
    `SELECT canonical_value, aliases_json, category
       FROM glossary_entries
      WHERE project_id = ? AND deleted_at IS NULL AND is_active = 1
      ORDER BY canonical_value`,
    [run.project_id],
  );
  return {
    run,
    locale: String(run.locale ?? "en-US"),
    segments: rows.map((row) => ({
      id: String(row.id),
      assetVersionId: String(row.asset_version_id),
      eventId: String(row.event_id),
      ordinal: Number(row.ordinal),
      speaker: row.speaker == null ? null : String(row.speaker),
      startMs: row.start_ms == null ? null : Number(row.start_ms),
      endMs: row.end_ms == null ? null : Number(row.end_ms),
      textRaw: String(row.text_raw),
      textNormalized: String(row.text_normalized),
      parserVersion: String(row.parser_version),
    })),
    glossary: glossaryRows.map((row) => ({
      term: String(row.canonical_value),
      meaning: parseJson<string[]>(String(row.aliases_json ?? "[]"), []).join(", ") || String(row.canonical_value),
      category: String(row.category),
      claimVersionId: null,
    })),
  };
}

export async function ensureReadableTranscriptChunks(
  run: Row,
  chunks: ReadableTranscriptSourceChunk[],
): Promise<EventAiArtifactChunkRecord[]> {
  if (!chunks.length) throw new Error("ARTIFACT_INPUT_MISSING_TRANSCRIPT");
  const timestamp = now();
  const expected = await Promise.all(chunks.map(async (chunk) => ({
    id: `eac_${String(run.id).replace(/^earun_/, "")}_${chunk.chunkIndex}`,
    chunkIndex: chunk.chunkIndex,
    inputHash: await hashText(JSON.stringify({
      artifact_run_id: run.id,
      chunk_index: chunk.chunkIndex,
      source_segments: chunk.segments.map((segment) => ({
        id: segment.id,
        asset_version_id: segment.assetVersionId,
        ordinal: segment.ordinal,
        speaker: segment.speaker,
        start_ms: segment.startMs,
        end_ms: segment.endMs,
        text_raw: segment.textRaw,
      })),
    })),
  })));
  await getD1().batch(expected.map((chunk) =>
    getD1().prepare(
      `INSERT OR IGNORE INTO event_ai_artifact_chunks (
         id, artifact_run_id, chunk_index, input_hash, status, attempt_no,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
    ).bind(chunk.id, run.id, chunk.chunkIndex, chunk.inputHash, timestamp, timestamp),
  ));
  const rows = await all(
    `SELECT * FROM event_ai_artifact_chunks
      WHERE artifact_run_id = ? ORDER BY chunk_index`,
    [run.id],
  );
  if (
    rows.length !== expected.length ||
    rows.some((row, index) =>
      Number(row.chunk_index) !== expected[index].chunkIndex ||
      String(row.input_hash) !== expected[index].inputHash
    )
  ) {
    throw new Error("READABLE_TRANSCRIPT_CHUNK_INPUT_CHANGED");
  }
  return rows.map(artifactChunkRecord);
}

export async function listReadableTranscriptChunks(
  runId: string,
): Promise<EventAiArtifactChunkRecord[]> {
  return (await all(
    `SELECT * FROM event_ai_artifact_chunks
      WHERE artifact_run_id = ? ORDER BY chunk_index`,
    [runId],
  )).map(artifactChunkRecord);
}

export async function persistReadableTranscriptChunk(
  run: Row,
  owner: string,
  chunkId: string,
  output: ReadableTranscriptOutput,
  usage: ModelUsage,
): Promise<void> {
  const timestamp = now();
  const guardId = id("guard");
  await getD1().batch([
    getD1().prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM event_ai_artifact_runs
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
       ) AND EXISTS (
         SELECT 1 FROM event_ai_artifact_chunks
          WHERE id = ? AND artifact_run_id = ? AND status = 'processing'
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, run.id, owner, chunkId, run.id, timestamp),
    getD1().prepare(
      `UPDATE event_ai_artifact_chunks
          SET status = 'succeeded', provider_request_id = COALESCE(?, provider_request_id),
              validated_output_json = ?, input_tokens = ?, output_tokens = ?,
              cached_tokens = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND artifact_run_id = ? AND status = 'processing'`,
    ).bind(
      usage.providerRequestId,
      JSON.stringify(output),
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      timestamp,
      chunkId,
      run.id,
    ),
    getD1().prepare(
      `UPDATE event_ai_artifact_runs
          SET provider_request_id = COALESCE(?, provider_request_id), updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    ).bind(usage.providerRequestId, timestamp, run.id, owner),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
}

export async function ensureEventAiArtifactRuns(input: {
  workspaceId: string;
  projectId: string;
  eventId: string;
  extractionRunId: string;
  inputManifestJson: string;
  provider: string;
  model: string;
}): Promise<EventAiArtifactRunRecord[]> {
  const bindings = getBindings();
  if (bindings.AI_EVENT_SUMMARY === "0" && bindings.AI_READABLE_TRANSCRIPT === "0") return [];
  const manifest = parseJson<Array<{ kind?: unknown }>>(input.inputManifestJson, []);
  if (!manifest.some((item) => item.kind === "transcript" || item.kind === "text")) return [];
  const timestamp = now();
  const efforts = normalizeVerifierReasoningEffort(bindings.AI_VERIFIER_REASONING_EFFORT);
  const definitions: Array<{
    kind: EventAiArtifactKind;
    prompt: string;
    schema: string;
    enabled: boolean;
  }> = [
    {
      kind: "summary",
      prompt: EVENT_SUMMARY_PROMPT_VERSION,
      schema: EVENT_SUMMARY_SCHEMA_VERSION,
      enabled: bindings.AI_EVENT_SUMMARY !== "0",
    },
    {
      kind: "readable_transcript",
      prompt: READABLE_TRANSCRIPT_PROMPT_VERSION,
      schema: READABLE_TRANSCRIPT_SCHEMA_VERSION,
      enabled: bindings.AI_READABLE_TRANSCRIPT !== "0",
    },
  ];
  for (const definition of definitions.filter((item) => item.enabled)) {
    const runId = id("earun");
    const idempotencyKey = `${input.extractionRunId}:${definition.kind}`;
    const inputHash = await hashText(JSON.stringify({
      extraction_run_id: input.extractionRunId,
      input_manifest: parseJson(input.inputManifestJson, []),
      kind: definition.kind,
      provider: input.provider,
      model: input.model,
      effort: efforts,
      prompt: definition.prompt,
      schema: definition.schema,
    }));
    await getD1()
      .prepare(
        `INSERT OR IGNORE INTO event_ai_artifact_runs (
           id, workspace_id, project_id, event_id, extraction_run_id, kind,
           status, idempotency_key, input_hash, input_manifest_json,
           provider, model, reasoning_effort, prompt_version, schema_version,
           attempt_no, next_attempt_at, queued_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        input.workspaceId,
        input.projectId,
        input.eventId,
        input.extractionRunId,
        definition.kind,
        idempotencyKey,
        inputHash,
        input.inputManifestJson,
        input.provider,
        input.model,
        efforts,
        definition.prompt,
        definition.schema,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
  }
  const rows = await all(
    `SELECT * FROM event_ai_artifact_runs
      WHERE extraction_run_id = ? ORDER BY kind`,
    [input.extractionRunId],
  );
  return rows.map(runRecord);
}

export async function listEventAiArtifacts(
  scope: RequestScope,
  eventId: string,
): Promise<{ runs: EventAiArtifactRunRecord[]; artifacts: EventAiArtifactRecord[] }> {
  const event = await first(
    `SELECT e.id FROM events e JOIN projects p ON p.id = e.project_id
      WHERE e.id = ? AND e.workspace_id = ? AND p.deleted_at IS NULL`,
    [eventId, scope.workspaceId],
  );
  if (!event) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  const runs = await all(
    `SELECT * FROM event_ai_artifact_runs
      WHERE event_id = ? AND workspace_id = ? ORDER BY created_at DESC`,
    [eventId, scope.workspaceId],
  );
  const artifacts = await all(
    `SELECT * FROM event_ai_artifacts
      WHERE event_id = ? AND workspace_id = ? ORDER BY kind, artifact_version DESC`,
    [eventId, scope.workspaceId],
  );
  return { runs: runs.map(runRecord), artifacts: artifacts.map(artifactRecord) };
}

export async function listEventAiArtifactRunDebug(
  extractionRunId: string,
  workspaceId: string,
): Promise<EventAiArtifactRunRecord[]> {
  const rows = await all(
    `SELECT ar.*
       FROM event_ai_artifact_runs ar
       JOIN extraction_runs er ON er.id = ar.extraction_run_id
      WHERE ar.extraction_run_id = ? AND ar.workspace_id = ?
        AND er.workspace_id = ?
      ORDER BY CASE ar.kind WHEN 'summary' THEN 1 ELSE 2 END, ar.created_at`,
    [extractionRunId, workspaceId, workspaceId],
  );
  return rows.map(runRecord);
}

export async function createEventAiArtifactRetry(
  scope: RequestScope,
  eventId: string,
  kind: EventAiArtifactKind,
  idempotencyKey: string,
): Promise<EventAiArtifactRunRecord> {
  let source = await first(
    `SELECT ar.* FROM event_ai_artifact_runs ar
       JOIN projects p ON p.id = ar.project_id
      WHERE ar.event_id = ? AND ar.workspace_id = ? AND ar.kind = ?
        AND p.deleted_at IS NULL
      ORDER BY ar.created_at DESC LIMIT 1`,
    [eventId, scope.workspaceId, kind],
  );
  if (source && String(source.status) !== "failed") {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "Only a failed AI artifact can be regenerated.");
  }
  if (!source) {
    source = await first(
      `SELECT er.*, er.id AS extraction_run_id
         FROM events e
         JOIN projects p ON p.id = e.project_id
         JOIN extraction_runs er ON er.id = e.active_run_id
        WHERE e.id = ? AND e.workspace_id = ? AND p.deleted_at IS NULL
          AND er.status IN ('succeeded','completed','completed_with_warnings')`,
      [eventId, scope.workspaceId],
    );
    if (!source) {
      throw new ApiFault(404, "NOT_FOUND", "Complete fact analysis is required before this reading aid can be generated.");
    }
  }
  const manifest = parseJson<Array<{ kind?: unknown }>>(String(source.input_manifest_json ?? "[]"), []);
  if (!manifest.some((item) => item.kind === "transcript" || item.kind === "text")) {
    throw new ApiFault(409, "EVENT_NOT_READY", "This event has no raw transcript for the requested reading aid.");
  }
  const existing = await first(
    `SELECT * FROM event_ai_artifact_runs
      WHERE event_id = ? AND kind = ? AND idempotency_key = ?`,
    [eventId, kind, idempotencyKey],
  );
  if (existing) return runRecord(existing);
  const runId = id("earun");
  const timestamp = now();
  const promptVersion = kind === "summary" ? EVENT_SUMMARY_PROMPT_VERSION : READABLE_TRANSCRIPT_PROMPT_VERSION;
  const schemaVersion = kind === "summary" ? EVENT_SUMMARY_SCHEMA_VERSION : READABLE_TRANSCRIPT_SCHEMA_VERSION;
  const modelParams = parseJson<Record<string, unknown>>(String(source.model_params_json ?? "{}"), {});
  const reasoningEffort = normalizeVerifierReasoningEffort(
    typeof modelParams.verifier_reasoning_effort === "string"
      ? modelParams.verifier_reasoning_effort
      : getBindings().AI_VERIFIER_REASONING_EFFORT,
  );
  const inputHash = await hashText(JSON.stringify({
    extraction_run_id: source.extraction_run_id,
    input_manifest: manifest,
    kind,
    provider: source.provider,
    model: source.model,
    effort: reasoningEffort,
    prompt: promptVersion,
    schema: schemaVersion,
  }));
  await getD1()
    .prepare(
      `INSERT INTO event_ai_artifact_runs (
         id, workspace_id, project_id, event_id, extraction_run_id, kind,
         status, idempotency_key, input_hash, input_manifest_json, provider,
         model, reasoning_effort, prompt_version, schema_version, attempt_no,
         next_attempt_at, queued_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(
      runId,
      source.workspace_id,
      source.project_id,
      source.event_id,
      source.extraction_run_id,
      kind,
      idempotencyKey,
      inputHash,
      source.input_manifest_json,
      source.provider,
      source.model,
      reasoningEffort,
      promptVersion,
      schemaVersion,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
  return runRecord((await first(`SELECT * FROM event_ai_artifact_runs WHERE id = ?`, [runId]))!);
}

export async function persistSummaryArtifact(
  run: Row,
  owner: string,
  output: EventSummaryOutput,
  usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; providerRequestId: string | null },
): Promise<void> {
  const timestamp = now();
  const artifactId = `eaa_${String(run.id).replace(/^earun_/, "")}`;
  const guardId = id("guard");
  const versionRow = await first(
    `SELECT COALESCE(MAX(artifact_version), 0) + 1 AS version
       FROM event_ai_artifacts WHERE event_id = ? AND kind = 'summary'`,
    [run.event_id],
  );
  await getD1().batch([
    getD1().prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM event_ai_artifact_runs
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, run.id, owner, timestamp),
    getD1().prepare(
      `INSERT OR IGNORE INTO event_ai_artifacts (
         id, workspace_id, project_id, event_id, run_id, kind, artifact_version,
         input_hash, content_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'summary', ?, ?, ?, ?, ?)`,
    ).bind(
      artifactId,
      run.workspace_id,
      run.project_id,
      run.event_id,
      run.id,
      Number(versionRow?.version ?? 1),
      run.input_hash,
      JSON.stringify(output),
      timestamp,
      timestamp,
    ),
    getD1().prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'succeeded', provider_request_id = COALESCE(?, provider_request_id),
              validated_output_json = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
              lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
              error_details_json = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    ).bind(
      usage.providerRequestId,
      JSON.stringify(output),
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      timestamp,
      timestamp,
      run.id,
      owner,
    ),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
}

export async function persistReadableTranscriptArtifact(
  run: Row,
  owner: string,
  output: ReadableTranscriptOutput,
  usage: { inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; providerRequestId: string | null },
): Promise<void> {
  const timestamp = now();
  const suffix = String(run.id).replace(/^earun_/, "");
  const artifactId = `eaa_${suffix}`;
  const assetId = `asset_readable_${suffix}`;
  const assetVersionId = `av_readable_${suffix}`;
  const guardId = id("guard");
  const serialized = JSON.stringify(output);
  const bytes = new TextEncoder().encode(serialized);
  const sha = await sha256Hex(bytes.buffer);
  const key = assetObjectKey({
    workspaceId: String(run.workspace_id),
    projectId: String(run.project_id),
    eventId: String(run.event_id),
    assetId,
    sha256: sha,
  });
  await getEvidenceBucket().put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: sha, artifactKind: "readable_transcript" },
  });
  const sourceVersionIds = [...new Set(output.segments.flatMap((segment) => segment.source_segment_ids))];
  const sourceVersion = await first(
    `SELECT asset_version_id FROM text_segments WHERE id = ?`,
    [sourceVersionIds[0] ?? ""],
  );
  const versionRow = await first(
    `SELECT COALESCE(MAX(artifact_version), 0) + 1 AS version
       FROM event_ai_artifacts WHERE event_id = ? AND kind = 'readable_transcript'`,
    [run.event_id],
  );
  const db = getD1();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM event_ai_artifact_runs
          WHERE id = ? AND status = 'processing' AND lease_owner = ?
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, run.id, owner, timestamp),
    db.prepare(
      `INSERT OR IGNORE INTO event_ai_artifacts (
         id, workspace_id, project_id, event_id, run_id, kind, artifact_version,
         input_hash, content_json, derived_asset_id, derived_asset_version_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'readable_transcript', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      artifactId,
      run.workspace_id,
      run.project_id,
      run.event_id,
      run.id,
      Number(versionRow?.version ?? 1),
      run.input_hash,
      serialized,
      assetId,
      assetVersionId,
      timestamp,
      timestamp,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO assets (
         id, workspace_id, project_id, event_id, kind, filename, current_version_id,
         metadata_json, processing_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'transcript', 'AI 易读逐字稿.json', ?, ?, 'ready', ?, ?)`,
    ).bind(
      assetId,
      run.workspace_id,
      run.project_id,
      run.event_id,
      assetVersionId,
      JSON.stringify({ artifact_kind: "readable_transcript", analysis_source: false, source_run_id: run.id }),
      timestamp,
      timestamp,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO asset_versions (
         id, asset_id, version_no, content_sha256, mime_type, size_bytes,
         parser_version, r2_original_key, derived_from_asset_version_id,
         transform_json, finalized_at, created_at
       ) VALUES (?, ?, 1, ?, 'application/json', ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      assetVersionId,
      assetId,
      sha,
      bytes.byteLength,
      READABLE_TRANSCRIPT_SCHEMA_VERSION,
      key,
      sourceVersion?.asset_version_id ?? null,
      JSON.stringify({ kind: "readable_transcript", source_segment_ids: sourceVersionIds }),
      timestamp,
      timestamp,
    ),
  ];
  output.segments.forEach((segment, index) => {
    const readableSegmentId = `rseg_${suffix}_${index}`;
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO text_segments (
           id, workspace_id, project_id, event_id, asset_id, asset_version_id,
           ordinal, speaker, start_ms, end_ms, parser_version,
           text_raw, text_normalized, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        readableSegmentId,
        run.workspace_id,
        run.project_id,
        run.event_id,
        assetId,
        assetVersionId,
        index,
        segment.speaker,
        segment.start_ms,
        segment.end_ms,
        READABLE_TRANSCRIPT_SCHEMA_VERSION,
        segment.readable_text,
        segment.readable_text.normalize("NFKC").replace(/\s+/g, " ").trim(),
        timestamp,
      ),
    );
    segment.source_segment_ids.forEach((sourceId, sourceOrder) => {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO readable_segment_sources (
             artifact_id, readable_segment_id, source_segment_id, source_order, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ).bind(artifactId, readableSegmentId, sourceId, sourceOrder, timestamp),
      );
    });
  });
  statements.push(
    db.prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'succeeded', provider_request_id = COALESCE(?, provider_request_id),
              validated_output_json = ?, input_tokens = ?, output_tokens = ?, cached_tokens = ?,
              lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
              error_details_json = NULL, finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    ).bind(
      usage.providerRequestId,
      serialized,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      timestamp,
      timestamp,
      run.id,
      owner,
    ),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  );
  await db.batch(statements);
}
