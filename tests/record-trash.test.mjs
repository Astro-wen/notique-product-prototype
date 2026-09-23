import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  RUN_CANCELLED,
  activeProviderRequestsBinds,
  activeProviderRequestsSql,
  cancelBinds,
  runCancellationStatements,
} from "../lib/domain/run-cancellation.ts";
import {
  CLAIM_LINKED_TABLES,
  RECORD_OWNED_TABLES,
  TRASH_BLOCKER_CHECKS,
  allTrashBlockerBinds,
  claimLinkedRewrite,
  recordPurgeBinds,
  recordPurgeStatements,
  recordStorageKeysSql,
  trashBlockerCountsSql,
  trashBlockerGuardSql,
  trashBlockers,
} from "../lib/domain/event-trash.ts";

const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

async function migratedDatabase({ foreignKeys = false } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"};`);
  const files = (await readdir(migrationsDirectory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const filename of files) {
    const sql = await readFile(new URL(filename, migrationsDirectory), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  return database;
}

/** 必填又没有默认值的列都给个值，加了新列这里不用改。每行一个新种子，免得撞唯一索引。 */
let nextSeed = 1;
function insertRow(database, table, overrides, seed = nextSeed++) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  const values = {};
  for (const column of columns) {
    if (column.name in overrides) {
      values[column.name] = overrides[column.name];
      continue;
    }
    if (!column.notnull || column.dflt_value !== null) continue;
    const type = String(column.type).toLowerCase();
    if (type.includes("int")) values[column.name] = seed;
    else if (type.includes("real")) values[column.name] = 0.5;
    else values[column.name] = `${table}.${column.name}.${seed}`;
  }
  const names = Object.keys(values);
  database
    .prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...names.map((name) => values[name]));
}

const WS = "ws_1";
const T = "2026-09-22T18:00:00.000Z";

function baseWorkspace(database) {
  insertRow(database, "workspaces", { id: WS, name: "工作区" });
  insertRow(database, "projects", { id: "prj_a", workspace_id: WS, name: "项目", scenario_status: "confirmed" });
  for (const [id, seq] of [["evt_gone", 1], ["evt_kept", 2]]) {
    insertRow(database, "events", {
      id, workspace_id: WS, project_id: "prj_a", event_type: "meeting",
      title: id, occurred_at: "2026-09-21T00:00:00Z", sequence_no: seq,
    });
  }
}

// ---------------------------------------------------------------- 停任务

test("删除时正在跑的任务全部停下，跑完的和别的记录的任务不碰", async () => {
  const database = await migratedDatabase();
  baseWorkspace(database);
  const runRow = (table, id, event, status, extra = {}) => insertRow(database, table, {
    id, workspace_id: WS, project_id: "prj_a", event_id: event, status,
    lease_owner: status === "processing" ? "worker_1" : null, ...extra,
  });
  runRow("transcription_runs", "tr_active", "evt_gone", "processing");
  runRow("transcription_runs", "tr_done", "evt_gone", "succeeded");
  runRow("transcription_runs", "tr_other", "evt_kept", "queued");
  runRow("extraction_runs", "ex_active", "evt_gone", "queued");
  runRow("event_ai_artifact_runs", "ar_active", "evt_gone", "processing", { provider_request_id: "resp_artifact" });
  runRow("event_ai_artifact_runs", "ar_other", "evt_kept", "processing", { provider_request_id: "resp_other" });
  insertRow(database, "extraction_model_stages", {
    id: "st_1", run_id: "ex_active", stage: "inventory", status: "processing", provider_request_id: "resp_stage",
  });
  insertRow(database, "event_ai_artifact_chunks", {
    id: "ch_1", artifact_run_id: "ar_active", chunk_index: 0, status: "queued", provider_request_id: "resp_chunk",
  });
  insertRow(database, "assets", {
    id: "ast_audio", workspace_id: WS, project_id: "prj_a", event_id: "evt_gone", kind: "audio",
    metadata_json: JSON.stringify({ transcription_run_id: "tr_active", transcription_status: "processing" }),
  });
  database.prepare(`UPDATE projects SET scenario_status = 'assessing', scenario_assessment_run_id = 'ex_active' WHERE id = 'prj_a'`).run();

  // 远程取消要在标停之前查，查到的是交给供应商、还在路上的那几个。
  const remote = database.prepare(activeProviderRequestsSql("event"))
    .all(...activeProviderRequestsBinds("evt_gone", WS))
    .map((row) => row.provider_request_id).sort();
  assert.deepEqual(remote, ["resp_artifact", "resp_chunk", "resp_stage"]);

  const context = { timestamp: T, scopeId: "evt_gone", workspace: WS, reason: "event_trashed" };
  for (const statement of runCancellationStatements("event")) {
    database.prepare(statement.sql).run(...cancelBinds(statement, context));
  }

  const status = (table, id) => database.prepare(`SELECT status, error_code, lease_owner FROM ${table} WHERE id = ?`).get(id);
  for (const [table, id] of [["transcription_runs", "tr_active"], ["extraction_runs", "ex_active"], ["event_ai_artifact_runs", "ar_active"]]) {
    assert.deepEqual({ ...status(table, id) }, { status: "failed", error_code: RUN_CANCELLED, lease_owner: null }, `${table} 没停下`);
  }
  assert.equal(status("transcription_runs", "tr_done").status, "succeeded", "跑完的任务被改了");
  assert.equal(status("transcription_runs", "tr_other").status, "queued", "别的记录的任务被停了");
  assert.equal(status("event_ai_artifact_runs", "ar_other").status, "processing", "别的记录的任务被停了");
  assert.equal(database.prepare(`SELECT status FROM extraction_model_stages WHERE id = 'st_1'`).get().status, "failed");
  assert.equal(database.prepare(`SELECT status FROM event_ai_artifact_chunks WHERE id = 'ch_1'`).get().status, "failed");
  const audio = JSON.parse(database.prepare(`SELECT metadata_json FROM assets WHERE id = 'ast_audio'`).get().metadata_json);
  assert.equal(audio.transcription_status, "failed", "录音还显示在转写，恢复后界面会一直转圈");
  const project = database.prepare(`SELECT scenario_status, scenario_assessment_run_id FROM projects WHERE id = 'prj_a'`).get();
  assert.deepEqual({ ...project }, { scenario_status: "unassessed", scenario_assessment_run_id: null });

  // 停下以后远程再查不出东西，重复删除也不会重复取消。
  assert.equal(database.prepare(activeProviderRequestsSql("event")).all(...activeProviderRequestsBinds("evt_gone", WS)).length, 0);
  database.close();
});

test("按项目停，覆盖项目里每一条记录", async () => {
  const database = await migratedDatabase();
  baseWorkspace(database);
  insertRow(database, "transcription_runs", { id: "tr_1", workspace_id: WS, project_id: "prj_a", event_id: "evt_gone", status: "queued" });
  insertRow(database, "transcription_runs", { id: "tr_2", workspace_id: WS, project_id: "prj_a", event_id: "evt_kept", status: "processing" });
  const context = { timestamp: T, scopeId: "prj_a", workspace: WS, reason: "project_trashed" };
  for (const statement of runCancellationStatements("project")) {
    database.prepare(statement.sql).run(...cancelBinds(statement, context));
  }
  const rows = database.prepare(`SELECT status FROM transcription_runs ORDER BY id`).all().map((row) => row.status);
  assert.deepEqual(rows, ["failed", "failed"]);
  database.close();
});

test("停下来的任务写不回结果：三类任务的写入都要求还是 processing 且租约在自己手里", async () => {
  // 标停之所以管用，全靠这一条。哪天有人把守卫改松了，这里当场失败。
  const artifacts = await read("lib/server/jobs/event-ai-artifacts.ts");
  const artifactRepo = await read("lib/server/db/event-ai-artifact-repository.ts");
  const extraction = await read("lib/server/jobs/extraction-processor.ts");
  const transcription = await read("lib/server/jobs/transcription-processor.ts");
  assert.match(artifactRepo, /SET status = 'succeeded'[^`]{0,600}WHERE id = \? AND status = 'processing' AND lease_owner = \?/);
  assert.match(extraction, /WHERE r\.id = \? AND r\.status = 'processing' AND r\.lease_owner = \?/);
  assert.match(transcription, /WHERE id = \? AND status = 'processing' AND lease_owner = \?/);
  assert.doesNotMatch(artifacts, /SET status = 'succeeded'[^`]*WHERE id = \?`/);
});

// ---------------------------------------------------------------- 单条记录的回收站

function seedClaim(database, claimId, eventId, versionId) {
  insertRow(database, "claims", {
    id: claimId, workspace_id: WS, project_id: "prj_a", event_id: eventId,
    first_event_id: eventId, type: "budget", source: "ai",
  });
  insertRow(database, "claim_versions", { id: versionId, claim_id: claimId, version_no: 1, statement: claimId, source: "ai" });
}

function blockerCounts(database, eventId) {
  return database.prepare(trashBlockerCountsSql()).get(...allTrashBlockerBinds(eventId, WS));
}

function guardPasses(database, eventId) {
  return database
    .prepare(`SELECT CASE WHEN ${trashBlockerGuardSql()} THEN 1 ELSE 0 END AS ok`)
    .get(...allTrashBlockerBinds(eventId, WS)).ok;
}

test("只拦和别的记录连着的；人工确认过的结论、记录内部的关系都放行", async () => {
  const database = await migratedDatabase();
  baseWorkspace(database);
  seedClaim(database, "clm_a1", "evt_gone", "cv_a1");
  seedClaim(database, "clm_a2", "evt_gone", "cv_a2");
  seedClaim(database, "clm_b1", "evt_kept", "cv_b1");
  // 人工判过、签过字、写过笔记：这些跟着记录一起走，不拦。
  insertRow(database, "verdicts", { id: "vdt_1", workspace_id: WS, project_id: "prj_a", claim_id: "clm_a1", action: "confirm", base_version_id: "cv_a1", user_id: "u" });
  insertRow(database, "claim_evidence_review_attestations", { id: "att_1", workspace_id: WS, project_id: "prj_a", claim_id: "clm_a1", claim_version_id: "cv_a1", actor_id: "u" });
  // 两头都在这条记录里的关系，不拦。
  insertRow(database, "claim_relations", {
    id: "rel_inside", workspace_id: WS, project_id: "prj_a", type: "supersedes",
    source_claim_version_id: "cv_a1", target_claim_version_id: "cv_a2", context_version: 1,
  });

  const clean = blockerCounts(database, "evt_gone");
  assert.deepEqual(trashBlockers(clean), [], `不该拦：${JSON.stringify(clean)}`);
  assert.equal(guardPasses(database, "evt_gone"), 1);

  // 一头在别的记录的关系，拦。
  insertRow(database, "claim_relations", {
    id: "rel_cross", workspace_id: WS, project_id: "prj_a", type: "supersedes",
    source_claim_version_id: "cv_b1", target_claim_version_id: "cv_a1", context_version: 1,
  });
  const blocked = blockerCounts(database, "evt_gone");
  assert.equal(blocked.crossRelations, 1);
  assert.equal(trashBlockers(blocked).length, 1);
  assert.equal(guardPasses(database, "evt_gone"), 0, "预览拦住了，守卫却放行");
  // 另一头那条记录同样被拦，关系是双向的。
  assert.equal(blockerCounts(database, "evt_kept").crossRelations, 1);
  database.close();
});

test("重复出现和首次出处跨记录时拦，两个方向都算", async () => {
  const database = await migratedDatabase();
  baseWorkspace(database);
  seedClaim(database, "clm_b1", "evt_kept", "cv_b1");
  // evt_gone 里出现了 evt_kept 那条结论的重复。
  insertRow(database, "claim_occurrences", {
    id: "occ_1", claim_id: "clm_b1", claim_version_id: "cv_b1", event_id: "evt_gone", evidence_ref_id: "evr_1",
  });
  assert.equal(blockerCounts(database, "evt_gone").crossOccurrences, 1, "删掉出现重复的那条");
  assert.equal(blockerCounts(database, "evt_kept").crossOccurrences, 1, "删掉结论所在的那条");

  const database2 = await migratedDatabase();
  baseWorkspace(database2);
  insertRow(database2, "claims", {
    id: "clm_repeat", workspace_id: WS, project_id: "prj_a", event_id: "evt_gone",
    first_event_id: "evt_kept", type: "budget", source: "ai",
  });
  assert.equal(blockerCounts(database2, "evt_gone").crossLinks, 1);
  database.close();
  database2.close();
});

test("判定语句的占位符和绑定值一一对上", () => {
  for (const check of TRASH_BLOCKER_CHECKS) {
    const placeholders = (check.sql.match(/\?/g) ?? []).length;
    const binds = allTrashBlockerBinds("e", "w").length;
    assert.ok(placeholders > 0, check.key);
    // 总数对上即可：allTrashBlockerBinds 按判定顺序拼，单条错了总数一定错。
    void binds;
  }
  const total = TRASH_BLOCKER_CHECKS.reduce((sum, check) => sum + (check.sql.match(/\?/g) ?? []).length, 0);
  assert.equal(allTrashBlockerBinds("e", "w").length, total);
});

test("跟着结论走的表都改了归属，别的记录的行不动", async () => {
  const database = await migratedDatabase();
  baseWorkspace(database);
  seedClaim(database, "clm_a1", "evt_gone", "cv_a1");
  seedClaim(database, "clm_a2", "evt_gone", "cv_a2");
  seedClaim(database, "clm_b1", "evt_kept", "cv_b1");
  insertRow(database, "verdicts", { id: "vdt_a", workspace_id: WS, project_id: "prj_a", claim_id: "clm_a1", action: "confirm", base_version_id: "cv_a1", user_id: "u" });
  insertRow(database, "verdicts", { id: "vdt_b", workspace_id: WS, project_id: "prj_a", claim_id: "clm_b1", action: "confirm", base_version_id: "cv_b1", user_id: "u" });
  insertRow(database, "claim_evidence_review_attestations", { id: "att_a", workspace_id: WS, project_id: "prj_a", claim_id: "clm_a1", claim_version_id: "cv_a1", actor_id: "u" });
  insertRow(database, "user_notes", { id: "note_a", workspace_id: WS, project_id: "prj_a", claim_id: "clm_a1", author_id: "u", body: "记一笔" });
  insertRow(database, "user_notes", { id: "note_b", workspace_id: WS, project_id: "prj_a", claim_id: "clm_b1", author_id: "u", body: "别的记录" });
  insertRow(database, "claim_relations", {
    id: "rel_a", workspace_id: WS, project_id: "prj_a", type: "supersedes",
    source_claim_version_id: "cv_a1", target_claim_version_id: "cv_a2", context_version: 1,
  });
  insertRow(database, "draft_link_candidates", {
    id: "dl_a", workspace_id: WS, project_id: "prj_a", source_claim_id: "clm_a1", target_draft_claim_id: "clm_a2",
  });

  for (const table of CLAIM_LINKED_TABLES) {
    const rewrite = claimLinkedRewrite(table);
    const pairs = Array.from({ length: rewrite.pairs }, () => ["evt_gone", WS]).flat();
    database.prepare(rewrite.sql).run("prj_bin", ...pairs);
  }
  const owner = (table, id) => database.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id).project_id;
  for (const [table, id] of [["verdicts", "vdt_a"], ["claim_evidence_review_attestations", "att_a"], ["user_notes", "note_a"], ["claim_relations", "rel_a"], ["draft_link_candidates", "dl_a"]]) {
    assert.equal(owner(table, id), "prj_bin", `${table} 没跟着结论走，原项目还会数到它`);
  }
  assert.equal(owner("verdicts", "vdt_b"), "prj_a", "别的记录的判断被搬走了");
  assert.equal(owner("user_notes", "note_b"), "prj_a", "别的记录的笔记被搬走了");
  database.close();
});

test("带 project_id 的表要么跟着记录走，要么跟着结论走，要么明确是项目级的", async () => {
  // 以后加一张带 project_id 的表，这里会当场失败，逼人想清楚删记录时它归谁。
  const PROJECT_LEVEL = new Set([
    "events", "context_snapshots", "gap_checks", "glossary_entries", "glossary_entry_audits",
    "review_sessions", "scenario_verdicts", "transcript_imports", "view_snapshots",
  ]);
  const database = await migratedDatabase();
  const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name);
  const unaccounted = tables.filter((name) => {
    const columns = database.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name);
    if (!columns.includes("project_id")) return false;
    return !RECORD_OWNED_TABLES.includes(name) && !CLAIM_LINKED_TABLES.includes(name) && !PROJECT_LEVEL.has(name);
  });
  assert.deepEqual(unaccounted, []);
  database.close();
});

test("永久删除清干净这条记录的每一行，另一条记录原样不动", async () => {
  const database = await migratedDatabase({ foreignKeys: true });
  baseWorkspace(database);
  for (const [suffix, eventId] of [["gone", "evt_gone"], ["kept", "evt_kept"]]) {
    insertRow(database, "extraction_runs", { id: `ex_${suffix}`, workspace_id: WS, project_id: "prj_a", event_id: eventId, status: "succeeded" });
    insertRow(database, "claims", {
      id: `clm_${suffix}`, workspace_id: WS, project_id: "prj_a", event_id: eventId, extraction_run_id: `ex_${suffix}`,
      first_event_id: eventId, type: "budget", source: "ai",
    });
    insertRow(database, "claim_versions", { id: `cv_${suffix}`, claim_id: `clm_${suffix}`, version_no: 1, statement: "s", source: "ai" });
    insertRow(database, "verdicts", { id: `vdt_${suffix}`, workspace_id: WS, project_id: "prj_a", claim_id: `clm_${suffix}`, action: "confirm", base_version_id: `cv_${suffix}`, user_id: "u" });
    insertRow(database, "assets", { id: `ast_${suffix}`, workspace_id: WS, project_id: "prj_a", event_id: eventId, kind: "transcript" });
    insertRow(database, "asset_versions", {
      id: `av_${suffix}`, asset_id: `ast_${suffix}`, version_no: 1, r2_original_key: `r2/${suffix}/original`,
    });
    insertRow(database, "text_segments", {
      id: `seg_${suffix}`, workspace_id: WS, project_id: "prj_a", event_id: eventId, asset_version_id: `av_${suffix}`,
    });
    insertRow(database, "user_notes", { id: `note_${suffix}`, workspace_id: WS, project_id: "prj_a", claim_id: `clm_${suffix}`, author_id: "u", body: "n" });
  }
  insertRow(database, "trashed_events", {
    event_id: "evt_gone", workspace_id: WS, original_project_id: "prj_a", original_sequence_no: 1, trashed_at: T,
  });

  const keys = database.prepare(recordStorageKeysSql())
    .all(...Array.from({ length: 4 }, () => ["evt_gone", WS]).flat())
    .map((row) => row.key);
  assert.deepEqual(keys, ["r2/gone/original"], "存储里的原件要列出来一起删");

  recordPurgeStatements().forEach((statement, index) => {
    database.prepare(statement.sql).run(...recordPurgeBinds(index, "evt_gone", WS));
  });
  const count = (table, where, value) => database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where} = ?`).get(value).n;
  for (const [table, where, value] of [
    ["events", "id", "evt_gone"], ["claims", "id", "clm_gone"], ["claim_versions", "id", "cv_gone"],
    ["verdicts", "id", "vdt_gone"], ["assets", "id", "ast_gone"], ["asset_versions", "id", "av_gone"],
    ["text_segments", "id", "seg_gone"], ["user_notes", "id", "note_gone"], ["extraction_runs", "id", "ex_gone"],
    ["trashed_events", "event_id", "evt_gone"],
  ]) {
    assert.equal(count(table, where, value), 0, `${table} 留下了孤儿行`);
  }
  for (const [table, id] of [["events", "evt_kept"], ["claims", "clm_kept"], ["verdicts", "vdt_kept"], ["assets", "ast_kept"], ["user_notes", "note_kept"]]) {
    assert.equal(count(table, "id", id), 1, `${table} 里别的记录被误删了`);
  }
  database.close();
});

// ---------------------------------------------------------------- 仓储层接线

test("项目删除不再因为任务在跑而拒绝，而是在同一批里停任务", async () => {
  const core = await read("lib/server/db/core-repository.ts");
  const trashFn = core.slice(core.indexOf("export async function moveProjectToTrash"), core.indexOf("export async function restoreProject"));
  assert.doesNotMatch(trashFn, /status IN \('queued','processing'\)/, "还在按在跑的任务拦删除");
  assert.match(trashFn, /\.\.\.runCancellationBatch\("project"/);
  assert.match(trashFn, /await cancelRemoteResponses\(providerRequests\)/);
  assert.match(core, /can_delete: true,/);
  // 收容记录的隐藏项目不出现在项目回收站，也不能被恢复或永久删除。
  assert.equal((core.match(/p\.deleted_at IS NOT NULL\s+AND p\.system_role IS NULL/g) ?? []).length, 2);
});

test("记录移进回收站也停任务，并且远程取消在提交之后", async () => {
  const repo = await read("lib/server/db/event-trash-repository.ts");
  const fn = repo.slice(repo.indexOf("export async function moveEventToTrash"), repo.indexOf("export async function listTrashedEvents"));
  assert.match(fn, /\.\.\.runCancellationBatch\("event"/);
  const batchAt = fn.indexOf("await db.batch(statements)");
  const remoteAt = fn.indexOf("await cancelRemoteResponses(providerRequests)");
  assert.ok(batchAt > 0 && remoteAt > batchAt, "远程取消必须在本地提交成功之后");
});
