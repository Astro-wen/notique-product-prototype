import { getD1 } from "@/db";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import { createManualRelation } from "@/lib/server/db/verdict-repository";

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

async function first(sql: string, bindings: unknown[]): Promise<Row | null> {
  return (await getD1().prepare(sql).bind(...bindings).first<Row>()) ?? null;
}

async function assertProject(scope: RequestScope, projectId: string): Promise<void> {
  const project = await first(
    `SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, scope.workspaceId],
  );
  if (!project) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");
}

export type DraftMemoryRecord = {
  claim_id: string;
  claim_version_id: string;
  event_id: string;
  event_title: string;
  event_sequence_no: number;
  type: string;
  statement: string;
  confidence: number;
  evidence_ref_ids: string[];
  created_at: string;
};

export type DraftLinkRecord = {
  id: string;
  source_claim_id: string;
  target_draft_claim_id: string;
  type: "same" | "changed" | "conflicting" | "possibly_answered";
  reason: string;
  confidence: number;
  status: "proposed" | "inactive" | "accepted" | "rejected";
  source_statement: string;
  target_statement: string;
  source_review_status: string;
  target_review_status: string;
};

export type FrozenDraftClaimRef = {
  claim_id: string;
  claim_version_id: string;
};

type DraftMemoryOptions = {
  /**
   * When present, load exactly the candidates frozen into an Extraction Run.
   * An empty array deliberately means that the Run had no draft context; it
   * must not fall back to whatever happens to be pending when the worker runs.
   */
  frozenClaims?: FrozenDraftClaimRef[];
};

const DRAFT_MEMORY_SELECT = `
  SELECT c.id AS claim_id, c.current_version_id AS claim_version_id,
         c.event_id, e.title AS event_title, e.sequence_no AS event_sequence_no,
         c.type, cv.statement, COALESCE(c.confidence, 0) AS confidence,
         c.created_at,
         COALESCE((
           SELECT json_group_array(er.id)
             FROM evidence_refs er
            WHERE er.claim_version_id = c.current_version_id
              AND er.structural_validation_status = 'valid'
         ), '[]') AS evidence_ref_ids_json
    FROM claims c
    JOIN claim_versions cv ON cv.id = c.current_version_id
    JOIN events e ON e.id = c.event_id`;

const DRAFT_MEMORY_ELIGIBILITY = `
   WHERE c.project_id = ? AND c.workspace_id = ?
     AND c.review_status = 'pending' AND c.lifecycle_status = 'active'
     AND c.source = 'ai'
     AND e.active_run_id = c.extraction_run_id
     AND EXISTS (
       SELECT 1 FROM evidence_refs er
        WHERE er.claim_version_id = c.current_version_id
          AND er.structural_validation_status = 'valid'
     )`;

async function listDraftMemoryClaims(
  scope: RequestScope,
  projectId: string,
  options?: DraftMemoryOptions,
): Promise<Row[]> {
  if (options?.frozenClaims !== undefined) {
    if (options.frozenClaims.length === 0) return [];
    // The frozen manifest is persisted server-side with the Run. json_each
    // keeps this a single binding even at the 100-candidate ceiling while the
    // join pins both the Claim and its exact version.
    return all(
      `WITH frozen AS (
         SELECT json_extract(value, '$.claim_id') AS claim_id,
                json_extract(value, '$.claim_version_id') AS claim_version_id
           FROM json_each(?)
       )
       SELECT frozen_claims.* FROM (
         ${DRAFT_MEMORY_SELECT}
         JOIN frozen
           ON frozen.claim_id = c.id
          AND frozen.claim_version_id = c.current_version_id
         ${DRAFT_MEMORY_ELIGIBILITY}
       ) AS frozen_claims
       ORDER BY frozen_claims.event_sequence_no,
                frozen_claims.created_at,
                frozen_claims.claim_id`,
      [JSON.stringify(options.frozenClaims), projectId, scope.workspaceId],
    );
  }

  // Select the newest 100 candidates from the newest ten communications first,
  // then restore chronological order for deterministic model input and UI.
  // Applying LIMIT to an ascending query would silently keep the oldest 100.
  return all(
    `SELECT recent_claims.* FROM (
       ${DRAFT_MEMORY_SELECT}
       ${DRAFT_MEMORY_ELIGIBILITY}
         AND e.id IN (
           SELECT recent_event.id
             FROM events recent_event
            WHERE recent_event.project_id = ?
              AND recent_event.workspace_id = ?
            ORDER BY recent_event.sequence_no DESC, recent_event.id DESC
            LIMIT 10
         )
       ORDER BY e.sequence_no DESC, c.created_at DESC, c.id DESC
       LIMIT 100
     ) AS recent_claims
     ORDER BY recent_claims.event_sequence_no,
              recent_claims.created_at,
              recent_claims.claim_id`,
    [projectId, scope.workspaceId, projectId, scope.workspaceId],
  );
}

export async function listProjectDraftMemory(
  scope: RequestScope,
  projectId: string,
  options?: DraftMemoryOptions,
): Promise<{ claims: DraftMemoryRecord[]; links: DraftLinkRecord[] }> {
  await assertProject(scope, projectId);
  const [claims, links] = await Promise.all([
    listDraftMemoryClaims(scope, projectId, options),
    all(
      `SELECT dl.*, source_version.statement AS source_statement,
              target_version.statement AS target_statement,
              source.review_status AS source_review_status,
              target.review_status AS target_review_status
         FROM draft_link_candidates dl
         JOIN claims source ON source.id = dl.source_claim_id
         JOIN claim_versions source_version ON source_version.id = dl.source_claim_version_id
         JOIN claims target ON target.id = dl.target_draft_claim_id
         JOIN claim_versions target_version ON target_version.id = dl.target_draft_claim_version_id
        WHERE dl.project_id = ? AND dl.workspace_id = ?
          AND dl.status = 'proposed'
          AND source.current_version_id = dl.source_claim_version_id
          AND target.current_version_id = dl.target_draft_claim_version_id
          AND source.review_status IN ('pending', 'verified')
          AND target.review_status IN ('pending', 'verified')
        ORDER BY dl.created_at, dl.id`,
      [projectId, scope.workspaceId],
    ),
  ]);
  return {
    claims: claims.map((row) => ({
      claim_id: String(row.claim_id),
      claim_version_id: String(row.claim_version_id),
      event_id: String(row.event_id),
      event_title: String(row.event_title),
      event_sequence_no: Number(row.event_sequence_no),
      type: String(row.type),
      statement: String(row.statement),
      confidence: Number(row.confidence),
      evidence_ref_ids: parseJson<string[]>(String(row.evidence_ref_ids_json), []),
      created_at: String(row.created_at),
    })),
    links: links.map((row) => ({
      id: String(row.id),
      source_claim_id: String(row.source_claim_id),
      target_draft_claim_id: String(row.target_draft_claim_id),
      type: String(row.type) as DraftLinkRecord["type"],
      reason: String(row.reason),
      confidence: Number(row.confidence),
      status: String(row.status) as DraftLinkRecord["status"],
      source_statement: String(row.source_statement),
      target_statement: String(row.target_statement),
      source_review_status: String(row.source_review_status),
      target_review_status: String(row.target_review_status),
    })),
  };
}

const DRAFT_LINK_RELATION_TYPES = {
  same: "informed_by",
  changed: "supersedes",
  conflicting: "contradicts",
  possibly_answered: "resolves",
} as const;

export async function applyDraftLinkVerdict(
  scope: RequestScope,
  linkId: string,
  input: { action: "accept" | "reject"; baseContextVersion: number },
  idempotencyKey: string,
): Promise<{
  draftLinkId: string;
  status: "accepted" | "rejected";
  formalRelationId: string | null;
}> {
  const endpointScope = `draft-links/${linkId}/verdict`;
  const replay = await findMutationReplay<{
    draftLinkId: string;
    status: "accepted" | "rejected";
    formalRelationId: string | null;
  }>(scope, endpointScope, idempotencyKey, input);
  if (replay.response) return replay.response;
  const link = await first(
    `SELECT dl.*, source.project_id, source.review_status AS source_review_status,
            source.lifecycle_status AS source_lifecycle_status,
            source.current_version_id AS source_current_version_id,
            target.review_status AS target_review_status,
            target.lifecycle_status AS target_lifecycle_status,
            target.current_version_id AS target_current_version_id,
            p.context_version
       FROM draft_link_candidates dl
       JOIN claims source ON source.id = dl.source_claim_id
       JOIN claims target ON target.id = dl.target_draft_claim_id
       JOIN projects p ON p.id = dl.project_id AND p.workspace_id = dl.workspace_id
      WHERE dl.id = ? AND dl.workspace_id = ? AND p.deleted_at IS NULL`,
    [linkId, scope.workspaceId],
  );
  if (!link) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Draft link was not found.");
  }
  if (String(link.status) !== "proposed") {
    throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", "Draft link changed. Refresh before deciding.");
  }
  const draftLinkType = String(link.type) as keyof typeof DRAFT_LINK_RELATION_TYPES;
  const relationType = DRAFT_LINK_RELATION_TYPES[draftLinkType];
  if (!relationType) {
    throw new ApiFault(422, "BAD_REQUEST", "Draft link type is invalid.");
  }
  const timestamp = now();
  if (input.action === "reject") {
    if (Number(link.context_version) !== input.baseContextVersion) {
      throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", "Draft link changed. Refresh before deciding.");
    }
    const guardId = id("guard");
    const response = { draftLinkId: linkId, status: "rejected" as const, formalRelationId: null };
    const db = getD1();
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO mutation_guards (id, guard_value, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM draft_link_candidates dl
             JOIN projects p ON p.id = dl.project_id AND p.workspace_id = dl.workspace_id
              WHERE dl.id = ? AND dl.workspace_id = ? AND dl.status = 'proposed'
                AND p.context_version = ? AND p.deleted_at IS NULL
           ) THEN 1 ELSE 0 END, ?`,
        ).bind(guardId, linkId, scope.workspaceId, input.baseContextVersion, timestamp),
        db.prepare(
          `UPDATE draft_link_candidates SET status = 'rejected', updated_at = ?
            WHERE id = ? AND workspace_id = ? AND status = 'proposed'`,
        ).bind(timestamp, linkId, scope.workspaceId),
        db.prepare(
          `UPDATE projects SET context_version = context_version + 1, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND context_version = ?`,
        ).bind(timestamp, link.project_id, scope.workspaceId, input.baseContextVersion),
        mutationReplayStatement(
          scope,
          endpointScope,
          idempotencyKey,
          replay.requestHash,
          response,
          timestamp,
        ),
        db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
      ]);
    } catch (error) {
      const recovered = await findMutationReplay<typeof response>(
        scope,
        endpointScope,
        idempotencyKey,
        input,
      );
      if (recovered.response) return recovered.response;
      throw error;
    }
    return response;
  }
  const existingFormalRelation = await first(
    `SELECT id FROM claim_relations
      WHERE workspace_id = ? AND project_id = ? AND type = ? AND status = 'active'
        AND source_claim_version_id = ? AND target_claim_version_id = ?
      LIMIT 1`,
    [
      scope.workspaceId,
      link.project_id,
      relationType,
      link.source_claim_version_id,
      link.target_draft_claim_version_id,
    ],
  );
  if (existingFormalRelation) {
    const response = {
      draftLinkId: linkId,
      status: "accepted" as const,
      formalRelationId: String(existingFormalRelation.id),
    };
    const db = getD1();
    await db.batch([
      db.prepare(
        `UPDATE draft_link_candidates SET status = 'accepted', updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'proposed'`,
      ).bind(timestamp, linkId, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        response,
        timestamp,
      ),
    ]);
    return response;
  }
  if (
    String(link.source_review_status) !== "verified" ||
    String(link.target_review_status) !== "verified" ||
    String(link.source_lifecycle_status) !== "active" ||
    String(link.target_lifecycle_status) !== "active" ||
    String(link.source_current_version_id) !== String(link.source_claim_version_id) ||
    String(link.target_current_version_id) !== String(link.target_draft_claim_version_id)
  ) {
    throw new ApiFault(
      409,
      "CLAIM_VERSION_CONFLICT",
      "Both draft-link records must be current and human-confirmed before a formal relation can be created.",
    );
  }
  const relation = await createManualRelation(
    scope,
    {
      project_id: String(link.project_id),
      base_context_version: input.baseContextVersion,
      source_claim_id: String(link.source_claim_id),
      source_claim_version_id: String(link.source_claim_version_id),
      target_claim_id: String(link.target_draft_claim_id),
      target_claim_version_id: String(link.target_draft_claim_version_id),
      type: relationType,
      reason: String(link.reason),
    },
    `${idempotencyKey}:formal-relation`,
  );
  const response = {
    draftLinkId: linkId,
    status: "accepted" as const,
    formalRelationId: relation.relation_id,
  };
  const db = getD1();
  await db.batch([
    db.prepare(
      `UPDATE draft_link_candidates SET status = 'accepted', updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'proposed'`,
    ).bind(now(), linkId, scope.workspaceId),
    mutationReplayStatement(
      scope,
      endpointScope,
      idempotencyKey,
      replay.requestHash,
      response,
      now(),
    ),
  ]);
  return response;
}

export type ProjectActionRecord = {
  claim_id: string;
  claim_version_id: string;
  statement: string;
  owner: string | null;
  due_at: string | null;
  event_id: string;
  event_title: string;
  status: "ai_suggested" | "confirmed" | "completed" | "not_adopted";
  evidence_ref_ids: string[];
  completed_by_claim_id: string | null;
};

export async function listProjectActions(
  scope: RequestScope,
  projectId: string,
): Promise<ProjectActionRecord[]> {
  await assertProject(scope, projectId);
  const rows = await all(
    `SELECT c.id AS claim_id, c.current_version_id AS claim_version_id,
            cv.statement, cv.normalized_value_json, c.event_id, e.title AS event_title,
            c.review_status, c.lifecycle_status,
            COALESCE((
              SELECT json_group_array(er.id) FROM evidence_refs er
               WHERE er.claim_version_id = c.current_version_id
                 AND er.structural_validation_status = 'valid'
            ), '[]') AS evidence_ref_ids_json,
            (
              SELECT source.id
                FROM claim_relations rel
                JOIN claim_versions source_version ON source_version.id = rel.source_claim_version_id
                JOIN claims source ON source.id = source_version.claim_id
               WHERE rel.target_claim_version_id = c.current_version_id
                 AND rel.type = 'resolves' AND rel.status = 'active'
               ORDER BY rel.created_at DESC LIMIT 1
            ) AS completed_by_claim_id
       FROM claims c
       JOIN claim_versions cv ON cv.id = c.current_version_id
       JOIN events e ON e.id = c.event_id
      WHERE c.project_id = ? AND c.workspace_id = ? AND c.type = 'next_action'
        AND c.review_status = 'verified' AND c.lifecycle_status <> 'withdrawn'
        AND COALESCE(json_extract(cv.normalized_value_json, '$.status'), '') <> 'completed'
      ORDER BY CASE c.lifecycle_status WHEN 'active' THEN 0 ELSE 1 END,
               e.sequence_no, c.created_at`,
    [projectId, scope.workspaceId],
  );
  return rows.map((row) => {
    const normalized = parseJson<Record<string, unknown> | null>(
      row.normalized_value_json == null ? null : String(row.normalized_value_json),
      null,
    );
    const lifecycle = String(row.lifecycle_status);
    const status: ProjectActionRecord["status"] = lifecycle === "resolved"
      ? "completed"
      : "confirmed";
    return {
      claim_id: String(row.claim_id),
      claim_version_id: String(row.claim_version_id),
      statement: String(row.statement),
      owner: typeof normalized?.owner === "string" ? normalized.owner : null,
      due_at: typeof normalized?.due_at === "string"
        ? normalized.due_at
        : typeof normalized?.deadline === "string" ? normalized.deadline : null,
      event_id: String(row.event_id),
      event_title: String(row.event_title),
      status,
      evidence_ref_ids: parseJson<string[]>(String(row.evidence_ref_ids_json), []),
      completed_by_claim_id: row.completed_by_claim_id == null ? null : String(row.completed_by_claim_id),
    };
  });
}

export async function completeProjectAction(
  scope: RequestScope,
  claimId: string,
  idempotencyKey: string,
): Promise<{ actionClaimId: string; completionClaimId: string }> {
  const endpointScope = `actions/${claimId}/complete`;
  const input = { claimId };
  const replay = await findMutationReplay<{ actionClaimId: string; completionClaimId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) return replay.response;
  const action = await first(
    `SELECT c.*, cv.statement, cv.normalized_value_json, p.context_version
       FROM claims c
       JOIN claim_versions cv ON cv.id = c.current_version_id
       JOIN projects p ON p.id = c.project_id AND p.workspace_id = c.workspace_id
      WHERE c.id = ? AND c.workspace_id = ? AND p.deleted_at IS NULL`,
    [claimId, scope.workspaceId],
  );
  if (!action) throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Action was not found.");
  if (
    String(action.type) !== "next_action" ||
    String(action.review_status) !== "verified" ||
    String(action.lifecycle_status) !== "active"
  ) {
    throw new ApiFault(409, "CLAIM_VERSION_CONFLICT", "Only an active confirmed action can be completed.");
  }
  const completionClaimId = id("clm");
  const completionVersionId = id("clv");
  const relationId = id("rel");
  const relationVerdictId = id("rvdt");
  const guardId = id("guard");
  const timestamp = now();
  const response = { actionClaimId: claimId, completionClaimId };
  const db = getD1();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO mutation_guards (id, guard_value, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM claims c
           JOIN projects p ON p.id = c.project_id AND p.workspace_id = c.workspace_id
          WHERE c.id = ? AND c.workspace_id = ? AND c.current_version_id = ?
            AND c.type = 'next_action' AND c.review_status = 'verified'
            AND c.lifecycle_status = 'active' AND p.context_version = ?
            AND p.deleted_at IS NULL
         ) THEN 1 ELSE 0 END, ?`,
      ).bind(
        guardId,
        claimId,
        scope.workspaceId,
        action.current_version_id,
        action.context_version,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO claims (
          id, workspace_id, project_id, event_id, extraction_run_id,
          client_claim_key, type, materiality, confidence,
          needs_additional_evidence, review_status, lifecycle_status,
          current_version_id, first_event_id, source, opened_at,
          repeat_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'next_action', 'high', 1,
                  0, 'verified', 'active', ?, ?, 'human', NULL, 0, ?, ?)`,
      ).bind(
        completionClaimId,
        scope.workspaceId,
        action.project_id,
        action.event_id,
        action.extraction_run_id,
        `completed:${claimId}`,
        completionVersionId,
        action.first_event_id,
        timestamp,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO claim_versions (
          id, claim_id, version_no, statement, normalized_value_json,
          uncertainty_json, source, created_by, created_at
        ) VALUES (?, ?, 1, ?, ?, NULL, 'human', ?, ?)`,
      ).bind(
        completionVersionId,
        completionClaimId,
        `已完成：${String(action.statement)}`,
        JSON.stringify({ status: "completed", completed_action_claim_id: claimId }),
        scope.actorId,
        timestamp,
      ),
      db.prepare(
        `INSERT INTO claim_relations (
          id, workspace_id, project_id, type, source_claim_version_id,
          target_claim_version_id, context_version, status, reason, confidence, created_at
        ) VALUES (?, ?, ?, 'resolves', ?, ?, ?, 'active', ?, 1, ?)`,
      ).bind(
        relationId,
        scope.workspaceId,
        action.project_id,
        completionVersionId,
        action.current_version_id,
        action.context_version,
        "The user marked this confirmed action as completed.",
        timestamp,
      ),
      db.prepare(
        `INSERT INTO relation_verdicts (
          id, relation_id, action, base_relation_status, user_id, created_at
        ) VALUES (?, ?, 'confirm', 'proposed', ?, ?)`,
      ).bind(relationVerdictId, relationId, scope.actorId, timestamp),
      db.prepare(
        `UPDATE claims SET lifecycle_status = 'resolved', resolved_at = ?, updated_at = ?
          WHERE id = ? AND current_version_id = ? AND review_status = 'verified'
            AND lifecycle_status = 'active'`,
      ).bind(timestamp, timestamp, claimId, action.current_version_id),
      db.prepare(
        `UPDATE projects SET ledger_version = ledger_version + 1,
            context_version = context_version + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND context_version = ?`,
      ).bind(timestamp, action.project_id, scope.workspaceId, action.context_version),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        response,
        timestamp,
      ),
      db.prepare(`DELETE FROM mutation_guards WHERE id = ?`).bind(guardId),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<typeof response>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) return recovered.response;
    throw error;
  }
  return response;
}
