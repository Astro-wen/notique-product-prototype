import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationsDirectory = new URL("../drizzle/", import.meta.url);

test("all D1 migrations apply from an empty database", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  assert.ok(migrationFiles.length >= 4, "expected the complete versioned schema");

  for (const filename of migrationFiles) {
    const sql = await readFile(new URL(filename, migrationsDirectory), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }

  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(foreignKeyFailures, []);

  const tables = new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  for (const table of [
    "projects",
    "events",
    "assets",
    "asset_versions",
    "text_segments",
    "extraction_runs",
    "queue_outbox",
    "claims",
    "claim_versions",
    "evidence_refs",
    "verdicts",
    "mutation_replays",
    "glossary_entries",
    "glossary_entry_audits",
    "claim_evidence_review_attestations",
  ]) {
    assert.equal(tables.has(table), true, `missing migrated table ${table}`);
  }

  const extractionRunColumns = new Set(
    database
      .prepare("PRAGMA table_info(extraction_runs)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(
    extractionRunColumns.has("validated_output_json"),
    true,
    "Run Debug requires the validated model output column",
  );

  const glossaryColumns = new Set(
    database
      .prepare("PRAGMA table_info(glossary_entries)")
      .all()
      .map((row) => row.name),
  );
  for (const column of [
    "category",
    "source_type",
    "source_label",
    "is_active",
    "version",
    "updated_at",
    "deleted_at",
  ]) {
    assert.equal(glossaryColumns.has(column), true, `missing glossary column ${column}`);
  }
  const glossaryMigration = await readFile(
    new URL("0006_glossary_management.sql", migrationsDirectory),
    "utf8",
  );
  assert.match(
    glossaryMigration,
    /source_type` = 'verified_claim'[\s\S]{0,120}source_claim_version_id` <> 'manual'/,
    "existing claim-derived glossary rows must remain behind the verified-only gate",
  );
  const reviewIndexes = new Set(
    database
      .prepare("PRAGMA index_list(claim_evidence_review_attestations)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(
    reviewIndexes.has("uq_claim_evidence_review_actor_version"),
    true,
    "batch review readiness must be unique per actor and Claim Version",
  );

  database.close();
});
