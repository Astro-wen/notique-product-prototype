import { getD1 } from "@/db";
import {
  buildDecisionLog,
  buildDeterministicBrief,
  buildFolderSummary,
  buildGapCheck,
  buildNextMeetingAgenda,
  buildOpenQuestions,
  buildPreferences,
  buildRisks,
  buildTimeline,
} from "@/lib/domain/views";
import type {
  ClaimRelation,
  ClaimType,
  ClaimVersionRecord,
  ClaimWithVersion,
  ProjectLedger,
} from "@/lib/domain/types";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import type { VerifiedViewType } from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

async function all(sql: string, bindings: unknown[]): Promise<Row[]> {
  return (await getD1().prepare(sql).bind(...bindings).all<Row>()).results ?? [];
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

function claimType(value: unknown): ClaimType {
  const normalized = String(value).trim().toLowerCase().replaceAll(" ", "_");
  const allowed: ClaimType[] = [
    "budget",
    "preference",
    "requirement",
    "decision",
    "concern",
    "risk",
    "open_question",
    "person_role",
    "timing",
    "property_fact",
    "material",
    "measurement",
    "other",
  ];
  return allowed.includes(normalized as ClaimType) ? (normalized as ClaimType) : "other";
}

export async function loadProjectLedger(
  scope: RequestScope,
  projectId: string,
): Promise<ProjectLedger> {
  const project = await first(
    `SELECT * FROM projects
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, scope.workspaceId],
  );
  if (!project) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");
  }
  const [claimRows, versionRows, evidenceRows, relationRows, withdrawRows, eventRows] =
    await Promise.all([
      all(
        `SELECT c.*, c.id AS claim_id, cv.id AS version_id, cv.version_no, cv.statement, cv.normalized_value_json,
                cv.uncertainty_json, cv.source AS version_source,
                cv.created_at AS version_created_at
           FROM claims c
           JOIN claim_versions cv ON cv.id = c.current_version_id
          WHERE c.project_id = ? AND c.workspace_id = ?`,
        [projectId, scope.workspaceId],
      ),
      all(
        `SELECT cv.id AS version_id, cv.claim_id, cv.version_no, cv.statement,
                cv.normalized_value_json, cv.uncertainty_json,
                cv.source AS version_source, cv.created_at AS version_created_at
           FROM claim_versions cv
           JOIN claims c ON c.id = cv.claim_id
          WHERE c.project_id = ? AND c.workspace_id = ?
          ORDER BY c.created_at, cv.version_no`,
        [projectId, scope.workspaceId],
      ),
      all(
        `SELECT er.id, er.claim_version_id
           FROM evidence_refs er
          WHERE er.project_id = ? AND er.workspace_id = ?
            AND er.structural_validation_status = 'valid'
          ORDER BY er.created_at`,
        [projectId, scope.workspaceId],
      ),
      all(
        `SELECT r.*,
                source.claim_id AS source_claim_id,
                target.claim_id AS target_claim_id
           FROM claim_relations r
           JOIN claim_versions source ON source.id = r.source_claim_version_id
          JOIN claim_versions target ON target.id = r.target_claim_version_id
          WHERE r.project_id = ? AND r.workspace_id = ?
          ORDER BY r.created_at, r.id`,
        [projectId, scope.workspaceId],
      ),
      all(
        `SELECT id, claim_id, base_version_id, created_at
           FROM verdicts
          WHERE project_id = ? AND workspace_id = ? AND action = 'withdraw'
          ORDER BY created_at`,
        [projectId, scope.workspaceId],
      ),
      all(
        `SELECT * FROM events
          WHERE project_id = ? AND workspace_id = ? ORDER BY sequence_no`,
        [projectId, scope.workspaceId],
      ),
    ]);

  const evidenceByVersion = new Map<string, string[]>();
  for (const row of evidenceRows) {
    const versionId = String(row.claim_version_id);
    evidenceByVersion.set(versionId, [
      ...(evidenceByVersion.get(versionId) ?? []),
      String(row.id),
    ]);
  }
  const versionRecord = (row: Row): ClaimVersionRecord => {
    const versionId = String(row.version_id);
    return {
      id: versionId,
      claimId: String(row.claim_id),
      versionNo: Number(row.version_no),
      statement: String(row.statement),
      normalizedValue: parseJson<Record<string, unknown> | null>(
        row.normalized_value_json ? String(row.normalized_value_json) : null,
        null,
      ),
      uncertainty: parseJson<ClaimVersionRecord["uncertainty"]>(
        row.uncertainty_json ? String(row.uncertainty_json) : null,
        null,
      ),
      source: String(row.version_source) === "human" ? "user_edit" : "ai",
      evidenceRefIds: evidenceByVersion.get(versionId) ?? [],
      createdAt: String(row.version_created_at),
    };
  };
  const claimVersions = versionRows.map(versionRecord);
  const claims: ClaimWithVersion[] = claimRows.map((row) => {
    const version = versionRecord(row);
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      eventId: String(row.event_id),
      type: claimType(row.type),
      reviewStatus: String(row.review_status) as ClaimWithVersion["reviewStatus"],
      lifecycleStatus: String(row.lifecycle_status) as ClaimWithVersion["lifecycleStatus"],
      currentVersionId: version.id,
      materiality: String(row.materiality) as ClaimWithVersion["materiality"],
      confidenceBp: Math.round(Number(row.confidence ?? 0) * 10_000),
      needsAdditionalEvidence: Boolean(row.needs_additional_evidence),
      openedAt: row.opened_at ? String(row.opened_at) : null,
      lastRepeatedAt: row.last_repeated_at ? String(row.last_repeated_at) : null,
      repeatCount: Number(row.repeat_count ?? 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      version,
    };
  });
  const relations: ClaimRelation[] = relationRows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    sourceClaimId: String(row.source_claim_id),
    sourceClaimVersionId: String(row.source_claim_version_id),
    targetClaimId: String(row.target_claim_id),
    targetClaimVersionId: String(row.target_claim_version_id),
    type: String(row.type) as ClaimRelation["type"],
    status: String(row.status) as ClaimRelation["status"],
    contradictionStatus: row.contradiction_status
      ? (String(row.contradiction_status) as ClaimRelation["contradictionStatus"])
      : null,
    createdAt: String(row.created_at),
  }));
  return {
    projectId,
    locale: String(project.locale),
    scenario: {
      status: String(project.scenario_status) as ProjectLedger["scenario"]["status"],
      value: project.scenario ? String(project.scenario) : null,
      version: Number(project.scenario_version),
    },
    claims,
    claimVersions,
    relations,
    withdraws: withdrawRows.map((row) => ({
      id: String(row.id),
      claimId: String(row.claim_id),
      claimVersionId: String(row.base_version_id),
      createdAt: String(row.created_at),
    })),
    events: eventRows.map((row) => ({
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      occurredAt: String(row.occurred_at),
      sequenceNo: Number(row.sequence_no),
    })),
  };
}

export async function buildProjectView(
  scope: RequestScope,
  projectId: string,
  viewType: VerifiedViewType,
) {
  const ledger = await loadProjectLedger(scope, projectId);
  if (viewType === "folder-summary") return buildFolderSummary(ledger);
  if (viewType === "timeline") return buildTimeline(ledger);
  if (viewType === "decisions") return buildDecisionLog(ledger);
  if (viewType === "preferences") return buildPreferences(ledger);
  if (viewType === "open-questions") return buildOpenQuestions(ledger);
  return buildRisks(ledger);
}

export async function buildProjectGapCheck(scope: RequestScope, projectId: string) {
  return buildGapCheck(await loadProjectLedger(scope, projectId));
}

export async function buildProjectAgenda(scope: RequestScope, projectId: string) {
  return { items: buildNextMeetingAgenda(await loadProjectLedger(scope, projectId)) };
}

export async function buildProjectBrief(scope: RequestScope, projectId: string) {
  return buildDeterministicBrief(await loadProjectLedger(scope, projectId));
}
