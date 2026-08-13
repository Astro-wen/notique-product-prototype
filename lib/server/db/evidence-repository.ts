import { getD1 } from "@/db";
import {
  buildTranscriptEvidenceContextWindow,
  DEFAULT_EVIDENCE_CONTEXT_SEGMENTS,
  evidenceAudioStartMs,
  type EvidenceContextTranscriptSegment,
} from "@/lib/domain/evidence";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import type {
  EvidenceContextRecord,
  EvidenceContextSegmentRecord,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function all(sql: string, bindings: unknown[]): Promise<Row[]> {
  return (await getD1().prepare(sql).bind(...bindings).all<Row>()).results ?? [];
}

function optionalString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function optionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function domainSegment(row: Row): EvidenceContextTranscriptSegment {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    assetVersionId: String(row.asset_version_id),
    ordinal: Number(row.ordinal),
    speaker: optionalString(row.speaker),
    startMs: optionalNumber(row.start_ms),
    endMs: optionalNumber(row.end_ms),
    textRaw: String(row.text_raw),
  };
}

function apiSegment(segment: EvidenceContextTranscriptSegment): EvidenceContextSegmentRecord {
  return {
    id: segment.id,
    event_id: segment.eventId,
    asset_version_id: segment.assetVersionId,
    ordinal: segment.ordinal,
    speaker: segment.speaker,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    text: segment.textRaw,
  };
}

const SEGMENT_SELECT = `
  SELECT id, event_id, asset_version_id, ordinal, speaker,
         start_ms, end_ms, text_raw
    FROM text_segments`;

/**
 * Returns a small, scoped Evidence reader payload. The query reads only the
 * target segments and their nearest neighbours, never the full Transcript.
 */
export async function getEvidenceContext(
  scope: RequestScope,
  evidenceRefId: string,
  contextSize = DEFAULT_EVIDENCE_CONTEXT_SEGMENTS,
): Promise<EvidenceContextRecord> {
  const row = await first(
    `SELECT er.*, a.id AS asset_id, a.filename, av.mime_type,
            source_a.id AS audio_asset_id, source_a.filename AS audio_filename
       FROM evidence_refs er
       LEFT JOIN asset_versions av ON av.id = er.asset_version_id
       LEFT JOIN assets a ON a.id = av.asset_id
       LEFT JOIN asset_versions source_av
         ON source_av.id = av.derived_from_asset_version_id
       LEFT JOIN assets source_a
         ON source_a.id = source_av.asset_id AND source_a.kind = 'audio'
      WHERE er.id = ? AND er.workspace_id = ?`,
    [evidenceRefId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Evidence reference was not found.");
  }

  const kind = String(row.kind);
  const segmentIds = parseJson<unknown[]>(String(row.segment_ids_json ?? "[]"), [])
    .filter((value): value is string => typeof value === "string" && Boolean(value));
  const assetVersionId = optionalString(row.asset_version_id);
  let context = {
    before: [] as EvidenceContextSegmentRecord[],
    target: [] as EvidenceContextSegmentRecord[],
    after: [] as EvidenceContextSegmentRecord[],
  };

  if ((kind === "transcript" || kind === "text") && assetVersionId && segmentIds.length) {
    const targetRows = await all(
      `${SEGMENT_SELECT}
        WHERE workspace_id = ? AND event_id = ? AND asset_version_id = ?
          AND id IN (${segmentIds.map(() => "?").join(",")})
        ORDER BY ordinal`,
      [scope.workspaceId, String(row.event_id), assetVersionId, ...segmentIds],
    );
    if (
      targetRows.length !== new Set(segmentIds).size ||
      targetRows.some((segment) => !segmentIds.includes(String(segment.id)))
    ) {
      throw new ApiFault(
        409,
        "EVIDENCE_SCOPE_INVALID",
        "Evidence target passages are no longer available in this Transcript.",
      );
    }

    const target = targetRows.map(domainSegment);
    const firstOrdinal = target[0].ordinal;
    const lastOrdinal = target.at(-1)!.ordinal;
    const [beforeRows, afterRows] = await Promise.all([
      contextSize
        ? all(
            `${SEGMENT_SELECT}
              WHERE workspace_id = ? AND event_id = ? AND asset_version_id = ?
                AND ordinal < ?
              ORDER BY ordinal DESC LIMIT ?`,
            [scope.workspaceId, String(row.event_id), assetVersionId, firstOrdinal, contextSize],
          )
        : Promise.resolve([]),
      contextSize
        ? all(
            `${SEGMENT_SELECT}
              WHERE workspace_id = ? AND event_id = ? AND asset_version_id = ?
                AND ordinal > ?
              ORDER BY ordinal ASC LIMIT ?`,
            [scope.workspaceId, String(row.event_id), assetVersionId, lastOrdinal, contextSize],
          )
        : Promise.resolve([]),
    ]);
    const window = buildTranscriptEvidenceContextWindow(
      target,
      beforeRows.map(domainSegment),
      afterRows.map(domainSegment),
      contextSize,
    );
    context = {
      before: window.before.map(apiSegment),
      target: window.target.map(apiSegment),
      after: window.after.map(apiSegment),
    };
  }

  const assetId = optionalString(row.asset_id);
  const audioAssetId = optionalString(row.audio_asset_id);
  const startMs = optionalNumber(row.start_ms);
  return {
    evidence_ref_id: evidenceRefId,
    project_id: String(row.project_id),
    event_id: String(row.event_id),
    claim_version_id: String(row.claim_version_id),
    kind,
    evidence_role: String(row.evidence_role),
    asset_version_id: assetVersionId,
    asset_id: assetId,
    filename: optionalString(row.filename),
    target: {
      segment_ids: segmentIds,
      quote_raw: optionalString(row.quote_raw),
      start_ms: startMs,
      end_ms: optionalNumber(row.end_ms),
      page_number: optionalNumber(row.page_number),
      bbox: parseJson(String(row.bbox_json ?? "null"), null),
      observation: optionalString(row.observation),
    },
    context,
    asset_view_url: assetId
      ? `/api/v1/assets/${encodeURIComponent(assetId)}/evidence-view`
      : null,
    audio: audioAssetId
      ? {
          asset_id: audioAssetId,
          filename: optionalString(row.audio_filename),
          view_url: `/api/v1/assets/${encodeURIComponent(audioAssetId)}/evidence-view`,
          start_ms: evidenceAudioStartMs(startMs, true),
        }
      : null,
  };
}
