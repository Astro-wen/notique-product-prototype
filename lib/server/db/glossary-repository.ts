import { getD1 } from "@/db";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";
import {
  findMutationReplay,
  mutationReplayStatement,
} from "@/lib/server/db/mutation-replay";
import type {
  CreateGlossaryEntryRequest,
  GlossaryEntryRecord,
  UpdateGlossaryEntryRequest,
} from "@/lib/shared/api-types";

type Row = Record<string, unknown>;

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

async function assertProject(scope: RequestScope, projectId: string): Promise<void> {
  const row = await first(
    `SELECT id FROM projects
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Project was not found.");
  }
}

function normalizeVariants(canonicalValue: string, variants: string[]): string[] {
  const canonicalKey = canonicalValue.toLocaleLowerCase("en-US");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of variants) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase("en-US");
    if (!value || key === canonicalKey || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function entryRecord(row: Row): GlossaryEntryRecord {
  const sourceType = String(row.source_type ?? "manual") as GlossaryEntryRecord["source_type"];
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    canonical_value: String(row.canonical_value),
    variants: parseJson<string[]>(String(row.aliases_json ?? "[]"), []),
    category: String(row.category ?? "general") as GlossaryEntryRecord["category"],
    source_type: sourceType,
    source_label: row.source_label == null ? null : String(row.source_label),
    source_claim_id:
      sourceType === "verified_claim" && row.source_claim_id != null
        ? String(row.source_claim_id)
        : null,
    source_claim_version_id:
      sourceType === "verified_claim" && row.source_claim_version_id != null
        ? String(row.source_claim_version_id)
        : null,
    is_active: Number(row.is_active ?? 0) === 1 && row.deleted_at == null,
    version: Number(row.version ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at ?? row.created_at),
  };
}

async function scopedEntry(
  scope: RequestScope,
  entryId: string,
  includeDeleted = false,
): Promise<Row> {
  const row = await first(
    `SELECT ge.* FROM glossary_entries ge
      JOIN projects p ON p.id = ge.project_id
     WHERE ge.id = ? AND p.workspace_id = ? AND p.deleted_at IS NULL
       ${includeDeleted ? "" : "AND ge.deleted_at IS NULL"}`,
    [entryId, scope.workspaceId],
  );
  if (!row) {
    throw new ApiFault(404, "PROJECT_SCOPE_VIOLATION", "Glossary entry was not found.");
  }
  return row;
}

async function duplicateEntry(projectId: string, canonicalValue: string, excludeId?: string) {
  return first(
    `SELECT id FROM glossary_entries
      WHERE project_id = ? AND deleted_at IS NULL
        AND lower(canonical_value) = lower(?)
        ${excludeId ? "AND id <> ?" : ""}
      LIMIT 1`,
    excludeId ? [projectId, canonicalValue, excludeId] : [projectId, canonicalValue],
  );
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

function auditStatement(input: {
  scope: RequestScope;
  projectId: string;
  entryId: string;
  action: "create" | "update" | "deactivate" | "activate" | "delete";
  baseVersion: number | null;
  resultVersion: number;
  snapshot: Record<string, unknown>;
  timestamp: string;
}): D1PreparedStatement {
  return getD1()
    .prepare(
      `INSERT INTO glossary_entry_audits (
         id, workspace_id, project_id, entry_id, action, base_version,
         result_version, actor_id, snapshot_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id("gaud"),
      input.scope.workspaceId,
      input.projectId,
      input.entryId,
      input.action,
      input.baseVersion,
      input.resultVersion,
      input.scope.actorId,
      JSON.stringify(input.snapshot),
      input.timestamp,
    );
}

function versionConflict(): ApiFault {
  return new ApiFault(
    409,
    "GLOSSARY_VERSION_CONFLICT",
    "Glossary entry changed. Refresh before saving again.",
  );
}

function duplicateConflict(): ApiFault {
  return new ApiFault(
    409,
    "GLOSSARY_DUPLICATE",
    "This project already has a glossary entry with the same canonical term.",
  );
}

export async function listGlossaryEntries(
  scope: RequestScope,
  projectId: string,
): Promise<GlossaryEntryRecord[]> {
  await assertProject(scope, projectId);
  const rows = await all(
    `SELECT ge.* FROM glossary_entries ge
      JOIN projects p ON p.id = ge.project_id
     WHERE ge.project_id = ? AND p.workspace_id = ?
       AND p.deleted_at IS NULL AND ge.deleted_at IS NULL
     ORDER BY ge.is_active DESC, lower(ge.canonical_value), ge.id`,
    [projectId, scope.workspaceId],
  );
  return rows.map(entryRecord);
}

export async function getGlossaryEntry(
  scope: RequestScope,
  entryId: string,
  includeDeleted = false,
): Promise<GlossaryEntryRecord> {
  return entryRecord(await scopedEntry(scope, entryId, includeDeleted));
}

export async function createGlossaryEntry(
  scope: RequestScope,
  projectId: string,
  input: CreateGlossaryEntryRequest,
  idempotencyKey: string,
): Promise<GlossaryEntryRecord> {
  await assertProject(scope, projectId);
  const normalized = {
    ...input,
    variants: normalizeVariants(input.canonical_value, input.variants),
  };
  const endpointScope = `projects/${projectId}/glossary`;
  const replay = await findMutationReplay<{ entryId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    normalized,
  );
  if (replay.response) return getGlossaryEntry(scope, replay.response.entryId);
  if (await duplicateEntry(projectId, normalized.canonical_value)) throw duplicateConflict();

  const entryId = id("gls");
  const guardId = id("guard");
  const timestamp = now();
  const snapshot = {
    canonical_value: normalized.canonical_value,
    variants: normalized.variants,
    category: normalized.category,
    source_type: "manual",
    is_active: true,
  };
  const db = getD1();
  try {
    await db.batch([
      guardStatement(
        guardId,
        `EXISTS (SELECT 1 FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL)
         AND NOT EXISTS (
           SELECT 1 FROM glossary_entries
            WHERE project_id = ? AND deleted_at IS NULL
              AND lower(canonical_value) = lower(?)
         )`,
        [projectId, scope.workspaceId, projectId, normalized.canonical_value],
        timestamp,
      ),
      db.prepare(
        `INSERT INTO glossary_entries (
           id, project_id, canonical_value, aliases_json,
           source_claim_id, source_claim_version_id, category, source_type,
           source_label, is_active, version, created_at, updated_at, deleted_at
         ) VALUES (?, ?, ?, ?, 'manual', 'manual', ?, 'manual', ?, 1, 1, ?, ?, NULL)`,
      ).bind(
        entryId,
        projectId,
        normalized.canonical_value,
        JSON.stringify(normalized.variants),
        normalized.category,
        "人工维护",
        timestamp,
        timestamp,
      ),
      auditStatement({
        scope,
        projectId,
        entryId,
        action: "create",
        baseVersion: null,
        resultVersion: 1,
        snapshot,
        timestamp,
      }),
      db.prepare(
        `UPDATE projects
            SET context_version = context_version + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      ).bind(timestamp, projectId, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { entryId },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ entryId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      normalized,
    );
    if (recovered.response) return getGlossaryEntry(scope, recovered.response.entryId);
    if (await duplicateEntry(projectId, normalized.canonical_value)) throw duplicateConflict();
    throw error;
  }
  return getGlossaryEntry(scope, entryId);
}

export async function updateGlossaryEntry(
  scope: RequestScope,
  entryId: string,
  input: UpdateGlossaryEntryRequest,
  idempotencyKey: string,
): Promise<GlossaryEntryRecord> {
  const normalized = {
    ...input,
    variants: normalizeVariants(input.canonical_value, input.variants),
  };
  const endpointScope = `glossary/${entryId}`;
  const replay = await findMutationReplay<{ entryId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    normalized,
  );
  if (replay.response) return getGlossaryEntry(scope, replay.response.entryId);
  const existing = await scopedEntry(scope, entryId);
  if (Number(existing.version) !== normalized.base_version) throw versionConflict();
  const projectId = String(existing.project_id);
  if (await duplicateEntry(projectId, normalized.canonical_value, entryId)) {
    throw duplicateConflict();
  }

  const guardId = id("guard");
  const timestamp = now();
  const resultVersion = normalized.base_version + 1;
  const wasActive = Number(existing.is_active) === 1;
  const action = wasActive === normalized.is_active
    ? "update"
    : normalized.is_active
      ? "activate"
      : "deactivate";
  const snapshot = {
    canonical_value: normalized.canonical_value,
    variants: normalized.variants,
    category: normalized.category,
    source_type: String(existing.source_type ?? "manual"),
    is_active: normalized.is_active,
  };
  const db = getD1();
  try {
    await db.batch([
      guardStatement(
        guardId,
        `EXISTS (
           SELECT 1 FROM glossary_entries ge
           JOIN projects p ON p.id = ge.project_id
            WHERE ge.id = ? AND ge.version = ? AND ge.deleted_at IS NULL
              AND p.workspace_id = ? AND p.deleted_at IS NULL
         ) AND NOT EXISTS (
           SELECT 1 FROM glossary_entries
            WHERE project_id = ? AND id <> ? AND deleted_at IS NULL
              AND lower(canonical_value) = lower(?)
         )`,
        [
          entryId,
          normalized.base_version,
          scope.workspaceId,
          projectId,
          entryId,
          normalized.canonical_value,
        ],
        timestamp,
      ),
      db.prepare(
        `UPDATE glossary_entries
            SET canonical_value = ?, aliases_json = ?, category = ?,
                is_active = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      ).bind(
        normalized.canonical_value,
        JSON.stringify(normalized.variants),
        normalized.category,
        normalized.is_active ? 1 : 0,
        resultVersion,
        timestamp,
        entryId,
        normalized.base_version,
      ),
      auditStatement({
        scope,
        projectId,
        entryId,
        action,
        baseVersion: normalized.base_version,
        resultVersion,
        snapshot,
        timestamp,
      }),
      db.prepare(
        `UPDATE projects
            SET context_version = context_version + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      ).bind(timestamp, projectId, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { entryId },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ entryId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      normalized,
    );
    if (recovered.response) return getGlossaryEntry(scope, recovered.response.entryId);
    const current = await scopedEntry(scope, entryId).catch(() => null);
    if (!current || Number(current.version) !== normalized.base_version) throw versionConflict();
    if (await duplicateEntry(projectId, normalized.canonical_value, entryId)) {
      throw duplicateConflict();
    }
    throw error;
  }
  return getGlossaryEntry(scope, entryId);
}

export async function deleteGlossaryEntry(
  scope: RequestScope,
  entryId: string,
  baseVersion: number,
  idempotencyKey: string,
): Promise<GlossaryEntryRecord> {
  const input = { base_version: baseVersion };
  const endpointScope = `glossary/${entryId}/delete`;
  const replay = await findMutationReplay<{ entryId: string }>(
    scope,
    endpointScope,
    idempotencyKey,
    input,
  );
  if (replay.response) return getGlossaryEntry(scope, replay.response.entryId, true);
  const existing = await scopedEntry(scope, entryId);
  if (Number(existing.version) !== baseVersion) throw versionConflict();

  const projectId = String(existing.project_id);
  const guardId = id("guard");
  const timestamp = now();
  const resultVersion = baseVersion + 1;
  const snapshot = {
    canonical_value: String(existing.canonical_value),
    variants: parseJson<string[]>(String(existing.aliases_json ?? "[]"), []),
    category: String(existing.category ?? "general"),
    source_type: String(existing.source_type ?? "manual"),
    is_active: false,
    deleted: true,
  };
  const db = getD1();
  try {
    await db.batch([
      guardStatement(
        guardId,
        `EXISTS (
           SELECT 1 FROM glossary_entries ge
           JOIN projects p ON p.id = ge.project_id
            WHERE ge.id = ? AND ge.version = ? AND ge.deleted_at IS NULL
              AND p.workspace_id = ? AND p.deleted_at IS NULL
         )`,
        [entryId, baseVersion, scope.workspaceId],
        timestamp,
      ),
      db.prepare(
        `UPDATE glossary_entries
            SET is_active = 0, version = ?, updated_at = ?, deleted_at = ?
          WHERE id = ? AND version = ? AND deleted_at IS NULL`,
      ).bind(resultVersion, timestamp, timestamp, entryId, baseVersion),
      auditStatement({
        scope,
        projectId,
        entryId,
        action: "delete",
        baseVersion,
        resultVersion,
        snapshot,
        timestamp,
      }),
      db.prepare(
        `UPDATE projects
            SET context_version = context_version + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ?`,
      ).bind(timestamp, projectId, scope.workspaceId),
      mutationReplayStatement(
        scope,
        endpointScope,
        idempotencyKey,
        replay.requestHash,
        { entryId },
        timestamp,
      ),
      deleteGuard(guardId),
    ]);
  } catch (error) {
    const recovered = await findMutationReplay<{ entryId: string }>(
      scope,
      endpointScope,
      idempotencyKey,
      input,
    );
    if (recovered.response) return getGlossaryEntry(scope, recovered.response.entryId, true);
    const current = await scopedEntry(scope, entryId, true).catch(() => null);
    if (
      !current ||
      current.deleted_at != null ||
      Number(current.version) !== baseVersion
    ) {
      throw versionConflict();
    }
    throw error;
  }
  return getGlossaryEntry(scope, entryId, true);
}
