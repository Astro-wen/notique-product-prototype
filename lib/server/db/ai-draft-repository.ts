import { getD1 } from "@/db";
import { getClaim } from "@/lib/server/db/verdict-repository";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import type {
  AiDraftAssessmentRecord,
  ClaimRecord,
  CreateManualClaimRequest,
  EventTranscriptSegmentRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

// A readable transcript is persisted as a transcript-shaped derived asset so
// that it can keep segment/time mappings. It is a reading aid, never a source
// transcript or formal Evidence. Keep this predicate on every user-selectable
// raw Transcript query in this repository.
const RAW_TRANSCRIPT_ASSET_PREDICATE = `
  a.kind IN ('transcript', 'text')
  AND COALESCE(json_extract(a.metadata_json, '$.analysis_source'), 1) <> 0
  AND COALESCE(json_extract(a.metadata_json, '$.artifact_kind'), '') <> 'readable_transcript'
`;

const COMPLETED_AI_DRAFT_STATUSES = new Set([
  "succeeded",
  "completed",
  "completed_with_warnings",
]);

type PersistedSummary = {
  sections?: Array<{
    items?: Array<{
      source_segment_ids?: unknown;
    }>;
  }>;
};

function summarySourceSegmentIds(contentJson: string): Set<string> {
  const summary = parseJson<PersistedSummary>(contentJson, {});
  const result = new Set<string>();
  if (!Array.isArray(summary.sections)) return result;
  for (const section of summary.sections) {
    if (!section || !Array.isArray(section.items)) continue;
    for (const item of section.items) {
      if (!item || !Array.isArray(item.source_segment_ids)) continue;
      for (const segmentId of item.source_segment_ids) {
        if (typeof segmentId === "string" && segmentId) result.add(segmentId);
      }
    }
  }
  return result;
}

async function activeSummarySourceSegmentIds(
  scope: RequestScope,
  projectId: string,
  eventId: string,
  runId: string,
): Promise<Set<string> | null> {
  const row = await getD1()
    .prepare(
      `SELECT artifact.content_json
         FROM event_ai_artifacts artifact
         JOIN event_ai_artifact_runs artifact_run
           ON artifact_run.id = artifact.run_id
          AND artifact_run.workspace_id = artifact.workspace_id
          AND artifact_run.project_id = artifact.project_id
          AND artifact_run.event_id = artifact.event_id
         JOIN extraction_runs extraction_run
           ON extraction_run.id = artifact_run.extraction_run_id
          AND extraction_run.workspace_id = artifact_run.workspace_id
          AND extraction_run.project_id = artifact_run.project_id
          AND extraction_run.event_id = artifact_run.event_id
        WHERE artifact.workspace_id = ? AND artifact.project_id = ?
          AND artifact.event_id = ? AND artifact.kind = 'summary'
          AND artifact_run.kind = 'summary' AND artifact_run.status = 'succeeded'
          AND artifact_run.extraction_run_id = ?
        ORDER BY artifact.artifact_version DESC, artifact.created_at DESC
        LIMIT 1`,
    )
    .bind(scope.workspaceId, projectId, eventId, runId)
    .first<Row>();
  if (!row || typeof row.content_json !== "string") return null;
  return summarySourceSegmentIds(row.content_json);
}

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
    `SELECT ts.id, ts.event_id, ts.asset_version_id, ts.ordinal, ts.speaker,
            ts.start_ms, ts.end_ms, ts.text_raw
       FROM text_segments ts
       JOIN assets a ON a.id = ts.asset_id
      WHERE ts.event_id = ? AND ts.workspace_id = ?
        AND ${RAW_TRANSCRIPT_ASSET_PREDICATE}
      ORDER BY ts.asset_version_id, ts.ordinal`,
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
         JOIN projects p
           ON p.id = e.project_id AND p.workspace_id = e.workspace_id
          AND p.deleted_at IS NULL
         LEFT JOIN extraction_runs r
           ON r.id = e.active_run_id
          AND r.workspace_id = e.workspace_id
          AND r.project_id = e.project_id
          AND r.event_id = e.id
        WHERE e.id = ? AND e.workspace_id = ?`,
    )
    .bind(eventId, scope.workspaceId)
    .first<Row>();
  if (!event) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  }
  const runId = event.active_run_id == null ? "" : String(event.active_run_id);
  const hasCompletedDraft = runId !== "" && COMPLETED_AI_DRAFT_STATUSES.has(String(event.run_status));
  const isEarlySourceBackedAction = runId !== "" && !hasCompletedDraft && input.type === "next_action";
  if (!hasCompletedDraft && !isEarlySourceBackedAction) {
    throw new ApiFault(
      409,
      "RUN_STATE_CONFLICT",
      "A source-backed next action can be added once this Event's Summary is ready; other missed facts require a completed AI draft.",
    );
  }
  const uniqueSegmentIds = [...new Set(input.segment_ids)];
  if (!uniqueSegmentIds.length) {
    throw new ApiFault(
      400,
      "EVIDENCE_SCOPE_INVALID",
      "At least one raw Transcript passage from this Event is required.",
    );
  }
  const segmentRows = await all(
    `SELECT ts.id, ts.asset_version_id, ts.speaker, ts.start_ms, ts.end_ms, ts.text_raw
       FROM text_segments ts
       JOIN assets a
         ON a.id = ts.asset_id
        AND a.workspace_id = ts.workspace_id
        AND a.project_id = ts.project_id
        AND a.event_id = ts.event_id
       JOIN asset_versions av
         ON av.id = ts.asset_version_id AND av.asset_id = a.id
      WHERE ts.workspace_id = ? AND ts.project_id = ? AND ts.event_id = ?
        AND ts.id IN (${uniqueSegmentIds.map(() => "?").join(",")})
        AND ${RAW_TRANSCRIPT_ASSET_PREDICATE}
      ORDER BY ts.asset_version_id, ts.ordinal`,
    [scope.workspaceId, String(event.project_id), eventId, ...uniqueSegmentIds],
  );
  if (segmentRows.length !== uniqueSegmentIds.length) {
    throw new ApiFault(
      400,
      "EVIDENCE_SCOPE_INVALID",
      "One or more selected passages are not raw Transcript evidence for this Event.",
    );
  }
  if (isEarlySourceBackedAction) {
    const summarySegmentIds = await activeSummarySourceSegmentIds(
      scope,
      String(event.project_id),
      eventId,
      runId,
    );
    if (summarySegmentIds === null) {
      throw new ApiFault(
        409,
        "RUN_STATE_CONFLICT",
        "Wait for this Event's Summary before adding an action while fact extraction is still running.",
      );
    }
    if (!uniqueSegmentIds.every((segmentId) => summarySegmentIds.has(segmentId))) {
      throw new ApiFault(
        400,
        "EVIDENCE_SCOPE_INVALID",
        "An action added before fact extraction finishes must use source passages cited by this Event's active Summary.",
      );
    }
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
