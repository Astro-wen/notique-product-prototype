import { getBindings, getD1, getEvidenceBucket } from "@/db";
import {
  AUDIO_TRANSCRIPTION_PARSER_VERSION,
  diarizedTranscriptJson,
  validateDiarizedTranscriptOutput,
  type ValidatedDiarizedTranscript,
} from "@/lib/domain/audio-transcription";
import { normalizeTranscriptText } from "@/lib/domain/transcript";
import { sha256Hex, transcriptionResultObjectKey } from "@/lib/server/storage/keys";

type Row = Record<string, unknown>;

export type TranscriptionProcessResult = {
  runId: string;
  status: "already_terminal" | "lease_not_acquired" | "succeeded" | "failed";
  segmentCount: number;
  errorCode?: string;
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_PROVIDER_ERROR_CHARS = 500;

class TranscriptionFault extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TranscriptionFault";
  }
}

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

function errorCode(error: unknown): string {
  if (error instanceof TranscriptionFault) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "TRANSCRIPTION_TIMEOUT";
  }
  return "AUDIO_TRANSCRIPTION_FAILED";
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, MAX_PROVIDER_ERROR_CHARS);
  return "Audio transcription failed.";
}

async function acquireLease(runId: string, owner: string, timestamp: string): Promise<Row | null> {
  const run = await first(`SELECT request_timeout_ms FROM transcription_runs WHERE id = ?`, [runId]);
  const timeoutMs = Number(run?.request_timeout_ms ?? 300_000);
  const leaseMs = Math.max(120_000, Math.min(timeoutMs + 60_000, 660_000));
  const db = getD1();
  const guardId = id("guard");
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM transcription_runs WHERE id = ? AND status = 'queued'
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(guardId, runId, timestamp),
      db
        .prepare(
          `UPDATE transcription_runs
              SET status = 'processing', attempt_no = attempt_no + 1,
                  lease_owner = ?, lease_expires_at = ?,
                  started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .bind(owner, plusMilliseconds(timestamp, leaseMs), timestamp, timestamp, runId),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    return null;
  }
  return first(
    `SELECT r.*, a.filename, av.mime_type, av.r2_original_key
       FROM transcription_runs r
       JOIN assets a ON a.id = r.audio_asset_id
       JOIN asset_versions av ON av.id = r.audio_asset_version_id
      WHERE r.id = ? AND r.status = 'processing' AND r.lease_owner = ?`,
    [runId, owner],
  );
}

async function callProvider(run: Row): Promise<{
  transcript: ValidatedDiarizedTranscript;
  providerRequestId: string | null;
}> {
  const bindings = getBindings();
  if (!bindings.AI_API_KEY || bindings.AI_PROVIDER !== "openai") {
    throw new TranscriptionFault(
      "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED",
      "OpenAI transcription is not configured.",
    );
  }
  const object = await getEvidenceBucket().get(String(run.r2_original_key));
  if (!object) {
    throw new TranscriptionFault(
      "AUDIO_TRANSCRIPTION_FAILED",
      "Stored audio content is missing.",
    );
  }
  const audio = await object.arrayBuffer();
  const form = new FormData();
  form.set(
    "file",
    new Blob([audio], { type: String(run.mime_type) }),
    String(run.filename),
  );
  form.set("model", String(run.model));
  form.set("response_format", "diarized_json");
  form.set("chunking_strategy", "auto");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(run.request_timeout_ms));
  let response: Response;
  try {
    const baseUrl = (bindings.AI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${bindings.AI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const providerRequestId = response.headers.get("x-request-id");
  const body = await response.text();
  if (!response.ok) {
    let message = `OpenAI transcription returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // Provider bodies are intentionally not persisted when they are not JSON.
    }
    throw new TranscriptionFault("AUDIO_TRANSCRIPTION_FAILED", message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TranscriptionFault(
      "TRANSCRIPTION_OUTPUT_INVALID",
      "OpenAI transcription did not return valid JSON.",
    );
  }
  try {
    return {
      transcript: validateDiarizedTranscriptOutput(parsed),
      providerRequestId,
    };
  } catch (error) {
    throw new TranscriptionFault(
      "TRANSCRIPTION_OUTPUT_INVALID",
      error instanceof Error ? error.message : "Transcription output is invalid.",
    );
  }
}

async function loadOrCreateStagedResult(run: Row, owner: string): Promise<{
  transcript: ValidatedDiarizedTranscript;
  resultKey: string;
  resultSha: string;
  providerRequestId: string | null;
}> {
  const bucket = getEvidenceBucket();
  if (run.staged_result_r2_key && run.staged_result_sha256) {
    const staged = await bucket.get(String(run.staged_result_r2_key));
    if (!staged) {
      throw new TranscriptionFault(
        "AUDIO_TRANSCRIPTION_FAILED",
        "The staged transcription result is missing.",
      );
    }
    try {
      return {
        transcript: validateDiarizedTranscriptOutput(JSON.parse(await staged.text())),
        resultKey: String(run.staged_result_r2_key),
        resultSha: String(run.staged_result_sha256),
        providerRequestId: run.provider_request_id ? String(run.provider_request_id) : null,
      };
    } catch {
      throw new TranscriptionFault(
        "TRANSCRIPTION_OUTPUT_INVALID",
        "The staged transcription result is invalid.",
      );
    }
  }
  const called = await callProvider(run);
  const content = diarizedTranscriptJson(called.transcript);
  const bytes = new TextEncoder().encode(content);
  const resultSha = await sha256Hex(bytes.buffer);
  const resultKey = transcriptionResultObjectKey({
    workspaceId: String(run.workspace_id),
    projectId: String(run.project_id),
    eventId: String(run.event_id),
    runId: String(run.id),
    sha256: resultSha,
  });
  await bucket.put(resultKey, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      sha256: resultSha,
      schema: "diarized-transcript.v1",
      source_audio_asset_version_id: String(run.audio_asset_version_id),
    },
  });
  const updated = await getD1()
    .prepare(
      `UPDATE transcription_runs
          SET staged_result_r2_key = ?, staged_result_sha256 = ?,
              provider_request_id = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
          AND staged_result_r2_key IS NULL`,
    )
    .bind(
      resultKey,
      resultSha,
      called.providerRequestId,
      now(),
      run.id,
      owner,
    )
    .run();
  if (Number(updated.meta.changes ?? 0) !== 1) {
    throw new TranscriptionFault(
      "AUDIO_TRANSCRIPTION_FAILED",
      "The transcription run lease changed before the result was staged.",
    );
  }
  return { ...called, resultKey, resultSha };
}

function derivedFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "").trim() || "recording";
  return `${base}.transcript.json`.slice(0, 500);
}

async function persistTranscript(
  run: Row,
  owner: string,
  staged: Awaited<ReturnType<typeof loadOrCreateStagedResult>>,
): Promise<TranscriptionProcessResult> {
  const timestamp = now();
  const transcriptAssetId = id("ast");
  const transcriptVersionId = id("av");
  const durationMs = staged.transcript.durationSeconds === null
    ? null
    : Math.round(staged.transcript.durationSeconds * 1000);
  const segments = staged.transcript.segments.map((segment, ordinal) => ({
    id: `seg_${transcriptVersionId}_${String(ordinal).padStart(5, "0")}`,
    ordinal,
    speaker: segment.speaker,
    startMs: Math.round(segment.startSeconds * 1000),
    endMs: Math.round(segment.endSeconds * 1000),
    textRaw: segment.text,
    textNormalized: normalizeTranscriptText(segment.text),
  }));
  const transform = {
    kind: "audio_transcription",
    transcription_run_id: run.id,
    provider: run.provider,
    model: run.model,
    response_format: run.response_format,
    source_audio_asset_id: run.audio_asset_id,
    source_audio_asset_version_id: run.audio_asset_version_id,
  };
  const db = getD1();
  const guardId = id("guard");
  await db.batch([
    db
      .prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM transcription_runs
            WHERE id = ? AND status = 'processing' AND lease_owner = ?
              AND staged_result_r2_key = ? AND staged_result_sha256 = ?
              AND derived_transcript_asset_id IS NULL
         ) THEN 1 ELSE 0 END, ?`,
      )
      .bind(guardId, run.id, owner, staged.resultKey, staged.resultSha, timestamp),
    db
      .prepare(
        `INSERT INTO assets (
          id, workspace_id, project_id, event_id, kind, filename,
          current_version_id, metadata_json, processing_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'transcript', ?, ?, ?, 'ready', ?, ?)`,
      )
      .bind(
        transcriptAssetId,
        run.workspace_id,
        run.project_id,
        run.event_id,
        derivedFilename(String(run.filename)),
        transcriptVersionId,
        JSON.stringify(transform),
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO asset_versions (
          id, asset_id, version_no, content_sha256, mime_type, size_bytes,
          parser_version, r2_original_key, derived_from_asset_version_id,
          transform_json, finalized_at, created_at
        ) VALUES (?, ?, 1, ?, 'application/json', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        transcriptVersionId,
        transcriptAssetId,
        staged.resultSha,
        new TextEncoder().encode(diarizedTranscriptJson(staged.transcript)).byteLength,
        AUDIO_TRANSCRIPTION_PARSER_VERSION,
        staged.resultKey,
        run.audio_asset_version_id,
        JSON.stringify(transform),
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO text_segments (
          id, workspace_id, project_id, event_id, asset_id, asset_version_id,
          ordinal, speaker, start_ms, end_ms, parser_version,
          text_raw, text_normalized, created_at
        )
        SELECT json_extract(value, '$.id'), ?, ?, ?, ?, ?,
               json_extract(value, '$.ordinal'), json_extract(value, '$.speaker'),
               json_extract(value, '$.startMs'), json_extract(value, '$.endMs'), ?,
               json_extract(value, '$.textRaw'), json_extract(value, '$.textNormalized'), ?
          FROM json_each(?)`,
      )
      .bind(
        run.workspace_id,
        run.project_id,
        run.event_id,
        transcriptAssetId,
        transcriptVersionId,
        AUDIO_TRANSCRIPTION_PARSER_VERSION,
        timestamp,
        JSON.stringify(segments),
      ),
    db
      .prepare(
        `UPDATE transcription_runs
            SET status = 'succeeded', derived_transcript_asset_id = ?,
                derived_transcript_asset_version_id = ?, segment_count = ?,
                duration_ms = ?, lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, error_code = NULL, error_details_json = NULL,
                updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        transcriptAssetId,
        transcriptVersionId,
        segments.length,
        durationMs,
        timestamp,
        timestamp,
        run.id,
        owner,
      ),
    db
      .prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_status', 'succeeded',
              '$.derived_transcript_asset_id', ?,
              '$.derived_transcript_asset_version_id', ?
            ), updated_at = ?
          WHERE id = ? AND workspace_id = ? AND current_version_id = ?`,
      )
      .bind(
        transcriptAssetId,
        transcriptVersionId,
        timestamp,
        run.audio_asset_id,
        run.workspace_id,
        run.audio_asset_version_id,
      ),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
  return {
    runId: String(run.id),
    status: "succeeded",
    segmentCount: segments.length,
  };
}

async function markFailed(
  run: Row,
  owner: string,
  error: unknown,
): Promise<TranscriptionProcessResult> {
  const timestamp = now();
  const code = errorCode(error);
  await getD1().batch([
    getD1()
      .prepare(
        `UPDATE transcription_runs
            SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, error_code = ?, error_details_json = ?, updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        timestamp,
        code,
        JSON.stringify({ message: safeError(error) }),
        timestamp,
        run.id,
        owner,
      ),
    getD1()
      .prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_status', 'failed',
              '$.transcription_error_code', ?
            ), updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      )
      .bind(code, timestamp, run.audio_asset_id, run.workspace_id),
  ]);
  return { runId: String(run.id), status: "failed", segmentCount: 0, errorCode: code };
}

export async function processTranscriptionRun(
  runId: string,
): Promise<TranscriptionProcessResult> {
  const initial = await first(`SELECT * FROM transcription_runs WHERE id = ?`, [runId]);
  if (!initial) throw new TranscriptionFault("NOT_FOUND", "Transcription run does not exist.");
  if (TERMINAL.has(String(initial.status))) {
    return { runId, status: "already_terminal", segmentCount: Number(initial.segment_count ?? 0) };
  }
  const owner = `transcriber_${crypto.randomUUID()}`;
  const leased = await acquireLease(runId, owner, now());
  if (!leased) return { runId, status: "lease_not_acquired", segmentCount: 0 };
  try {
    const staged = await loadOrCreateStagedResult(leased, owner);
    return await persistTranscript(leased, owner, staged);
  } catch (error) {
    return markFailed(leased, owner, error);
  }
}

export async function failExpiredTranscriptionRuns(timestamp = now()): Promise<number> {
  const expired = await getD1()
    .prepare(
      `UPDATE transcription_runs
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              finished_at = ?, error_code = 'TRANSCRIPTION_TIMEOUT',
              error_details_json = '{"reason":"consumer_lease_expired"}', updated_at = ?
        WHERE status = 'processing' AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?`,
    )
    .bind(timestamp, timestamp, timestamp)
    .run();
  await getD1()
    .prepare(
      `UPDATE assets
          SET metadata_json = json_set(
            COALESCE(metadata_json, '{}'),
            '$.transcription_status', 'failed',
            '$.transcription_error_code', 'TRANSCRIPTION_TIMEOUT'
          ), updated_at = ?
        WHERE id IN (
          SELECT audio_asset_id FROM transcription_runs
           WHERE status = 'failed' AND error_code = 'TRANSCRIPTION_TIMEOUT'
             AND finished_at = ?
        )`,
    )
    .bind(timestamp, timestamp)
    .run();
  return Number(expired.meta.changes ?? 0);
}
