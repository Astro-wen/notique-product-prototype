import { getBindings, getD1, getEvidenceBucket } from "@/db";
import {
  AUDIO_TRANSCRIPTION_PARSER_VERSION,
  diarizedTranscriptJson,
  parseDiarizedTranscriptProviderBody,
  validateDiarizedTranscriptOutput,
  type ValidatedDiarizedTranscript,
} from "@/lib/domain/audio-transcription";
import {
  classifyTranscriptionHttpFailure,
  classifyTranscriptionTransportFailure,
  loadOrStageTranscriptionResult,
} from "@/lib/domain/transcription-retry";
import { normalizeTranscriptText } from "@/lib/domain/transcript";
import { sha256Hex, transcriptionStagingObjectKey } from "@/lib/server/storage/keys";

type Row = Record<string, unknown>;

export type TranscriptionProcessResult = {
  runId: string;
  status: "already_terminal" | "lease_not_acquired" | "succeeded" | "retryable" | "failed";
  segmentCount: number;
  errorCode?: string;
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_PROVIDER_ERROR_CHARS = 500;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 600_000;

class TranscriptionFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly providerRequestId: string | null = null,
  ) {
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

/**
 * Never shorten a Run's persisted timeout, but allow a production operator to
 * extend an older queued Run after observing that a long audio response needs
 * more time. This keeps retries on the same Run and gives its provider call
 * and leases the same effective deadline.
 */
export function transcriptionTimeoutMs(run: Row): number {
  const persisted = Number(run.request_timeout_ms);
  const configured = Number(getBindings().AI_TRANSCRIPTION_TIMEOUT_MS);
  const configuredMs = Number.isSafeInteger(configured)
    && configured >= 30_000
    && configured <= 600_000
    ? configured
    : DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  return Math.max(
    Number.isSafeInteger(persisted) && persisted >= 30_000 ? persisted : DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
    configuredMs,
  );
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

function persistenceRetry(error: unknown, fallback: string): TranscriptionFault {
  return new TranscriptionFault(
    "TRANSCRIPTION_PERSIST_RETRY",
    error instanceof Error ? safeError(error) : fallback,
    true,
  );
}

async function acquireLease(runId: string, owner: string, timestamp: string): Promise<Row | null> {
  const run = await first(`SELECT request_timeout_ms FROM transcription_runs WHERE id = ?`, [runId]);
  const timeoutMs = transcriptionTimeoutMs(run ?? {});
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
                  started_at = COALESCE(started_at, ?),
                  first_started_at = COALESCE(first_started_at, ?),
                  current_started_at = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .bind(
          owner,
          plusMilliseconds(timestamp, leaseMs),
          timestamp,
          timestamp,
          timestamp,
          timestamp,
          runId,
        ),
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
  form.set("stream", "true");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transcriptionTimeoutMs(run));
  let response: Response;
  let body: string;
  try {
    const baseUrl = (bindings.AI_API_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bindings.AI_API_KEY}`,
        "idempotency-key": `notique-transcription-${String(run.id)}`,
      },
      body: form,
      signal: controller.signal,
    });
    // Keep the timeout active until the streamed response body has finished.
    // Receiving headers alone does not mean a long transcription completed.
    body = await response.text();
  } catch (error) {
    const failure = classifyTranscriptionTransportFailure(
      controller.signal.aborted || error instanceof DOMException && error.name === "AbortError",
    );
    throw new TranscriptionFault(failure.code, safeError(error), failure.retryable);
  } finally {
    clearTimeout(timer);
  }
  const providerRequestId = response.headers.get("x-request-id");
  if (!response.ok) {
    let message = `OpenAI transcription returned HTTP ${response.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") message = parsed.error.message;
    } catch {
      // Provider bodies are intentionally not persisted when they are not JSON.
    }
    const failure = classifyTranscriptionHttpFailure(response.status);
    throw new TranscriptionFault(failure.code, message, failure.retryable);
  }
  try {
    return {
      transcript: parseDiarizedTranscriptProviderBody(
        body,
        response.headers.get("content-type"),
      ),
      providerRequestId,
    };
  } catch (error) {
    throw new TranscriptionFault(
      "TRANSCRIPTION_OUTPUT_INVALID",
      error instanceof Error ? error.message : "Transcription output is invalid.",
      false,
      providerRequestId,
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
  let resultKey = run.staged_result_r2_key ? String(run.staged_result_r2_key) : "";
  if (!resultKey) {
    resultKey = transcriptionStagingObjectKey({
      workspaceId: String(run.workspace_id),
      projectId: String(run.project_id),
      eventId: String(run.event_id),
      runId: String(run.id),
    });
    try {
      const reserved = await getD1()
        .prepare(
          `UPDATE transcription_runs
              SET staged_result_r2_key = ?, updated_at = ?
            WHERE id = ? AND status = 'processing' AND lease_owner = ?
              AND staged_result_r2_key IS NULL`,
        )
        .bind(resultKey, now(), run.id, owner)
        .run();
      if (Number(reserved.meta.changes ?? 0) !== 1) {
        throw new Error("The transcription staging slot could not be reserved.");
      }
    } catch (error) {
      throw persistenceRetry(error, "The transcription staging slot could not be reserved.");
    }
  }

  let existing: R2ObjectBody | null;
  try {
    existing = await bucket.get(resultKey);
  } catch (error) {
    throw persistenceRetry(error, "The staged transcription result could not be loaded.");
  }

  let existingResult: {
    transcript: ValidatedDiarizedTranscript;
    resultKey: string;
    resultSha: string;
    providerRequestId: string | null;
  } | null = null;
  if (existing) {
    let content: string;
    try {
      content = await existing.text();
    } catch (error) {
      throw persistenceRetry(error, "The staged transcription result could not be read.");
    }
    let transcript: ValidatedDiarizedTranscript;
    try {
      transcript = validateDiarizedTranscriptOutput(JSON.parse(content));
    } catch {
      throw new TranscriptionFault(
        "TRANSCRIPTION_OUTPUT_INVALID",
        "The staged transcription result is invalid.",
      );
    }
    const resultSha = await sha256Hex(new TextEncoder().encode(content).buffer);
    if (run.staged_result_sha256 && String(run.staged_result_sha256) !== resultSha) {
      throw new TranscriptionFault(
        "TRANSCRIPTION_OUTPUT_INVALID",
        "The staged transcription checksum does not match the Run record.",
      );
    }
    const providerRequestId = run.provider_request_id
      ? String(run.provider_request_id)
      : existing.customMetadata?.provider_request_id || null;
    if (!run.staged_result_sha256) {
      try {
        const recovered = await getD1()
          .prepare(
            `UPDATE transcription_runs
                SET staged_result_sha256 = ?, provider_request_id = COALESCE(?, provider_request_id),
                    updated_at = ?
              WHERE id = ? AND status = 'processing' AND lease_owner = ?
                AND staged_result_r2_key = ? AND staged_result_sha256 IS NULL`,
          )
          .bind(resultSha, providerRequestId, now(), run.id, owner, resultKey)
          .run();
        if (Number(recovered.meta.changes ?? 0) !== 1) {
          throw new Error("The recovered staged transcription could not be recorded.");
        }
      } catch (error) {
        throw persistenceRetry(error, "The recovered staged transcription could not be recorded.");
      }
    }
    existingResult = { transcript, resultKey, resultSha, providerRequestId };
  } else if (run.staged_result_sha256) {
    throw new TranscriptionFault(
      "AUDIO_TRANSCRIPTION_FAILED",
      "The staged transcription result is missing.",
    );
  }

  return loadOrStageTranscriptionResult({
    stagedResultAvailable: existingResult !== null,
    loadStagedResult: async () => existingResult!,
    callProvider: () => callProvider(run),
    stageProviderResult: async (called) => {
      const content = diarizedTranscriptJson(called.transcript);
      const bytes = new TextEncoder().encode(content);
      const resultSha = await sha256Hex(bytes.buffer);
      try {
        await bucket.put(resultKey, bytes, {
          httpMetadata: { contentType: "application/json" },
          customMetadata: {
            sha256: resultSha,
            schema: "diarized-transcript.v1",
            source_audio_asset_version_id: String(run.audio_asset_version_id),
            ...(called.providerRequestId
              ? { provider_request_id: called.providerRequestId }
              : {}),
          },
        });
      } catch (error) {
        throw persistenceRetry(error, "The transcription result could not be staged.");
      }
      try {
        const updated = await getD1()
          .prepare(
            `UPDATE transcription_runs
                SET staged_result_sha256 = ?, provider_request_id = ?, updated_at = ?
              WHERE id = ? AND status = 'processing' AND lease_owner = ?
                AND staged_result_r2_key = ? AND staged_result_sha256 IS NULL`,
          )
          .bind(
            resultSha,
            called.providerRequestId,
            now(),
            run.id,
            owner,
            resultKey,
          )
          .run();
        if (Number(updated.meta.changes ?? 0) !== 1) {
          throw new Error("The transcription run lease changed before the result was recorded.");
        }
      } catch (error) {
        throw persistenceRetry(error, "The transcription result could not be recorded.");
      }
      return { ...called, resultKey, resultSha };
    },
  });
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
            SET metadata_json = json_remove(
              json_set(
                COALESCE(metadata_json, '{}'),
                '$.transcription_status', 'succeeded',
                '$.derived_transcript_asset_id', ?,
                '$.derived_transcript_asset_version_id', ?
              ),
              '$.transcription_error_code'
            ), updated_at = ?
          WHERE id = ? AND workspace_id = ? AND current_version_id = ?
            AND json_extract(
              COALESCE(metadata_json, '{}'),
              '$.transcription_run_id'
            ) = ?
            AND EXISTS (
              SELECT 1 FROM transcription_runs
               WHERE id = ? AND status = 'succeeded'
                 AND derived_transcript_asset_id = ?
                 AND derived_transcript_asset_version_id = ?
            )`,
      )
      .bind(
        transcriptAssetId,
        transcriptVersionId,
        timestamp,
        run.audio_asset_id,
        run.workspace_id,
        run.audio_asset_version_id,
        run.id,
        run.id,
        transcriptAssetId,
        transcriptVersionId,
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
  const providerRequestId = error instanceof TranscriptionFault
    ? error.providerRequestId
    : null;
  await getD1().batch([
    getD1()
      .prepare(
        `UPDATE transcription_runs
            SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
                finished_at = ?, error_code = ?, error_details_json = ?,
                provider_request_id = COALESCE(?, provider_request_id), updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        timestamp,
        code,
        JSON.stringify({ message: safeError(error) }),
        providerRequestId,
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
          WHERE id = ? AND workspace_id = ?
            AND json_extract(
              COALESCE(metadata_json, '{}'),
              '$.transcription_run_id'
            ) = ?
            AND EXISTS (
              SELECT 1 FROM transcription_runs
               WHERE id = ? AND status = 'failed' AND error_code = ?
                 AND finished_at = ?
            )`,
      )
      .bind(
        code,
        timestamp,
        run.audio_asset_id,
        run.workspace_id,
        run.id,
        run.id,
        code,
        timestamp,
      ),
  ]);
  return { runId: String(run.id), status: "failed", segmentCount: 0, errorCode: code };
}

async function markRetryable(
  run: Row,
  owner: string,
  error: unknown,
): Promise<TranscriptionProcessResult> {
  const timestamp = now();
  const code = errorCode(error);
  const providerRequestId = error instanceof TranscriptionFault
    ? error.providerRequestId
    : null;
  await getD1().batch([
    getD1()
      .prepare(
        `UPDATE transcription_runs
            SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                current_queued_at = ?, finished_at = NULL, error_code = ?,
                error_details_json = ?, provider_request_id = COALESCE(?, provider_request_id),
                updated_at = ?
          WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
      )
      .bind(
        timestamp,
        code,
        JSON.stringify({ message: safeError(error), retryable: true }),
        providerRequestId,
        timestamp,
        run.id,
        owner,
      ),
    getD1()
      .prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_status', 'queued',
              '$.transcription_error_code', ?
            ), updated_at = ?
          WHERE id = ? AND workspace_id = ?
            AND json_extract(
              COALESCE(metadata_json, '{}'),
              '$.transcription_run_id'
            ) = ?
            AND EXISTS (
              SELECT 1 FROM transcription_runs
               WHERE id = ? AND status = 'queued' AND error_code = ?
                 AND current_queued_at = ?
            )`,
      )
      .bind(
        code,
        timestamp,
        run.audio_asset_id,
        run.workspace_id,
        run.id,
        run.id,
        code,
        timestamp,
      ),
  ]);
  return { runId: String(run.id), status: "retryable", segmentCount: 0, errorCode: code };
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
  let stagedReady = false;
  try {
    const staged = await loadOrCreateStagedResult(leased, owner);
    stagedReady = true;
    return await persistTranscript(leased, owner, staged);
  } catch (error) {
    if (error instanceof TranscriptionFault && error.retryable) {
      return markRetryable(leased, owner, error);
    }
    if (stagedReady) {
      return markRetryable(
        leased,
        owner,
        new TranscriptionFault(
          "TRANSCRIPTION_PERSIST_RETRY",
          safeError(error),
          true,
        ),
      );
    }
    return markFailed(leased, owner, error);
  }
}

export async function requeueExpiredTranscriptionRuns(timestamp = now()): Promise<number> {
  const [expired] = await getD1().batch([
    getD1()
      .prepare(
        `UPDATE transcription_runs
            SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                current_queued_at = ?, finished_at = NULL, error_code = 'TRANSCRIPTION_TIMEOUT',
                error_details_json = '{"reason":"consumer_lease_expired","retryable":true}', updated_at = ?
          WHERE status = 'processing' AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?`,
      )
      .bind(timestamp, timestamp, timestamp),
    getD1()
      .prepare(
        `UPDATE assets
            SET metadata_json = json_set(
              COALESCE(metadata_json, '{}'),
              '$.transcription_status', 'queued',
              '$.transcription_error_code', 'TRANSCRIPTION_TIMEOUT'
            ), updated_at = ?
          WHERE EXISTS (
            SELECT 1 FROM transcription_runs
             WHERE id = json_extract(
               COALESCE(assets.metadata_json, '{}'),
               '$.transcription_run_id'
             )
               AND audio_asset_id = assets.id
               AND workspace_id = assets.workspace_id
               AND status = 'queued'
               AND error_code = 'TRANSCRIPTION_TIMEOUT'
               AND current_queued_at = ?
          )`,
      )
      .bind(timestamp, timestamp),
  ]);
  return Number(expired.meta.changes ?? 0);
}
