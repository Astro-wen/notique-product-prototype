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
            WHERE workspace_id = ? AND status IN ('queued', 'processing')
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
        WHERE workspace_id = ? AND status IN ('queued', 'processing')`,
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
