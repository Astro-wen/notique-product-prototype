import { getBindings, getD1 } from "@/db";
import { CONTEXT_PACK_SCHEMA_VERSION, type ContextPack } from "@/lib/domain/context-pack";
import {
  chunkReadableTranscriptSource,
  mergeReadableTranscriptChunks,
  validateEventSummaryOutput,
  validateReadableTranscriptOutput,
} from "@/lib/domain/event-ai-artifacts";
import type { ModelUsage } from "@/lib/domain/model-contract";
import {
  createModelProvider,
  ModelBackgroundPendingError,
  ModelOutputInvalidError,
  ModelProviderRequestError,
  ModelTimeoutError,
} from "@/lib/server/ai/model-provider";
import {
  ensureReadableTranscriptChunks,
  listReadableTranscriptChunks,
  persistReadableTranscriptChunk,
  persistReadableTranscriptArtifact,
  persistSummaryArtifact,
  sourceSegmentsForArtifactRun,
  type EventAiArtifactChunkRecord,
} from "@/lib/server/db/event-ai-artifact-repository";

type Row = Record<string, unknown>;

const TARGET_LEASE_MS = 40_000;
const CRON_LEASE_MS = 2 * 60_000;
const ARTIFACT_PROVIDER_TIMEOUT_MS = 25_000;
const MAX_CREATE_ATTEMPTS = 3;
const MAX_JOB_AGE_MS = 30 * 60_000;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

function nextPoll(timestamp: string, milliseconds = 5_000): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function transient(error: unknown): boolean {
  return error instanceof ModelTimeoutError ||
    error instanceof ModelProviderRequestError && (
      error.status === null || error.status === 408 || error.status === 409 ||
      error.status === 429 || (error.status !== null && error.status >= 500)
    );
}

function safeIssue(error: unknown): Record<string, unknown> {
  if (error instanceof ModelOutputInvalidError) return { issues: error.issues.slice(0, 20) };
  if (error instanceof ModelProviderRequestError) return { message: error.message, status: error.status };
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: "Unexpected artifact processing failure." };
}

async function leaseRun(row: Row, owner: string, leaseMs: number): Promise<Row | null> {
  const timestamp = now();
  const leaseExpires = nextPoll(timestamp, leaseMs);
  await getD1()
    .prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'processing', lease_owner = ?, lease_expires_at = ?,
              attempt_no = attempt_no + CASE WHEN provider_request_id IS NULL THEN 1 ELSE 0 END,
              started_at = COALESCE(started_at, ?), updated_at = ?
        WHERE id = ? AND status IN ('queued', 'processing')
          AND next_attempt_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    )
    .bind(owner, leaseExpires, timestamp, timestamp, row.id, timestamp, timestamp)
    .run();
  return first(
    `SELECT * FROM event_ai_artifact_runs
      WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    [row.id, owner],
  );
}

async function releasePending(run: Row, owner: string, responseId: string, status: string): Promise<void> {
  const timestamp = now();
  await getD1()
    .prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'queued', provider_request_id = ?, next_attempt_at = ?,
              lease_owner = NULL, lease_expires_at = NULL,
              error_code = NULL, error_details_json = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    )
    .bind(
      responseId,
      nextPoll(timestamp),
      JSON.stringify({ background_response_status: status }),
      timestamp,
      run.id,
      owner,
    )
    .run();
}

async function deferTransient(run: Row, owner: string, error: unknown): Promise<void> {
  const timestamp = now();
  const noResponseId = run.provider_request_id == null;
  const terminal = noResponseId && Number(run.attempt_no) >= MAX_CREATE_ATTEMPTS ||
    Date.parse(timestamp) - Date.parse(String(run.created_at)) >= MAX_JOB_AGE_MS;
  await getD1()
    .prepare(
      `UPDATE event_ai_artifact_runs
          SET status = ?, next_attempt_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, error_code = ?, error_details_json = ?,
              finished_at = CASE WHEN ? THEN ? ELSE finished_at END, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    )
    .bind(
      terminal ? "failed" : "queued",
      terminal ? "9999-12-31T23:59:59.999Z" : nextPoll(timestamp, 10_000),
      terminal ? "ARTIFACT_RETRY_EXHAUSTED" : "ARTIFACT_RETRY_SCHEDULED",
      JSON.stringify(safeIssue(error)).slice(0, 64 * 1024),
      terminal ? 1 : 0,
      timestamp,
      timestamp,
      run.id,
      owner,
    )
    .run();
}

async function failRun(run: Row, owner: string, error: unknown): Promise<void> {
  const timestamp = now();
  const code = error instanceof ModelOutputInvalidError
    ? "MODEL_OUTPUT_INVALID"
    : error instanceof ModelProviderRequestError
      ? "MODEL_PROVIDER_REQUEST_FAILED"
      : "ARTIFACT_PROCESSING_FAILED";
  await getD1()
    .prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = '9999-12-31T23:59:59.999Z', error_code = ?,
              error_details_json = ?, finished_at = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    )
    .bind(
      code,
      JSON.stringify(safeIssue(error)).slice(0, 64 * 1024),
      timestamp,
      timestamp,
      run.id,
      owner,
    )
    .run();
}

function guardReadableChunk() {
  return getD1().prepare(
    `INSERT INTO mutation_guards (id, guard_value, created_at)
     SELECT ?, CASE WHEN EXISTS (
       SELECT 1 FROM event_ai_artifact_runs
        WHERE id = ? AND status = 'processing' AND lease_owner = ?
     ) AND EXISTS (
       SELECT 1 FROM event_ai_artifact_chunks
        WHERE id = ? AND artifact_run_id = ? AND status = 'processing'
     ) THEN 1 ELSE 0 END, ?`,
  );
}

async function leaseReadableChunk(
  run: Row,
  owner: string,
  chunk: EventAiArtifactChunkRecord,
): Promise<EventAiArtifactChunkRecord | null> {
  const timestamp = now();
  await getD1().prepare(
    `UPDATE event_ai_artifact_chunks
        SET status = 'processing',
            attempt_no = attempt_no + CASE WHEN provider_request_id IS NULL THEN 1 ELSE 0 END,
            error_code = NULL, updated_at = ?
      WHERE id = ? AND artifact_run_id = ? AND status IN ('queued','processing')
        AND EXISTS (
          SELECT 1 FROM event_ai_artifact_runs
           WHERE id = ? AND status = 'processing' AND lease_owner = ?
        )`,
  ).bind(timestamp, chunk.id, run.id, run.id, owner).run();
  const row = await first(
    `SELECT * FROM event_ai_artifact_chunks
      WHERE id = ? AND artifact_run_id = ? AND status = 'processing'`,
    [chunk.id, run.id],
  );
  if (!row) return null;
  return {
    id: String(row.id),
    artifact_run_id: String(row.artifact_run_id),
    chunk_index: Number(row.chunk_index),
    input_hash: String(row.input_hash),
    status: "processing",
    provider_request_id: row.provider_request_id == null ? null : String(row.provider_request_id),
    validated_output_json: row.validated_output_json == null ? null : String(row.validated_output_json),
    input_tokens: row.input_tokens == null ? null : Number(row.input_tokens),
    output_tokens: row.output_tokens == null ? null : Number(row.output_tokens),
    cached_tokens: row.cached_tokens == null ? null : Number(row.cached_tokens),
    attempt_no: Number(row.attempt_no ?? 0),
    error_code: row.error_code == null ? null : String(row.error_code),
  };
}

async function recordReadableProviderResponse(
  run: Row,
  owner: string,
  chunk: EventAiArtifactChunkRecord,
  response: { id: string; status: string },
): Promise<void> {
  const timestamp = now();
  const guardId = id("guard");
  await getD1().batch([
    guardReadableChunk().bind(
      guardId,
      run.id,
      owner,
      chunk.id,
      run.id,
      timestamp,
    ),
    getD1().prepare(
      `UPDATE event_ai_artifact_chunks
          SET provider_request_id = ?, updated_at = ?
        WHERE id = ? AND artifact_run_id = ? AND status = 'processing'`,
    ).bind(response.id, timestamp, chunk.id, run.id),
    getD1().prepare(
      `UPDATE event_ai_artifact_runs
          SET provider_request_id = ?, error_details_json = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    ).bind(
      response.id,
      JSON.stringify({
        background_response_status: response.status,
        readable_chunk_index: chunk.chunk_index,
      }),
      timestamp,
      run.id,
      owner,
    ),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
}

async function releaseReadablePending(
  run: Row,
  owner: string,
  chunk: EventAiArtifactChunkRecord,
  responseId: string,
  status: string,
): Promise<void> {
  const timestamp = now();
  const guardId = id("guard");
  await getD1().batch([
    guardReadableChunk().bind(
      guardId,
      run.id,
      owner,
      chunk.id,
      run.id,
      timestamp,
    ),
    getD1().prepare(
      `UPDATE event_ai_artifact_chunks
          SET status = 'queued', provider_request_id = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND artifact_run_id = ? AND status = 'processing'`,
    ).bind(responseId, timestamp, chunk.id, run.id),
    getD1().prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'queued', provider_request_id = ?, next_attempt_at = ?,
              lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
              error_details_json = ?, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    ).bind(
      responseId,
      nextPoll(timestamp),
      JSON.stringify({
        background_response_status: status,
        readable_chunk_index: chunk.chunk_index,
      }),
      timestamp,
      run.id,
      owner,
    ),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
}

async function releaseForNextReadableChunk(
  run: Row,
  owner: string,
  completedChunks: number,
  totalChunks: number,
): Promise<void> {
  const timestamp = now();
  await getD1().prepare(
    `UPDATE event_ai_artifact_runs
        SET status = 'queued', next_attempt_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, error_code = NULL, error_details_json = ?, updated_at = ?
      WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
  ).bind(
    timestamp,
    JSON.stringify({ readable_chunks_completed: completedChunks, readable_chunks_total: totalChunks }),
    timestamp,
    run.id,
    owner,
  ).run();
}

async function failReadableChunk(
  run: Row,
  owner: string,
  chunk: EventAiArtifactChunkRecord,
  error: unknown,
  retryable: boolean,
): Promise<"pending" | "failed"> {
  const timestamp = now();
  const ageExpired = Date.parse(timestamp) - Date.parse(String(run.created_at)) >= MAX_JOB_AGE_MS;
  const attemptsExpired = chunk.provider_request_id == null && chunk.attempt_no >= MAX_CREATE_ATTEMPTS;
  const terminal = !retryable || ageExpired || attemptsExpired;
  const guardId = id("guard");
  const errorCode = terminal
    ? error instanceof ModelOutputInvalidError
      ? "MODEL_OUTPUT_INVALID"
      : retryable
        ? "ARTIFACT_RETRY_EXHAUSTED"
        : "ARTIFACT_PROCESSING_FAILED"
    : "ARTIFACT_RETRY_SCHEDULED";
  await getD1().batch([
    guardReadableChunk().bind(
      guardId,
      run.id,
      owner,
      chunk.id,
      run.id,
      timestamp,
    ),
    getD1().prepare(
      `UPDATE event_ai_artifact_chunks
          SET status = ?, error_code = ?, updated_at = ?
        WHERE id = ? AND artifact_run_id = ? AND status = 'processing'`,
    ).bind(terminal ? "failed" : "queued", errorCode, timestamp, chunk.id, run.id),
    getD1().prepare(
      `UPDATE event_ai_artifact_runs
          SET status = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              error_code = ?, error_details_json = ?,
              finished_at = CASE WHEN ? THEN ? ELSE finished_at END, updated_at = ?
        WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
    ).bind(
      terminal ? "failed" : "queued",
      terminal ? "9999-12-31T23:59:59.999Z" : nextPoll(timestamp, 10_000),
      errorCode,
      JSON.stringify({ readable_chunk_index: chunk.chunk_index, ...safeIssue(error) }).slice(0, 64 * 1024),
      terminal ? 1 : 0,
      timestamp,
      timestamp,
      run.id,
      owner,
    ),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
  return terminal ? "failed" : "pending";
}

function aggregateChunkUsage(chunks: EventAiArtifactChunkRecord[]): ModelUsage {
  const sum = (key: "input_tokens" | "output_tokens" | "cached_tokens") => {
    const values = chunks.map((chunk) => chunk[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  return {
    inputTokens: sum("input_tokens"),
    outputTokens: sum("output_tokens"),
    cachedTokens: sum("cached_tokens"),
    providerRequestId: [...chunks].reverse().find((chunk) => chunk.provider_request_id)?.provider_request_id ?? null,
  };
}

function minimalContext(input: Awaited<ReturnType<typeof sourceSegmentsForArtifactRun>>): ContextPack {
  return {
    schema_version: CONTEXT_PACK_SCHEMA_VERSION,
    project: {
      id: String(input.run.project_id),
      scenario: null,
      locale: input.locale,
      context_version: 0,
    },
    verified_context: {
      glossary: input.glossary.map((entry) => ({
        ...entry,
        sourceKind: "manual" as const,
      })),
      active_claims: [],
      recent_history: [],
      open_questions: [],
      active_risks: [],
    },
    draft_context: {
      enabled: false,
      claims: [],
    },
    new_event: {
      event_id: String(input.run.event_id),
      transcript_segments: input.segments,
      readable_transcript_segments: [],
      photos: [],
      documents: [],
    },
  };
}

async function processReadableTranscriptRun(
  run: Row,
  owner: string,
  source: Awaited<ReturnType<typeof sourceSegmentsForArtifactRun>>,
  provider: ReturnType<typeof createModelProvider>,
): Promise<"succeeded" | "pending" | "failed"> {
  const sourceChunks = chunkReadableTranscriptSource(source.segments);
  const storedChunks = await ensureReadableTranscriptChunks(run, sourceChunks);
  const nextStoredChunk = storedChunks.find((chunk) => chunk.status !== "succeeded");
  if (!nextStoredChunk) {
    const outputs = storedChunks.map((chunk) => JSON.parse(chunk.validated_output_json ?? "null"));
    const merged = mergeReadableTranscriptChunks(String(run.event_id), outputs);
    const validated = validateReadableTranscriptOutput(merged, {
      eventId: String(run.event_id),
      segments: source.segments,
    });
    if (!validated.output) {
      await failRun(run, owner, new ModelOutputInvalidError(validated.issues, aggregateChunkUsage(storedChunks)));
      return "failed";
    }
    await persistReadableTranscriptArtifact(run, owner, validated.output, aggregateChunkUsage(storedChunks));
    return "succeeded";
  }
  if (nextStoredChunk.status === "failed") {
    await failRun(run, owner, new Error(nextStoredChunk.error_code ?? "READABLE_TRANSCRIPT_CHUNK_FAILED"));
    return "failed";
  }
  const chunk = await leaseReadableChunk(run, owner, nextStoredChunk);
  if (!chunk) return "pending";
  const sourceChunk = sourceChunks[chunk.chunk_index];
  if (!sourceChunk) {
    return failReadableChunk(run, owner, chunk, new Error("READABLE_TRANSCRIPT_CHUNK_MISSING"), false);
  }
  const context = minimalContext({ ...source, segments: sourceChunk.segments });
  try {
    const result = await provider.refineTranscript(context, {
      idempotencyKey: `notique:${run.id}:readable_transcript:chunk:${chunk.chunk_index}`,
      ...(chunk.provider_request_id ? { resumeProviderResponseId: chunk.provider_request_id } : {}),
      onProviderResponse: (response) => recordReadableProviderResponse(run, owner, chunk, response),
      promptCacheKey: `notique:${run.extraction_run_id}:readable:${chunk.chunk_index}`,
    });
    const validated = validateReadableTranscriptOutput(result.output, {
      eventId: String(run.event_id),
      segments: sourceChunk.segments,
    });
    if (!validated.output) throw new ModelOutputInvalidError(validated.issues, result.usage);
    await persistReadableTranscriptChunk(run, owner, chunk.id, validated.output, result.usage);
    const refreshed = await listReadableTranscriptChunks(String(run.id));
    if (refreshed.every((item) => item.status === "succeeded")) {
      const outputs = refreshed.map((item) => JSON.parse(item.validated_output_json ?? "null"));
      const merged = mergeReadableTranscriptChunks(String(run.event_id), outputs);
      const finalValidation = validateReadableTranscriptOutput(merged, {
        eventId: String(run.event_id),
        segments: source.segments,
      });
      if (!finalValidation.output) {
        throw new ModelOutputInvalidError(finalValidation.issues, aggregateChunkUsage(refreshed));
      }
      await persistReadableTranscriptArtifact(
        run,
        owner,
        finalValidation.output,
        aggregateChunkUsage(refreshed),
      );
      return "succeeded";
    }
    await releaseForNextReadableChunk(
      run,
      owner,
      refreshed.filter((item) => item.status === "succeeded").length,
      refreshed.length,
    );
    return "pending";
  } catch (error) {
    if (error instanceof ModelBackgroundPendingError) {
      await releaseReadablePending(run, owner, chunk, error.providerResponseId, error.providerStatus);
      return "pending";
    }
    const currentChunk = (await listReadableTranscriptChunks(String(run.id)))
      .find((item) => item.id === chunk.id);
    if (currentChunk?.status === "succeeded") {
      await failRun(run, owner, error);
      return "failed";
    }
    return failReadableChunk(run, owner, chunk, error, transient(error));
  }
}

async function processLeasedRun(run: Row, owner: string): Promise<"succeeded" | "pending" | "failed"> {
  try {
    const source = await sourceSegmentsForArtifactRun(String(run.id));
    if (!source.segments.length) throw new Error("ARTIFACT_INPUT_MISSING_TRANSCRIPT");
    const provider = createModelProvider(getBindings(), {
      provider: String(run.provider),
      model: String(run.model),
      reasoningEffort: String(run.reasoning_effort),
      timeoutMs: ARTIFACT_PROVIDER_TIMEOUT_MS,
    });
    if (String(run.kind) === "readable_transcript") {
      return processReadableTranscriptRun(run, owner, source, provider);
    }
    const context = minimalContext(source);
    const onProviderResponse = async (response: { id: string; status: string }) => {
      await getD1()
        .prepare(
          `UPDATE event_ai_artifact_runs
              SET provider_request_id = ?, error_details_json = ?, updated_at = ?
            WHERE id = ? AND status = 'processing' AND lease_owner = ?`,
        )
        .bind(
          response.id,
          JSON.stringify({ background_response_status: response.status }),
          now(),
          run.id,
          owner,
        )
        .run();
    };
    const options = {
      idempotencyKey: `notique:${run.id}:${run.kind}`,
      ...(run.provider_request_id ? { resumeProviderResponseId: String(run.provider_request_id) } : {}),
      onProviderResponse,
      promptCacheKey: `notique:${run.extraction_run_id}:event-artifacts`,
    };
    const result = await provider.summarizeEvent(context, options);
    const validated = validateEventSummaryOutput(result.output, {
      eventId: String(run.event_id),
      segments: source.segments,
    });
    if (!validated.output) throw new ModelOutputInvalidError(validated.issues, result.usage);
    await persistSummaryArtifact(run, owner, validated.output, result.usage);
    return "succeeded";
  } catch (error) {
    if (error instanceof ModelBackgroundPendingError) {
      await releasePending(run, owner, error.providerResponseId, error.providerStatus);
      return "pending";
    }
    if (transient(error)) {
      await deferTransient(run, owner, error);
      return "pending";
    }
    await failRun(run, owner, error);
    return "failed";
  }
}

export async function dispatchDueEventAiArtifactRuns(input?: {
  workspaceId: string;
  runId?: string;
  extractionRunId?: string;
  targeted?: boolean;
}): Promise<{ claimed: number; succeeded: number; pending: number; failed: number }> {
  const timestamp = now();
  const clauses = [
    "status IN ('queued', 'processing')",
    "next_attempt_at <= ?",
    "(lease_expires_at IS NULL OR lease_expires_at <= ?)",
  ];
  const bindings: unknown[] = [timestamp, timestamp];
  if (input?.workspaceId) {
    clauses.push("workspace_id = ?");
    bindings.push(input.workspaceId);
  }
  if (input?.runId) {
    clauses.push("id = ?");
    bindings.push(input.runId);
  }
  if (input?.extractionRunId) {
    clauses.push("extraction_run_id = ?");
    bindings.push(input.extractionRunId);
  }
  const limit = input?.runId ? 1 : input?.extractionRunId ? 2 : 2;
  const rows = await getD1()
    .prepare(
      `SELECT * FROM event_ai_artifact_runs
        WHERE ${clauses.join(" AND ")}
        ORDER BY next_attempt_at, created_at LIMIT ?`,
    )
    .bind(...bindings, limit)
    .all<Row>();
  const result = { claimed: 0, succeeded: 0, pending: 0, failed: 0 };
  await Promise.all((rows.results ?? []).map(async (row) => {
    const owner = id("eaw");
    const leased = await leaseRun(row, owner, input?.targeted ? TARGET_LEASE_MS : CRON_LEASE_MS);
    if (!leased) return;
    result.claimed += 1;
    const outcome = await processLeasedRun(leased, owner);
    result[outcome] += 1;
  }));
  return result;
}

export async function dispatchEventAiArtifactsForExtraction(
  workspaceId: string,
  extractionRunId: string,
): Promise<{ claimed: number; succeeded: number; pending: number; failed: number }> {
  return dispatchDueEventAiArtifactRuns({ workspaceId, extractionRunId, targeted: true });
}

export async function dispatchEventAiArtifactRun(
  workspaceId: string,
  runId: string,
): Promise<{ claimed: number; succeeded: number; pending: number; failed: number }> {
  return dispatchDueEventAiArtifactRuns({ workspaceId, runId, targeted: true });
}

export async function sweepEventAiArtifactRuns(): Promise<number> {
  const timestamp = now();
  const recovered = await getD1()
    .prepare(
      `UPDATE event_ai_artifact_runs
          SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
              next_attempt_at = ?, error_code = 'ARTIFACT_LEASE_RECOVERED', updated_at = ?
        WHERE status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
    )
    .bind(timestamp, timestamp, timestamp)
    .run();
  return Number(recovered.meta.changes ?? 0);
}

export async function sweepAndDispatchEventAiArtifacts() {
  const recovered = await sweepEventAiArtifactRuns();
  const dispatch = await dispatchDueEventAiArtifactRuns();
  return { recovered, dispatch };
}
