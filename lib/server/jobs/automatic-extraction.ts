import { getD1 } from "@/db";
import { createExtractionRun } from "@/lib/server/db/core-repository";
import { ApiFault } from "@/lib/server/http/api";
import { sha256Hex } from "@/lib/server/storage/keys";

type Row = Record<string, unknown>;

const AUTOMATIC_EXTRACTION_CANDIDATE_LIMIT = 50;
const MAX_EXTRACTION_ASSET_VERSIONS = 25;

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

async function idempotencyKey(eventId: string, assetVersionIds: string[]): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({
    event_id: eventId,
    asset_version_ids: assetVersionIds,
  }));
  const digest = await sha256Hex(payload.buffer);
  return `auto-transcription.v1:${digest}`;
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
 * Ensures that a successfully transcribed Event receives one extraction Run
 * even when the browser that initiated transcription is no longer open. This
 * is deliberately an idempotent Cron repair path; the browser remains the
 * faster path while it is present.
 */
export async function ensureAutomaticExtractionRuns(): Promise<AutomaticExtractionEnsureResult> {
  const candidates = await all(
    `SELECT tr.workspace_id, tr.event_id, MAX(tr.finished_at) AS finished_at
       FROM transcription_runs tr
       JOIN events e ON e.id = tr.event_id AND e.workspace_id = tr.workspace_id
       JOIN projects p ON p.id = tr.project_id AND p.workspace_id = tr.workspace_id
       JOIN assets source_audio
         ON source_audio.id = tr.audio_asset_id
        AND source_audio.workspace_id = tr.workspace_id
        AND source_audio.current_version_id = tr.audio_asset_version_id
       JOIN assets derived_transcript
         ON derived_transcript.id = tr.derived_transcript_asset_id
        AND derived_transcript.workspace_id = tr.workspace_id
        AND derived_transcript.event_id = tr.event_id
        AND derived_transcript.current_version_id = tr.derived_transcript_asset_version_id
        AND derived_transcript.processing_status = 'ready'
      WHERE tr.parent_run_id IS NULL
        AND tr.status = 'succeeded'
        AND tr.derived_transcript_asset_version_id IS NOT NULL
        AND e.material_status = 'ready'
        AND p.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM extraction_runs er,
                 json_each(CASE WHEN json_valid(er.input_manifest_json)
                                THEN er.input_manifest_json ELSE '[]' END) manifest_item
           WHERE er.event_id = tr.event_id
             AND er.workspace_id = tr.workspace_id
             AND json_extract(manifest_item.value, '$.asset_version_id') =
                 tr.derived_transcript_asset_version_id
        )
      GROUP BY tr.workspace_id, tr.event_id
      ORDER BY finished_at ASC, tr.event_id ASC
      LIMIT ?`,
    [AUTOMATIC_EXTRACTION_CANDIDATE_LIMIT],
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
      `SELECT id, input_manifest_json
         FROM extraction_runs
        WHERE event_id = ? AND workspace_id = ?
        ORDER BY created_at DESC`,
      [eventId, workspaceId],
    );
    const covered = previousRuns.find((row) => {
      const manifestIds = parseManifestAssetVersionIds(row.input_manifest_json);
      return manifestIds !== null && sameIds(manifestIds, assetVersionIds);
    });
    if (covered) {
      result.covered += 1;
      result.items.push({
        ...itemBase,
        outcome: "covered",
        runId: String(covered.id),
      });
      continue;
    }

    try {
      const ensured = await createExtractionRun(
        { workspaceId, actorId: "system-auto-transcription" },
        eventId,
        await idempotencyKey(eventId, assetVersionIds),
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
