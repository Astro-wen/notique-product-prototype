import { getD1 } from "@/db";
import { validatePhotoBbox } from "@/lib/domain/evidence";
import {
  matchesFrozenOccurrenceTarget,
  OCCURRENCE_FROZEN_TARGET_PREDICATE_SQL,
} from "@/lib/domain/occurrence-conversion";
import {
  DomainConflictError,
  planRelationCarryForward,
  validateExplicitClaimEditProjection,
} from "@/lib/domain/claim-state";
import { ApiFault } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import { claimRecord } from "@/lib/server/db/records";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import type {
  BatchClaimVerdictRequest,
  ClaimRecord,
  ClaimRelationForReviewRecord,
  ClaimVerdictRequest,
  OccurrenceConversionClaimInput,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

const CLAIM_SELECT = `
  SELECT c.*,
         cv.version_no,
         cv.statement,
         cv.normalized_value_json,
         cv.uncertainty_json,
         cv.source AS version_source
    FROM claims c
    JOIN claim_versions cv ON cv.id = c.current_version_id`;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function now(): string {
  return new Date().toISOString();
}

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function all(sql: string, bindings: unknown[]): Promise<Row[]> {
  return (await getD1().prepare(sql).bind(...bindings).all<Row>()).results ?? [];
}

async function claimRow(scope: RequestScope, claimId: string): Promise<Row> {
  const row = await first(
    `${CLAIM_SELECT} WHERE c.id = ? AND c.workspace_id = ?`,
    [claimId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Claim was not found.");
  }
  return row;
}

async function evidenceIds(versionId: string): Promise<string[]> {
  const rows = await all(
    `SELECT id FROM evidence_refs
      WHERE claim_version_id = ? AND structural_validation_status = 'valid'
      ORDER BY created_at`,
    [versionId],
  );
  return rows.map((row) => String(row.id));
}

function acceptReviewedEvidenceStatement(versionId: string): D1PreparedStatement {
  return getD1()
    .prepare(
      `UPDATE evidence_refs
          SET semantic_support_verdict = CASE evidence_role
                WHEN 'direct' THEN 'fully_supports'
                WHEN 'corroborating' THEN 'partially_supports'
                ELSE semantic_support_verdict
              END
        WHERE claim_version_id = ?
          AND structural_validation_status = 'valid'
          AND evidence_role IN ('direct', 'corroborating')`,
    )
    .bind(versionId);
}

async function hasBatchReviewAttestation(
  scope: RequestScope,
  claimId: string,
  versionId: string,
): Promise<boolean> {
  return Boolean(await first(
    `SELECT 1 AS reviewed
       FROM claim_evidence_review_attestations
      WHERE workspace_id = ? AND actor_id = ?
        AND claim_id = ? AND claim_version_id = ?`,
    [scope.workspaceId, scope.actorId, claimId, versionId],
  ));
}

export async function getClaim(
  scope: RequestScope,
  claimId: string,
): Promise<ClaimRecord> {
  const row = await claimRow(scope, claimId);
  const relationRows = await all(
    `SELECT r.*, target.id AS target_claim_id,
            target_version.statement AS target_statement
       FROM claim_relations r
       JOIN claim_versions target_version ON target_version.id = r.target_claim_version_id
       JOIN claims target ON target.id = target_version.claim_id
      WHERE r.source_claim_version_id = ? AND r.workspace_id = ?
        AND r.status IN ('proposed', 'active')
        AND (r.contradiction_status IS NULL OR r.contradiction_status = 'open')
        AND target.current_version_id = r.target_claim_version_id
        AND target.review_status = 'verified'
        AND target.lifecycle_status <> 'withdrawn'
      ORDER BY r.created_at, r.id`,
    [String(row.current_version_id), scope.workspaceId],
  );
  const relationsForReview: ClaimRelationForReviewRecord[] = relationRows.map((relation) => ({
    id: String(relation.id),
    type: String(relation.type) as ClaimRelationForReviewRecord["type"],
    status: String(relation.status) as ClaimRelationForReviewRecord["status"],
    target_claim_id: String(relation.target_claim_id),
    target_claim_version_id: String(relation.target_claim_version_id),
    target_statement: String(relation.target_statement),
    reason: relation.reason == null ? null : String(relation.reason),
    confidence: relation.confidence == null ? null : Number(relation.confidence),
  }));
  const versionId = String(row.current_version_id);
  const [claimEvidenceIds, batchReviewAttested] = await Promise.all([
    evidenceIds(versionId),
    hasBatchReviewAttestation(scope, claimId, versionId),
  ]);
  return claimRecord(row, claimEvidenceIds, relationsForReview, batchReviewAttested);
}

function lifecycleRecalculationStatements(
  projectId: string,
  timestamp: string,
): D1PreparedStatement[] {
  const db = getD1();
  return [
    db
      .prepare(
        `UPDATE claims AS c
            SET lifecycle_status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM claim_relations r
                    WHERE r.target_claim_version_id = c.current_version_id
                      AND r.status = 'active' AND r.type = 'supersedes'
                  ) THEN 'superseded'
                  WHEN EXISTS (
                    SELECT 1 FROM claim_relations r
                    WHERE r.target_claim_version_id = c.current_version_id
                      AND r.status = 'active' AND r.type = 'resolves'
                  ) THEN 'resolved'
                  ELSE 'active'
                END,
                resolved_at = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM claim_relations r
                    WHERE r.target_claim_version_id = c.current_version_id
                      AND r.status = 'active' AND r.type = 'resolves'
                  ) THEN COALESCE(c.resolved_at, ?)
                  ELSE NULL
                END,
                updated_at = ?
          WHERE c.project_id = ? AND c.review_status = 'verified'
            AND c.lifecycle_status <> 'withdrawn'`,
      )
      .bind(timestamp, timestamp, projectId),
  ];
}

function guardStatement(
  guardId: string,
  predicateSql: string,
  bindings: unknown[],
  timestamp: string,
): D1PreparedStatement {
  return getD1()
    .prepare(
      `INSERT INTO mutation_guards (id, guard_value, created_at)
       SELECT ?, CASE WHEN (${predicateSql}) THEN 1 ELSE 0 END, ?`,
    )
    .bind(guardId, ...bindings, timestamp);
}

function deleteGuard(guardId: string): D1PreparedStatement {
  return getD1().prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId);
}

function conflict(): ApiFault {
  return new ApiFault(
    409,
    "CLAIM_VERSION_CONFLICT",
    "Claim changed. Refresh before submitting this decision.",
  );
}

export async function attestClaimEvidenceReview(
  scope: RequestScope,
  claimId: string,
  baseVersionId: string,
  idempotencyKey: string,
): Promise<ClaimRecord> {
  const endpointScope = `claims/${claimId}/evidence-review-attestations`;
  const request = { base_version_id: baseVersionId };
  const replay = await findMutationReplay<{ claimId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    request,
  );
  if (replay.response) return getClaim(scope, replay.response.claimId);

  const existing = await claimRow(scope, claimId);
  if (String(existing.current_version_id) !== baseVersionId) throw conflict();
  if (String(existing.review_status) !== "pending") {
    throw new ApiFault(
      409,
      "CLAIM_STATE_CONFLICT",
      "Only a pending Claim can be marked ready for batch confirmation.",
    );
  }
  const reviewId = id("erv");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      guardStatement(
        guardId,
        `EXISTS (
           SELECT 1 FROM claims
            WHERE id = ? AND workspace_id = ? AND current_version_id = ?
              AND review_status = 'pending'
         ) AND EXISTS (
           SELECT 1 FROM evidence_refs
            WHERE claim_version_id = ?
              AND structural_validation_status = 'valid'
              AND evidence_role IN ('direct', 'corroborating')
         )`,
        [claimId, scope.workspaceId, baseVersionId, baseVersionId],
        timestamp,
      ),
      db
        .prepare(
          `INSERT OR IGNORE INTO claim_evidence_review_attestations
           (id, workspace_id, project_id, claim_id, claim_version_id, actor_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          reviewId,
          scope.workspaceId,
          existing.project_id,
          claimId,
          baseVersionId,
          scope.actorId,
          timestamp,
        ),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { claimId },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<{ claimId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      request,
    );
    if (recovered.response) return getClaim(scope, recovered.response.claimId);
    throw conflict();
  }
  return getClaim(scope, claimId);
}

export async function applyClaimVerdict(
  scope: RequestScope,
  claimId: string,
  input: ClaimVerdictRequest,
  idempotencyKey: string,
): Promise<{ claim: ClaimRecord; verdictId: string }> {
  const endpointScope = `claims/${claimId}/verdicts`;
  const replay = await findMutationReplay<{ claimId: string; verdictId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) {
    return {
      claim: await getClaim(scope, replay.response.claimId),
      verdictId: replay.response.verdictId,
    };
  }
  const existing = await claimRow(scope, claimId);
  if (String(existing.current_version_id) !== input.base_version_id) throw conflict();
  const verdictId = id("vdt");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();

  if (input.action === "confirm") {
    if (String(existing.review_status) !== "pending") {
      throw new ApiFault(409, "CLAIM_STATE_CONFLICT", "Only pending claims can be confirmed.");
    }
    const validEvidence = await first(
      `SELECT COUNT(*) AS count FROM evidence_refs
        WHERE claim_version_id = ? AND structural_validation_status = 'valid'
          AND evidence_role IN ('direct', 'corroborating')`,
      [input.base_version_id],
    );
    if (Number(validEvidence?.count ?? 0) === 0) {
      throw new ApiFault(
        422,
        "BAD_REQUEST",
        "A claim needs valid direct or corroborating evidence before confirmation.",
      );
    }
    const targetConflict = await first(
      `SELECT r.id FROM claim_relations r
        JOIN claim_versions target_version ON target_version.id = r.target_claim_version_id
        JOIN claims target_claim ON target_claim.id = target_version.claim_id
       WHERE r.source_claim_version_id = ? AND r.status = 'proposed'
         AND target_claim.current_version_id <> r.target_claim_version_id
       LIMIT 1`,
      [input.base_version_id],
    );
    if (targetConflict) throw conflict();

    try {
      await db.batch([
        guardStatement(
          guardId,
          `EXISTS (
             SELECT 1 FROM claims
              WHERE id = ? AND workspace_id = ? AND current_version_id = ?
                AND review_status = 'pending'
           ) AND EXISTS (
             SELECT 1 FROM evidence_refs
              WHERE claim_version_id = ?
                AND structural_validation_status = 'valid'
                AND evidence_role IN ('direct', 'corroborating')
           ) AND NOT EXISTS (
             SELECT 1 FROM claim_relations r
             JOIN claim_versions target_version
               ON target_version.id = r.target_claim_version_id
             JOIN claims target_claim ON target_claim.id = target_version.claim_id
              WHERE r.source_claim_version_id = ? AND r.status = 'proposed'
                AND target_claim.current_version_id <> r.target_claim_version_id
           )`,
          [
            claimId,
            scope.workspaceId,
            input.base_version_id,
            input.base_version_id,
            input.base_version_id,
          ],
          timestamp,
        ),
        db
          .prepare(
            `UPDATE claims SET review_status = 'verified', updated_at = ?
              WHERE id = ? AND workspace_id = ? AND current_version_id = ?`,
          )
          .bind(timestamp, claimId, scope.workspaceId, input.base_version_id),
        acceptReviewedEvidenceStatement(input.base_version_id),
        db
          .prepare(
            `INSERT INTO verdicts
             (id, workspace_id, project_id, claim_id, action, base_version_id,
              user_id, explanation, created_at)
             VALUES (?, ?, ?, ?, 'confirm', ?, ?, ?, ?)`,
          )
          .bind(
            verdictId,
            scope.workspaceId,
            existing.project_id,
            claimId,
            input.base_version_id,
            scope.actorId,
            input.explanation ?? null,
            timestamp,
          ),
        db
          .prepare(
            `UPDATE claim_relations SET status = 'active'
              WHERE source_claim_version_id = ? AND status = 'proposed'`,
          )
          .bind(input.base_version_id),
        ...lifecycleRecalculationStatements(String(existing.project_id), timestamp),
        db
          .prepare(
            `UPDATE projects
                SET ledger_version = ledger_version + 1,
                    context_version = context_version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          )
          .bind(timestamp, existing.project_id, scope.workspaceId),
        mutationReplayStatement(
          scope,
          endpointScope,
          idempotencyKey,
          replay.requestHash,
          { claimId, verdictId },
          timestamp,
        ),
        deleteGuard(guardId),
      ]);
    } catch {
      const recovered = await findMutationReplay<{ claimId: string; verdictId: string }>(
        scope,
        endpointScope,
        idempotencyKey,
        input,
      );
      if (recovered.response) {
        return {
          claim: await getClaim(scope, recovered.response.claimId),
          verdictId: recovered.response.verdictId,
        };
      }
      throw conflict();
    }
  } else if (input.action === "reject") {
    if (String(existing.review_status) !== "pending") {
      throw new ApiFault(409, "CLAIM_STATE_CONFLICT", "Only pending claims can be rejected.");
    }
    try {
      await db.batch([
        guardStatement(
          guardId,
          `EXISTS (
             SELECT 1 FROM claims
              WHERE id = ? AND workspace_id = ? AND current_version_id = ?
                AND review_status = 'pending'
           )`,
          [claimId, scope.workspaceId, input.base_version_id],
          timestamp,
        ),
        db
          .prepare(
            `UPDATE claims SET review_status = 'rejected', updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          )
          .bind(timestamp, claimId, scope.workspaceId),
        db
          .prepare(
            `UPDATE claim_relations SET status = 'rejected'
              WHERE source_claim_version_id = ? AND status = 'proposed'`,
          )
          .bind(input.base_version_id),
        db
          .prepare(
            `INSERT INTO verdicts
             (id, workspace_id, project_id, claim_id, action, base_version_id,
              user_id, explanation, created_at)
             VALUES (?, ?, ?, ?, 'reject', ?, ?, ?, ?)`,
          )
          .bind(
            verdictId,
            scope.workspaceId,
            existing.project_id,
            claimId,
            input.base_version_id,
            scope.actorId,
            input.explanation ?? null,
            timestamp,
          ),
        db
          .prepare(
            `UPDATE projects SET ledger_version = ledger_version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          )
          .bind(timestamp, existing.project_id, scope.workspaceId),
        mutationReplayStatement(
          scope,
          endpointScope,
          idempotencyKey,
          replay.requestHash,
          { claimId, verdictId },
          timestamp,
        ),
        deleteGuard(guardId),
      ]);
    } catch {
      const recovered = await findMutationReplay<{ claimId: string; verdictId: string }>(
        scope,
        endpointScope,
        idempotencyKey,
        input,
      );
      if (recovered.response) {
        return {
          claim: await getClaim(scope, recovered.response.claimId),
          verdictId: recovered.response.verdictId,
        };
      }
      throw conflict();
    }
  } else {
    const edit = input.edit;
    if (!edit?.statement.trim()) {
      throw new ApiFault(400, "BAD_REQUEST", "edit.statement is required for an edit verdict.");
    }
    let projection;
    try {
      projection = validateExplicitClaimEditProjection({
        type: edit.type,
        normalizedValue: edit.normalized_value,
        uncertainty: edit.uncertainty,
      });
    } catch (error) {
      if (error instanceof DomainConflictError) {
        throw new ApiFault(400, "BAD_REQUEST", error.message);
      }
      throw error;
    }
    if (!edit.retain_existing_evidence && !edit.evidence_ref_ids?.length && !edit.secondary_evidence_note?.trim()) {
      throw new ApiFault(
        400,
        "BAD_REQUEST",
        "Edit must explicitly retain evidence, select new evidence, or add secondary evidence.",
      );
    }
    const selectedEvidence = edit.retain_existing_evidence
      ? await all(
          `SELECT * FROM evidence_refs
            WHERE claim_version_id = ? AND structural_validation_status = 'valid'`,
          [input.base_version_id],
        )
      : edit.evidence_ref_ids?.length
        ? await all(
            `SELECT * FROM evidence_refs
              WHERE id IN (${edit.evidence_ref_ids.map(() => "?").join(",")})
                AND workspace_id = ? AND project_id = ?
                AND structural_validation_status = 'valid'`,
            [...edit.evidence_ref_ids, scope.workspaceId, existing.project_id],
          )
        : [];
    if (
      edit.evidence_ref_ids?.length &&
      selectedEvidence.length !== new Set(edit.evidence_ref_ids).size
    ) {
      throw new ApiFault(400, "BAD_REQUEST", "One or more selected evidence references are invalid.");
    }
    const hasSecondaryEvidenceNote = Boolean(edit.secondary_evidence_note?.trim());
    const supportingEvidenceIds = selectedEvidence
      .filter((row) => row.evidence_role === "direct" || row.evidence_role === "corroborating")
      .map((row) => String(row.id));
    if (!hasSecondaryEvidenceNote && supportingEvidenceIds.length === 0) {
      throw new ApiFault(
        422,
        "EVIDENCE_SUPPORT_REQUIRED",
        "An edited Claim needs at least one direct or corroborating Evidence Ref, or a secondary evidence note.",
      );
    }
    const relationRows = (await all(
      `SELECT r.*, target.id AS target_claim_id,
              target.current_version_id AS target_current_version_id,
              target.review_status AS target_review_status,
              target.lifecycle_status AS target_lifecycle_status
         FROM claim_relations r
         JOIN claim_versions target_version ON target_version.id = r.target_claim_version_id
         JOIN claims target ON target.id = target_version.claim_id
        WHERE r.source_claim_version_id = ? AND r.workspace_id = ?
          AND r.status IN ('proposed', 'active')
          AND (r.contradiction_status IS NULL OR r.contradiction_status = 'open')
        ORDER BY r.created_at, r.id`,
      [input.base_version_id, scope.workspaceId],
    )).map((relation) => ({
      ...relation,
      id: String(relation.id),
      type: String(relation.type),
      status: String(relation.status),
      target_claim_version_id: String(relation.target_claim_version_id),
      target_current_version_id: String(relation.target_current_version_id),
      target_review_status: String(relation.target_review_status),
      target_lifecycle_status: String(relation.target_lifecycle_status),
      reason: relation.reason == null ? null : String(relation.reason),
      confidence: relation.confidence == null ? null : Number(relation.confidence),
    }));
    let relationPlan;
    try {
      relationPlan = planRelationCarryForward(relationRows, edit.retain_relation_ids);
    } catch (error) {
      if (error instanceof DomainConflictError) {
        throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", error.message);
      }
      throw error;
    }
    for (const relation of relationPlan.retained) {
      if (
        String(relation.target_current_version_id) !== String(relation.target_claim_version_id) ||
        String(relation.target_review_status) !== "verified" ||
        String(relation.target_lifecycle_status) === "withdrawn"
      ) {
        throw conflict();
      }
    }
    const projectVersionRow = await first(
      `SELECT context_version FROM projects WHERE id = ? AND workspace_id = ?`,
      [existing.project_id, scope.workspaceId],
    );
    if (!projectVersionRow) throw conflict();
    const baseProjectContextVersion = Number(projectVersionRow.context_version);
    const newVersionId = id("cv");
    const newVersionNo = Number(existing.version_no) + 1;
    const userNoteId = edit.secondary_evidence_note?.trim() ? id("unote") : null;
    const relationMutations = relationRows.map((relation) => ({
      row: relation,
      retained: relationPlan.retained.some((item) => item.id === relation.id),
      verdictId: id("rvdt"),
      replacementId: relationPlan.retained.some((item) => item.id === relation.id)
        ? id("rel")
        : null,
    }));
    const evidenceStatements = selectedEvidence.map((row) =>
      db
        .prepare(
          `INSERT INTO evidence_refs (
            id, workspace_id, project_id, event_id, claim_version_id, kind,
            asset_version_id, user_note_id, segment_ids_json, quote_raw,
            start_ms, end_ms, page_number, bbox_json, observation,
            evidence_role, provenance_grade, structural_validation_status,
            semantic_support_verdict, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id("evr"),
          row.workspace_id,
          row.project_id,
          row.event_id,
          newVersionId,
          row.kind,
          row.asset_version_id,
          row.user_note_id,
          row.segment_ids_json,
          row.quote_raw,
          row.start_ms,
          row.end_ms,
          row.page_number,
          row.bbox_json,
          row.observation,
          row.evidence_role,
          row.provenance_grade,
          row.structural_validation_status,
          row.evidence_role === "direct"
            ? "fully_supports"
            : row.evidence_role === "corroborating"
              ? "partially_supports"
              : "unreviewed",
          timestamp,
        ),
    );
    if (userNoteId) {
      evidenceStatements.push(
        db
          .prepare(
            `INSERT INTO user_notes
             (id, workspace_id, project_id, claim_id, verdict_id, author_id, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            userNoteId,
            scope.workspaceId,
            existing.project_id,
            claimId,
            verdictId,
            scope.actorId,
            edit.secondary_evidence_note!.trim(),
            timestamp,
          ),
        db
          .prepare(
            `INSERT INTO evidence_refs (
              id, workspace_id, project_id, event_id, claim_version_id, kind,
              user_note_id, evidence_role, provenance_grade,
              structural_validation_status, semantic_support_verdict, created_at
            ) VALUES (?, ?, ?, ?, ?, 'user_note', ?, 'direct', 'secondary',
                      'valid', 'fully_supports', ?)`,
          )
          .bind(
            id("evr"),
            scope.workspaceId,
            existing.project_id,
            existing.event_id,
            newVersionId,
            userNoteId,
            timestamp,
          ),
      );
    }

    try {
      await db.batch([
        guardStatement(
          guardId,
          `EXISTS (
             SELECT 1 FROM claims
              WHERE id = ? AND workspace_id = ? AND current_version_id = ?
                AND review_status IN ('pending', 'verified')
                AND lifecycle_status <> 'withdrawn'
           ) AND EXISTS (
             SELECT 1 FROM projects
              WHERE id = ? AND workspace_id = ? AND context_version = ?
           )${hasSecondaryEvidenceNote ? "" : ` AND EXISTS (
             SELECT 1 FROM evidence_refs
              WHERE id IN (${supportingEvidenceIds.map(() => "?").join(",")})
                AND workspace_id = ? AND project_id = ?
                AND structural_validation_status = 'valid'
                AND evidence_role IN ('direct', 'corroborating')
           )`}${relationRows.map(() => ` AND EXISTS (
             SELECT 1 FROM claim_relations
              WHERE id = ? AND workspace_id = ? AND source_claim_version_id = ?
                AND status = ?
           )`).join("")}${relationPlan.retained.map(() => ` AND EXISTS (
             SELECT 1 FROM claim_relations r
             JOIN claim_versions target_version ON target_version.id = r.target_claim_version_id
             JOIN claims target ON target.id = target_version.claim_id
              WHERE r.id = ? AND r.source_claim_version_id = ?
                AND target.current_version_id = r.target_claim_version_id
                AND target.review_status = 'verified'
                AND target.lifecycle_status <> 'withdrawn'
           )`).join("")}`,
          [
            claimId,
            scope.workspaceId,
            input.base_version_id,
            existing.project_id,
            scope.workspaceId,
            baseProjectContextVersion,
            ...(hasSecondaryEvidenceNote
              ? []
              : [...supportingEvidenceIds, scope.workspaceId, existing.project_id]),
            ...relationRows.flatMap((relation) => [
              relation.id,
              scope.workspaceId,
              input.base_version_id,
              relation.status,
            ]),
            ...relationPlan.retained.flatMap((relation) => [
              relation.id,
              input.base_version_id,
            ]),
          ],
          timestamp,
        ),
        db
          .prepare(
            `INSERT INTO claim_versions
             (id, claim_id, version_no, statement, normalized_value_json,
              uncertainty_json, source, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'human', ?, ?)`,
          )
          .bind(
            newVersionId,
            claimId,
            newVersionNo,
            edit.statement.trim(),
            projection.normalizedValue === null
              ? null
              : JSON.stringify(projection.normalizedValue),
            projection.uncertainty === null
              ? null
              : JSON.stringify(projection.uncertainty),
            scope.actorId,
            timestamp,
          ),
        db
          .prepare(
            `UPDATE claims
                SET current_version_id = ?, type = ?,
                    confidence = NULL, needs_additional_evidence = ?,
                    review_status = 'verified', lifecycle_status = 'active',
                    resolved_at = NULL, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          )
          .bind(
            newVersionId,
            projection.type,
            projection.uncertainty === null ? 0 : 1,
            timestamp,
            claimId,
            scope.workspaceId,
          ),
        db
          .prepare(
            `UPDATE claim_relations SET status = 'inactive'
              WHERE status = 'active'
                AND (source_claim_version_id = ? OR target_claim_version_id = ?)`,
          )
          .bind(input.base_version_id, input.base_version_id),
        ...relationMutations.map(({ row, retained, replacementId }) =>
          db
            .prepare(
              `UPDATE claim_relations
                  SET status = ?, resolved_by_relation_id = ?
                WHERE id = ? AND source_claim_version_id = ?`,
            )
            .bind(
              retained || String(row.status) === "active" ? "inactive" : "rejected",
              replacementId,
              row.id,
              input.base_version_id,
            ),
        ),
        ...relationMutations.flatMap(({ row, retained, verdictId: relationVerdictId, replacementId }) => [
          db
            .prepare(
              `INSERT INTO relation_verdicts
               (id, relation_id, action, base_relation_status, user_id, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              relationVerdictId,
              row.id,
              retained ? "confirm" : "reject",
              row.status,
              scope.actorId,
              timestamp,
            ),
          ...(retained && replacementId
            ? [
                db
                  .prepare(
                    `INSERT INTO claim_relations (
                      id, workspace_id, project_id, type,
                      source_claim_version_id, target_claim_version_id,
                      context_version, replaces_relation_id, status,
                      contradiction_status, reason, confidence, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
                  )
                  .bind(
                    replacementId,
                    scope.workspaceId,
                    existing.project_id,
                    row.type,
                    newVersionId,
                    row.target_claim_version_id,
                    baseProjectContextVersion + 1,
                    row.id,
                    String(row.type) === "contradicts" ? "open" : null,
                    row.reason,
                    row.confidence,
                    timestamp,
                  ),
              ]
            : []),
        ]),
        db
          .prepare(
            `INSERT INTO verdicts
             (id, workspace_id, project_id, claim_id, action, base_version_id,
              new_version_id, user_id, explanation, created_at)
             VALUES (?, ?, ?, ?, 'edit', ?, ?, ?, ?, ?)`,
          )
          .bind(
            verdictId,
            scope.workspaceId,
            existing.project_id,
            claimId,
            input.base_version_id,
            newVersionId,
            scope.actorId,
            input.explanation ?? null,
            timestamp,
          ),
        ...evidenceStatements,
        ...lifecycleRecalculationStatements(String(existing.project_id), timestamp),
        db
          .prepare(
            `UPDATE projects
                SET ledger_version = ledger_version + 1,
                    context_version = context_version + 1, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          )
          .bind(timestamp, existing.project_id, scope.workspaceId),
        mutationReplayStatement(
          scope,
          endpointScope,
          idempotencyKey,
          replay.requestHash,
          { claimId, verdictId },
          timestamp,
        ),
        deleteGuard(guardId),
      ]);
    } catch {
      const recovered = await findMutationReplay<{ claimId: string; verdictId: string }>(
        scope,
        endpointScope,
        idempotencyKey,
        input,
      );
      if (recovered.response) {
        return {
          claim: await getClaim(scope, recovered.response.claimId),
          verdictId: recovered.response.verdictId,
        };
      }
      throw conflict();
    }
  }

  return { claim: await getClaim(scope, claimId), verdictId };
}

export async function withdrawClaim(
  scope: RequestScope,
  claimId: string,
  input: { baseVersionId: string; explanation?: string },
  idempotencyKey: string,
): Promise<{ claim: ClaimRecord; verdictId: string }> {
  const endpointScope = `claims/${claimId}/withdraw`;
  const replay = await findMutationReplay<{ claimId: string; verdictId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) {
    return {
      claim: await getClaim(scope, replay.response.claimId),
      verdictId: replay.response.verdictId,
    };
  }
  const existing = await claimRow(scope, claimId);
  if (String(existing.current_version_id) !== input.baseVersionId) throw conflict();
  if (String(existing.review_status) !== "verified") {
    throw new ApiFault(409, "CLAIM_STATE_CONFLICT", "Only verified claims can be withdrawn.");
  }
  if (String(existing.lifecycle_status) === "withdrawn") {
    throw new ApiFault(409, "CLAIM_STATE_CONFLICT", "Claim is already withdrawn.");
  }
  const verdictId = id("vdt");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      guardStatement(
        guardId,
        `EXISTS (
           SELECT 1 FROM claims
            WHERE id = ? AND workspace_id = ? AND current_version_id = ?
              AND review_status = 'verified' AND lifecycle_status <> 'withdrawn'
         )`,
        [claimId, scope.workspaceId, input.baseVersionId],
        timestamp,
      ),
      db
        .prepare(
          `UPDATE claims
              SET lifecycle_status = 'withdrawn', withdraw_reason = ?, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .bind(input.explanation ?? "user_withdrawal", timestamp, claimId, scope.workspaceId),
      db
        .prepare(
          `UPDATE claim_relations SET status = 'inactive'
            WHERE status = 'active'
              AND (source_claim_version_id = ? OR target_claim_version_id = ?)`,
        )
        .bind(input.baseVersionId, input.baseVersionId),
      db
        .prepare(
          `INSERT INTO verdicts
           (id, workspace_id, project_id, claim_id, action, base_version_id,
            user_id, explanation, created_at)
           VALUES (?, ?, ?, ?, 'withdraw', ?, ?, ?, ?)`,
        )
        .bind(
          verdictId,
          scope.workspaceId,
          existing.project_id,
          claimId,
          input.baseVersionId,
          scope.actorId,
          input.explanation ?? null,
          timestamp,
        ),
      ...lifecycleRecalculationStatements(String(existing.project_id), timestamp),
      db
        .prepare(
          `UPDATE projects
              SET ledger_version = ledger_version + 1,
                  context_version = context_version + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .bind(timestamp, existing.project_id, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { claimId, verdictId },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<{ claimId: string; verdictId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) {
      return {
        claim: await getClaim(scope, recovered.response.claimId),
        verdictId: recovered.response.verdictId,
      };
    }
    throw conflict();
  }
  return { claim: await getClaim(scope, claimId), verdictId };
}

export async function applyBatchVerdicts(
  scope: RequestScope,
  input: BatchClaimVerdictRequest,
  idempotencyKey: string,
): Promise<Array<{ claim: ClaimRecord; verdictId: string }>> {
  if (!input.verdicts.length || input.verdicts.length > 50) {
    throw new ApiFault(400, "BAD_REQUEST", "Batch must contain 1 to 50 verdicts.");
  }
  if (new Set(input.verdicts.map((item) => item.claim_id)).size !== input.verdicts.length) {
    throw new ApiFault(400, "BAD_REQUEST", "A claim can appear only once in a batch.");
  }
  const endpointScope = "claims/batch-verdicts";
  const replay = await findMutationReplay<{
    items: Array<{ claimId: string; verdictId: string }>;
  }>(scope, endpointScope, idempotencyKey, input);
  if (replay.response) {
    return Promise.all(
      replay.response.items.map(async (item) => ({
        claim: await getClaim(scope, item.claimId),
        verdictId: item.verdictId,
      })),
    );
  }
  const rows = await Promise.all(
    input.verdicts.map((item) => claimRow(scope, item.claim_id)),
  );
  for (const item of input.verdicts) {
    if (item.action !== "confirm") continue;
    const reviewAttestation = await first(
      `SELECT 1 AS reviewed
         FROM claim_evidence_review_attestations
        WHERE workspace_id = ? AND actor_id = ?
          AND claim_id = ? AND claim_version_id = ?`,
      [scope.workspaceId, scope.actorId, item.claim_id, item.base_version_id],
    );
    if (!reviewAttestation) {
      throw new ApiFault(
        422,
        "EVIDENCE_REVIEW_REQUIRED",
        "Open this Claim and explicitly attest that its Evidence was reviewed before batch confirmation.",
        { claim_id: item.claim_id },
      );
    }
    const validEvidence = await first(
      `SELECT COUNT(*) AS count FROM evidence_refs
        WHERE claim_version_id = ? AND structural_validation_status = 'valid'
          AND evidence_role IN ('direct', 'corroborating')`,
      [item.base_version_id],
    );
    if (Number(validEvidence?.count ?? 0) === 0) {
      throw new ApiFault(
        422,
        "BAD_REQUEST",
        "Every confirmed claim needs valid direct or corroborating evidence.",
        { claim_id: item.claim_id },
      );
    }
    const staleTarget = await first(
      `SELECT r.id FROM claim_relations r
        JOIN claim_versions target_version ON target_version.id = r.target_claim_version_id
        JOIN claims target_claim ON target_claim.id = target_version.claim_id
       WHERE r.source_claim_version_id = ? AND r.status = 'proposed'
         AND target_claim.current_version_id <> r.target_claim_version_id
       LIMIT 1`,
      [item.base_version_id],
    );
    if (staleTarget) throw conflict();
  }
  const timestamp = now();
  const db = getD1();
  const guardId = id("guard");
  const verdictIds = input.verdicts.map(() => id("vdt"));
  const guardClauses: string[] = [];
  const guardBindings: unknown[] = [];
  input.verdicts.forEach((item) => {
    let clause = `EXISTS (SELECT 1 FROM claims WHERE id = ? AND workspace_id = ?
                            AND current_version_id = ? AND review_status = 'pending')`;
    guardBindings.push(item.claim_id, scope.workspaceId, item.base_version_id);
    if (item.action === "confirm") {
      clause += ` AND EXISTS (
        SELECT 1 FROM evidence_refs WHERE claim_version_id = ?
          AND structural_validation_status = 'valid'
          AND evidence_role IN ('direct', 'corroborating')
      ) AND EXISTS (
        SELECT 1 FROM claim_evidence_review_attestations
         WHERE workspace_id = ? AND actor_id = ?
           AND claim_id = ? AND claim_version_id = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM claim_relations r
        JOIN claim_versions target_version ON target_version.id = r.target_claim_version_id
        JOIN claims target_claim ON target_claim.id = target_version.claim_id
        WHERE r.source_claim_version_id = ? AND r.status = 'proposed'
          AND target_claim.current_version_id <> r.target_claim_version_id
      )`;
      guardBindings.push(
        item.base_version_id,
        scope.workspaceId,
        scope.actorId,
        item.claim_id,
        item.base_version_id,
        item.base_version_id,
      );
    }
    guardClauses.push(clause);
  });
  try {
    await db.batch([
      guardStatement(guardId, guardClauses.join(" AND "), guardBindings, timestamp),
      ...input.verdicts.flatMap((item, index) => [
        db
          .prepare(
            `UPDATE claims SET review_status = ?, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
          )
          .bind(item.action === "confirm" ? "verified" : "rejected", timestamp, item.claim_id, scope.workspaceId),
        ...(item.action === "confirm"
          ? [acceptReviewedEvidenceStatement(item.base_version_id)]
          : []),
        db
          .prepare(
            `UPDATE claim_relations SET status = ?
              WHERE source_claim_version_id = ? AND status = 'proposed'`,
          )
          .bind(item.action === "confirm" ? "active" : "rejected", item.base_version_id),
        db
          .prepare(
            `INSERT INTO verdicts
             (id, workspace_id, project_id, claim_id, action, base_version_id,
              user_id, explanation, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            verdictIds[index],
            scope.workspaceId,
            rows[index].project_id,
            item.claim_id,
            item.action,
            item.base_version_id,
            scope.actorId,
            item.explanation ?? null,
            timestamp,
          ),
      ]),
      ...[...new Set(rows.map((row) => String(row.project_id)))].flatMap((projectId) => {
        const changesContext = input.verdicts.some(
          (item, index) =>
            String(rows[index].project_id) === projectId && item.action === "confirm",
        );
        return [
          ...lifecycleRecalculationStatements(projectId, timestamp),
          db
            .prepare(
              `UPDATE projects
                  SET ledger_version = ledger_version + 1,
                      context_version = context_version + ?, updated_at = ?
                WHERE id = ? AND workspace_id = ?`,
            )
            .bind(changesContext ? 1 : 0, timestamp, projectId, scope.workspaceId),
        ];
      }),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        {
          items: input.verdicts.map((item, index) => ({
            claimId: item.claim_id,
            verdictId: verdictIds[index],
          })),
        },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<{
      items: Array<{ claimId: string; verdictId: string }>;
    }>(scope, endpointScope, idempotencyKey, input);
    if (recovered.response) {
      return Promise.all(
        recovered.response.items.map(async (item) => ({
          claim: await getClaim(scope, item.claimId),
          verdictId: item.verdictId,
        })),
      );
    }
    throw conflict();
  }
  return Promise.all(
    input.verdicts.map(async (item, index) => ({
      claim: await getClaim(scope, item.claim_id),
      verdictId: verdictIds[index],
    })),
  );
}

export async function applyOccurrenceVerdict(
  scope: RequestScope,
  candidateId: string,
  input: {
    action: "confirm" | "reject" | "convert_to_new_claim";
    targetBaseVersionId: string;
    newClaims?: OccurrenceConversionClaimInput[];
  },
  idempotencyKey: string,
) {
  const endpointScope = `occurrence-candidates/${candidateId}/verdicts`;
  type PersistedOccurrenceVerdict = {
    candidate_id: string;
    verdict_id: string;
    status: "confirm" | "reject" | "converted";
    converted_claim_ids?: string[];
  };
  const replay = await findMutationReplay<PersistedOccurrenceVerdict>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) {
    return {
      candidate_id: replay.response.candidate_id,
      verdict_id: replay.response.verdict_id,
      status: replay.response.status,
      converted_claims: await Promise.all(
        (replay.response.converted_claim_ids ?? []).map((claimId) => getClaim(scope, claimId)),
      ),
    };
  }
  const allowedClaimTypes = new Set([
    "budget", "preference", "requirement", "decision", "concern", "risk",
    "open_question", "person_role", "timing", "property_fact", "material",
    "measurement", "other",
  ]);
  const conversionClaims = input.action === "convert_to_new_claim" ? input.newClaims ?? [] : [];
  if (input.action === "convert_to_new_claim") {
    if (!conversionClaims.length || conversionClaims.length > 10) {
      throw new ApiFault(400, "BAD_REQUEST", "Conversion requires 1 to 10 new claims.");
    }
    for (const claim of conversionClaims) {
      if (
        typeof claim.statement !== "string" ||
        claim.statement.trim().length < 1 ||
        claim.statement.trim().length > 10_000 ||
        !allowedClaimTypes.has(claim.type)
      ) {
        throw new ApiFault(400, "BAD_REQUEST", "A converted claim is invalid.");
      }
    }
    if (
      new Set(conversionClaims.map((claim) => `${claim.type}\u0000${claim.statement.trim()}`)).size !==
      conversionClaims.length
    ) {
      throw new ApiFault(400, "BAD_REQUEST", "Converted claims must be unique.");
    }
  }
  const candidate = await first(
    `SELECT occ.*, c.current_version_id, c.review_status, c.lifecycle_status,
            c.type, c.project_id AS claim_project_id
       FROM claim_occurrence_candidates occ
       JOIN claims c ON c.id = occ.target_claim_id
      WHERE occ.id = ? AND occ.workspace_id = ? AND occ.project_id = c.project_id`,
    [candidateId, scope.workspaceId],
  );
  if (!candidate) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Occurrence candidate was not found.");
  }
  if (!matchesFrozenOccurrenceTarget({
    status: candidate.status,
    baseVersionId: candidate.base_version_id,
    targetClaimVersionId: candidate.target_claim_version_id,
    currentVersionId: candidate.current_version_id,
    reviewStatus: candidate.review_status,
    lifecycleStatus: candidate.lifecycle_status,
  }, input.targetBaseVersionId)) {
    throw conflict();
  }
  const verdictId = id("ovdt");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();
  type CandidateEvidence = {
    kind: "transcript" | "text" | "photo" | "document";
    assetVersionId: string;
    segmentIdsJson: string | null;
    quoteRaw: string | null;
    startMs: number | null;
    endMs: number | null;
    pageNumber: number | null;
    bboxJson: string | null;
    observation: string | null;
    evidenceRole: "direct" | "corroborating" | "contextual";
  };
  type CandidateEvidencePayload = {
    schema_version: "occurrence-evidence.v1";
    evidence: CandidateEvidence[];
  };
  let legacyEvidenceId: string | null = null;
  let candidateEvidence: CandidateEvidence[] = [];
  if (input.action === "confirm" || input.action === "convert_to_new_claim") {
    let payload: { id?: unknown } | CandidateEvidencePayload;
    try {
      payload = JSON.parse(String(candidate.evidence_ref_json)) as
        | { id?: unknown }
        | CandidateEvidencePayload;
    } catch {
      throw new ApiFault(422, "BAD_REQUEST", "Occurrence evidence payload is invalid.");
    }
    if ("id" in payload && typeof payload.id === "string" && payload.id) {
      legacyEvidenceId = payload.id;
    } else if (
      "schema_version" in payload &&
      payload.schema_version === "occurrence-evidence.v1" &&
      Array.isArray(payload.evidence)
    ) {
      candidateEvidence = payload.evidence;
    }
    if (!legacyEvidenceId && !candidateEvidence.length) {
      throw new ApiFault(422, "BAD_REQUEST", "Occurrence candidate has no validated evidence.");
    }
    if (input.action === "convert_to_new_claim" && legacyEvidenceId) {
      throw new ApiFault(422, "BAD_REQUEST", "Conversion requires canonical occurrence evidence.");
    }
  }
  for (const evidence of candidateEvidence) {
    if (
      !["transcript", "text", "photo", "document"].includes(evidence.kind) ||
      !evidence.assetVersionId ||
      !["direct", "corroborating", "contextual"].includes(evidence.evidenceRole)
    ) {
      throw new ApiFault(422, "BAD_REQUEST", "Occurrence evidence payload is invalid.");
    }
    if (evidence.kind === "transcript" || evidence.kind === "text") {
      let segmentIds: unknown;
      try {
        segmentIds = JSON.parse(evidence.segmentIdsJson ?? "null");
      } catch {
        segmentIds = null;
      }
      if (
        !Array.isArray(segmentIds) ||
        !segmentIds.length ||
        new Set(segmentIds).size !== segmentIds.length ||
        segmentIds.some((segmentId) => typeof segmentId !== "string" || !segmentId)
      ) {
        throw new ApiFault(422, "BAD_REQUEST", "Occurrence transcript evidence is invalid.");
      }
    }
    if (evidence.kind === "photo" && evidence.bboxJson !== null) {
      let bbox: unknown;
      try {
        bbox = JSON.parse(evidence.bboxJson);
      } catch {
        bbox = null;
      }
      if (!validatePhotoBbox(bbox)) {
        throw new ApiFault(422, "BAD_REQUEST", "Occurrence photo evidence is invalid.");
      }
    }
    if (
      evidence.kind === "document" &&
      evidence.pageNumber !== null &&
      (!Number.isSafeInteger(evidence.pageNumber) || evidence.pageNumber < 1)
    ) {
      throw new ApiFault(422, "BAD_REQUEST", "Occurrence document evidence is invalid.");
    }
  }
  const confirmationEvidenceIds = candidateEvidence.map(() => id("evr"));
  const occurrenceEvidenceId = legacyEvidenceId ?? confirmationEvidenceIds[0] ?? null;
  const convertedClaims = conversionClaims.map((claim, index) => ({
    input: { ...claim, statement: claim.statement.trim() },
    claimId: id("clm"),
    versionId: id("cv"),
    evidenceIds: candidateEvidence.map(() => id("evr")),
    clientClaimKey: `occurrence-conversion:${candidateId}:${index + 1}`,
  }));
  let guardPredicate = `EXISTS (
    SELECT 1 FROM claim_occurrence_candidates occ
    JOIN claims c ON c.id = occ.target_claim_id
    WHERE occ.id = ? AND occ.workspace_id = ?
      AND ${OCCURRENCE_FROZEN_TARGET_PREDICATE_SQL}
  )`;
  const guardBindings: unknown[] = [
    candidateId,
    scope.workspaceId,
    input.targetBaseVersionId,
    input.targetBaseVersionId,
  ];
  if (input.action === "confirm" || input.action === "convert_to_new_claim") {
    if (legacyEvidenceId) {
      guardPredicate += ` AND EXISTS (
        SELECT 1 FROM evidence_refs er
         WHERE er.id = ? AND er.workspace_id = ? AND er.project_id = ?
           AND er.event_id = ? AND er.structural_validation_status = 'valid'
      )`;
      guardBindings.push(
        legacyEvidenceId,
        scope.workspaceId,
        candidate.project_id,
        candidate.event_id,
      );
    }
    for (const evidence of candidateEvidence) {
      guardPredicate += ` AND EXISTS (
        SELECT 1 FROM asset_versions av
        JOIN assets a ON a.id = av.asset_id
        WHERE av.id = ? AND a.workspace_id = ? AND a.project_id = ?
          AND a.event_id = ?
      )`;
      guardBindings.push(
        evidence.assetVersionId,
        scope.workspaceId,
        candidate.project_id,
        candidate.event_id,
      );
      if (evidence.kind === "transcript" || evidence.kind === "text") {
        guardPredicate += ` AND NOT EXISTS (
          SELECT 1 FROM json_each(?) requested
           WHERE NOT EXISTS (
             SELECT 1 FROM text_segments ts
              WHERE ts.id = requested.value AND ts.asset_version_id = ?
                AND ts.workspace_id = ? AND ts.project_id = ? AND ts.event_id = ?
           )
        )`;
        guardBindings.push(
          evidence.segmentIdsJson,
          evidence.assetVersionId,
          scope.workspaceId,
          candidate.project_id,
          candidate.event_id,
        );
      }
    }
  }
  const evidenceInsertStatements = candidateEvidence.map((evidence, index) =>
    db
      .prepare(
        `INSERT INTO evidence_refs (
          id, workspace_id, project_id, event_id, claim_version_id, kind,
          asset_version_id, segment_ids_json, quote_raw, start_ms, end_ms,
          page_number, bbox_json, observation, evidence_role, provenance_grade,
          structural_validation_status, semantic_support_verdict, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'primary',
                  'valid', 'unreviewed', ?)`,
      )
      .bind(
        confirmationEvidenceIds[index],
        scope.workspaceId,
        candidate.project_id,
        candidate.event_id,
        input.targetBaseVersionId,
        evidence.kind,
        evidence.assetVersionId,
        evidence.segmentIdsJson,
        evidence.quoteRaw,
        evidence.startMs,
        evidence.endMs,
        evidence.pageNumber,
        evidence.bboxJson,
        evidence.observation,
        evidence.evidenceRole,
        timestamp,
      ),
  );
  const hasPrimarySupport = candidateEvidence.some(
    (evidence) => evidence.evidenceRole === "direct" || evidence.evidenceRole === "corroborating",
  );
  const convertedClaimStatements = convertedClaims.flatMap((converted) => [
    db
      .prepare(
        `INSERT INTO claims (
          id, workspace_id, project_id, event_id, extraction_run_id,
          client_claim_key, type, materiality, confidence,
          needs_additional_evidence, review_status, lifecycle_status,
          current_version_id, first_event_id, source, opened_at,
          repeat_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', NULL, ?, 'pending', 'active',
                  ?, ?, 'occurrence_conversion', ?, 0, ?, ?)`,
      )
      .bind(
        converted.claimId,
        scope.workspaceId,
        candidate.project_id,
        candidate.event_id,
        candidate.extraction_run_id,
        converted.clientClaimKey,
        converted.input.type,
        hasPrimarySupport ? 0 : 1,
        converted.versionId,
        candidate.event_id,
        converted.input.type === "open_question" ? timestamp : null,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO claim_versions (
          id, claim_id, version_no, statement, normalized_value_json,
          uncertainty_json, source, created_by, created_at
        ) VALUES (?, ?, 1, ?, NULL, NULL, 'human', ?, ?)`,
      )
      .bind(
        converted.versionId,
        converted.claimId,
        converted.input.statement,
        scope.actorId,
        timestamp,
      ),
    ...candidateEvidence.map((evidence, index) =>
      db
        .prepare(
          `INSERT INTO evidence_refs (
            id, workspace_id, project_id, event_id, claim_version_id, kind,
            asset_version_id, segment_ids_json, quote_raw, start_ms, end_ms,
            page_number, bbox_json, observation, evidence_role, provenance_grade,
            structural_validation_status, semantic_support_verdict, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'primary',
                    'valid', 'unreviewed', ?)`,
        )
        .bind(
          converted.evidenceIds[index],
          scope.workspaceId,
          candidate.project_id,
          candidate.event_id,
          converted.versionId,
          evidence.kind,
          evidence.assetVersionId,
          evidence.segmentIdsJson,
          evidence.quoteRaw,
          evidence.startMs,
          evidence.endMs,
          evidence.pageNumber,
          evidence.bboxJson,
          evidence.observation,
          evidence.evidenceRole,
          timestamp,
        ),
    ),
  ]);
  const persistedResult: PersistedOccurrenceVerdict = {
    candidate_id: candidateId,
    verdict_id: verdictId,
    status: input.action === "convert_to_new_claim" ? "converted" : input.action,
    converted_claim_ids: convertedClaims.map((converted) => converted.claimId),
  };
  try {
    await db.batch([
      guardStatement(
        guardId,
        guardPredicate,
        guardBindings,
        timestamp,
      ),
      db
        .prepare(
          `UPDATE claim_occurrence_candidates SET status = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          input.action === "confirm"
            ? "confirmed"
            : input.action === "convert_to_new_claim"
              ? "converted"
              : "rejected",
          timestamp,
          candidateId,
        ),
      db
        .prepare(
          `INSERT INTO occurrence_verdicts
           (id, candidate_id, action, target_base_version_id, user_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(verdictId, candidateId, input.action, input.targetBaseVersionId, scope.actorId, timestamp),
      ...(input.action === "confirm"
        ? [
            ...evidenceInsertStatements,
            db
              .prepare(
                `INSERT INTO claim_occurrences
                 (id, claim_id, claim_version_id, event_id, evidence_ref_id,
                  occurrence_verdict_id, confirmed_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                id("occ"),
                candidate.target_claim_id,
                input.targetBaseVersionId,
                candidate.event_id,
                occurrenceEvidenceId,
                verdictId,
                timestamp,
                timestamp,
              ),
            db
              .prepare(
            `UPDATE claims
                    SET last_repeated_at = ?, repeat_count = repeat_count + 1, updated_at = ?
                  WHERE id = ? AND lower(replace(type, ' ', '_')) = 'open_question'`,
              )
              .bind(timestamp, timestamp, candidate.target_claim_id),
          ]
        : []),
      ...(input.action === "convert_to_new_claim" ? convertedClaimStatements : []),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        persistedResult,
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<PersistedOccurrenceVerdict>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) {
      return {
        candidate_id: recovered.response.candidate_id,
        verdict_id: recovered.response.verdict_id,
        status: recovered.response.status,
        converted_claims: await Promise.all(
          (recovered.response.converted_claim_ids ?? []).map((claimId) => getClaim(scope, claimId)),
        ),
      };
    }
    throw conflict();
  }
  return {
    candidate_id: persistedResult.candidate_id,
    verdict_id: persistedResult.verdict_id,
    status: persistedResult.status,
    converted_claims: await Promise.all(
      (persistedResult.converted_claim_ids ?? []).map((claimId) => getClaim(scope, claimId)),
    ),
  };
}

export async function resolveContradiction(
  scope: RequestScope,
  relationId: string,
  input: {
    baseRelationStatus: string;
    sourceClaimVersionId: string;
    targetClaimVersionId: string;
    winningClaimVersionId: string;
    explanation?: string;
  },
  idempotencyKey: string,
) {
  const endpointScope = `claim-relations/${relationId}/resolve`;
  const replay = await findMutationReplay<{
    relation_id: string;
    verdict_id: string;
    status: "resolved";
  }>(scope, endpointScope, idempotencyKey, input);
  if (replay.response) return replay.response;
  const relation = await first(
    `SELECT * FROM claim_relations
      WHERE id = ? AND workspace_id = ? AND type = 'contradicts'`,
    [relationId, scope.workspaceId],
  );
  if (!relation) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Contradiction relation was not found.");
  }
  const endpoints = [String(relation.source_claim_version_id), String(relation.target_claim_version_id)];
  if (
    input.baseRelationStatus !== "active" ||
    relation.status !== "active" ||
    relation.status !== input.baseRelationStatus ||
    relation.contradiction_status !== "open" ||
    input.sourceClaimVersionId !== endpoints[0] ||
    input.targetClaimVersionId !== endpoints[1] ||
    !endpoints.includes(input.winningClaimVersionId)
  ) {
    throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", "Contradiction changed. Refresh first.");
  }
  const losingVersionId = endpoints.find((versionId) => versionId !== input.winningClaimVersionId)!;
  const verdictId = id("rvdt");
  const guardId = id("guard");
  const timestamp = now();
  const db = getD1();
  try {
    await db.batch([
      guardStatement(
        guardId,
        `EXISTS (
          SELECT 1 FROM claim_relations WHERE id = ? AND workspace_id = ?
            AND status = ? AND contradiction_status = 'open'
            AND source_claim_version_id = ? AND target_claim_version_id = ?
        ) AND EXISTS (
          SELECT 1 FROM claims
           WHERE current_version_id = ? AND workspace_id = ?
             AND review_status = 'verified' AND lifecycle_status <> 'withdrawn'
        ) AND EXISTS (
          SELECT 1 FROM claims
           WHERE current_version_id = ? AND workspace_id = ?
             AND review_status = 'verified' AND lifecycle_status <> 'withdrawn'
        )`,
        [
          relationId,
          scope.workspaceId,
          input.baseRelationStatus,
          input.sourceClaimVersionId,
          input.targetClaimVersionId,
          input.winningClaimVersionId,
          scope.workspaceId,
          losingVersionId,
          scope.workspaceId,
        ],
        timestamp,
      ),
      db
        .prepare(
          `UPDATE claims
              SET lifecycle_status = 'withdrawn', withdraw_reason = 'contradiction_resolution',
                  updated_at = ?
            WHERE current_version_id = ? AND project_id = ?`,
        )
        .bind(timestamp, losingVersionId, relation.project_id),
      db
        .prepare(
          `UPDATE claim_relations SET status = 'inactive'
            WHERE id <> ? AND status = 'active'
              AND (source_claim_version_id = ? OR target_claim_version_id = ?)`,
        )
        .bind(relationId, losingVersionId, losingVersionId),
      db
        .prepare(
          `UPDATE claim_relations
              SET contradiction_status = 'resolved', resolved_at = ?,
                  resolved_by_verdict_id = ?
            WHERE id = ?`,
        )
        .bind(timestamp, verdictId, relationId),
      db
        .prepare(
          `INSERT INTO relation_verdicts
           (id, relation_id, action, base_relation_status, winning_claim_version_id,
            secondary_evidence_note, user_id, created_at)
           VALUES (?, ?, 'resolve', ?, ?, ?, ?, ?)`,
        )
        .bind(
          verdictId,
          relationId,
          input.baseRelationStatus,
          input.winningClaimVersionId,
          input.explanation ?? null,
          scope.actorId,
          timestamp,
        ),
      ...lifecycleRecalculationStatements(String(relation.project_id), timestamp),
      db
        .prepare(
          `UPDATE projects
              SET ledger_version = ledger_version + 1,
                  context_version = context_version + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ?`,
        )
        .bind(timestamp, relation.project_id, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { relation_id: relationId, verdict_id: verdictId, status: "resolved" },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch {
    const recovered = await findMutationReplay<{
      relation_id: string;
      verdict_id: string;
      status: "resolved";
    }>(scope, endpointScope, idempotencyKey, input);
    if (recovered.response) return recovered.response;
    throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", "Contradiction changed. Refresh first.");
  }
  return { relation_id: relationId, verdict_id: verdictId, status: "resolved" };
}
