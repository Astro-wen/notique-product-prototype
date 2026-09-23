import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  CONTEXT_CHANGED_RESTARTED,
  MAX_CONTEXT_RESTARTS_PER_HOUR,
  contextRestartIdempotencyKey,
  mayRestartAfterContextChange,
} from "../lib/domain/context-restart.ts";

const read = (relative) => readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("连续被打断时有上限，不会无限重跑", () => {
  assert.equal(mayRestartAfterContextChange(0), true);
  assert.equal(mayRestartAfterContextChange(MAX_CONTEXT_RESTARTS_PER_HOUR - 1), true);
  assert.equal(mayRestartAfterContextChange(MAX_CONTEXT_RESTARTS_PER_HOUR), false);
  assert.equal(mayRestartAfterContextChange(Number.NaN), false);
});

test("同一个旧任务只会有一个接班", () => {
  assert.equal(contextRestartIdempotencyKey("run_1"), contextRestartIdempotencyKey("run_1"));
  assert.notEqual(contextRestartIdempotencyKey("run_1"), contextRestartIdempotencyKey("run_2"));
});

test("上下文变了不再直接判失败，而是另起接班任务", async () => {
  const processor = await read("lib/server/jobs/extraction-processor.ts");
  // 开始调模型之前就查一次，接班任务一分钱都不多花。
  const beforeStages = processor.indexOf("Project context changed before extraction started.");
  const firstStage = processor.indexOf('stage: "inventory"');
  assert.ok(beforeStages > 0 && beforeStages < firstStage, "要在第一个模型阶段之前查上下文");
  assert.match(processor, /error instanceof ProcessingFault && error\.code === "CLAIM_VERSION_CONFLICT"[\s\S]{0,80}restartAfterContextChange/);

  const restart = processor.slice(processor.indexOf("async function restartAfterContextChange"), processor.indexOf("export async function failExpiredProcessingRuns"));
  // 先按接班码收尾再建新任务：createExtractionRun 见到在跑的旧任务会拒绝。
  const markedAt = restart.indexOf("new ProcessingFault(CONTEXT_CHANGED_RESTARTED");
  const createdAt = restart.indexOf("await createExtractionRun(");
  assert.ok(markedAt > 0 && createdAt > markedAt);
  assert.match(restart, /contextRestartIdempotencyKey\(String\(run\.id\)\)/);
  assert.match(restart, /mayRestartAfterContextChange/);
  // 接不上班就改回普通失败码，界面照常提示。
  assert.match(restart, /SET error_code = 'CLAIM_VERSION_CONFLICT'[\s\S]*WHERE id = \? AND error_code = \?/);
});

test("接班期间界面不显示失败，自动整理也不把它算作一次失败", async () => {
  const [workflow, scanner, page] = await Promise.all([
    read("lib/server/db/workflow-repository.ts"),
    read("lib/server/jobs/automatic-extraction.ts"),
    read("app/page.tsx"),
  ]);
  assert.match(workflow, /rawExtractionStatus === "failed" &&[\s\S]{0,120}CONTEXT_CHANGED_RESTARTED[\s\S]{0,40}\? "queued"/);
  assert.match(scanner, new RegExp(`error_code, ''\\) <> '${CONTEXT_CHANGED_RESTARTED}'`));
  const branchStart = page.indexOf("latest.errorCode === CONTEXT_CHANGED_RESTARTED");
  const branch = page.slice(branchStart, page.indexOf('} else if (latest.status === "failed") {', branchStart));
  assert.match(branch, /api\.getEvent\(eventId\)/);
  assert.match(branch, /setRun\(successor\)/);
  assert.doesNotMatch(branch, /setEventIssue/, "接班期间不该报错");
});
