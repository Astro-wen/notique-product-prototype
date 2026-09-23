import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

/*
 * 项目类型不再要人确认。以前第一条记录分析完弹一张「设置项目类型」卡片，
 * 用户看不懂，而且第二条起要等人点了才能分析，整条流程卡在那里。
 */

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("the first analysis applies the most confident type itself", async () => {
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  assert.match(processor, /\[\.\.\.candidates\]\.sort\(\(left, right\) => right\.confidence - left\.confidence\)\[0\]/);
  assert.match(processor, /SET scenario_status = 'confirmed', scenario = \?/);
  assert.match(processor, /scenario_confirmed_by = 'system:auto-scenario'/);
  assert.doesNotMatch(processor, /SET scenario_status = 'pending_confirmation'/);
  // 自动采用不推进上下文版本，同项目里正在跑的分析不必重跑。
  const autoConfirm = processor.slice(processor.indexOf("SET scenario_status = 'confirmed', scenario = ?"), processor.indexOf("AND scenario_assessment_run_id = ? AND context_version = ?"));
  assert.doesNotMatch(autoConfirm, /context_version = context_version \+ 1/);
  // 不负责判类型的分析带回候选时直接不用，不作废整次分析。
  assert.doesNotMatch(processor, /Extraction returned scenario candidates for a project with a confirmed scenario/);
});

test("no record waits for the type any more", async () => {
  const [core, scanner] = await Promise.all([
    read("lib/server/db/core-repository.ts"),
    read("lib/server/jobs/automatic-extraction.ts"),
  ]);
  assert.doesNotMatch(core, /Confirm the scenario from the first event before extracting later events/);
  assert.doesNotMatch(core, /The first event is already assessing a scenario or awaiting confirmation/);
  assert.doesNotMatch(scanner, /sc\.sequence_no = 1 OR sc\.scenario_status = 'confirmed'/);
});

test("projects already waiting on the card get their most confident type applied", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = OFF;");
  const directory = new URL("../drizzle/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  const before = files.filter((name) => name < "0022");
  for (const filename of before) {
    database.exec((await readFile(new URL(filename, directory), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  database.prepare(`INSERT INTO workspaces (id, name) VALUES ('ws', 'ws')`).run();
  const candidates = JSON.stringify([
    { scenario: "Financing-constrained home purchase", confidence: 0.91, reason: "r" },
    { scenario: "Residential buyer purchase journey", confidence: 0.99, reason: "r" },
  ]);
  database.prepare(`INSERT INTO projects (id, workspace_id, name, scenario_status, scenario_candidates_json)
                    VALUES ('waiting', 'ws', 'p', 'pending_confirmation', ?), ('fresh', 'ws', 'q', 'unassessed', '[]')`).run(candidates);
  database.exec((await readFile(new URL("0022_auto_confirm_scenarios.sql", directory), "utf8")).replaceAll("--> statement-breakpoint", ""));
  const waiting = database.prepare(`SELECT scenario_status, scenario, scenario_confirmed_by FROM projects WHERE id = 'waiting'`).get();
  assert.deepEqual({ ...waiting }, {
    scenario_status: "confirmed",
    scenario: "Residential buyer purchase journey",
    scenario_confirmed_by: "system:auto-scenario",
  });
  assert.equal(database.prepare(`SELECT scenario_status FROM projects WHERE id = 'fresh'`).get().scenario_status, "unassessed");
  database.close();
});
