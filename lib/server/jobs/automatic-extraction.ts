import { getD1 } from "@/db";
import { createExtractionRun } from "@/lib/server/db/core-repository";
import { ApiFault } from "@/lib/server/http/api";
import { sha256Hex } from "@/lib/server/storage/keys";

type Row = Record<string, unknown>;

const AUTOMATIC_EXTRACTION_CANDIDATE_LIMIT = 50;
const MAX_EXTRACTION_ASSET_VERSIONS = 25;
const MAX_AUTOMATIC_EXTRACTION_ATTEMPTS = 2;
const COVERED_EXTRACTION_RUN_STATES = new Set([
  "queued",
  "processing",
  "succeeded",
  "completed_with_warnings",
  "cancelled",
]);

export type AutomaticExtractionEnsureResult = {
  scanned: number;
  created: number;
  reused: number;
  covered: number;
  deferred: number;
  items: Array<{
    workspaceId: string;
    eventId: string;
    outcome: "created" | "reused" | "covered" | "deferred";
    reason?: string;
    runId?: string;
  }>;
};

async function all(sql: string, bindings: unknown[] = []): Promise<Row[]> {
  const result = await getD1().prepare(sql).bind(...bindings).all<Row>();
  return result.results ?? [];
}

function parseManifestAssetVersionIds(value: unknown): string[] | null {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = (item as Record<string, unknown>).asset_version_id;
      return typeof id === "string" && id ? id : null;
    });
    if (ids.some((id) => id === null)) return null;
    const uniqueIds = new Set(ids as string[]);
    if (uniqueIds.size !== ids.length) return null;
    return [...uniqueIds].sort();
  } catch {
    return null;
  }
}

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

async function idempotencyKey(
  eventId: string,
  assetVersionIds: string[],
  retryOrdinal = 0,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({
    event_id: eventId,
    asset_version_ids: assetVersionIds,
  }));
  const digest = await sha256Hex(payload.buffer);
  const base = `auto-manifest.v1:${digest}`;
  return retryOrdinal > 0 ? `${base}:retry-${retryOrdinal}` : base;
}

function deferredReason(error: unknown): string | null {
  if (!(error instanceof ApiFault)) return null;
  if (
    error.code === "EVENT_NOT_READY" ||
    error.code === "RUN_STATE_CONFLICT" ||
    error.code === "WORKSPACE_RUN_LIMIT" ||
    error.code === "SCENARIO_CONFIRMATION_REQUIRED" ||
    error.code === "SCENARIO_VERSION_CONFLICT" ||
    error.code === "MODEL_PROVIDER_NOT_CONFIGURED" ||
    error.code === "RUN_BUDGET_EXCEEDED" ||
    error.code === "TOO_MANY_IMAGES" ||
    error.code === "ASSET_TOO_LARGE"
  ) {
    return error.code;
  }
  return null;
}

/**
 * Ensures that every ready Event receives an extraction Run for its exact
 * current source manifest. The browser remains the fast path; this Cron repair
 * path also catches transcript/photo-only Events and material added after an
 * earlier Run, even when the originating browser is no longer open.
 */
export async function ensureAutomaticExtractionRuns(input?: {
  /**
   * Restricts the scan to one Event.
   *
   * This function commissions paid analysis, so who may call it matters. The
   * Cron trigger runs it across the workspace because that is unattended work
   * nobody is waiting on. A browser must not: opening the app would then spend
   * money on Events in projects the reader never looked at. Scoped to the
   * Event on screen, it does only what the product already promises about that
   * recording.
   */
  eventId?: string;
}): Promise<AutomaticExtractionEnsureResult> {
  const candidates = await all(
    `WITH current_sources AS (
       SELECT a.workspace_id, a.event_id, a.current_version_id,
              e.sequence_no, p.scenario_status
         FROM assets a
         JOIN events e ON e.id = a.event_id AND e.workspace_id = a.workspace_id
         JOIN projects p ON p.id = e.project_id AND p.workspace_id = e.workspace_id
        WHERE e.material_status = 'ready'
          AND p.deleted_at IS NULL
          AND a.kind <> 'audio'
          AND a.processing_status = 'ready'
          AND a.current_version_id IS NOT NULL
          AND COALESCE(a.failure_code, '') NOT IN ('UPLOAD_ABORTED', 'UPLOAD_EXPIRED')
          AND COALESCE(json_extract(a.metadata_json, '$.analysis_source'), 1) <> 0
          AND COALESCE(json_extract(a.metadata_json, '$.artifact_kind'), '') <> 'readable_transcript'
          AND COALESCE(json_extract(a.metadata_json, '$.transcription_chunk'), 0) <> 1
          AND (
            json_extract(a.metadata_json, '$.source_audio_asset_version_id') IS NULL
            OR EXISTS (
              SELECT 1 FROM assets current_audio
               WHERE current_audio.event_id = a.event_id
                 AND current_audio.workspace_id = a.workspace_id
                 AND current_audio.kind = 'audio'
                 AND current_audio.current_version_id =
                     json_extract(a.metadata_json, '$.source_audio_asset_version_id')
            )
          )
     ), source_counts AS (
       SELECT workspace_id, event_id, COUNT(*) AS source_count,
              MAX(sequence_no) AS sequence_no,
              MAX(scenario_status) AS scenario_status
         FROM current_sources
        GROUP BY workspace_id, event_id
       HAVING COUNT(*) <= ?
     ), exact_runs AS (
       SELECT er.workspace_id, er.event_id, er.id, er.status
         FROM extraction_runs er
         JOIN source_counts sc
           ON sc.event_id = er.event_id AND sc.workspace_id = er.workspace_id
        WHERE json_valid(er.input_manifest_json)
          AND (SELECT COUNT(*) FROM json_each(er.input_manifest_json)) = sc.source_count
          AND NOT EXISTS (
            SELECT 1 FROM current_sources source
             WHERE source.event_id = sc.event_id
               AND source.workspace_id = sc.workspace_id
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(er.input_manifest_json) manifest_item
                  WHERE json_extract(manifest_item.value, '$.asset_version_id') =
                        source.current_version_id
               )
          )
          AND NOT EXISTS (
            SELECT 1 FROM json_each(er.input_manifest_json) manifest_item
             WHERE NOT EXISTS (
               SELECT 1 FROM current_sources source
                WHERE source.event_id = sc.event_id
                  AND source.workspace_id = sc.workspace_id
                  AND source.current_version_id =
                      json_extract(manifest_item.value, '$.asset_version_id')
             )
          )
     )
     SELECT sc.workspace_id, sc.event_id
       FROM source_counts sc
      WHERE (sc.sequence_no = 1 OR sc.scenario_status = 'confirmed')
        AND (? IS NULL OR sc.event_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM exact_runs er
           WHERE er.event_id = sc.event_id
             AND er.workspace_id = sc.workspace_id
             AND (
               er.status IN (
                 'queued', 'processing', 'succeeded',
                 'completed_with_warnings', 'cancelled'
               )
               OR (
                 SELECT COUNT(*) FROM exact_runs failed
                  WHERE failed.event_id = sc.event_id
                    AND failed.workspace_id = sc.workspace_id
                    AND failed.status = 'failed'
               ) >= ?
             )
        )
      -- A stable first page lets one long-lived deferred row starve every
      -- Event after it. Random ordering gives each eligible uncovered Event a
      -- fair chance on every minute without adding mutable cursor state.
      ORDER BY random()
      LIMIT ?`,
    [
      MAX_EXTRACTION_ASSET_VERSIONS,
      input?.eventId ?? null,
      input?.eventId ?? null,
      MAX_AUTOMATIC_EXTRACTION_ATTEMPTS,
      AUTOMATIC_EXTRACTION_CANDIDATE_LIMIT,
    ],
  );

  const result: AutomaticExtractionEnsureResult = {
    scanned: candidates.length,
    created: 0,
    reused: 0,
    covered: 0,
    deferred: 0,
    items: [],
  };

  for (const candidate of candidates) {
    const workspaceId = String(candidate.workspace_id);
    const eventId = String(candidate.event_id);
    const itemBase = { workspaceId, eventId };
    const sourceRows = await all(
      `SELECT id, kind, current_version_id, processing_status, metadata_json
         FROM assets
        WHERE event_id = ? AND workspace_id = ?
          AND COALESCE(failure_code, '') NOT IN ('UPLOAD_ABORTED', 'UPLOAD_EXPIRED')
          AND COALESCE(json_extract(metadata_json, '$.analysis_source'), 1) <> 0
          AND COALESCE(json_extract(metadata_json, '$.artifact_kind'), '') <> 'readable_transcript'
          AND COALESCE(json_extract(metadata_json, '$.transcription_chunk'), 0) <> 1
          AND (
            json_extract(metadata_json, '$.source_audio_asset_version_id') IS NULL
            OR EXISTS (
              SELECT 1 FROM assets current_audio
               WHERE current_audio.event_id = assets.event_id
                 AND current_audio.workspace_id = assets.workspace_id
                 AND current_audio.kind = 'audio'
                 AND current_audio.current_version_id =
                     json_extract(assets.metadata_json, '$.source_audio_asset_version_id')
            )
          )
        ORDER BY created_at, id`,
      [eventId, workspaceId],
    );

    if (
      sourceRows.length === 0 ||
      sourceRows.some((row) =>
        String(row.processing_status) !== "ready" || !row.current_version_id
      )
    ) {
      result.deferred += 1;
      result.items.push({ ...itemBase, outcome: "deferred", reason: "EVENT_NOT_READY" });
      continue;
    }

    const audioVersionIds = sourceRows
      .filter((row) => String(row.kind) === "audio")
      .map((row) => String(row.current_version_id));
    if (audioVersionIds.length > 0) {
      const placeholders = audioVersionIds.map(() => "?").join(",");
      const successfulAudioRows = await all(
        `SELECT DISTINCT tr.audio_asset_version_id
           FROM transcription_runs tr
           JOIN assets derived
             ON derived.id = tr.derived_transcript_asset_id
            AND derived.workspace_id = tr.workspace_id
            AND derived.event_id = tr.event_id
            AND derived.current_version_id = tr.derived_transcript_asset_version_id
            AND derived.processing_status = 'ready'
          WHERE tr.event_id = ? AND tr.workspace_id = ?
            AND tr.parent_run_id IS NULL AND tr.status = 'succeeded'
            AND tr.derived_transcript_asset_version_id IS NOT NULL
            AND tr.audio_asset_version_id IN (${placeholders})`,
        [eventId, workspaceId, ...audioVersionIds],
      );
      const successfulAudioIds = new Set(
        successfulAudioRows.map((row) => String(row.audio_asset_version_id)),
      );
      if (audioVersionIds.some((id) => !successfulAudioIds.has(id))) {
        result.deferred += 1;
        result.items.push({
          ...itemBase,
          outcome: "deferred",
          reason: "TRANSCRIPTION_NOT_READY",
        });
        continue;
      }
    }

    const assetVersionIds = sourceRows
      .filter((row) => String(row.kind) !== "audio")
      .map((row) => String(row.current_version_id))
      .sort();
    if (assetVersionIds.length === 0) {
      result.deferred += 1;
      result.items.push({ ...itemBase, outcome: "deferred", reason: "NO_ANALYZABLE_SOURCE" });
      continue;
    }
    if (assetVersionIds.length > MAX_EXTRACTION_ASSET_VERSIONS) {
      result.deferred += 1;
      result.items.push({ ...itemBase, outcome: "deferred", reason: "TOO_MANY_ASSETS" });
      continue;
    }

    const previousRuns = await all(
      `SELECT id, status, input_manifest_json
         FROM extraction_runs
        WHERE event_id = ? AND workspace_id = ?
        ORDER BY created_at DESC`,
      [eventId, workspaceId],
    );
    const exactRuns = previousRuns.filter((row) => {
      const manifestIds = parseManifestAssetVersionIds(row.input_manifest_json);
      return manifestIds !== null && sameIds(manifestIds, assetVersionIds);
    });
    const covered = exactRuns.find((row) => COVERED_EXTRACTION_RUN_STATES.has(String(row.status)));
    if (covered) {
      result.covered += 1;
      result.items.push({
        ...itemBase,
        outcome: "covered",
        runId: String(covered.id),
      });
      continue;
    }
    const failedAttempts = exactRuns.filter((row) => String(row.status) === "failed").length;
    if (failedAttempts >= MAX_AUTOMATIC_EXTRACTION_ATTEMPTS) {
      result.deferred += 1;
      result.items.push({
        ...itemBase,
        outcome: "deferred",
        reason: "AUTOMATIC_RETRY_EXHAUSTED",
      });
      continue;
    }

    try {
      const ensured = await createExtractionRun(
        { workspaceId, actorId: "system-auto-manifest" },
        eventId,
        await idempotencyKey(eventId, assetVersionIds, failedAttempts),
        assetVersionIds,
      );
      const outcome = ensured.created ? "created" : "reused";
      result[outcome] += 1;
      result.items.push({
        ...itemBase,
        outcome,
        runId: ensured.run.id,
      });
    } catch (error) {
      const reason = deferredReason(error);
      result.deferred += 1;
      result.items.push({
        ...itemBase,
        outcome: "deferred",
        reason: reason ?? "AUTOMATIC_EXTRACTION_FAILED",
      });
      if (!reason) {
        console.error("automatic_extraction_ensure_failed", {
          workspace_id: workspaceId,
          event_id: eventId,
          message: error instanceof Error ? error.message : "Unexpected error",
        });
      }
    }
  }

  return result;
}
