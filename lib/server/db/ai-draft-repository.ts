import { getD1 } from "@/db";
import { getClaim } from "@/lib/server/db/verdict-repository";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import type {
  AiDraftAssessmentRecord,
  ClaimRecord,
  CreateManualClaimRequest,
  EventTranscriptSegmentRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

async function all(sql: string, bindings: unknown[]): Promise<Row[]> {
  return (await getD1().prepare(sql).bind(...bindings).all<Row>()).results ?? [];
}

async function assessmentByRun(
  scope: RequestScope,
  runId: string,
): Promise<AiDraftAssessmentRecord | null> {
  const row = await getD1()
    .prepare(
      `SELECT a.*
         FROM ai_draft_assessments a
         JOIN extraction_runs r ON r.id = a.extraction_run_id
        WHERE a.extraction_run_id = ? AND a.workspace_id = ?
          AND a.actor_id = ? AND r.workspace_id = a.workspace_id`,
    )
    .bind(runId, scope.workspaceId, scope.actorId)
    .first<Row>();
  if (!row) return null;
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    event_id: String(row.event_id),
    extraction_run_id: String(row.extraction_run_id),
    assessment: String(row.assessment) as AiDraftAssessmentRecord["assessment"],
    created_at: String(row.created_at),
  };
}

export async function getAiDraftAssessment(
  scope: RequestScope,
  runId: string,
): Promise<AiDraftAssessmentRecord | null> {
  const visibleRun = await getD1()
    .prepare(`SELECT 1 FROM extraction_runs WHERE id = ? AND workspace_id = ?`)
    .bind(runId, scope.workspaceId)
    .first();
  if (!visibleRun) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Extraction run was not found.");
  }
  return assessmentByRun(scope, runId);
}

export async function recordAiDraftAssessment(
  scope: RequestScope,
  runId: string,
  assessment: AiDraftAssessmentRecord["assessment"],
  idempotencyKey: string,
): Promise<AiDraftAssessmentRecord> {
  const endpointScope = `extraction-runs/${runId}/draft-assessment`;
  const request = { assessment };
  const replay = await findMutationReplay<{ runId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    request,
  );
  if (replay.response) {
    const existing = await assessmentByRun(scope, replay.response.runId);
    if (existing) return existing;
  }
  const run = await getD1()
    .prepare(
      `SELECT id, project_id, event_id, status
         FROM extraction_runs
        WHERE id = ? AND workspace_id = ?`,
    )
    .bind(runId, scope.workspaceId)
    .first<Row>();
  if (!run) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Extraction run was not found.");
  }
  if (!["succeeded", "completed", "completed_with_warnings"].includes(String(run.status))) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "Only a completed AI draft can be assessed.");
  }
  const existing = await assessmentByRun(scope, runId);
  if (existing) {
    if (existing.assessment !== assessment) {
      throw new ApiFault(409, "DRAFT_ASSESSMENT_CONFLICT", "The first draft assessment is already recorded.");
    }
    return existing;
  }
  const assessmentId = id("dra");
  const timestamp = now();
  try {
    await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO ai_draft_assessments (
             id, workspace_id, project_id, event_id, extraction_run_id,
             actor_id, assessment, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          assessmentId,
          scope.workspaceId,
          String(run.project_id),
          String(run.event_id),
          runId,
          scope.actorId,
          assessment,
          timestamp,
        ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { runId },
        timestamp,
      ),
    ]);
  } catch (error) {
    const recovered = await assessmentByRun(scope, runId);
    if (recovered?.assessment === assessment) return recovered;
    throw error;
  }
  const created = await assessmentByRun(scope, runId);
  if (!created) throw new Error("Draft assessment was not persisted.");
  return created;
}

export async function listEventTranscriptSegments(
  scope: RequestScope,
  eventId: string,
): Promise<EventTranscriptSegmentRecord[]> {
  const event = await getD1()
    .prepare(`SELECT 1 FROM events WHERE id = ? AND workspace_id = ?`)
    .bind(eventId, scope.workspaceId)
    .first();
  if (!event) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  }
  const rows = await all(
    `SELECT id, event_id, asset_version_id, ordinal, speaker, start_ms, end_ms, text_raw
       FROM text_segments
      WHERE event_id = ? AND workspace_id = ?
      ORDER BY asset_version_id, ordinal`,
    [eventId, scope.workspaceId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    event_id: String(row.event_id),
    asset_version_id: String(row.asset_version_id),
    ordinal: Number(row.ordinal),
    speaker: row.speaker == null ? null : String(row.speaker),
    start_ms: row.start_ms == null ? null : Number(row.start_ms),
    end_ms: row.end_ms == null ? null : Number(row.end_ms),
    text: String(row.text_raw),
  }));
}

export async function createManualClaim(
  scope: RequestScope,
  eventId: string,
  input: CreateManualClaimRequest,
  idempotencyKey: string,
): Promise<ClaimRecord> {
  const endpointScope = `events/${eventId}/manual-claims`;
  const request = {
    ...input,
    segment_ids: [...input.segment_ids].sort(),
  };
  const replay = await findMutationReplay<{ claimId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    request,
  );
  if (replay.response) return getClaim(scope, replay.response.claimId);

  const event = await getD1()
    .prepare(
      `SELECT e.project_id, e.active_run_id, r.status AS run_status
         FROM events e
         LEFT JOIN extraction_runs r ON r.id = e.active_run_id
        WHERE e.id = ? AND e.workspace_id = ?`,
    )
    .bind(eventId, scope.workspaceId)
    .first<Row>();
  if (!event) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  }
  const runId = event.active_run_id == null ? "" : String(event.active_run_id);
  if (!runId || !["succeeded", "completed", "completed_with_warnings"].includes(String(event.run_status))) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "A missed fact can only be added after this Event has an AI draft.");
  }
  const uniqueSegmentIds = [...new Set(input.segment_ids)];
  const segmentRows = await all(
    `SELECT id, asset_version_id, speaker, start_ms, end_ms, text_raw
       FROM text_segments
      WHERE workspace_id = ? AND project_id = ? AND event_id = ?
        AND id IN (${uniqueSegmentIds.map(() => "?").join(",")})
      ORDER BY asset_version_id, ordinal`,
    [scope.workspaceId, String(event.project_id), eventId, ...uniqueSegmentIds],
  );
  if (segmentRows.length !== uniqueSegmentIds.length) {
    throw new ApiFault(400, "EVIDENCE_SCOPE_INVALID", "One or more selected Transcript passages do not belong to this Event.");
  }

  const claimId = id("clm");
  const versionId = id("clv");
  const timestamp = now();
  const openedAt = ["open_question", "risk", "concern"].includes(input.type) ? timestamp : null;
  const statements = [
    getD1()
      .prepare(
        `INSERT INTO claims (
           id, workspace_id, project_id, event_id, extraction_run_id,
           client_claim_key, type, materiality, confidence,
           needs_additional_evidence, review_status, lifecycle_status,
           current_version_id, first_event_id, source, opened_at,
           repeat_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'high', NULL, 0, 'pending', 'active', ?, ?, 'human', ?, 0, ?, ?)`,
      )
      .bind(
        claimId,
        scope.workspaceId,
        String(event.project_id),
        eventId,
        runId,
        `human_missing:${replay.requestHash}`,
        input.type,
        versionId,
        eventId,
        openedAt,
        timestamp,
        timestamp,
      ),
    getD1()
      .prepare(
        `INSERT INTO claim_versions (
           id, claim_id, version_no, statement, normalized_value_json,
           uncertainty_json, source, created_by, created_at
         ) VALUES (?, ?, 1, ?, NULL, NULL, 'human', ?, ?)`,
      )
      .bind(versionId, claimId, input.statement, scope.actorId, timestamp),
    ...segmentRows.map((segment) =>
      getD1()
        .prepare(
          `INSERT INTO evidence_refs (
             id, workspace_id, project_id, event_id, claim_version_id,
             kind, asset_version_id, segment_ids_json, quote_raw,
             start_ms, end_ms, evidence_role, provenance_grade,
             structural_validation_status, semantic_support_verdict, created_at
           ) VALUES (?, ?, ?, ?, ?, 'transcript', ?, ?, ?, ?, ?,
             'direct', 'primary', 'valid', 'unreviewed', ?)`,
        )
        .bind(
          id("evr"),
          scope.workspaceId,
          String(event.project_id),
          eventId,
          versionId,
          String(segment.asset_version_id),
          JSON.stringify([String(segment.id)]),
          String(segment.text_raw),
          segment.start_ms == null ? null : Number(segment.start_ms),
          segment.end_ms == null ? null : Number(segment.end_ms),
          timestamp,
        ),
    ),
    mutationReplayStatement(
      scope,
      endpointScope,
      idempotencyKey,
      replay.requestHash,
      { claimId },
      timestamp,
    ),
  ];
  try {
    await getD1().batch(statements);
  } catch (error) {
    const recovered = await findMutationReplay<{ claimId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      request,
    );
    if (recovered.response) return getClaim(scope, recovered.response.claimId);
    throw error;
  }
  return getClaim(scope, claimId);
}
