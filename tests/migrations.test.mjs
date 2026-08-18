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

  const journal = JSON.parse(await readFile(
    new URL("meta/_journal.json", migrationsDirectory),
    "utf8",
  ));
  const journalTags = journal.entries.map((entry) => entry.tag);
  assert.deepEqual(
    journalTags,
    migrationFiles.map((filename) => filename.replace(/\.sql$/, "")),
    "every SQL migration must have the same ordered Drizzle journal entry",
  );
  assert.equal(
    journal.entries.at(-1)?.idx,
    migrationFiles.length - 1,
    "the Drizzle journal index must end at the latest SQL migration",
  );

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
    "extraction_model_stages",
    "queue_outbox",
    "claims",
    "claim_versions",
    "evidence_refs",
    "verdicts",
    "mutation_replays",
    "glossary_entries",
    "glossary_entry_audits",
    "claim_evidence_review_attestations",
    "transcription_runs",
    "transcription_queue_outbox",
    "review_sessions",
    "ai_draft_assessments",
    "event_ai_artifact_runs",
    "event_ai_artifacts",
    "readable_segment_sources",
    "event_ai_artifact_chunks",
    "draft_link_candidates",
  ]) {
    assert.equal(tables.has(table), true, `missing migrated table ${table}`);
  }

  const transcriptionIndexes = new Set(
    database
      .prepare("PRAGMA index_list(transcription_runs)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(
    transcriptionIndexes.has("uq_transcription_runs_audio_idempotency"),
    true,
    "audio transcription retries must be idempotent per audio version",
  );

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
  for (const column of [
    "first_queued_at",
    "current_queued_at",
    "first_started_at",
    "current_started_at",
  ]) {
    assert.equal(extractionRunColumns.has(column), true, `missing extraction timing column ${column}`);
  }
  assert.equal(
    transcriptionIndexes.has("uq_transcription_runs_parent_chunk"),
    true,
    "each parent transcription must have at most one child Run per chunk index",
  );
  const transcriptionRunColumns = new Set(
    database
      .prepare("PRAGMA table_info(transcription_runs)")
      .all()
      .map((row) => row.name),
  );
  for (const column of [
    "first_queued_at",
    "current_queued_at",
    "first_started_at",
    "current_started_at",
    "orchestration_mode",
    "parent_run_id",
    "chunk_index",
    "chunk_start_ms",
    "chunk_end_ms",
    "chunk_count",
    "completed_chunk_count",
  ]) {
    assert.equal(transcriptionRunColumns.has(column), true, `missing transcription timing column ${column}`);
  }

  const extractionStageIndexes = new Set(
    database
      .prepare("PRAGMA index_list(extraction_model_stages)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(
    extractionStageIndexes.has("uq_extraction_model_stages_run_stage_attempt"),
    true,
    "model stage resume records must be unique per Run, stage, and attempt",
  );
  const extractionStageForeignKeys = database
    .prepare("PRAGMA foreign_key_list(extraction_model_stages)")
    .all();
  assert.equal(
    extractionStageForeignKeys.some(
      (row) => row.table === "extraction_runs" && row.from === "run_id" && row.on_delete === "CASCADE",
    ),
    true,
    "model stage records must remain scoped to their parent Run",
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

  const reviewSessionIndexes = new Set(
    database
      .prepare("PRAGMA index_list(review_sessions)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(
    reviewSessionIndexes.has("uq_review_sessions_active_actor_project"),
    true,
    "only one active review timer may exist per actor and Project",
  );

  const draftAssessmentIndexes = new Set(
    database
      .prepare("PRAGMA index_list(ai_draft_assessments)")
      .all()
      .map((row) => row.name),
  );
  assert.equal(
    draftAssessmentIndexes.has("uq_ai_draft_assessment_actor_run"),
    true,
    "each reviewer must have one durable first-impression assessment per Run",
  );

  assert.throws(
    () => database.prepare(
      `INSERT INTO review_sessions (
         id, workspace_id, project_id, actor_id, status, started_at,
         initial_pending_claim_count, initial_pending_occurrence_count,
         remaining_pending_claim_count, remaining_pending_occurrence_count
       ) VALUES ('rvs_invalid', 'missing', 'missing', 'actor', 'active',
         '2026-08-10T00:00:00.000Z', 0, 0, 0, 0)`,
    ).run(),
    /CHECK constraint failed|FOREIGN KEY constraint failed/,
    "a timer with no review work must be rejected by the database",
  );

  database.close();
});
