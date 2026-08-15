import { getD1 } from "@/db";
import {
  deriveProjectWorkflowDisplayStatus,
  planProjectWorkflow,
  projectNeedsScenarioConfirmation,
} from "@/lib/domain/project-workflow";
import { getProject } from "@/lib/server/db/core-repository";
import type { RequestScope } from "@/lib/server/http/context";
import type {
  ExtractionModelStageName,
  ExtractionRunStatus,
  EventAiArtifactRunRecord,
  MaterialStatus,
  TranscriptionRunStatus,
  WorkflowSnapshotRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

function integer(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function nullableText(row: Row, key: string): string | null {
  return row[key] == null ? null : String(row[key]);
}

function artifactRun(row: Row, prefix: "summary" | "readable"): EventAiArtifactRunRecord | null {
  const runId = nullableText(row, `${prefix}_run_id`);
  if (!runId) return null;
  return {
    id: runId,
    project_id: String(row[`${prefix}_project_id`]),
    event_id: String(row[`${prefix}_event_id`]),
    extraction_run_id: String(row[`${prefix}_extraction_run_id`]),
    kind: String(row[`${prefix}_kind`]) as EventAiArtifactRunRecord["kind"],
    status: String(row[`${prefix}_status`]) as EventAiArtifactRunRecord["status"],
    provider: String(row[`${prefix}_provider`]),
    model: String(row[`${prefix}_model`]),
    reasoning_effort: String(row[`${prefix}_reasoning_effort`]),
    prompt_version: String(row[`${prefix}_prompt_version`]),
    schema_version: String(row[`${prefix}_schema_version`]),
    attempt_no: integer(row, `${prefix}_attempt_no`),
    provider_request_id: nullableText(row, `${prefix}_provider_request_id`),
    input_tokens: row[`${prefix}_input_tokens`] == null ? null : integer(row, `${prefix}_input_tokens`),
    output_tokens: row[`${prefix}_output_tokens`] == null ? null : integer(row, `${prefix}_output_tokens`),
    cached_tokens: row[`${prefix}_cached_tokens`] == null ? null : integer(row, `${prefix}_cached_tokens`),
    error_code: nullableText(row, `${prefix}_error_code`),
    queued_at: String(row[`${prefix}_queued_at`]),
    started_at: nullableText(row, `${prefix}_started_at`),
    finished_at: nullableText(row, `${prefix}_finished_at`),
    created_at: String(row[`${prefix}_created_at`]),
    updated_at: String(row[`${prefix}_updated_at`]),
  };
}

export async function getWorkflowSnapshot(
  scope: RequestScope,
  projectId: string,
): Promise<WorkflowSnapshotRecord> {
  const project = await getProject(scope, projectId);
  const result = await getD1()
    .prepare(
      `WITH material_counts AS (
         SELECT event_id,
                COUNT(*) AS material_total,
                SUM(CASE WHEN processing_status = 'ready' THEN 1 ELSE 0 END) AS material_ready,
                SUM(CASE WHEN processing_status IN ('uploading', 'parsing') THEN 1 ELSE 0 END) AS material_processing,
                SUM(CASE WHEN processing_status = 'failed' THEN 1 ELSE 0 END) AS material_failed
           FROM assets WHERE workspace_id = ? GROUP BY event_id
       )
       SELECT e.*,
              COALESCE(mc.material_total, 0) AS material_total,
              COALESCE(mc.material_ready, 0) AS material_ready,
              COALESCE(mc.material_processing, 0) AS material_processing,
              COALESCE(mc.material_failed, 0) AS material_failed,
              er.status AS extraction_status,
              er.error_code AS extraction_error_code,
              er.attempt_no AS extraction_attempt_no,
              er.created_at AS extraction_created_at,
              er.queued_at AS extraction_queued_at,
              er.first_queued_at AS extraction_first_queued_at,
              er.current_queued_at AS extraction_current_queued_at,
              er.started_at AS extraction_started_at,
              er.first_started_at AS extraction_first_started_at,
              er.current_started_at AS extraction_current_started_at,
              er.finished_at AS extraction_finished_at,
              er.updated_at AS extraction_updated_at,
              COALESCE(eo.attempt, 0) AS extraction_dispatch_attempt,
              (SELECT s.stage FROM extraction_model_stages s
                WHERE s.run_id = er.id
                ORDER BY CASE s.stage
                  WHEN 'verify_escalated' THEN 3 WHEN 'verify' THEN 2 ELSE 1 END DESC,
                  s.attempt DESC LIMIT 1) AS extraction_stage,
              tr.id AS transcription_run_id,
              tr.status AS transcription_status,
              tr.error_code AS transcription_error_code,
              tr.attempt_no AS transcription_attempt_no,
              COALESCE(tqo.attempt, 0) AS transcription_dispatch_attempt,
              sr.id AS summary_run_id,
              sr.project_id AS summary_project_id,
              sr.event_id AS summary_event_id,
              sr.extraction_run_id AS summary_extraction_run_id,
              sr.kind AS summary_kind,
              sr.status AS summary_status,
              sr.provider AS summary_provider,
              sr.model AS summary_model,
              sr.reasoning_effort AS summary_reasoning_effort,
              sr.prompt_version AS summary_prompt_version,
              sr.schema_version AS summary_schema_version,
              sr.attempt_no AS summary_attempt_no,
              sr.provider_request_id AS summary_provider_request_id,
              sr.input_tokens AS summary_input_tokens,
              sr.output_tokens AS summary_output_tokens,
              sr.cached_tokens AS summary_cached_tokens,
              sr.error_code AS summary_error_code,
              sr.queued_at AS summary_queued_at,
              sr.started_at AS summary_started_at,
              sr.finished_at AS summary_finished_at,
              sr.created_at AS summary_created_at,
              sr.updated_at AS summary_updated_at,
              rr.id AS readable_run_id,
              rr.project_id AS readable_project_id,
              rr.event_id AS readable_event_id,
              rr.extraction_run_id AS readable_extraction_run_id,
              rr.kind AS readable_kind,
              rr.status AS readable_status,
              rr.provider AS readable_provider,
              rr.model AS readable_model,
              rr.reasoning_effort AS readable_reasoning_effort,
              rr.prompt_version AS readable_prompt_version,
              rr.schema_version AS readable_schema_version,
              rr.attempt_no AS readable_attempt_no,
              rr.provider_request_id AS readable_provider_request_id,
              rr.input_tokens AS readable_input_tokens,
              rr.output_tokens AS readable_output_tokens,
              rr.cached_tokens AS readable_cached_tokens,
              rr.error_code AS readable_error_code,
              rr.queued_at AS readable_queued_at,
              rr.started_at AS readable_started_at,
              rr.finished_at AS readable_finished_at,
              rr.created_at AS readable_created_at,
              rr.updated_at AS readable_updated_at,
              COALESCE((SELECT COUNT(*) FROM claims c
                WHERE c.extraction_run_id = e.active_run_id
                  AND c.workspace_id = e.workspace_id), 0) +
              COALESCE((SELECT COUNT(*) FROM claim_occurrence_candidates occ
                WHERE occ.extraction_run_id = e.active_run_id
                  AND occ.workspace_id = e.workspace_id), 0) AS candidate_count,
              COALESCE((SELECT COUNT(*) FROM claims c
                WHERE c.extraction_run_id = e.active_run_id
                  AND c.workspace_id = e.workspace_id
                  AND c.review_status = 'pending' AND c.lifecycle_status = 'active'), 0)
                AS pending_claim_count,
              COALESCE((SELECT COUNT(*) FROM claim_occurrence_candidates occ
                WHERE occ.extraction_run_id = e.active_run_id
                  AND occ.workspace_id = e.workspace_id AND occ.status = 'pending'), 0)
                AS pending_occurrence_count
         FROM events e
         LEFT JOIN material_counts mc ON mc.event_id = e.id
         LEFT JOIN extraction_runs er
           ON er.id = e.active_run_id AND er.workspace_id = e.workspace_id
         LEFT JOIN queue_outbox eo ON eo.run_id = er.id
         LEFT JOIN transcription_runs tr ON tr.id = (
           SELECT latest.id FROM transcription_runs latest
            WHERE latest.event_id = e.id AND latest.workspace_id = e.workspace_id
            ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
         )
         LEFT JOIN transcription_queue_outbox tqo ON tqo.run_id = tr.id
         LEFT JOIN event_ai_artifact_runs sr ON sr.id = (
           SELECT latest.id FROM event_ai_artifact_runs latest
            WHERE latest.event_id = e.id AND latest.workspace_id = e.workspace_id
              AND latest.kind = 'summary'
              AND latest.extraction_run_id = e.active_run_id
            ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
         )
         LEFT JOIN event_ai_artifact_runs rr ON rr.id = (
           SELECT latest.id FROM event_ai_artifact_runs latest
            WHERE latest.event_id = e.id AND latest.workspace_id = e.workspace_id
              AND latest.kind = 'readable_transcript'
              AND latest.extraction_run_id = e.active_run_id
            ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
         )
        WHERE e.project_id = ? AND e.workspace_id = ?
        ORDER BY e.sequence_no ASC`,
    )
    .bind(scope.workspaceId, projectId, scope.workspaceId)
    .all<Row>();

  const rows = result.results ?? [];
  const events: WorkflowSnapshotRecord["events"] = rows.map((row) => {
    const pendingClaimCount = integer(row, "pending_claim_count");
    const pendingOccurrenceCount = integer(row, "pending_occurrence_count");
    const candidateCount = integer(row, "candidate_count");
    const materialStatus = String(row.material_status) as MaterialStatus;
    const extractionStatus = nullableText(row, "extraction_status");
    const extractionStage = nullableText(row, "extraction_stage") as ExtractionModelStageName | null;
    const transcriptionStatus = nullableText(row, "transcription_status");
    const materialTotal = integer(row, "material_total");
    const materialReady = integer(row, "material_ready");
    const materialProcessing = integer(row, "material_processing");
    const materialFailed = integer(row, "material_failed");
    const pendingCount = pendingClaimCount + pendingOccurrenceCount;
    const summaryRun = artifactRun(row, "summary");
    const readableTranscriptRun = artifactRun(row, "readable");
    const values = {
      materialStatus,
      materialTotal,
      materialProcessing,
      materialFailed,
      transcriptionStatus,
      extractionStatus,
      extractionStage,
      scenarioStatus: project.scenario_status,
      pendingCount,
      candidateCount,
    };
    const transcriptionRunId = nullableText(row, "transcription_run_id");
    const extractionRunId = nullableText(row, "active_run_id");
    return {
      id: String(row.id),
      title: String(row.title),
      occurred_at: String(row.occurred_at),
      sequence_no: integer(row, "sequence_no"),
      material_status: materialStatus,
      display_status: deriveProjectWorkflowDisplayStatus(values),
      status_summary: {
        material_count: materialTotal,
        material_ready_count: materialReady,
        material_processing_count: materialProcessing,
        material_failed_count: materialFailed,
        transcription_status: transcriptionStatus as TranscriptionRunStatus | null,
        extraction_status: extractionStatus as ExtractionRunStatus | null,
        pending_count: pendingCount,
        candidate_count: candidateCount,
        summary_status: summaryRun?.status ?? null,
        readable_transcript_status: readableTranscriptRun?.status ?? null,
      },
      materials: {
        total: materialTotal,
        ready: materialReady,
        processing: materialProcessing,
        failed: materialFailed,
      },
      transcription: transcriptionRunId && transcriptionStatus
        ? {
            run_id: transcriptionRunId,
            status: transcriptionStatus as TranscriptionRunStatus,
            error_code: nullableText(row, "transcription_error_code"),
            processing_attempt_no: integer(row, "transcription_attempt_no"),
            dispatch_attempt_no: integer(row, "transcription_dispatch_attempt"),
          }
        : null,
      extraction: extractionRunId && extractionStatus
        ? {
            run_id: extractionRunId,
            status: extractionStatus as ExtractionRunStatus,
            stage: extractionStage,
            error_code: nullableText(row, "extraction_error_code"),
            processing_attempt_no: integer(row, "extraction_attempt_no"),
            dispatch_attempt_no: integer(row, "extraction_dispatch_attempt"),
            created_at: String(row.extraction_created_at),
            queued_at: nullableText(row, "extraction_queued_at"),
            first_queued_at: nullableText(row, "extraction_first_queued_at"),
            current_queued_at: nullableText(row, "extraction_current_queued_at"),
            started_at: nullableText(row, "extraction_started_at"),
            first_started_at: nullableText(row, "extraction_first_started_at"),
            current_started_at: nullableText(row, "extraction_current_started_at"),
            finished_at: nullableText(row, "extraction_finished_at"),
            updated_at: String(row.extraction_updated_at),
          }
        : null,
      ai_artifacts: {
        summary: summaryRun,
        readable_transcript: readableTranscriptRun,
      },
      pending_claim_count: pendingClaimCount,
      pending_occurrence_count: pendingOccurrenceCount,
      candidate_count: candidateCount,
    };
  });

  const plan = planProjectWorkflow({
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      occurredAt: event.occurred_at,
      hasMaterial: event.materials.total > 0,
      ready: event.material_status === "ready" && event.materials.processing === 0,
      runId: event.extraction?.run_id,
      runStatus: event.extraction?.status,
      candidateCount: event.candidate_count,
      pendingCount: event.pending_claim_count + event.pending_occurrence_count,
    })),
    needsScenarioConfirmation: projectNeedsScenarioConfirmation({
      scenarioStatus: project.scenario_status,
      scenarioCandidateCount: project.scenario_candidates.length,
    }),
  });
  const currentEvent = events.find((event) => event.id === plan.currentEventId) ?? null;
  const actionByPhase = {
    empty: "add_material",
    waiting_material: currentEvent?.display_status === "needs_attention"
      ? "inspect_material"
      : "wait",
    ready: "start_analysis",
    running: "wait",
    empty_output: "inspect_material",
    waiting_scenario: "confirm_scenario",
    waiting_review: "review",
    draft_ready: "open_draft",
    partially_reviewed: "open_draft",
    complete: "open_brief",
  } as const;

  return {
    project,
    workflow: {
      phase: plan.phase,
      total: plan.total,
      completed: plan.completed,
      trust_state: plan.trustState,
      pending_total: plan.pendingTotal,
      current_position: plan.currentPosition,
      current_event_id: plan.currentEventId ?? null,
      current_run_id: plan.currentRunId ?? null,
      next_action: {
        kind: actionByPhase[plan.phase],
        event_id: plan.currentEventId ?? null,
        run_id: plan.currentRunId ?? null,
        requires_user_confirmation: plan.phase === "ready",
      },
    },
    events,
  };
}
