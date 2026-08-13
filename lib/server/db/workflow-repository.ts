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
            ORDER BY latest.created_at DESC LIMIT 1
         )
         LEFT JOIN transcription_queue_outbox tqo ON tqo.run_id = tr.id
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
    const values = {
      materialStatus,
      materialTotal: integer(row, "material_total"),
      materialProcessing: integer(row, "material_processing"),
      materialFailed: integer(row, "material_failed"),
      transcriptionStatus,
      extractionStatus,
      extractionStage,
      scenarioStatus: project.scenario_status,
      pendingCount: pendingClaimCount + pendingOccurrenceCount,
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
      materials: {
        total: values.materialTotal,
        ready: integer(row, "material_ready"),
        processing: values.materialProcessing,
        failed: values.materialFailed,
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
    complete: "open_brief",
  } as const;

  return {
    project,
    workflow: {
      phase: plan.phase,
      total: plan.total,
      completed: plan.completed,
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
