import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  MOVED_TABLES,
  MOVE_BLOCKER_CHECKS,
  canMoveEvent,
  eventMoveRewriteSql,
  moveBlockerBinds,
  moveBlockerCountsSql,
  moveBlockerGuardSql,
  moveBlockers,
  sameProjectBlocker,
} from "../lib/domain/event-move.ts";

const migrationsDirectory = new URL("../drizzle/", import.meta.url);
const repositoryPath = new URL("../lib/server/db/event-move-repository.ts", import.meta.url);

/** 七类都是零。键从判定条件表来，加了一类而忘了给理由，这里会当场露馅。 */
const noBlockers = () =>
  Object.fromEntries(MOVE_BLOCKER_CHECKS.map((check) => [check.key, 0]));

test("没有任何人工决定压着的时候才放行", () => {
  assert.equal(canMoveEvent(noBlockers()), true);
  assert.deepEqual(moveBlockers(noBlockers()), []);
});

test("每一类挡路的行都换成一句说得清的话", () => {
  for (const { key } of MOVE_BLOCKER_CHECKS) {
    const counts = { ...noBlockers(), [key]: 3 };
    const reasons = moveBlockers(counts);
    assert.equal(reasons.length, 1, `${key} 应该只给一条理由`);
    assert.equal(canMoveEvent(counts), false, `${key} 应该拦住搬动`);
    const reason = reasons[0];
    assert.ok(reason.length > 8, `${key} 的理由太短，说不清事`);
    // 这些是界面上直接念给人听的话，房规禁止的符号一个都不能有。
    for (const forbidden of ["「", "」", "→", "—", "我"]) {
      assert.equal(reason.includes(forbidden), false, `${key} 的理由里不该出现 ${forbidden}`);
    }
  }
});

test("能数出来的类别把数目说给人听", () => {
  // 场景锚点那条只有一条记录可说，报数字反而奇怪，所以不在此列。
  for (const key of ["verdicts", "claimRelations", "evidenceAttestations", "occurrenceDecisions", "crossEventLinks", "activeReviewSessions"]) {
    assert.match(moveBlockers({ ...noBlockers(), [key]: 7 })[0], /7/);
  }
});

test("搬回它自己所在的项目不叫搬", () => {
  assert.equal(sameProjectBlocker({ sourceProjectId: "prj_a", targetProjectId: "prj_a" }) !== null, true);
  assert.equal(sameProjectBlocker({ sourceProjectId: "prj_a", targetProjectId: " prj_a " }) !== null, true);
  assert.equal(sameProjectBlocker({ sourceProjectId: "prj_a", targetProjectId: "prj_b" }), null);
  assert.equal(sameProjectBlocker({ sourceProjectId: "prj_a", targetProjectId: "  " }) !== null, true);

  const reasons = moveBlockers(noBlockers(), { sourceProjectId: "prj_a", targetProjectId: "prj_a" });
  assert.equal(reasons.length, 1);
});

test("坏掉的数目不会变成理由", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -4, undefined, null, "三"]) {
    assert.deepEqual(moveBlockers({ ...noBlockers(), verdicts: bad }), []);
  }
});

test("重写语句只改归属，不动别的列", () => {
  for (const table of MOVED_TABLES) {
    assert.equal(
      eventMoveRewriteSql(table),
      `UPDATE ${table} SET project_id = ? WHERE event_id = ? AND workspace_id = ?`,
    );
  }
});

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  const files = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const filename of files) {
    const sql = await readFile(new URL(filename, migrationsDirectory), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }
  return database;
}

/**
 * 表里每个必填又没有默认值的列都给个值，这样加了新列这个测试也不用改。
 * seed 拌进生成的值里，同一张表插两行才不会撞上唯一索引。
 */
function insertRow(database, table, overrides, seed = 1) {
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

test("清单和真实表结构对得上，以后加表会当场失败", async () => {
  const database = await migratedDatabase();
  const withBothColumns = database
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all()
    .map((row) => row.name)
    .filter((name) => {
      const columns = database.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name);
      return columns.includes("project_id") && columns.includes("event_id");
    });

  // 两个方向都查：清单里有假表会漏改，表结构里有漏登记的表会留下孤儿行。
  assert.deepEqual([...withBothColumns].sort(), [...MOVED_TABLES].sort());
  database.close();
});

test("搬完之后每一张表里的行都跟着走了", async () => {
  const database = await migratedDatabase();
  // 这个测试问的是归属列有没有跟着改，不是外键完整性，所以用最小行，不接外键。
  database.exec("PRAGMA foreign_keys = OFF;");
  const workspace = "ws_1";
  insertRow(database, "workspaces", { id: workspace, name: "工作区" });
  insertRow(database, "projects", { id: "prj_source", workspace_id: workspace, name: "原项目", next_event_sequence: 3 });
  insertRow(database, "projects", { id: "prj_target", workspace_id: workspace, name: "目标项目", next_event_sequence: 5 });
  insertRow(database, "events", {
    id: "evt_moving", workspace_id: workspace, project_id: "prj_source",
    event_type: "meeting", title: "要搬的材料", occurred_at: "2026-09-21T00:00:00Z", sequence_no: 2,
  });
  // 原项目里留一条不该被碰的记录，顺便证明它的序号不会被重排。
  insertRow(database, "events", {
    id: "evt_staying", workspace_id: workspace, project_id: "prj_source",
    event_type: "meeting", title: "留下的材料", occurred_at: "2026-09-21T00:00:00Z", sequence_no: 1,
  });
  for (const table of MOVED_TABLES) {
    insertRow(database, table, {
      id: `${table}_row`, workspace_id: workspace, project_id: "prj_source", event_id: "evt_moving",
    }, 1);
    // 同一张表里挂在别的记录上的行，一行都不许动。
    insertRow(database, table, {
      id: `${table}_other`, workspace_id: workspace, project_id: "prj_source", event_id: "evt_staying",
    }, 2);
  }
  insertRow(database, "event_routing_suggestions", {
    event_id: "evt_moving", workspace_id: workspace,
    suggested_project_id: "prj_target", probability: 0.91, judge: "jev",
  });

  const timestamp = "2026-09-21T10:00:00Z";
  database.exec("BEGIN");
  database
    .prepare(
      `UPDATE projects SET next_event_sequence = next_event_sequence + 1,
              ledger_version = ledger_version + 1, context_version = context_version + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    )
    .run(timestamp, "prj_target", workspace);
  database
    .prepare(
      `UPDATE events SET project_id = ?,
              sequence_no = (SELECT next_event_sequence - 1 FROM projects WHERE id = ? AND workspace_id = ?),
              updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    )
    .run("prj_target", "prj_target", workspace, timestamp, "evt_moving", workspace);
  for (const table of MOVED_TABLES) {
    database.prepare(eventMoveRewriteSql(table)).run("prj_target", "evt_moving", workspace);
  }
  database
    .prepare(`DELETE FROM event_routing_suggestions WHERE event_id = ? AND workspace_id = ?`)
    .run("evt_moving", workspace);
  database
    .prepare(
      `UPDATE projects SET ledger_version = ledger_version + 1, context_version = context_version + 1, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    )
    .run(timestamp, "prj_source", workspace);
  database.exec("COMMIT");

  for (const table of MOVED_TABLES) {
    const moved = database.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(`${table}_row`);
    assert.equal(moved.project_id, "prj_target", `${table} 里的行没跟着搬`);
    const untouched = database.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(`${table}_other`);
    assert.equal(untouched.project_id, "prj_source", `${table} 里别的记录的行被误改了`);
  }

  const moved = database.prepare(`SELECT project_id, sequence_no FROM events WHERE id = ?`).get("evt_moving");
  assert.equal(moved.project_id, "prj_target");
  // 目标项目的下一个号是 5，所以搬过去的记录接在 5，而不是沿用它原来的 2。
  assert.equal(moved.sequence_no, 5);
  const stayed = database.prepare(`SELECT project_id, sequence_no FROM events WHERE id = ?`).get("evt_staying");
  assert.deepEqual({ ...stayed }, { project_id: "prj_source", sequence_no: 1 });
  // 原项目不重排，2 号就这么空着。唯一索引只管不重复，不管连不连续。
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND sequence_no = 2`).get("prj_source").n,
    0,
  );

  assert.equal(
    database.prepare(`SELECT COUNT(*) AS n FROM event_routing_suggestions WHERE event_id = ?`).get("evt_moving").n,
    0,
    "搬完之后那条建议应该没了",
  );
  for (const projectId of ["prj_source", "prj_target"]) {
    const project = database.prepare(`SELECT ledger_version, context_version FROM projects WHERE id = ?`).get(projectId);
    assert.equal(project.ledger_version, 1, `${projectId} 的账本版本没往前走`);
    assert.equal(project.context_version, 1, `${projectId} 的上下文版本没往前走`);
  }
  database.close();
});

test("预览数出来的和守卫判出来的是同一件事", async () => {
  const database = await migratedDatabase();
  database.exec("PRAGMA foreign_keys = OFF;");
  const workspace = "ws_1";
  insertRow(database, "workspaces", { id: workspace, name: "工作区" });
  insertRow(database, "projects", { id: "prj_source", workspace_id: workspace, name: "原项目", scenario_status: "confirmed" });
  insertRow(database, "projects", { id: "prj_target", workspace_id: workspace, name: "目标项目", scenario_status: "confirmed" });
  insertRow(database, "events", {
    id: "evt_moving", workspace_id: workspace, project_id: "prj_source",
    event_type: "meeting", title: "材料", occurred_at: "2026-09-21T00:00:00Z", sequence_no: 1,
  });
  insertRow(database, "claims", {
    id: "clm_1", workspace_id: workspace, project_id: "prj_source", event_id: "evt_moving",
    first_event_id: "evt_moving", type: "budget", source: "ai",
  });

  const context = { event: "evt_moving", workspace, sourceProject: "prj_source", targetProject: "prj_target" };
  const countsOf = () =>
    database.prepare(moveBlockerCountsSql()).get(...moveBlockerBinds(context));
  const guardPasses = () =>
    database
      .prepare(`SELECT CASE WHEN ${moveBlockerGuardSql()} THEN 1 ELSE 0 END AS ok`)
      .get(...moveBlockerBinds(context)).ok;

  const clean = countsOf();
  assert.equal(canMoveEvent(clean), true, `干净的记录不该被拦：${JSON.stringify(clean)}`);
  assert.equal(guardPasses(), 1);

  // 有人对这条记录的结论下过判断，两边必须同时变脸。
  insertRow(database, "verdicts", {
    id: "vdt_1", workspace_id: workspace, project_id: "prj_source", claim_id: "clm_1",
    action: "confirm", base_version_id: "cv_1", user_id: "u_1",
  });
  const blocked = countsOf();
  assert.equal(blocked.verdicts, 1);
  assert.equal(canMoveEvent(blocked), false);
  assert.equal(guardPasses(), 0, "预览拦住了，守卫却放行，并发就能穿过去");
  database.close();
});

/** 一个场景干净的工作区：原项目场景已确认，只有一条要搬的记录和它的一条结论。 */
async function cleanWorkspace() {
  const database = await migratedDatabase();
  database.exec("PRAGMA foreign_keys = OFF;");
  insertRow(database, "workspaces", { id: "ws_1", name: "工作区" });
  for (const id of ["prj_source", "prj_target"]) {
    insertRow(database, "projects", { id, workspace_id: "ws_1", name: id, scenario_status: "confirmed" });
  }
  insertRow(database, "events", {
    id: "evt_moving", workspace_id: "ws_1", project_id: "prj_source",
    event_type: "meeting", title: "材料", occurred_at: "2026-09-21T00:00:00Z", sequence_no: 1,
  });
  insertRow(database, "claims", {
    id: "clm_1", workspace_id: "ws_1", project_id: "prj_source", event_id: "evt_moving",
    // 这条结论是它自己的首次出处，否则它本身就成了一处跨记录引用。
    first_event_id: "evt_moving", type: "budget", source: "ai",
  });
  return database;
}

const BLOCKING_ROWS = {
  verdicts: (database) => insertRow(database, "verdicts", {
    id: "vdt_1", workspace_id: "ws_1", project_id: "prj_source", claim_id: "clm_1",
    action: "confirm", base_version_id: "cv_1", user_id: "u_1",
  }),
  claimRelations: (database) => {
    insertRow(database, "claim_versions", { id: "cv_1", claim_id: "clm_1", version_no: 1, statement: "预算一百二", source: "ai" });
    insertRow(database, "claim_relations", {
      id: "rel_1", workspace_id: "ws_1", project_id: "prj_source", type: "supersedes",
      source_claim_version_id: "cv_1", target_claim_version_id: "cv_other", context_version: 1,
    });
  },
  evidenceAttestations: (database) => insertRow(database, "claim_evidence_review_attestations", {
    id: "att_1", workspace_id: "ws_1", project_id: "prj_source", claim_id: "clm_1",
    claim_version_id: "cv_1", actor_id: "u_1",
  }),
  occurrenceDecisions: (database) => insertRow(database, "claim_occurrences", {
    id: "occ_1", claim_id: "clm_other", claim_version_id: "cv_other", event_id: "evt_moving",
    evidence_ref_id: "evr_1", occurrence_verdict_id: "ovd_1", confirmed_at: "2026-09-21T00:00:00Z",
  }),
  crossEventLinks: (database) => insertRow(database, "claims", {
    id: "clm_repeat", workspace_id: "ws_1", project_id: "prj_source", event_id: "evt_moving",
    // 这条结论是别处那条的重复，首次出处留在原项目里。
    first_event_id: "evt_elsewhere", type: "budget", source: "ai",
  }, 2),
  activeReviewSessions: (database) => insertRow(database, "review_sessions", {
    id: "rvs_1", workspace_id: "ws_1", project_id: "prj_source", actor_id: "u_1",
    status: "active", started_at: "2026-09-21T00:00:00Z",
  }),
  scenarioAnchor: (database) => {
    database.prepare(`UPDATE projects SET scenario_status = 'unassessed' WHERE id = ?`).run("prj_source");
    insertRow(database, "events", {
      id: "evt_stranded", workspace_id: "ws_1", project_id: "prj_source",
      event_type: "meeting", title: "等着定场景的材料", occurred_at: "2026-09-21T00:00:00Z", sequence_no: 2,
    }, 2);
  },
};

test("七类判定条件各自真的能查到它要查的行", async () => {
  const context = { event: "evt_moving", workspace: "ws_1", sourceProject: "prj_source", targetProject: "prj_target" };
  for (const { key } of MOVE_BLOCKER_CHECKS) {
    const database = await cleanWorkspace();
    const before = database.prepare(moveBlockerCountsSql()).get(...moveBlockerBinds(context));
    assert.equal(canMoveEvent(before), true, `布景本身就不干净：${JSON.stringify(before)}`);

    BLOCKING_ROWS[key](database);
    const after = database.prepare(moveBlockerCountsSql()).get(...moveBlockerBinds(context));
    assert.ok(after[key] > 0, `${key} 的判定条件没查到那行`);
    assert.equal(canMoveEvent(after), false);
    database.close();
  }
});

test("写入那条路自己再判一次，不吃预览的结论", async () => {
  const source = await readFile(repositoryPath, "utf8");
  // 预览只是给界面看的。真正说了算的是 batch 里那条守卫：条件不成立就写进一个
  // 违反 CHECK 的值，整段回滚。
  assert.match(source, /INSERT INTO mutation_guards/);
  assert.match(source, /moveBlockerGuardSql\(\)/);
  assert.match(source, /moveBlockerBinds\(context\)/);
  // 守卫和预览用的是同一份判定条件，不是各写一套。
  assert.match(source, /moveBlockerCountsSql\(\)/);
  // 表清单只能来自常量，谁也不许在这里手抄一遍表名。
  assert.match(source, /MOVED_TABLES\.map\(\(table\) =>/);
  assert.match(source, /eventMoveRewriteSql\(table\)/);
  for (const table of MOVED_TABLES) {
    assert.equal(
      new RegExp(`["'\`]${table}["'\`]`).test(source),
      false,
      `${table} 不该在仓储层里被手抄一遍`,
    );
  }
  // 搬完清掉建议，两个项目的版本都往前走。
  assert.match(source, /DELETE FROM event_routing_suggestions/);
  assert.match(source, /ledger_version = ledger_version \+ 1/);
  assert.match(source, /next_event_sequence = next_event_sequence \+ 1/);
});
