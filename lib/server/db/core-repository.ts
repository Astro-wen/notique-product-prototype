import { getBindings, getD1, getEvidenceBucket } from "@/db";
import {
  DEFAULT_AI_MAX_OUTPUT_TOKENS,
  normalizeAiTimeoutMs,
  normalizeOpenAiReasoningEffort,
  normalizeVerifierReasoningEffort,
  twoPassPipelineEnabled,
} from "@/lib/domain/model-config";
import {
  CLAIM_EXTRACTION_PROMPT_VERSION,
  CLAIM_EXTRACTION_SCHEMA_VERSION,
} from "@/lib/domain/model-contract";
import { parseTranscript } from "@/lib/domain/transcript";
import {
  DEFAULT_MAX_RUN_IMAGE_BYTES,
  isHeifLike,
  isSupportedModelImageMime,
  MAX_IMAGE_BYTES,
  MODEL_IMAGE_MIME_TYPES,
  normalizeMimeType,
} from "@/lib/domain/asset-policy";
import {
  audioMimeFor,
  MAX_AUDIO_BYTES,
  validAudioMagic,
} from "@/lib/domain/audio-transcription";
import {
  assetObjectKey,
  importObjectKey,
  sha256Hex,
} from "@/lib/server/storage/keys";
import {
  ApiFault,
  parseJson,
} from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import {
  assetRecord,
  claimRecord,
  eventRecord,
  extractionRunRecord,
  projectRecord,
  transcriptImportItemRecord,
  transcriptImportRecord,
} from "@/lib/server/db/records";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import {
  listExtractionModelStageDebug,
  listExtractionModelStageTimings,
} from "@/lib/server/db/extraction-stage-repository";
import {
  ensureEventAiArtifactRuns,
  listEventAiArtifactRunDebug,
} from "@/lib/server/db/event-ai-artifact-repository";
import type {
  AssetKind,
  AssetRecord,
  ClaimRecord,
  EventRecord,
  ExtractionRunRecord,
  OccurrenceCandidateRecord,
  ProjectDeletePreviewRecord,
  ProjectRecord,
  TranscriptImportRecord,
  VerifiedViewResponse,
  VerifiedViewType,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

type UploadSpec = {
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

type FinalizeImportItem = {
  itemId: string;
  occurredAt: string;
  title: string;
  eventType: EventRecord["event_type"];
};

const ASSET_SELECT = `
  SELECT a.*,
         av.id AS version_id,
         av.version_no,
         av.content_sha256,
         av.mime_type AS version_mime_type,
         av.size_bytes AS version_size_bytes,
         av.parser_version,
         av.r2_original_key,
         av.r2_model_key,
         av.derived_from_asset_version_id,
         av.transform_json,
         av.finalized_at
    FROM assets a
    LEFT JOIN asset_versions av ON av.id = a.current_version_id`;

const CLAIM_SELECT = `
  SELECT c.*,
         cv.version_no,
         cv.statement,
         cv.normalized_value_json,
         cv.uncertainty_json,
         cv.source AS version_source
    FROM claims c
    JOIN claim_versions cv ON cv.id = c.current_version_id`;

const PROJECT_WITH_REVIEW_COUNTS_SELECT = `
  SELECT p.*,
         COALESCE((
           SELECT COUNT(*) FROM events e
            WHERE e.project_id = p.id AND e.workspace_id = p.workspace_id
         ), 0) AS event_count,
         COALESCE((
           SELECT COUNT(*) FROM claims c
            WHERE c.project_id = p.id AND c.workspace_id = p.workspace_id
              AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
              AND EXISTS (
                SELECT 1 FROM events latest
                 WHERE latest.id = c.event_id
                   AND latest.project_id = p.id
                   AND latest.workspace_id = p.workspace_id
                   AND latest.active_run_id = c.extraction_run_id
              )
         ), 0) AS pending_claim_count,
         COALESCE((
           SELECT COUNT(*) FROM claim_occurrence_candidates occ
            WHERE occ.project_id = p.id AND occ.workspace_id = p.workspace_id
              AND occ.status = 'pending'
              AND EXISTS (
                SELECT 1 FROM events latest
                 WHERE latest.id = occ.event_id
                   AND latest.project_id = p.id
                   AND latest.workspace_id = p.workspace_id
                   AND latest.active_run_id = occ.extraction_run_id
              )
         ), 0) AS pending_occurrence_count
    FROM projects p`;

const EVENT_WITH_REVIEW_COUNTS_SELECT = `
  SELECT e.*,
         COALESCE((
           SELECT COUNT(*) FROM claims c
            WHERE c.event_id = e.id AND c.workspace_id = e.workspace_id
              AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
              AND c.extraction_run_id = e.active_run_id
         ), 0) AS pending_claim_count,
         COALESCE((
           SELECT COUNT(*) FROM claim_occurrence_candidates occ
            WHERE occ.event_id = e.id AND occ.workspace_id = e.workspace_id
              AND occ.status = 'pending'
              AND occ.extraction_run_id = e.active_run_id
         ), 0) AS pending_occurrence_count
    FROM events e`;

function now(): string {
  return new Date().toISOString();
}

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function enforceDeclaredUploadLength(
  request: Request,
  maxBytes: number,
  expectedBytes?: number,
): void {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw new ApiFault(400, "BAD_REQUEST", "Content-Length is invalid.");
  }
  if (declared > maxBytes) {
    throw new ApiFault(413, "ASSET_TOO_LARGE", "Upload exceeds its size limit.", {
      max_size_bytes: maxBytes,
      declared_size_bytes: declared,
    });
  }
  if (expectedBytes !== undefined && declared !== expectedBytes) {
    throw new ApiFault(400, "BAD_REQUEST", "Content-Length does not match initialization.", {
      expected_size_bytes: expectedBytes,
      declared_size_bytes: declared,
    });
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function first(sqlText: string, bindings: unknown[]): Promise<Row | null> {
  return (
    (await getD1().prepare(sqlText).bind(...bindings).first<Row>()) ?? null
  );
}

async function all(sqlText: string, bindings: unknown[]): Promise<Row[]> {
  const result = await getD1().prepare(sqlText).bind(...bindings).all<Row>();
  return result.results ?? [];
}

async function assertProject(scope: RequestScope, projectId: string): Promise<Row> {
  const row = await first(
    `SELECT * FROM projects
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");
  }
  return row;
}

async function assertEvent(scope: RequestScope, eventId: string): Promise<Row> {
  const row = await first(
    `SELECT e.* FROM events e
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = ? AND e.workspace_id = ? AND p.deleted_at IS NULL`,
    [eventId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  }
  return row;
}

export async function createProject(
  scope: RequestScope,
  input: {
    name: string;
    locale: string;
    profile?: "real_estate_buyer_journey";
  },
  idempotencyKey: string,
): Promise<ProjectRecord> {
  const endpointScope = "projects";
  const replay = await findMutationReplay<{ projectId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) return getProject(scope, replay.response.projectId);
  const projectId = id("prj");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      db.prepare(
      `INSERT INTO projects (
        id, workspace_id, name, scenario_status, scenario_candidates_json,
        scenario, scenario_version, scenario_confirmed_at, scenario_confirmed_by,
        locale, ledger_version, context_version,
        next_event_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, 0, 0, 1, ?, ?)`,
      ).bind(
        projectId,
        scope.workspaceId,
        input.name,
        input.profile ? "confirmed" : "unassessed",
        input.profile ?? null,
        input.profile ? 1 : 0,
        input.profile ? timestamp : null,
        input.profile ? scope.actorId : null,
        input.locale,
        timestamp,
        timestamp,
      ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { projectId },
        timestamp,
      ),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ projectId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) return getProject(scope, recovered.response.projectId);
    throw error;
  }
  return getProject(scope, projectId);
}

export async function listProjects(scope: RequestScope): Promise<ProjectRecord[]> {
  const rows = await all(
    `${PROJECT_WITH_REVIEW_COUNTS_SELECT}
      WHERE p.workspace_id = ? AND p.deleted_at IS NULL
      ORDER BY p.updated_at DESC, p.created_at DESC`,
    [scope.workspaceId],
  );
  return rows.map(projectRecord);
}

export async function getProject(
  scope: RequestScope,
  projectId: string,
): Promise<ProjectRecord> {
  const row = await first(
    `${PROJECT_WITH_REVIEW_COUNTS_SELECT}
      WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL`,
    [projectId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");
  }
  return projectRecord(row);
}

async function getDeletedProject(
  scope: RequestScope,
  projectId: string,
): Promise<ProjectRecord> {
  const row = await first(
    `${PROJECT_WITH_REVIEW_COUNTS_SELECT}
      WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NOT NULL`,
    [projectId, scope.workspaceId],
  );
  if (!row) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Deleted project was not found.");
  return projectRecord(row);
}

export async function listDeletedProjects(scope: RequestScope): Promise<ProjectRecord[]> {
  const rows = await all(
    `${PROJECT_WITH_REVIEW_COUNTS_SELECT}
      WHERE p.workspace_id = ? AND p.deleted_at IS NOT NULL
      ORDER BY p.deleted_at DESC`,
    [scope.workspaceId],
  );
  return rows.map(projectRecord);
}

export async function getProjectDeletePreview(
  scope: RequestScope,
  projectId: string,
): Promise<ProjectDeletePreviewRecord> {
  const project = await getProject(scope, projectId);
  const row = await first(
    `SELECT
       (SELECT COUNT(*) FROM assets WHERE project_id = ? AND workspace_id = ?
          AND COALESCE(json_extract(metadata_json, '$.artifact_kind'), '') <> 'readable_transcript'
          AND COALESCE(json_extract(metadata_json, '$.analysis_source'), 1) <> 0
          AND COALESCE(json_extract(metadata_json, '$.transcription_chunk'), 0) <> 1) AS material_count,
       (SELECT COUNT(*) FROM extraction_runs
         WHERE project_id = ? AND workspace_id = ? AND status IN ('queued','processing')) +
       (SELECT COUNT(*) FROM transcription_runs
         WHERE project_id = ? AND workspace_id = ? AND status IN ('queued','processing')) +
       (SELECT COUNT(*) FROM event_ai_artifact_runs
         WHERE project_id = ? AND workspace_id = ? AND status IN ('queued','processing')) AS active_job_count`,
    [
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
    ],
  );
  const activeJobCount = Number(row?.active_job_count ?? 0);
  return {
    project_id: project.id,
    project_name: project.name,
    event_count: project.event_count,
    material_count: Number(row?.material_count ?? 0),
    pending_count: project.pending_claim_count + project.pending_occurrence_count,
    active_job_count: activeJobCount,
    can_delete: activeJobCount === 0,
  };
}

export async function moveProjectToTrash(
  scope: RequestScope,
  projectId: string,
  idempotencyKey: string,
): Promise<ProjectRecord> {
  const endpointScope = `projects/${projectId}/trash`;
  const replay = await findMutationReplay<{ projectId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    {},
  );
  if (replay.response) return getDeletedProject(scope, replay.response.projectId);
  const preview = await getProjectDeletePreview(scope, projectId);
  if (!preview.can_delete) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "Wait for transcription and analysis to finish before deleting this project.", {
      active_job_count: preview.active_job_count,
    });
  }
  const timestamp = now();
  const guardId = id("guard");
  await getD1().batch([
    getD1().prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM projects p
          WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM extraction_runs WHERE project_id = p.id AND status IN ('queued','processing'))
            AND NOT EXISTS (SELECT 1 FROM transcription_runs WHERE project_id = p.id AND status IN ('queued','processing'))
            AND NOT EXISTS (SELECT 1 FROM event_ai_artifact_runs WHERE project_id = p.id AND status IN ('queued','processing'))
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, projectId, scope.workspaceId, timestamp),
    getD1().prepare(
      `UPDATE projects SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM extraction_runs WHERE project_id = ? AND status IN ('queued','processing'))
          AND NOT EXISTS (SELECT 1 FROM transcription_runs WHERE project_id = ? AND status IN ('queued','processing'))
          AND NOT EXISTS (SELECT 1 FROM event_ai_artifact_runs WHERE project_id = ? AND status IN ('queued','processing'))`,
    ).bind(timestamp, timestamp, projectId, scope.workspaceId, projectId, projectId, projectId),
    mutationReplayStatement(scope, endpointScope, idempotencyKey, replay.requestHash, { projectId }, timestamp),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  ]);
  return getDeletedProject(scope, projectId);
}

export async function restoreProject(
  scope: RequestScope,
  projectId: string,
  idempotencyKey: string,
): Promise<ProjectRecord> {
  const endpointScope = `projects/${projectId}/restore`;
  const replay = await findMutationReplay<{ projectId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    {},
  );
  if (replay.response) return getProject(scope, replay.response.projectId);
  await getDeletedProject(scope, projectId);
  const timestamp = now();
  const guardId = id("guard");
  const purgeLockId = `project-purge:${projectId}`;
  try {
    await getD1().batch([
      getD1().prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM mutation_guards WHERE id = ?)
         ) THEN 1 ELSE 0 END, ?`,
      ).bind(guardId, projectId, scope.workspaceId, purgeLockId, timestamp),
      getD1().prepare(
        `UPDATE projects SET deleted_at = NULL, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM mutation_guards WHERE id = ?)`,
      ).bind(timestamp, projectId, scope.workspaceId, purgeLockId),
      mutationReplayStatement(scope, endpointScope, idempotencyKey, replay.requestHash, { projectId }, timestamp),
      getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    const purgeLocked = await first(`SELECT id FROM mutation_guards WHERE id = ?`, [purgeLockId]);
    if (purgeLocked) {
      throw new ApiFault(409, "RUN_STATE_CONFLICT", "Permanent deletion is in progress or needs to be retried before this project can be restored.");
    }
    throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", "Project state changed. Refresh the recycle bin before restoring it.");
  }
  return getProject(scope, projectId);
}

export async function permanentlyDeleteProject(
  scope: RequestScope,
  projectId: string,
  confirmName: string,
  idempotencyKey: string,
): Promise<{ projectId: string; permanentlyDeleted: true }> {
  const endpointScope = `projects/${projectId}/permanent`;
  const input = { confirmName };
  const replay = await findMutationReplay<{ projectId: string; permanentlyDeleted: true }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) return replay.response;
  const project = await getDeletedProject(scope, projectId);
  if (confirmName !== project.name) {
    throw new ApiFault(400, "BAD_REQUEST", "Project name confirmation does not match.", { field: "confirm_name" });
  }
  const purgeLockId = `project-purge:${projectId}`;
  const timestamp = now();
  await getD1()
    .prepare(
      `INSERT OR IGNORE INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, 1, ? WHERE EXISTS (
         SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL
       )`,
    )
    .bind(purgeLockId, timestamp, projectId, scope.workspaceId)
    .run();
  const purgeLock = await first(
    `SELECT id FROM mutation_guards WHERE id = ?`,
    [purgeLockId],
  );
  if (!purgeLock) {
    throw new ApiFault(409, "RUN_STATE_CONFLICT", "Project deletion could not be locked. Refresh the recycle bin and retry.");
  }
  const keyRows = await all(
    `SELECT key FROM (
       SELECT av.r2_original_key AS key FROM asset_versions av
         JOIN assets a ON a.id = av.asset_id WHERE a.project_id = ? AND a.workspace_id = ?
       UNION SELECT av.r2_model_key AS key FROM asset_versions av
         JOIN assets a ON a.id = av.asset_id WHERE a.project_id = ? AND a.workspace_id = ?
       UNION SELECT a.staged_r2_key AS key FROM assets a WHERE a.project_id = ? AND a.workspace_id = ?
       UNION SELECT tii.r2_key AS key FROM transcript_import_items tii
         JOIN transcript_imports ti ON ti.id = tii.import_id WHERE ti.project_id = ? AND ti.workspace_id = ?
       UNION SELECT tr.staged_result_r2_key AS key FROM transcription_runs tr
         WHERE tr.project_id = ? AND tr.workspace_id = ?
     ) WHERE key IS NOT NULL`,
    [
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
      projectId, scope.workspaceId,
    ],
  );
  try {
    await Promise.all(keyRows.map((row) => getEvidenceBucket().delete(String(row.key))));
  } catch {
    throw new ApiFault(503, "R2_BINDING_UNAVAILABLE", "Stored project files could not be fully deleted. The project remains locked in the recycle bin so permanent deletion can be retried safely.");
  }
  const response = { projectId, permanentlyDeleted: true as const };
  const guardId = id("guard");
  await getD1().batch([
    getD1().prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM mutation_guards WHERE id = ?)
       ) THEN 1 ELSE 0 END, ?`,
    ).bind(guardId, projectId, scope.workspaceId, purgeLockId, timestamp),
    getD1().prepare(
      `DELETE FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NOT NULL`,
    ).bind(projectId, scope.workspaceId),
    mutationReplayStatement(scope, endpointScope, idempotencyKey, replay.requestHash, response, timestamp),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(purgeLockId),
  ]);
  return response;
}

export async function confirmScenario(
  scope: RequestScope,
  projectId: string,
  input: { scenarioVersion: number; scenario: string; source: "candidate" | "manual" },
  idempotencyKey: string,
): Promise<ProjectRecord> {
  const endpointScope = `projects/${projectId}/scenario-verdict`;
  const replay = await findMutationReplay<{ projectId: string; verdictId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) return getProject(scope, replay.response.projectId);
  const existing = await assertProject(scope, projectId);
  if (String(existing.scenario_status) !== "pending_confirmation") {
    throw new ApiFault(
      409,
      "SCENARIO_VERSION_CONFLICT",
      "Scenario assessment is not awaiting confirmation. Refresh the project before continuing.",
      { scenario_status: existing.scenario_status },
    );
  }
  const verdictId = id("scv");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM projects
              WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
                AND scenario_status = 'pending_confirmation'
                AND scenario_version = ?
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(
          guardId,
          projectId,
          scope.workspaceId,
          input.scenarioVersion,
          timestamp,
        ),
      db
        .prepare(
          `UPDATE projects
              SET scenario = ?, scenario_status = 'confirmed',
                  scenario_version = scenario_version + 1,
                  context_version = context_version + 1,
                  scenario_confirmed_by = ?, scenario_confirmed_at = ?,
                  scenario_lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND workspace_id = ?
              AND scenario_status = 'pending_confirmation'
              AND scenario_version = ?`,
        )
        .bind(
          input.scenario,
          scope.actorId,
          timestamp,
          timestamp,
          projectId,
          scope.workspaceId,
          input.scenarioVersion,
        ),
      db
        .prepare(
          `INSERT INTO scenario_verdicts
           (id, project_id, scenario_version, scenario, source, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          verdictId,
          projectId,
          input.scenarioVersion + 1,
          input.scenario,
          input.source,
          scope.actorId,
          timestamp,
        ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { projectId, verdictId },
        timestamp,
      ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<{ projectId: string; verdictId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) return getProject(scope, recovered.response.projectId);
    throw new ApiFault(
      409,
      "SCENARIO_VERSION_CONFLICT",
      "Scenario changed. Refresh before confirming it.",
    );
  }
  return getProject(scope, projectId);
}

export async function createEvent(
  scope: RequestScope,
  projectId: string,
  input: {
    eventType: EventRecord["event_type"];
    title: string;
    occurredAt: string;
    metadata: Record<string, unknown>;
  },
  idempotencyKey: string,
): Promise<EventRecord> {
  const endpointScope = `projects/${projectId}/events`;
  const replay = await findMutationReplay<{ eventId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) {
    return getEvent(scope, replay.response.eventId).then((value) => value.event);
  }
  await assertProject(scope, projectId);
  const eventId = id("evt");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
    db
      .prepare(
        `UPDATE projects
            SET next_event_sequence = next_event_sequence + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .bind(timestamp, projectId, scope.workspaceId),
    db
      .prepare(
        `INSERT INTO events (
          id, workspace_id, project_id, event_type, title, occurred_at,
          sequence_no, material_status, metadata_json, created_at, updated_at
        )
        SELECT ?, ?, id, ?, ?, ?, next_event_sequence - 1,
               'draft', ?, ?, ?
          FROM projects
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .bind(
        eventId,
        scope.workspaceId,
        input.eventType,
        input.title,
        input.occurredAt,
        JSON.stringify(input.metadata),
        timestamp,
        timestamp,
        projectId,
        scope.workspaceId,
      ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { eventId },
        timestamp,
      ),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ eventId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) {
      return getEvent(scope, recovered.response.eventId).then((value) => value.event);
    }
    throw error;
  }
  return getEvent(scope, eventId).then((value) => value.event);
}

export async function listEvents(
  scope: RequestScope,
  projectId: string,
): Promise<EventRecord[]> {
  await assertProject(scope, projectId);
  const rows = await all(
    `${EVENT_WITH_REVIEW_COUNTS_SELECT}
      WHERE e.project_id = ? AND e.workspace_id = ?
      ORDER BY e.sequence_no ASC`,
    [projectId, scope.workspaceId],
  );
  return rows.map(eventRecord);
}

export async function getEvent(
  scope: RequestScope,
  eventId: string,
): Promise<{ event: EventRecord; assets: AssetRecord[] }> {
  const event = await first(
    `${EVENT_WITH_REVIEW_COUNTS_SELECT}
      JOIN projects p ON p.id = e.project_id
     WHERE e.id = ? AND e.workspace_id = ? AND p.deleted_at IS NULL`,
    [eventId, scope.workspaceId],
  );
  if (!event) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Event was not found.");
  }
  const rows = await all(
    `${ASSET_SELECT}
      WHERE a.event_id = ? AND a.workspace_id = ?
      ORDER BY a.created_at ASC`,
    [eventId, scope.workspaceId],
  );
  return { event: eventRecord(event), assets: rows.map(assetRecord) };
}

export async function createTranscriptImport(
  scope: RequestScope,
  projectId: string,
  files: UploadSpec[],
  idempotencyKey: string,
): Promise<TranscriptImportRecord> {
  const endpointScope = `projects/${projectId}/transcript-imports`;
  const replay = await findMutationReplay<{ importId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    { files },
  );
  if (replay.response) return getTranscriptImport(scope, replay.response.importId);
  await assertProject(scope, projectId);
  const importId = id("timp");
  const timestamp = now();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const db = getD1();
  const statements = [
    db
      .prepare(
        `INSERT INTO transcript_imports
         (id, workspace_id, project_id, status, item_count, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .bind(
        importId,
        scope.workspaceId,
        projectId,
        files.length,
        expiresAt,
        timestamp,
        timestamp,
      ),
    ...files.map((file) =>
      db
        .prepare(
          `INSERT INTO transcript_import_items
           (id, import_id, filename, mime_type, size_bytes, upload_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(
          id("titem"),
          importId,
          file.filename,
          file.mimeType,
          file.sizeBytes,
          timestamp,
          timestamp,
        ),
    ),
    mutationReplayStatement(
      scope,
      endpointScope,
      idempotencyKey,
      replay.requestHash,
      { importId },
      timestamp,
    ),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const recovered = await findMutationReplay<{ importId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      { files },
    );
    if (recovered.response) return getTranscriptImport(scope, recovered.response.importId);
    throw error;
  }
  return getTranscriptImport(scope, importId);
}

export async function getTranscriptImport(
  scope: RequestScope,
  importId: string,
): Promise<TranscriptImportRecord> {
  const row = await first(
    `SELECT ti.* FROM transcript_imports ti
      JOIN projects p ON p.id = ti.project_id
     WHERE ti.id = ? AND ti.workspace_id = ? AND p.deleted_at IS NULL`,
    [importId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Transcript import was not found.");
  }
  const items = await all(
    `SELECT * FROM transcript_import_items WHERE import_id = ? ORDER BY created_at ASC`,
    [importId],
  );
  return transcriptImportRecord(row, items.map(transcriptImportItemRecord));
}

function transcriptMimeAllowed(mimeType: string, filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    ["text/plain", "text/vtt", "application/json", "application/x-subrip"].includes(
      mimeType,
    ) || /\.(txt|vtt|srt|json)$/.test(lower)
  );
}

export async function uploadTranscriptImportItem(
  scope: RequestScope,
  importId: string,
  itemId: string,
  request: Request,
): Promise<TranscriptImportRecord> {
  const row = await first(
    `SELECT ti.project_id, ti.status, ti.expires_at,
            item.filename, item.mime_type, item.size_bytes,
            item.upload_status, item.r2_key, item.content_sha256,
            item.uploaded_size_bytes
       FROM transcript_import_items item
       JOIN transcript_imports ti ON ti.id = item.import_id
      WHERE item.id = ? AND item.import_id = ? AND ti.workspace_id = ?`,
    [itemId, importId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Import item was not found.");
  }
  if (!new Set(["open", "finalized"]).has(String(row.status))) {
    throw new ApiFault(409, "BAD_REQUEST", "Transcript import is no longer open.");
  }
  const filename = String(row.filename);
  const mimeType = request.headers.get("content-type")?.split(";")[0] || String(row.mime_type);
  if (!transcriptMimeAllowed(mimeType, filename)) {
    throw new ApiFault(
      415,
      "ASSET_UNSUPPORTED_FORMAT",
      "Transcript must be TXT, VTT, SRT, or JSON.",
      { filename, mime_type: mimeType },
    );
  }
  const expectedSize = Number(row.size_bytes);
  if (expectedSize > 5 * 1024 * 1024) {
    throw new ApiFault(413, "ASSET_TOO_LARGE", "Transcript exceeds the 5 MB limit.");
  }
  enforceDeclaredUploadLength(request, 5 * 1024 * 1024, expectedSize);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) {
    throw new ApiFault(413, "ASSET_TOO_LARGE", "Transcript is empty or exceeds 5 MB.");
  }
  if (bytes.byteLength !== expectedSize) {
    throw new ApiFault(400, "BAD_REQUEST", "Uploaded size does not match the initialized file.", {
      expected_size_bytes: expectedSize,
      uploaded_size_bytes: bytes.byteLength,
    });
  }
  const sha = await sha256Hex(bytes);
  const key = importObjectKey({
    workspaceId: scope.workspaceId,
    projectId: String(row.project_id),
    importId,
    itemId,
    sha256: sha,
  });
  if (String(row.upload_status) !== "pending") {
    if (
      (row.upload_status === "uploaded" || row.upload_status === "finalized") &&
      row.r2_key === key &&
      row.content_sha256 === sha &&
      Number(row.uploaded_size_bytes) === bytes.byteLength
    ) {
      return getTranscriptImport(scope, importId);
    }
    throw new ApiFault(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Transcript item was already uploaded with different content.",
    );
  }
  if (String(row.status) !== "open" || Date.parse(String(row.expires_at)) <= Date.now()) {
    throw new ApiFault(409, "BAD_REQUEST", "Transcript import is no longer open.");
  }
  await getEvidenceBucket().put(key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { sha256: sha },
  });
  const timestamp = now();
  const updated = await getD1()
    .prepare(
      `UPDATE transcript_import_items
          SET upload_status = 'uploaded', r2_key = ?, content_sha256 = ?,
              uploaded_size_bytes = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND import_id = ? AND upload_status = 'pending'
          AND EXISTS (
            SELECT 1 FROM transcript_imports ti
             WHERE ti.id = transcript_import_items.import_id
               AND ti.workspace_id = ? AND ti.status = 'open'
               AND ti.expires_at > ?
          )`,
    )
    .bind(
      key,
      sha,
      bytes.byteLength,
      timestamp,
      itemId,
      importId,
      scope.workspaceId,
      timestamp,
    )
    .run();
  if (Number(updated.meta.changes ?? 0) === 0) {
    const current = await first(
      `SELECT item.upload_status, item.r2_key, item.content_sha256,
              item.uploaded_size_bytes, ti.status AS import_status
         FROM transcript_import_items item
         JOIN transcript_imports ti ON ti.id = item.import_id
        WHERE item.id = ? AND item.import_id = ? AND ti.workspace_id = ?`,
      [itemId, importId, scope.workspaceId],
    );
    if (
      (current?.upload_status === "uploaded" || current?.upload_status === "finalized") &&
      current.r2_key === key &&
      current.content_sha256 === sha &&
      Number(current.uploaded_size_bytes) === bytes.byteLength
    ) {
      return getTranscriptImport(scope, importId);
    }
    const referenced = await first(
      `SELECT 1 AS referenced
         FROM transcript_import_items
        WHERE r2_key = ?
        UNION ALL
       SELECT 1 AS referenced
         FROM asset_versions
        WHERE r2_original_key = ?
        LIMIT 1`,
      [key, key],
    );
    if (!referenced) {
      await getEvidenceBucket().delete(key).catch(() => undefined);
    }
    throw new ApiFault(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Transcript item was already uploaded, finalized, or expired with different content.",
      { import_status: current?.import_status ?? null },
    );
  }
  return getTranscriptImport(scope, importId);
}

function transcriptFormat(filename: string, mimeType: string) {
  const extension = filename.toLowerCase().split(".").at(-1);
  if (extension === "vtt" || mimeType === "text/vtt") return "vtt" as const;
  if (extension === "srt" || mimeType === "application/x-subrip") return "srt" as const;
  if (extension === "json" || mimeType === "application/json") return "json" as const;
  return "txt" as const;
}

export async function finalizeTranscriptImport(
  scope: RequestScope,
  importId: string,
  ordered: FinalizeImportItem[],
): Promise<{ transcriptImport: TranscriptImportRecord; events: EventRecord[] }> {
  const transcriptImport = await getTranscriptImport(scope, importId);
  if (transcriptImport.status !== "open") {
    if (transcriptImport.status === "finalized") {
      const events = await all(
        `SELECT e.* FROM events e
          JOIN assets a ON a.event_id = e.id
          JOIN asset_versions av ON av.id = a.current_version_id
         WHERE json_extract(e.metadata_json, '$.transcript_import_id') = ?
           AND e.workspace_id = ?
         GROUP BY e.id ORDER BY e.sequence_no`,
        [importId, scope.workspaceId],
      );
      return { transcriptImport, events: events.map(eventRecord) };
    }
    throw new ApiFault(409, "BAD_REQUEST", "Transcript import is not open.");
  }
  if (Date.parse(transcriptImport.expires_at) <= Date.now()) {
    throw new ApiFault(409, "BAD_REQUEST", "Transcript import has expired.");
  }
  const expected = new Set(transcriptImport.items.map((item) => item.id));
  const actual = new Set(ordered.map((item) => item.itemId));
  if (
    ordered.length !== expected.size ||
    actual.size !== expected.size ||
    [...expected].some((itemId) => !actual.has(itemId))
  ) {
    throw new ApiFault(400, "BAD_REQUEST", "ordered_items must contain every import item once.");
  }
  const notUploaded = transcriptImport.items.filter(
    (item) => item.upload_status !== "uploaded",
  );
  if (notUploaded.length) {
    throw new ApiFault(409, "EVENT_NOT_READY", "Every transcript must finish uploading.", {
      items: notUploaded.map((item) => ({
        item_id: item.id,
        status: item.upload_status,
        error_code: item.error_code,
      })),
    });
  }

  const importRows = await all(
    `SELECT * FROM transcript_import_items WHERE import_id = ?`,
    [importId],
  );
  const byId = new Map(importRows.map((row) => [String(row.id), row]));
  const timestamp = now();
  const prepared = [] as Array<{
    eventId: string;
    assetId: string;
    assetVersionId: string;
    itemId: string;
    originalKey: string;
    parserVersion: string;
    segmentsJson: string;
  }>;
  const bucket = getEvidenceBucket();

  for (const item of ordered) {
    const row = byId.get(item.itemId);
    if (!row || !row.r2_key || !row.content_sha256) {
      throw new ApiFault(409, "EVENT_NOT_READY", "An import item has no stored content.", {
        item_id: item.itemId,
      });
    }
    const object = await bucket.get(String(row.r2_key));
    if (!object) {
      throw new ApiFault(409, "EVENT_NOT_READY", "Stored transcript content is missing.", {
        item_id: item.itemId,
      });
    }
    const content = await object.text();
    const eventId = id("evt");
    const assetId = id("ast");
    const assetVersionId = id("av");
    let segments;
    try {
      segments = parseTranscript({
        assetVersionId,
        eventId,
        filename: String(row.filename),
        content,
        format: transcriptFormat(String(row.filename), String(row.mime_type)),
      });
    } catch (error) {
      throw new ApiFault(
        422,
        "TRANSCRIPT_PARSE_FAILED",
        error instanceof Error ? error.message : "Transcript could not be parsed.",
        { item_id: item.itemId, filename: row.filename },
      );
    }
    const originalKey = assetObjectKey({
      workspaceId: scope.workspaceId,
      projectId: transcriptImport.project_id,
      eventId,
      assetId,
      sha256: String(row.content_sha256),
    });
    await bucket.put(originalKey, content, {
      httpMetadata: { contentType: String(row.mime_type) },
      customMetadata: { sha256: String(row.content_sha256) },
    });
    prepared.push({
      eventId,
      assetId,
      assetVersionId,
      itemId: item.itemId,
      originalKey,
      parserVersion: segments[0].parserVersion,
      segmentsJson: JSON.stringify(segments),
    });
  }

  const db = getD1();
  const guardId = id("guard");
  const statements = [
    db
      .prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM transcript_imports ti
            WHERE ti.id = ? AND ti.workspace_id = ? AND ti.status = 'open'
              AND ti.expires_at > ? AND ti.item_count = ?
              AND ti.item_count = (
                SELECT COUNT(*) FROM transcript_import_items item
                 WHERE item.import_id = ti.id AND item.upload_status = 'uploaded'
              )
         ) THEN 1 ELSE 0 END, ?`,
      )
      .bind(
        guardId,
        importId,
        scope.workspaceId,
        timestamp,
        prepared.length,
        timestamp,
      ),
    db
      .prepare(
        `UPDATE projects
            SET next_event_sequence = next_event_sequence + ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .bind(prepared.length, timestamp, transcriptImport.project_id, scope.workspaceId),
  ];
  ordered.forEach((item, index) => {
    const row = byId.get(item.itemId)!;
    const value = prepared[index];
    statements.push(
      db
        .prepare(
          `INSERT INTO events (
            id, workspace_id, project_id, event_type, title, occurred_at,
            sequence_no, material_status, metadata_json, created_at, updated_at
          )
          SELECT ?, ?, id, ?, ?, ?, next_event_sequence - ? + ?,
                 'ready', ?, ?, ?
            FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
        )
        .bind(
          value.eventId,
          scope.workspaceId,
          item.eventType,
          item.title,
          item.occurredAt,
          prepared.length,
          index,
          JSON.stringify({ transcript_import_id: importId, import_item_id: item.itemId }),
          timestamp,
          timestamp,
          transcriptImport.project_id,
          scope.workspaceId,
        ),
      db
        .prepare(
          `INSERT INTO assets (
            id, workspace_id, project_id, event_id, kind, filename,
            current_version_id, metadata_json, processing_status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'transcript', ?, ?, '{}', 'ready', ?, ?)`,
        )
        .bind(
          value.assetId,
          scope.workspaceId,
          transcriptImport.project_id,
          value.eventId,
          row.filename,
          value.assetVersionId,
          timestamp,
          timestamp,
        ),
      db
        .prepare(
          `INSERT INTO asset_versions (
            id, asset_id, version_no, content_sha256, mime_type, size_bytes,
            parser_version, r2_original_key, finalized_at, created_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          value.assetVersionId,
          value.assetId,
          row.content_sha256,
          row.mime_type,
          row.uploaded_size_bytes,
          value.parserVersion,
          value.originalKey,
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
          SELECT
            json_extract(value, '$.id'), ?, ?, ?, ?, ?,
            json_extract(value, '$.ordinal'),
            json_extract(value, '$.speaker'),
            json_extract(value, '$.startMs'),
            json_extract(value, '$.endMs'),
            json_extract(value, '$.parserVersion'),
            json_extract(value, '$.textRaw'),
            json_extract(value, '$.textNormalized'), ?
          FROM json_each(?)`,
        )
        .bind(
          scope.workspaceId,
          transcriptImport.project_id,
          value.eventId,
          value.assetId,
          value.assetVersionId,
          timestamp,
          value.segmentsJson,
        ),
      db
        .prepare(
          `UPDATE transcript_import_items
              SET upload_status = 'finalized', event_id = ?, asset_id = ?, updated_at = ?
            WHERE id = ? AND import_id = ? AND upload_status = 'uploaded'`,
        )
        .bind(value.eventId, value.assetId, timestamp, item.itemId, importId),
    );
  });
  statements.push(
    db
      .prepare(
        `UPDATE transcript_imports
            SET status = 'finalized', finalized_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'open'`,
      )
      .bind(timestamp, timestamp, importId, scope.workspaceId),
    db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const current = await getTranscriptImport(scope, importId);
    if (current.status === "finalized") {
      await Promise.all(
        prepared.map((value) => bucket.delete(value.originalKey).catch(() => undefined)),
      );
      const events = await all(
        `SELECT e.* FROM events e
          JOIN transcript_import_items item ON item.event_id = e.id
         WHERE item.import_id = ? AND e.workspace_id = ?
         ORDER BY e.sequence_no`,
        [importId, scope.workspaceId],
      );
      return { transcriptImport: current, events: events.map(eventRecord) };
    }
    throw error;
  }

  return {
    transcriptImport: await getTranscriptImport(scope, importId),
    events: await listEvents(scope, transcriptImport.project_id).then((events) =>
      events.filter((event) => prepared.some((value) => value.eventId === event.id)),
    ),
  };
}

export async function initializeAsset(
  scope: RequestScope,
  eventId: string,
  input: {
    kind: AssetKind;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    capturedAt?: string;
    metadata: Record<string, unknown>;
  },
  idempotencyKey: string,
): Promise<AssetRecord> {
  const mimeType = input.kind === "audio"
    ? audioMimeFor(input.filename, input.mimeType) ?? normalizeMimeType(input.mimeType)
    : normalizeMimeType(input.mimeType);
  if (
    isHeifLike(input.filename, mimeType) ||
    !allowedMime(input.kind, mimeType)
  ) {
    throw unsupportedAssetFormat(
      isHeifLike(input.filename, mimeType) ? "photo" : input.kind,
      input.filename,
      mimeType,
    );
  }
  const maxBytes = maxAssetBytes(input.kind);
  if (input.sizeBytes > maxBytes) {
    throw new ApiFault(413, "ASSET_TOO_LARGE", "Asset exceeds its per-file size limit.", {
      kind: input.kind,
      filename: input.filename,
      max_size_bytes: maxBytes,
      size_bytes: input.sizeBytes,
    });
  }
  const validatedInput = { ...input, mimeType };
  const endpointScope = `events/${eventId}/assets/init`;
  const replay = await findMutationReplay<{ assetId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    validatedInput,
  );
  if (replay.response) return getAsset(scope, replay.response.assetId);
  const event = await assertEvent(scope, eventId);
  const assetId = id("ast");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      db.prepare(
      `INSERT INTO assets (
        id, workspace_id, project_id, event_id, kind, filename, captured_at,
        metadata_json, processing_status, staged_mime_type, staged_size_bytes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?)`,
      ).bind(
      assetId,
      scope.workspaceId,
      event.project_id,
      eventId,
      validatedInput.kind,
      validatedInput.filename,
      validatedInput.capturedAt ?? null,
      JSON.stringify(validatedInput.metadata),
      validatedInput.mimeType,
      validatedInput.sizeBytes,
      timestamp,
      timestamp,
      ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { assetId },
        timestamp,
      ),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ assetId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      validatedInput,
    );
    if (recovered.response) return getAsset(scope, recovered.response.assetId);
    throw error;
  }
  return getAsset(scope, assetId);
}

function maxAssetBytes(kind: AssetKind): number {
  if (kind === "photo") return MAX_IMAGE_BYTES;
  if (kind === "pdf") return 10 * 1024 * 1024;
  if (kind === "transcript") return 5 * 1024 * 1024;
  if (kind === "audio") {
    return Math.min(
      configuredPositiveInteger(getBindings().MAX_AUDIO_BYTES, MAX_AUDIO_BYTES),
      MAX_AUDIO_BYTES,
    );
  }
  return 1024 * 1024;
}

function allowedMime(kind: AssetKind, mime: string): boolean {
  const normalized = normalizeMimeType(mime);
  const map: Record<AssetKind, string[]> = {
    transcript: ["text/plain", "text/vtt", "application/json", "application/x-subrip"],
    photo: [...MODEL_IMAGE_MIME_TYPES],
    pdf: ["application/pdf"],
    text: ["text/plain"],
    audio: [
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/x-m4a",
      "audio/wav",
      "audio/x-wav",
      "audio/webm",
      "video/mp4",
    ],
  };
  return kind === "photo"
    ? isSupportedModelImageMime(normalized)
    : map[kind].includes(normalized);
}

function unsupportedAssetFormat(
  kind: AssetKind,
  filename: string,
  mimeType: string,
): ApiFault {
  const photoMessage =
    "Photos must be JPEG, PNG, or WebP. HEIC/HEIF conversion is not available in this POC.";
  const audioMessage =
    "Audio must be MP3, MP4, MPEG, MPGA, M4A, WAV, or WebM and no larger than 100 MB.";
  return new ApiFault(
    415,
    "ASSET_UNSUPPORTED_FORMAT",
    kind === "photo"
      ? photoMessage
      : kind === "audio"
        ? audioMessage
        : "Asset format is unsupported.",
    {
      kind,
      filename,
      mime_type: mimeType,
      ...(kind === "photo" ? { accepted_mime_types: [...MODEL_IMAGE_MIME_TYPES] } : {}),
    },
  );
}

function validMagic(kind: AssetKind, mime: string, bytes: Uint8Array): boolean {
  if (kind === "transcript" || kind === "text") return true;
  if (kind === "audio") return validAudioMagic(mime, bytes);
  if (mime === "application/pdf") {
    return String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  }
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mime === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47].every((value, index) => bytes[index] === value);
  }
  if (mime === "image/webp") {
    return (
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    );
  }
  return false;
}

export async function uploadAssetContent(
  scope: RequestScope,
  assetId: string,
  request: Request,
): Promise<AssetRecord> {
  const row = await first(
    `SELECT * FROM assets WHERE id = ? AND workspace_id = ?`,
    [assetId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Asset was not found.");
  }
  if (row.current_version_id) {
    throw new ApiFault(409, "BAD_REQUEST", "Finalized asset content is immutable.");
  }
  const kind = String(row.kind) as AssetKind;
  const mime = normalizeMimeType(
    request.headers.get("content-type") || String(row.staged_mime_type),
  );
  if (
    isHeifLike(String(row.filename), mime) ||
    !allowedMime(kind, mime)
  ) {
    throw unsupportedAssetFormat(
      isHeifLike(String(row.filename), mime) ? "photo" : kind,
      String(row.filename),
      mime,
    );
  }
  const max = maxAssetBytes(kind);
  enforceDeclaredUploadLength(request, max, Number(row.staged_size_bytes));
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > max) {
    throw new ApiFault(413, "ASSET_TOO_LARGE", "Asset is empty or exceeds its size limit.", {
      max_size_bytes: max,
      size_bytes: bytes.byteLength,
    });
  }
  if (Number(row.staged_size_bytes) !== bytes.byteLength) {
    throw new ApiFault(400, "BAD_REQUEST", "Uploaded size does not match asset initialization.");
  }
  if (!validMagic(kind, mime, new Uint8Array(bytes))) {
    throw new ApiFault(415, "ASSET_UNSUPPORTED_FORMAT", "File content does not match MIME type.");
  }
  const sha = await sha256Hex(bytes);
  const key = assetObjectKey({
    workspaceId: scope.workspaceId,
    projectId: String(row.project_id),
    eventId: String(row.event_id),
    assetId,
    sha256: sha,
  });
  await getEvidenceBucket().put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { sha256: sha },
  });
  const updated = await getD1()
    .prepare(
      `UPDATE assets
          SET staged_r2_key = ?, staged_sha256 = ?, staged_mime_type = ?,
              staged_size_bytes = ?, processing_status = 'parsing', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND current_version_id IS NULL
          AND staged_r2_key IS NULL`,
    )
    .bind(key, sha, mime, bytes.byteLength, now(), assetId, scope.workspaceId)
    .run();
  if (Number(updated.meta.changes ?? 0) === 0) {
    const current = await first(
      `SELECT * FROM assets WHERE id = ? AND workspace_id = ?`,
      [assetId, scope.workspaceId],
    );
    if (current?.staged_r2_key === key || current?.current_version_id) {
      return getAsset(scope, assetId);
    }
    if (current?.staged_r2_key !== key) {
      await getEvidenceBucket().delete(key).catch(() => undefined);
    }
    throw new ApiFault(409, "BAD_REQUEST", "Asset upload was already completed by another request.");
  }
  return getAsset(scope, assetId);
}

export async function finalizeAsset(
  scope: RequestScope,
  assetId: string,
): Promise<AssetRecord> {
  const row = await first(
    `SELECT * FROM assets WHERE id = ? AND workspace_id = ?`,
    [assetId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Asset was not found.");
  }
  if (row.current_version_id) return getAsset(scope, assetId);
  if (!row.staged_r2_key || !row.staged_sha256 || !row.staged_mime_type) {
    throw new ApiFault(409, "EVENT_NOT_READY", "Asset content has not been uploaded.");
  }
  const object = await getEvidenceBucket().get(String(row.staged_r2_key));
  if (!object) {
    throw new ApiFault(409, "EVENT_NOT_READY", "Stored asset content is missing.");
  }
  const versionId = id("av");
  const timestamp = now();
  const kind = String(row.kind) as AssetKind;
  const db = getD1();
  const statements = [
    db
      .prepare(
        `INSERT INTO asset_versions (
          id, asset_id, version_no, content_sha256, mime_type, size_bytes,
          parser_version, r2_original_key, finalized_at, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        versionId,
        assetId,
        row.staged_sha256,
        row.staged_mime_type,
        row.staged_size_bytes,
        kind === "transcript" || kind === "text" ? "transcript-parser.v1" : null,
        row.staged_r2_key,
        timestamp,
        timestamp,
      ),
  ];
  if (kind === "transcript" || kind === "text") {
    let segments;
    try {
      const content = await object.text();
      segments = parseTranscript({
        assetVersionId: versionId,
        eventId: String(row.event_id),
        filename: String(row.filename),
        content,
        format: transcriptFormat(String(row.filename), String(row.staged_mime_type)),
      });
    } catch (error) {
      await getD1()
        .prepare(
          `UPDATE assets SET processing_status = 'failed', failure_code = 'TRANSCRIPT_PARSE_FAILED',
                             updated_at = ? WHERE id = ? AND workspace_id = ?`,
        )
        .bind(timestamp, assetId, scope.workspaceId)
        .run();
      throw new ApiFault(
        422,
        "TRANSCRIPT_PARSE_FAILED",
        error instanceof Error ? error.message : "Transcript could not be parsed.",
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO text_segments (
            id, workspace_id, project_id, event_id, asset_id, asset_version_id,
            ordinal, speaker, start_ms, end_ms, parser_version,
            text_raw, text_normalized, created_at
          )
          SELECT
            json_extract(value, '$.id'), ?, ?, ?, ?, ?,
            json_extract(value, '$.ordinal'), json_extract(value, '$.speaker'),
            json_extract(value, '$.startMs'), json_extract(value, '$.endMs'),
            json_extract(value, '$.parserVersion'), json_extract(value, '$.textRaw'),
            json_extract(value, '$.textNormalized'), ?
          FROM json_each(?)`,
        )
        .bind(
          scope.workspaceId,
          row.project_id,
          row.event_id,
          assetId,
          versionId,
          timestamp,
          JSON.stringify(segments),
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE assets
            SET current_version_id = ?, processing_status = 'ready', failure_code = NULL,
                updated_at = ?
          WHERE id = ? AND workspace_id = ? AND current_version_id IS NULL`,
      )
      .bind(versionId, timestamp, assetId, scope.workspaceId),
    db
      .prepare(
        `UPDATE events SET material_status = 'ready', updated_at = ?
          WHERE id = ? AND workspace_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM assets
               WHERE event_id = ? AND id <> ? AND processing_status <> 'ready'
            )`,
      )
      .bind(timestamp, row.event_id, scope.workspaceId, row.event_id, assetId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const current = await first(
      `SELECT current_version_id FROM assets WHERE id = ? AND workspace_id = ?`,
      [assetId, scope.workspaceId],
    );
    if (current?.current_version_id) return getAsset(scope, assetId);
    throw error;
  }
  return getAsset(scope, assetId);
}

export async function getAsset(scope: RequestScope, assetId: string): Promise<AssetRecord> {
  const row = await first(
    `${ASSET_SELECT} WHERE a.id = ? AND a.workspace_id = ?`,
    [assetId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Asset was not found.");
  }
  return assetRecord(row);
}

export async function getAssetEvidenceObject(
  scope: RequestScope,
  assetId: string,
  range?: { offset: number; length: number },
) {
  const row = await first(
    `${ASSET_SELECT} WHERE a.id = ? AND a.workspace_id = ?`,
    [assetId, scope.workspaceId],
  );
  if (!row || !row.r2_original_key) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Asset evidence was not found.");
  }
  const object = await getEvidenceBucket().get(
    String(row.r2_original_key),
    range ? { range } : undefined,
  );
  if (!object) {
    throw new ApiFault(404, "NOT_FOUND", "Stored evidence object was not found.");
  }
  return { row, object };
}

async function shaText(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value).buffer);
}

export async function createExtractionRun(
  scope: RequestScope,
  eventId: string,
  idempotencyKey: string,
  assetVersionIds: string[],
): Promise<{ run: ExtractionRunRecord; created: boolean }> {
  const bindings = getBindings();
  const providerHasEndpoint =
    Boolean(bindings.AI_API_BASE_URL?.trim()) ||
    bindings.AI_PROVIDER === "openai" ||
    bindings.AI_PROVIDER === "deepseek";
  if (
    !bindings.AI_API_KEY ||
    !bindings.AI_PROVIDER ||
    !bindings.AI_MODEL ||
    !providerHasEndpoint
  ) {
    throw new ApiFault(
      503,
      "MODEL_PROVIDER_NOT_CONFIGURED",
      "AI provider is not configured. No extraction run was created.",
    );
  }
  const event = await assertEvent(scope, eventId);
  if (String(event.material_status) !== "ready") {
    throw new ApiFault(409, "EVENT_NOT_READY", "Event materials are not ready.");
  }
  const project = await assertProject(scope, String(event.project_id));
  const scenarioStatus = String(project.scenario_status);
  if (scenarioStatus !== "confirmed" && Number(event.sequence_no) !== 1) {
    throw new ApiFault(
      409,
      "SCENARIO_CONFIRMATION_REQUIRED",
      "Confirm the scenario from the first event before extracting later events.",
    );
  }
  if (assetVersionIds.length === 0) {
    throw new ApiFault(400, "BAD_REQUEST", "asset_version_ids must not be empty.");
  }
  if (new Set(assetVersionIds).size !== assetVersionIds.length) {
    throw new ApiFault(400, "BAD_REQUEST", "asset_version_ids must not contain duplicates.");
  }
  const versions = await all(
    `SELECT av.id, av.content_sha256, av.parser_version, av.mime_type,
            av.size_bytes, a.kind, a.filename, a.metadata_json
       FROM asset_versions av
       JOIN assets a ON a.id = av.asset_id
      WHERE a.event_id = ? AND a.workspace_id = ?
        AND av.id IN (${assetVersionIds.map(() => "?").join(",")})`,
    [eventId, scope.workspaceId, ...assetVersionIds],
  );
  if (versions.length !== assetVersionIds.length) {
    throw new ApiFault(400, "BAD_REQUEST", "Every asset_version_id must belong to the event.");
  }
  const derivedReadable = versions.find((row) => {
    const metadata = parseJson<Record<string, unknown>>(String(row.metadata_json ?? "{}"), {});
    return metadata.analysis_source === false || metadata.artifact_kind === "readable_transcript";
  });
  if (derivedReadable) {
    throw new ApiFault(
      400,
      "BAD_REQUEST",
      "AI-readable transcripts cannot replace raw source material for fact extraction.",
      { asset_version_id: derivedReadable.id },
    );
  }
  const photoVersions = versions.filter((row) => String(row.kind) === "photo");
  const directAudio = versions.find((row) => String(row.kind) === "audio");
  if (directAudio) {
    throw new ApiFault(
      409,
      "EVENT_NOT_READY",
      "Audio must finish transcription before analysis. Select the derived Transcript instead.",
      { audio_asset_version_id: directAudio.id },
    );
  }
  const unsupportedPhoto = photoVersions.find((row) =>
    isHeifLike(String(row.filename), String(row.mime_type)) ||
    !isSupportedModelImageMime(String(row.mime_type)),
  );
  if (unsupportedPhoto) {
    throw unsupportedAssetFormat(
      "photo",
      String(unsupportedPhoto.filename),
      normalizeMimeType(String(unsupportedPhoto.mime_type)),
    );
  }
  const totalImageBytes = photoVersions.reduce(
    (total, row) => total + Number(row.size_bytes ?? 0),
    0,
  );
  const maxRunImageBytes = configuredPositiveInteger(
    bindings.MAX_RUN_IMAGE_BYTES,
    DEFAULT_MAX_RUN_IMAGE_BYTES,
  );
  if (totalImageBytes > maxRunImageBytes) {
    throw new ApiFault(
      413,
      "ASSET_TOO_LARGE",
      "Combined image size exceeds the extraction limit.",
      {
        image_count: photoVersions.length,
        total_image_bytes: totalImageBytes,
        max_total_image_bytes: maxRunImageBytes,
      },
    );
  }
  const byId = new Map(versions.map((row) => [String(row.id), row]));
  const manifest = assetVersionIds.map((versionId) => {
    const row = byId.get(versionId)!;
    return {
      asset_version_id: versionId,
      sha256: row.content_sha256,
      parser_version: row.parser_version,
      kind: row.kind,
    };
  });
  const selectedSegmentRows = await all(
    `SELECT id, length(text_normalized) AS character_count
       FROM text_segments
      WHERE asset_version_id IN (${assetVersionIds.map(() => "?").join(",")})
      ORDER BY asset_version_id, ordinal`,
    assetVersionIds,
  );
  const selectedSegmentIds = selectedSegmentRows.map((row) => String(row.id));
  const estimatedInputTokens =
    2_000 +
    Math.ceil(
      selectedSegmentRows.reduce(
        (total, row) => total + Number(row.character_count ?? 0),
        0,
      ) / 4,
    ) +
    manifest.filter((item) => item.kind === "photo").length * 1_500;
  const maxOutputTokens = configuredPositiveInteger(
    bindings.AI_MAX_OUTPUT_TOKENS,
    DEFAULT_AI_MAX_OUTPUT_TOKENS,
  );
  const timeoutMs = normalizeAiTimeoutMs(bindings.AI_TIMEOUT_MS);
  const pipelineEnabled = twoPassPipelineEnabled(bindings.AI_TWO_PASS_PIPELINE);
  const draftContextEnabled = bindings.AI_DRAFT_CONTEXT === "1";
  const draftContextManifest = draftContextEnabled
    ? (await all(
        `SELECT recent_claims.claim_id, recent_claims.claim_version_id
           FROM (
             SELECT c.id AS claim_id,
                    c.current_version_id AS claim_version_id,
                    source_event.sequence_no AS event_sequence_no,
                    c.created_at
               FROM claims c
               JOIN events source_event ON source_event.id = c.event_id
              WHERE c.project_id = ? AND c.workspace_id = ?
                AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
                AND c.source = 'ai' AND source_event.sequence_no < ?
                AND source_event.id IN (
                  SELECT recent_event.id FROM events recent_event
                   WHERE recent_event.project_id = ? AND recent_event.workspace_id = ?
                     AND recent_event.sequence_no < ?
                   ORDER BY recent_event.sequence_no DESC, recent_event.id DESC
                   LIMIT 10
                )
                AND source_event.active_run_id = c.extraction_run_id
                AND EXISTS (
                  SELECT 1 FROM evidence_refs er
                   WHERE er.claim_version_id = c.current_version_id
                     AND er.structural_validation_status = 'valid'
                )
              ORDER BY source_event.sequence_no DESC, c.created_at DESC, c.id DESC
              LIMIT 100
           ) AS recent_claims
          ORDER BY recent_claims.event_sequence_no,
                   recent_claims.created_at,
                   recent_claims.claim_id`,
        [
          project.id,
          scope.workspaceId,
          event.sequence_no,
          project.id,
          scope.workspaceId,
          event.sequence_no,
        ],
      )).map((row) => ({
        claim_id: String(row.claim_id),
        claim_version_id: String(row.claim_version_id),
      }))
    : [];
  const hasTranscriptInput = manifest.some((item) => item.kind === "transcript" || item.kind === "text");
  const eventSummaryEnabled = hasTranscriptInput && bindings.AI_EVENT_SUMMARY !== "0";
  const readableTranscriptEnabled = hasTranscriptInput && bindings.AI_READABLE_TRANSCRIPT !== "0";
  const artifactStageCount = Number(eventSummaryEnabled) + Number(readableTranscriptEnabled);
  const maxModelStages = (pipelineEnabled ? 3 : 1) + artifactStageCount;
  const reservedModelTokens =
    estimatedInputTokens * maxModelStages + maxOutputTokens * maxModelStages;
  const maxRunInputTokens = configuredPositiveInteger(
    bindings.MAX_RUN_INPUT_TOKENS,
    120_000,
  );
  const maxConcurrentRuns = configuredPositiveInteger(
    bindings.MAX_CONCURRENT_RUNS_PER_WORKSPACE,
    2,
  );
  const maxImageUnits = configuredPositiveInteger(bindings.MAX_RUN_IMAGE_UNITS, 12);
  const reasoningEffort = normalizeOpenAiReasoningEffort(bindings.AI_REASONING_EFFORT);
  const verifierReasoningEffort = normalizeVerifierReasoningEffort(
    bindings.AI_VERIFIER_REASONING_EFFORT,
  );
  const imageUnits = manifest.filter((item) => item.kind === "photo").length;
  if (estimatedInputTokens > maxRunInputTokens) {
    throw new ApiFault(422, "RUN_BUDGET_EXCEEDED", "Run exceeds the configured input token limit.", {
      estimated_input_tokens: estimatedInputTokens,
      max_input_tokens: maxRunInputTokens,
    });
  }
  if (imageUnits > maxImageUnits) {
    throw new ApiFault(413, "TOO_MANY_IMAGES", "Run exceeds the configured image limit.", {
      image_units: imageUnits,
      max_image_units: maxImageUnits,
    });
  }
  const contextSnapshotHash = await shaText(
    JSON.stringify({ project_id: project.id, context_version: project.context_version }),
  );
  const inputManifestJson = JSON.stringify(manifest);
  const inputHash = await shaText(
    JSON.stringify({
      manifest,
      context_snapshot_hash: contextSnapshotHash,
      provider: bindings.AI_PROVIDER,
      model: bindings.AI_MODEL,
      reasoning_effort: reasoningEffort,
      verifier_reasoning_effort: verifierReasoningEffort,
      two_pass_pipeline: pipelineEnabled,
      draft_context: draftContextEnabled,
      draft_context_manifest: draftContextManifest,
      max_model_stages: maxModelStages,
      max_output_tokens: maxOutputTokens,
      timeout_ms: timeoutMs,
      prompt_version: CLAIM_EXTRACTION_PROMPT_VERSION,
      schema_version: CLAIM_EXTRACTION_SCHEMA_VERSION,
      parser_version: "transcript-parser.v1",
      locale: project.locale,
      ordered_segment_ids: selectedSegmentIds,
    }),
  );
  const existing = await first(
    `SELECT * FROM extraction_runs
      WHERE event_id = ? AND idempotency_key = ? AND workspace_id = ?`,
    [eventId, idempotencyKey, scope.workspaceId],
  );
  if (existing) {
    if (String(existing.input_hash) !== inputHash) {
      throw new ApiFault(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different extraction input.",
        { existing_run_id: existing.id },
      );
    }
    await ensureEventAiArtifactRuns({
      workspaceId: scope.workspaceId,
      projectId: String(existing.project_id),
      eventId,
      extractionRunId: String(existing.id),
      inputManifestJson: String(existing.input_manifest_json),
      provider: String(existing.provider),
      model: String(existing.model),
    });
    return { run: extractionRunRecord(existing), created: false };
  }

  const needsScenarioAssessment = scenarioStatus === "unassessed";
  if (
    Number(event.sequence_no) === 1 &&
    scenarioStatus !== "confirmed" &&
    !needsScenarioAssessment
  ) {
    throw new ApiFault(
      409,
      "SCENARIO_CONFIRMATION_REQUIRED",
      "The first event is already assessing a scenario or awaiting confirmation.",
      { scenario_status: scenarioStatus },
    );
  }

  const runId = id("run");
  const outboxId = id("out");
  const timestamp = now();
  const payloadJson = JSON.stringify({ run_id: runId });
  const payloadHash = await shaText(payloadJson);
  const db = getD1();
  const quotaGuardId = id("guard");
  const scenarioGuardId = needsScenarioAssessment ? id("guard") : null;
  const scenarioLeaseExpiresAt = new Date(Date.now() + 35 * 60_000).toISOString();
  const modelParamsJson = JSON.stringify({
    max_output_tokens: maxOutputTokens,
    timeout_ms: timeoutMs,
    reasoning_effort: reasoningEffort,
    verifier_reasoning_effort: verifierReasoningEffort,
    two_pass_pipeline: pipelineEnabled,
    draft_context: draftContextEnabled,
    draft_context_manifest: draftContextManifest,
    max_model_stages: maxModelStages,
    event_summary: eventSummaryEnabled,
    readable_transcript: readableTranscriptEnabled,
    verification_uses_readable: bindings.AI_VERIFICATION_USES_READABLE !== "0",
    reserved_input_tokens: estimatedInputTokens,
    reserved_model_tokens: reservedModelTokens,
    token_budget_policy: "per-run-safety.v1",
  });
  const statements = [
    db
      .prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN (
           SELECT COUNT(*) FROM extraction_runs
            WHERE workspace_id = ? AND status IN ('queued', 'processing')
         ) < ? THEN 1 ELSE 0 END, ?`,
      )
      .bind(
        quotaGuardId,
        scope.workspaceId,
        maxConcurrentRuns,
        timestamp,
      ),
  ] as D1PreparedStatement[];
  if (needsScenarioAssessment) {
    statements.push(
      db
        .prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM projects p
             JOIN events e ON e.project_id = p.id
              WHERE p.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
                AND p.scenario_status = 'unassessed' AND e.id = ?
                AND e.sequence_no = 1
           ) THEN 1 ELSE 0 END, ?`,
        )
        .bind(
          scenarioGuardId,
          project.id,
          scope.workspaceId,
          eventId,
          timestamp,
        ),
      db
        .prepare(
          `UPDATE projects
              SET scenario_status = 'assessing', scenario_assessment_run_id = ?,
                  scenario_lease_expires_at = ?,
                  scenario_assessment_attempt = scenario_assessment_attempt + 1,
                  updated_at = ?
            WHERE id = ? AND workspace_id = ? AND scenario_status = 'unassessed'`,
        )
        .bind(
          runId,
          scenarioLeaseExpiresAt,
          timestamp,
          project.id,
          scope.workspaceId,
        ),
    );
  }
  statements.push(
    db
      .prepare(
      `INSERT INTO extraction_runs (
        id, workspace_id, project_id, event_id, status, idempotency_key,
        input_hash, input_snapshot_hash, input_manifest_json, context_version,
        context_snapshot_hash, provider, model, model_params_json,
        prompt_version, schema_version, parser_version, attempt_no,
        queued_at, first_queued_at, current_queued_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?,
                'transcript-parser.v1', 0, ?, ?, ?, ?, ?)`,
    )
      .bind(
      runId,
      scope.workspaceId,
      project.id,
      eventId,
      idempotencyKey,
      inputHash,
      inputHash,
      inputManifestJson,
      project.context_version,
      contextSnapshotHash,
      bindings.AI_PROVIDER,
      bindings.AI_MODEL,
      modelParamsJson,
      CLAIM_EXTRACTION_PROMPT_VERSION,
      CLAIM_EXTRACTION_SCHEMA_VERSION,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      ),
    db
      .prepare(
        `INSERT INTO queue_outbox (
        id, run_id, payload_hash, payload_json, status, attempt,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .bind(outboxId, runId, payloadHash, payloadJson, timestamp, timestamp, timestamp),
    db
      .prepare(
        `UPDATE events SET active_run_id = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      )
      .bind(runId, timestamp, eventId, scope.workspaceId),
  );
  if (scenarioGuardId) {
    statements.push(db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(scenarioGuardId));
  }
  statements.push(db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(quotaGuardId));
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await first(
      `SELECT * FROM extraction_runs
        WHERE event_id = ? AND idempotency_key = ? AND workspace_id = ?`,
      [eventId, idempotencyKey, scope.workspaceId],
    );
    if (raced && String(raced.input_hash) === inputHash) {
      await ensureEventAiArtifactRuns({
        workspaceId: scope.workspaceId,
        projectId: String(raced.project_id),
        eventId,
        extractionRunId: String(raced.id),
        inputManifestJson: String(raced.input_manifest_json),
        provider: String(raced.provider),
        model: String(raced.model),
      });
      return { run: extractionRunRecord(raced), created: false };
    }
    if (raced) {
      throw new ApiFault(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with different extraction input.",
        { existing_run_id: raced.id },
      );
    }
    const quotaState = await first(
      `SELECT SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS active_count
         FROM extraction_runs WHERE workspace_id = ?`,
      [scope.workspaceId],
    );
    const activeCount = Number(quotaState?.active_count ?? 0);
    if (activeCount >= maxConcurrentRuns) {
      throw new ApiFault(
        429,
        "WORKSPACE_RUN_LIMIT",
        "Workspace extraction concurrency limit was reached.",
        { active_runs: activeCount, max_concurrent_runs: maxConcurrentRuns },
      );
    }
    if (needsScenarioAssessment) {
      throw new ApiFault(
        409,
        "SCENARIO_VERSION_CONFLICT",
        "Another request acquired the first-event scenario assessment lease.",
      );
    }
    throw error;
  }
  await ensureEventAiArtifactRuns({
    workspaceId: scope.workspaceId,
    projectId: String(project.id),
    eventId,
    extractionRunId: runId,
    inputManifestJson,
    provider: String(bindings.AI_PROVIDER),
    model: String(bindings.AI_MODEL),
  });
  return { run: await getExtractionRun(scope, runId), created: true };
}

export async function getExtractionRun(
  scope: RequestScope,
  runId: string,
): Promise<ExtractionRunRecord> {
  const row = await first(
    `SELECT r.*,
            COALESCE((SELECT o.attempt FROM queue_outbox o WHERE o.run_id = r.id), 0)
              AS dispatch_attempt_no,
            (SELECT s.stage FROM extraction_model_stages s
              WHERE s.run_id = r.id
              ORDER BY CASE s.stage
                WHEN 'verify_escalated' THEN 3
                WHEN 'verify' THEN 2
                ELSE 1 END DESC,
                s.updated_at DESC
              LIMIT 1) AS pipeline_stage
       FROM extraction_runs r WHERE r.id = ? AND r.workspace_id = ?`,
    [runId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Extraction run was not found.");
  }
  const stages = await listExtractionModelStageTimings(runId, scope.workspaceId);
  return extractionRunRecord(row, stages);
}

async function evidenceIdsForVersions(versionIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!versionIds.length) return result;
  const rows = await all(
    `SELECT id, claim_version_id FROM evidence_refs
      WHERE claim_version_id IN (${versionIds.map(() => "?").join(",")})
        AND structural_validation_status = 'valid'
      ORDER BY created_at`,
    versionIds,
  );
  for (const row of rows) {
    const key = String(row.claim_version_id);
    result.set(key, [...(result.get(key) ?? []), String(row.id)]);
  }
  return result;
}

function claimsFromRows(
  rows: Row[],
  evidence: Map<string, string[]>,
  batchReviewedVersionIds: Set<string> = new Set(),
): ClaimRecord[] {
  return rows.map((row) =>
    claimRecord(
      row,
      evidence.get(String(row.current_version_id)) ?? [],
      [],
      batchReviewedVersionIds.has(String(row.current_version_id)),
    ),
  );
}

export async function getRunClaims(
  scope: RequestScope,
  runId: string,
): Promise<{
  run: ExtractionRunRecord;
  claims: ClaimRecord[];
  occurrence_candidates: OccurrenceCandidateRecord[];
}> {
  const run = await getExtractionRun(scope, runId);
  const rows = await all(
    `${CLAIM_SELECT}
      WHERE c.extraction_run_id = ? AND c.workspace_id = ?
      ORDER BY CASE c.materiality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               c.confidence DESC, c.created_at`,
    [runId, scope.workspaceId],
  );
  const evidence = await evidenceIdsForVersions(
    rows.map((row) => String(row.current_version_id)),
  );
  const versionIds = rows.map((row) => String(row.current_version_id));
  const batchReviewedVersionIds = versionIds.length
    ? new Set((await all(
        `SELECT claim_version_id
           FROM claim_evidence_review_attestations
          WHERE workspace_id = ? AND actor_id = ?
            AND claim_version_id IN (${versionIds.map(() => "?").join(",")})`,
        [scope.workspaceId, scope.actorId, ...versionIds],
      )).map((row) => String(row.claim_version_id)))
    : new Set<string>();
  const occurrenceRows = await all(
    `SELECT occ.*, c.type AS target_type, cv.statement AS target_statement
       FROM claim_occurrence_candidates occ
       JOIN claims c ON c.id = occ.target_claim_id
       JOIN claim_versions cv ON cv.id = occ.target_claim_version_id
      WHERE occ.extraction_run_id = ? AND occ.workspace_id = ?
      ORDER BY occ.created_at`,
    [runId, scope.workspaceId],
  );
  type CandidatePayload = {
    schema_version?: string;
    statement?: string;
    type?: string;
    evidence?: Array<Record<string, unknown>>;
  };
  const payloads = occurrenceRows.map((row) =>
    parseJson<CandidatePayload>(String(row.evidence_ref_json ?? "{}"), {}),
  );
  const occurrenceAssetVersionIds = [...new Set(
    payloads.flatMap((payload) =>
      (payload.evidence ?? []).flatMap((evidenceItem) =>
        typeof evidenceItem.assetVersionId === "string"
          ? [evidenceItem.assetVersionId]
          : [],
      ),
    ),
  )];
  const occurrenceAssets = occurrenceAssetVersionIds.length
    ? await all(
        `SELECT av.id AS asset_version_id, a.id AS asset_id
           FROM asset_versions av
           JOIN assets a ON a.id = av.asset_id
          WHERE av.id IN (${occurrenceAssetVersionIds.map(() => "?").join(",")})
            AND a.workspace_id = ?`,
        [...occurrenceAssetVersionIds, scope.workspaceId],
      )
    : [];
  const assetIdByVersion = new Map(
    occurrenceAssets.map((row) => [String(row.asset_version_id), String(row.asset_id)]),
  );
  const occurrenceCandidates: OccurrenceCandidateRecord[] = occurrenceRows.map((row, index) => {
    const payload = payloads[index];
    return {
      id: String(row.id),
      project_id: String(row.project_id),
      event_id: String(row.event_id),
      extraction_run_id: String(row.extraction_run_id),
      target_claim_id: String(row.target_claim_id),
      target_claim_version_id: String(row.target_claim_version_id),
      target_statement: String(row.target_statement),
      target_type: String(row.target_type),
      proposed_statement: typeof payload.statement === "string" ? payload.statement : null,
      proposed_type: typeof payload.type === "string" ? payload.type : null,
      status: String(row.status) as OccurrenceCandidateRecord["status"],
      evidence: (payload.evidence ?? []).flatMap((item) => {
        const assetVersionId =
          typeof item.assetVersionId === "string" ? item.assetVersionId : "";
        if (!assetVersionId) return [];
        const assetId = assetIdByVersion.get(assetVersionId) ?? null;
        return [{
          kind: String(item.kind) as OccurrenceCandidateRecord["evidence"][number]["kind"],
          asset_version_id: assetVersionId,
          asset_id: assetId,
          asset_view_url: assetId
            ? `/api/v1/assets/${encodeURIComponent(assetId)}/evidence-view`
            : null,
          segment_ids: parseJson<string[]>(
            typeof item.segmentIdsJson === "string" ? item.segmentIdsJson : null,
            [],
          ),
          quote_raw: typeof item.quoteRaw === "string" ? item.quoteRaw : null,
          start_ms: typeof item.startMs === "number" ? item.startMs : null,
          end_ms: typeof item.endMs === "number" ? item.endMs : null,
          page_number: typeof item.pageNumber === "number" ? item.pageNumber : null,
          bbox: parseJson<[number, number, number, number] | null>(
            typeof item.bboxJson === "string" ? item.bboxJson : null,
            null,
          ),
          observation: typeof item.observation === "string" ? item.observation : null,
          evidence_role: String(item.evidenceRole) as OccurrenceCandidateRecord["evidence"][number]["evidence_role"],
        }];
      }),
      base_version_id: String(row.base_version_id),
      created_at: String(row.created_at),
    };
  });
  return {
    run,
    claims: claimsFromRows(rows, evidence, batchReviewedVersionIds),
    occurrence_candidates: occurrenceCandidates,
  };
}

export async function getClaimHistory(scope: RequestScope, claimId: string) {
  const claim = await first(
    `SELECT * FROM claims WHERE id = ? AND workspace_id = ?`,
    [claimId, scope.workspaceId],
  );
  if (!claim) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Claim was not found.");
  }
  const [versions, verdictRows, relations, occurrences] = await Promise.all([
    all(`SELECT * FROM claim_versions WHERE claim_id = ? ORDER BY version_no`, [claimId]),
    all(`SELECT * FROM verdicts WHERE claim_id = ? ORDER BY created_at`, [claimId]),
    all(
      `SELECT r.* FROM claim_relations r
        JOIN claim_versions source ON source.id = r.source_claim_version_id
        JOIN claim_versions target ON target.id = r.target_claim_version_id
       WHERE source.claim_id = ? OR target.claim_id = ? ORDER BY r.created_at`,
      [claimId, claimId],
    ),
    all(`SELECT * FROM claim_occurrences WHERE claim_id = ? ORDER BY confirmed_at`, [claimId]),
  ]);
  return { claim, versions, verdicts: verdictRows, relations, occurrences };
}

export async function getEvidenceRef(scope: RequestScope, evidenceRefId: string) {
  const row = await first(
    `SELECT er.*, a.id AS asset_id, a.filename, av.mime_type, av.r2_original_key,
            source_a.id AS audio_asset_id, source_a.filename AS audio_filename
       FROM evidence_refs er
       LEFT JOIN asset_versions av ON av.id = er.asset_version_id
       LEFT JOIN assets a ON a.id = av.asset_id
       LEFT JOIN asset_versions source_av ON source_av.id = av.derived_from_asset_version_id
       LEFT JOIN assets source_a ON source_a.id = source_av.asset_id AND source_a.kind = 'audio'
      WHERE er.id = ? AND er.workspace_id = ?`,
    [evidenceRefId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Evidence reference was not found.");
  }
  return {
    ...row,
    segment_ids: parseJson(String(row.segment_ids_json ?? "[]"), []),
    bbox: parseJson(String(row.bbox_json ?? "null"), null),
    asset_view_url: row.asset_version_id
      ? `/api/v1/assets/${encodeURIComponent(String(row.asset_id ?? ""))}/evidence-view`
      : null,
    audio_view_url: row.audio_asset_id
      ? `/api/v1/assets/${encodeURIComponent(String(row.audio_asset_id))}/evidence-view`
      : null,
  };
}

export async function getVerifiedView(
  scope: RequestScope,
  projectId: string,
  viewType: VerifiedViewType,
): Promise<VerifiedViewResponse> {
  const project = await getProject(scope, projectId);
  const predicates = ["c.project_id = ?", "c.workspace_id = ?", "c.review_status = 'verified'"];
  const bindings: unknown[] = [projectId, scope.workspaceId];
  if (viewType !== "timeline") predicates.push("c.lifecycle_status = 'active'");
  if (viewType === "decisions") predicates.push("lower(c.type) = 'decision'");
  if (viewType === "preferences") predicates.push("lower(c.type) = 'preference'");
  if (viewType === "open-questions") {
    predicates.push("lower(replace(c.type, ' ', '_')) = 'open_question'");
  }
  if (viewType === "risks") predicates.push("lower(c.type) IN ('risk', 'concern')");
  const rows = await all(
    `${CLAIM_SELECT}
      JOIN events e ON e.id = c.event_id
      WHERE ${predicates.join(" AND ")}
      ORDER BY e.sequence_no ASC, c.created_at ASC`,
    bindings,
  );
  const evidence = await evidenceIdsForVersions(
    rows.map((row) => String(row.current_version_id)),
  );
  const claims = claimsFromRows(rows, evidence);
  const items = claims.map((claim) => ({
    claim_id: claim.id,
    claim_version_id: claim.current_version.id,
    event_id: claim.event_id,
    type: claim.type,
    statement: claim.current_version.statement,
    normalized_value: claim.current_version.normalized_value,
    review_status: claim.review_status,
    lifecycle_status: claim.lifecycle_status,
    evidence_ref_ids: claim.evidence_ref_ids,
  }));
  return {
    project_id: projectId,
    view_type: viewType,
    ledger_version: project.ledger_version,
    scenario_version: project.scenario_version,
    generated_at: now(),
    items,
    empty_reason: items.length ? null : "No verified information is available for this view.",
  };
}

export async function debugRun(scope: RequestScope, runId: string) {
  const row = await first(
    `SELECT r.*, o.status AS outbox_status, o.attempt AS outbox_attempt,
            o.next_attempt_at, o.last_error_code AS outbox_error_code
       FROM extraction_runs r
       LEFT JOIN queue_outbox o ON o.run_id = r.id
      WHERE r.id = ? AND r.workspace_id = ?`,
    [runId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Extraction run was not found.");
  }
  const validatedOutputJson = row.validated_output_json;
  const [stages, artifactRuns] = await Promise.all([
    listExtractionModelStageDebug(runId, scope.workspaceId),
    listEventAiArtifactRunDebug(runId, scope.workspaceId),
  ]);
  const debugRow = { ...row };
  for (const key of [
    "idempotency_key",
    "input_manifest_json",
    "model_params_json",
    "validated_output_json",
    "error_details_json",
  ]) {
    delete debugRow[key];
  }
  return {
    ...debugRow,
    input_manifest: parseJson(String(row.input_manifest_json ?? "[]"), []),
    model_params: parseJson(String(row.model_params_json ?? "{}"), {}),
    validated_output: parseJson(String(validatedOutputJson ?? "null"), null),
    error_details: parseJson(String(row.error_details_json ?? "null"), null),
    stages,
    artifact_runs: artifactRuns,
  };
}
