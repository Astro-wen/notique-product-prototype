import { getBindings, getD1 } from "@/db";
import {
  AUDIO_TRANSCRIPTION_MODEL_DEFAULT,
} from "@/lib/domain/audio-transcription";
import { transcriptionRunRecord } from "@/lib/server/db/records";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import { sha256Hex } from "@/lib/server/storage/keys";
import type {
  TranscriptionRunRecord,
  TranscriptionSegmentRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

export type TranscriptionChunkInput = {
  assetId: string;
  index: number;
  startMs: number;
  endMs: number;
};

const TRANSCRIPTION_RESPONSE_FORMAT = "diarized_json";
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 600_000;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function hashText(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value).buffer);
}

function configuredTimeout(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 30_000 && parsed <= 600_000
    ? parsed
    : DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
}

function configuredConcurrency(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10) : 2;
}

export async function createTranscriptionRun(
  scope: RequestScope,
  audioAssetId: string,
  idempotencyKey: string,
  chunkInputs: TranscriptionChunkInput[] = [],
): Promise<{ transcriptionRun: TranscriptionRunRecord; created: boolean }> {
  const bindings = getBindings();
  if (!bindings.AI_API_KEY || bindings.AI_PROVIDER !== "openai") {
    throw new ApiFault(
      503,
      "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED",
      "OpenAI transcription is not configured. The audio was preserved, but no transcription run was created.",
    );
  }
  const source = await first(
    `SELECT a.*, av.id AS audio_asset_version_id, av.content_sha256,
            av.mime_type, av.size_bytes, av.r2_original_key
       FROM assets a
       JOIN asset_versions av ON av.id = a.current_version_id
      WHERE a.id = ? AND a.workspace_id = ?`,
    [audioAssetId, scope.workspaceId],
  );
  if (!source) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Audio asset was not found.");
  }
  if (String(source.kind) !== "audio" || String(source.processing_status) !== "ready") {
    throw new ApiFault(
      409,
      "EVENT_NOT_READY",
      "The asset must be a finalized audio file before transcription can start.",
    );
  }
  if (chunkInputs.length) {
    return createChunkedTranscriptionRun(
      scope,
      source,
      audioAssetId,
      idempotencyKey,
      chunkInputs,
    );
  }
  const model = bindings.AI_TRANSCRIPTION_MODEL?.trim() || AUDIO_TRANSCRIPTION_MODEL_DEFAULT;
  const timeoutMs = configuredTimeout(bindings.AI_TRANSCRIPTION_TIMEOUT_MS);
  const inputHash = await hashText(JSON.stringify({
    audio_asset_version_id: source.audio_asset_version_id,
    content_sha256: source.content_sha256,
    mime_type: source.mime_type,
    size_bytes: source.size_bytes,
    provider: "openai",
    model,
    response_format: TRANSCRIPTION_RESPONSE_FORMAT,
    timeout_ms: timeoutMs,
  }));
  const existing = await first(
    `SELECT * FROM transcription_runs
      WHERE audio_asset_version_id = ? AND idempotency_key = ?
        AND workspace_id = ?`,
    [source.audio_asset_version_id, idempotencyKey, scope.workspaceId],
  );
  if (existing) {
    if (String(existing.input_hash) !== inputHash) {
      throw new ApiFault(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different transcription input.",
        { existing_transcription_run_id: existing.id },
      );
    }
    return {
      transcriptionRun: await getTranscriptionRun(scope, String(existing.id)),
      created: false,
    };
  }
  const runId = id("trun");
  const outboxId = id("tout");
  const guardId = id("guard");
  const timestamp = now();
  const payloadJson = JSON.stringify({ transcription_run_id: runId });
  const payloadHash = await hashText(payloadJson);
  const maxConcurrent = configuredConcurrency(
    bindings.MAX_CONCURRENT_RUNS_PER_WORKSPACE,
  );
  const db = getD1();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN (
           SELECT COUNT(*) FROM transcription_runs
            WHERE workspace_id = ? AND parent_run_id IS NULL
              AND status IN ('queued', 'processing')
         ) < ? THEN 1 ELSE 0 END, ?`,
      ).bind(guardId, scope.workspaceId, maxConcurrent, timestamp),
      db.prepare(
        `INSERT INTO transcription_runs (
          id, workspace_id, project_id, event_id, audio_asset_id,
          audio_asset_version_id, status, idempotency_key, input_hash,
          provider, model, response_format, request_timeout_ms,
          queued_at, first_queued_at, current_queued_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 'openai', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        runId,
        scope.workspaceId,
        source.project_id,
        source.event_id,
        audioAssetId,
        source.audio_asset_version_id,
        idempotencyKey,
        inputHash,
        model,
        TRANSCRIPTION_RESPONSE_FORMAT,
        timeoutMs,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO transcription_queue_outbox (
          id, run_id, payload_hash, payload_json, status, attempt,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).bind(outboxId, runId, payloadHash, payloadJson, timestamp, timestamp, timestamp),
      db.prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_run_id', ?,
              '$.transcription_status', 'queued'
            ), updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      ).bind(runId, timestamp, audioAssetId, scope.workspaceId),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch (error) {
    const raced = await first(
      `SELECT * FROM transcription_runs
        WHERE audio_asset_version_id = ? AND idempotency_key = ?
          AND workspace_id = ?`,
      [source.audio_asset_version_id, idempotencyKey, scope.workspaceId],
    );
    if (raced && String(raced.input_hash) === inputHash) {
      return {
        transcriptionRun: await getTranscriptionRun(scope, String(raced.id)),
        created: false,
      };
    }
    if (raced) {
      throw new ApiFault(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different transcription input.",
      );
    }
    const active = await first(
      `SELECT COUNT(*) AS count FROM transcription_runs
        WHERE workspace_id = ? AND parent_run_id IS NULL
          AND status IN ('queued', 'processing')`,
      [scope.workspaceId],
    );
    if (Number(active?.count ?? 0) >= maxConcurrent) {
      throw new ApiFault(
        429,
        "WORKSPACE_RUN_LIMIT",
        "Workspace transcription concurrency limit was reached.",
        { max_concurrent_runs: maxConcurrent },
      );
    }
    throw error;
  }
  return {
    transcriptionRun: await getTranscriptionRun(scope, runId),
    created: true,
  };
}

function normalizedChunkInputs(inputs: TranscriptionChunkInput[]): TranscriptionChunkInput[] {
  if (inputs.length < 2 || inputs.length > 30) {
    throw new ApiFault(
      400,
      "BAD_REQUEST",
      "Chunked transcription requires 2 to 30 ordered audio chunks.",
    );
  }
  const chunks = [...inputs].sort((left, right) => left.index - right.index);
  chunks.forEach((chunk, position) => {
    if (
      chunk.index !== position ||
      !Number.isSafeInteger(chunk.startMs) ||
      !Number.isSafeInteger(chunk.endMs) ||
      chunk.startMs < 0 ||
      chunk.endMs <= chunk.startMs ||
      chunk.endMs - chunk.startMs > 5 * 60_000
    ) {
      throw new ApiFault(400, "BAD_REQUEST", "Audio chunk ranges are invalid or out of order.");
    }
    if (position === 0 && chunk.startMs !== 0) {
      throw new ApiFault(400, "BAD_REQUEST", "The first audio chunk must begin at zero.");
    }
    if (position > 0) {
      const previous = chunks[position - 1]!;
      const overlap = previous.endMs - chunk.startMs;
      if (overlap < 1_000 || overlap > 15_000 || chunk.endMs <= previous.endMs) {
        throw new ApiFault(
          400,
          "BAD_REQUEST",
          "Adjacent audio chunks must advance in time with a 1 to 15 second overlap.",
        );
      }
    }
  });
  if (new Set(chunks.map((chunk) => chunk.assetId)).size !== chunks.length) {
    throw new ApiFault(400, "BAD_REQUEST", "Each audio chunk must use a distinct Asset.");
  }
  return chunks;
}

async function createChunkedTranscriptionRun(
  scope: RequestScope,
  source: Row,
  audioAssetId: string,
  idempotencyKey: string,
  chunkInputs: TranscriptionChunkInput[],
): Promise<{ transcriptionRun: TranscriptionRunRecord; created: boolean }> {
  const bindings = getBindings();
  const chunks = normalizedChunkInputs(chunkInputs);
  const chunkRows = (
    await getD1()
      .prepare(
        `SELECT a.*, av.id AS audio_asset_version_id, av.content_sha256,
                av.mime_type, av.size_bytes, av.r2_original_key
           FROM assets a
           JOIN asset_versions av ON av.id = a.current_version_id
          WHERE a.workspace_id = ? AND a.id IN (SELECT value FROM json_each(?))`,
      )
      .bind(scope.workspaceId, JSON.stringify(chunks.map((chunk) => chunk.assetId)))
      .all<Row>()
  ).results ?? [];
  if (chunkRows.length !== chunks.length) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "One or more audio chunks were not found.");
  }
  const rowById = new Map(chunkRows.map((row) => [String(row.id), row]));
  for (const chunk of chunks) {
    const row = rowById.get(chunk.assetId)!;
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>;
    } catch {
      throw new ApiFault(409, "EVENT_NOT_READY", "Audio chunk metadata is invalid.");
    }
    if (
      String(row.kind) !== "audio" ||
      String(row.processing_status) !== "ready" ||
      String(row.project_id) !== String(source.project_id) ||
      String(row.event_id) !== String(source.event_id) ||
      metadata.transcription_chunk !== true ||
      metadata.analysis_source !== false ||
      metadata.source_audio_asset_id !== audioAssetId ||
      metadata.chunk_index !== chunk.index ||
      metadata.chunk_start_ms !== chunk.startMs ||
      metadata.chunk_end_ms !== chunk.endMs
    ) {
      throw new ApiFault(
        409,
        "EVENT_NOT_READY",
        "Audio chunks must be finalized, hidden, and mapped to the same original recording.",
      );
    }
  }

  const model = bindings.AI_TRANSCRIPTION_MODEL?.trim() || AUDIO_TRANSCRIPTION_MODEL_DEFAULT;
  const timeoutMs = configuredTimeout(bindings.AI_TRANSCRIPTION_TIMEOUT_MS);
  const frozenChunks = chunks.map((chunk) => {
    const row = rowById.get(chunk.assetId)!;
    return {
      ...chunk,
      assetVersionId: String(row.audio_asset_version_id),
      contentSha256: String(row.content_sha256),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes),
    };
  });
  const inputHash = await hashText(JSON.stringify({
    audio_asset_version_id: source.audio_asset_version_id,
    content_sha256: source.content_sha256,
    provider: "openai",
    model,
    response_format: TRANSCRIPTION_RESPONSE_FORMAT,
    orchestration_mode: "chunked",
    chunks: frozenChunks,
  }));
  const existing = await first(
    `SELECT * FROM transcription_runs
      WHERE audio_asset_version_id = ? AND idempotency_key = ? AND workspace_id = ?`,
    [source.audio_asset_version_id, idempotencyKey, scope.workspaceId],
  );
  if (existing) {
    if (String(existing.input_hash) !== inputHash) {
      throw new ApiFault(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was used with different chunks.");
    }
    return { transcriptionRun: await getTranscriptionRun(scope, String(existing.id)), created: false };
  }

  const parentRunId = id("trun");
  const guardId = id("guard");
  const timestamp = now();
  const maxConcurrent = configuredConcurrency(bindings.MAX_CONCURRENT_RUNS_PER_WORKSPACE);
  const db = getD1();
  const statements = [
    db.prepare(
      `UPDATE transcription_runs
          SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
              finished_at = ?, error_code = 'TRANSCRIPTION_REPLACED_BY_CHUNKED',
              error_details_json = '{"reason":"replaced_by_chunked_transcription"}', updated_at = ?
        WHERE workspace_id = ? AND audio_asset_version_id = ?
          AND parent_run_id IS NULL AND orchestration_mode = 'single'
          AND (
            status = 'queued' OR (
              status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
            )
          )`,
    ).bind(
      timestamp,
      timestamp,
      scope.workspaceId,
      source.audio_asset_version_id,
      timestamp,
    ),
    db.prepare(
      `UPDATE transcription_queue_outbox
          SET status = 'sent', sent_at = COALESCE(sent_at, ?), lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = 'RUN_REPLACED_BY_CHUNKED', updated_at = ?
        WHERE run_id IN (
          SELECT id FROM transcription_runs
           WHERE workspace_id = ? AND audio_asset_version_id = ?
             AND status = 'cancelled' AND error_code = 'TRANSCRIPTION_REPLACED_BY_CHUNKED'
             AND finished_at = ?
        )`,
    ).bind(
      timestamp,
      timestamp,
      scope.workspaceId,
      source.audio_asset_version_id,
      timestamp,
    ),
    db.prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN (
         SELECT COUNT(*) FROM transcription_runs
          WHERE workspace_id = ? AND parent_run_id IS NULL
            AND status IN ('queued','processing')
       ) < ? THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, scope.workspaceId, maxConcurrent, timestamp),
    db.prepare(
      `INSERT INTO transcription_runs (
        id, workspace_id, project_id, event_id, audio_asset_id,
        audio_asset_version_id, status, idempotency_key, input_hash,
        provider, model, response_format, request_timeout_ms,
        orchestration_mode, chunk_count, completed_chunk_count, duration_ms,
        queued_at, first_queued_at, current_queued_at,
        started_at, first_started_at, current_started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?, 'openai', ?, ?, ?,
                'chunked', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      parentRunId,
      scope.workspaceId,
      source.project_id,
      source.event_id,
      audioAssetId,
      source.audio_asset_version_id,
      idempotencyKey,
      inputHash,
      model,
      TRANSCRIPTION_RESPONSE_FORMAT,
      timeoutMs,
      frozenChunks.length,
      chunks.at(-1)!.endMs,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ),
  ];
  for (const frozen of frozenChunks) {
    const childRunId = id("trun");
    const outboxId = id("tout");
    const childIdempotencyKey = `${idempotencyKey}:chunk:${frozen.index}`;
    const childInputHash = await hashText(JSON.stringify({
      parent_run_id: parentRunId,
      chunk_index: frozen.index,
      chunk_start_ms: frozen.startMs,
      chunk_end_ms: frozen.endMs,
      audio_asset_version_id: frozen.assetVersionId,
      content_sha256: frozen.contentSha256,
      provider: "openai",
      model,
      response_format: TRANSCRIPTION_RESPONSE_FORMAT,
    }));
    const payloadJson = JSON.stringify({ transcription_run_id: childRunId });
    const payloadHash = await hashText(payloadJson);
    statements.push(
      db.prepare(
        `INSERT INTO transcription_runs (
          id, workspace_id, project_id, event_id, audio_asset_id,
          audio_asset_version_id, status, idempotency_key, input_hash,
          provider, model, response_format, request_timeout_ms,
          orchestration_mode, parent_run_id, chunk_index, chunk_start_ms, chunk_end_ms,
          queued_at, first_queued_at, current_queued_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 'openai', ?, ?, ?,
                  'chunk', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        childRunId,
        scope.workspaceId,
        source.project_id,
        source.event_id,
        frozen.assetId,
        frozen.assetVersionId,
        childIdempotencyKey,
        childInputHash,
        model,
        TRANSCRIPTION_RESPONSE_FORMAT,
        timeoutMs,
        parentRunId,
        frozen.index,
        frozen.startMs,
        frozen.endMs,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO transcription_queue_outbox (
          id, run_id, payload_hash, payload_json, status, attempt,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).bind(outboxId, childRunId, payloadHash, payloadJson, timestamp, timestamp, timestamp),
      db.prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_run_id', ?,
              '$.transcription_status', 'queued',
              '$.parent_transcription_run_id', ?
            ), updated_at = ?
          WHERE id = ? AND workspace_id = ?
            AND json_extract(COALESCE(metadata_json, '{}'), '$.transcription_chunk') = 1`,
      ).bind(childRunId, parentRunId, timestamp, frozen.assetId, scope.workspaceId),
    );
  }
  statements.push(
    db.prepare(
      `UPDATE assets
          SET metadata_json = json_set(
            COALESCE(metadata_json, '{}'),
            '$.transcription_run_id', ?,
            '$.transcription_status', 'processing',
            '$.transcription_mode', 'chunked',
            '$.transcription_chunk_count', ?
          ), updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    ).bind(parentRunId, frozenChunks.length, timestamp, audioAssetId, scope.workspaceId),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await first(
      `SELECT * FROM transcription_runs
        WHERE audio_asset_version_id = ? AND idempotency_key = ? AND workspace_id = ?`,
      [source.audio_asset_version_id, idempotencyKey, scope.workspaceId],
    );
    if (raced && String(raced.input_hash) === inputHash) {
      return { transcriptionRun: await getTranscriptionRun(scope, String(raced.id)), created: false };
    }
    const active = await first(
      `SELECT COUNT(*) AS count FROM transcription_runs
        WHERE workspace_id = ? AND parent_run_id IS NULL
          AND status IN ('queued','processing')`,
      [scope.workspaceId],
    );
    if (Number(active?.count ?? 0) >= maxConcurrent) {
      throw new ApiFault(429, "WORKSPACE_RUN_LIMIT", "Workspace transcription limit was reached.", {
        max_concurrent_runs: maxConcurrent,
      });
    }
    throw error;
  }
  return { transcriptionRun: await getTranscriptionRun(scope, parentRunId), created: true };
}

export async function getTranscriptionRun(
  scope: RequestScope,
  runId: string,
): Promise<TranscriptionRunRecord> {
  const row = await first(
    `SELECT r.*,
            COALESCE((
              SELECT o.attempt FROM transcription_queue_outbox o WHERE o.run_id = r.id
            ), 0) AS dispatch_attempt_no
       FROM transcription_runs r WHERE r.id = ? AND r.workspace_id = ?`,
    [runId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(
      404,
      "PROJECT_SCOPE_VIOLATION",
      "Transcription run was not found.",
    );
  }
  const result = transcriptionRunRecord(row);
  if (result.orchestration_mode === "chunked") {
    const chunkRows = (
      await getD1()
        .prepare(
          `SELECT id, chunk_index, chunk_start_ms, chunk_end_ms, status,
                  attempt_no, error_code
             FROM transcription_runs
            WHERE parent_run_id = ? AND workspace_id = ?
            ORDER BY chunk_index`,
        )
        .bind(result.id, scope.workspaceId)
        .all<Row>()
    ).results ?? [];
    result.chunks = chunkRows.map((chunk) => ({
      id: String(chunk.id),
      index: Number(chunk.chunk_index),
      start_ms: Number(chunk.chunk_start_ms),
      end_ms: Number(chunk.chunk_end_ms),
      status: String(chunk.status) as TranscriptionRunRecord["status"],
      processing_attempt_no: Number(chunk.attempt_no ?? 0),
      error_code: chunk.error_code ? String(chunk.error_code) : null,
    }));
  }
  if (result.derived_transcript_asset_version_id) {
    const segmentRows = (
      await getD1()
        .prepare(
          `SELECT id, ordinal, speaker, start_ms, end_ms, text_raw
             FROM text_segments
            WHERE asset_version_id = ? AND workspace_id = ?
            ORDER BY ordinal`,
        )
        .bind(result.derived_transcript_asset_version_id, scope.workspaceId)
        .all<Row>()
    ).results ?? [];
    result.segments = segmentRows.map((segment): TranscriptionSegmentRecord => ({
      id: String(segment.id),
      ordinal: Number(segment.ordinal),
      speaker: String(segment.speaker ?? "Speaker"),
      start_ms: Number(segment.start_ms ?? 0),
      end_ms: Number(segment.end_ms ?? 0),
      text: String(segment.text_raw ?? ""),
    }));
  }
  return result;
}

export async function retryFailedTranscriptionChunks(
  scope: RequestScope,
  parentRunId: string,
): Promise<TranscriptionRunRecord> {
  const parent = await first(
    `SELECT * FROM transcription_runs
      WHERE id = ? AND workspace_id = ? AND orchestration_mode = 'chunked'`,
    [parentRunId, scope.workspaceId],
  );
  if (!parent) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Chunked transcription Run was not found.");
  }
  if (String(parent.status) !== "processing") {
    throw new ApiFault(409, "EVENT_NOT_READY", "Only an unfinished chunked transcription can retry chunks.");
  }
  const failed = await first(
    `SELECT COUNT(*) AS count FROM transcription_runs
      WHERE parent_run_id = ? AND workspace_id = ? AND status = 'failed'`,
    [parentRunId, scope.workspaceId],
  );
  if (Number(failed?.count ?? 0) === 0) return getTranscriptionRun(scope, parentRunId);
  const timestamp = now();
  const db = getD1();
  await db.batch([
    db.prepare(
      `UPDATE transcription_runs
          SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
              current_queued_at = ?, finished_at = NULL, error_code = NULL,
              error_details_json = NULL, updated_at = ?
        WHERE parent_run_id = ? AND workspace_id = ? AND status = 'failed'`,
    ).bind(timestamp, timestamp, parentRunId, scope.workspaceId),
    db.prepare(
      `UPDATE transcription_queue_outbox
          SET status = 'pending', attempt = 0, next_attempt_at = ?, sent_at = NULL,
              lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL,
              updated_at = ?
        WHERE run_id IN (
          SELECT id FROM transcription_runs
           WHERE parent_run_id = ? AND workspace_id = ? AND status = 'queued'
        )`,
    ).bind(timestamp, timestamp, parentRunId, scope.workspaceId),
    db.prepare(
      `UPDATE transcription_runs
          SET error_code = NULL, error_details_json = NULL, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'processing'`,
    ).bind(timestamp, parentRunId, scope.workspaceId),
  ]);
  return getTranscriptionRun(scope, parentRunId);
}
