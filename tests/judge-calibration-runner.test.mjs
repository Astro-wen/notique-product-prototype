import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_JUDGE_GATES } from "../lib/domain/judge-calibration.ts";
import {
  VERDICT_LABEL_SQL,
  buildCalibration,
  collectAnswers,
  countBySource,
  estimateCostUsd,
  gateSentence,
  lexicalStubJudge,
  loadEvalSamples,
  parseArgs,
  renderMarkdown,
  renderReport,
  resolveJudge,
  stratify,
  verdictSamples,
} from "../scripts/lib/judge-calibration-runner.mjs";

const repoRoot = new URL("..", import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);

// ---------------------------------------------------------------------------
// 裁决行化成样本
// ---------------------------------------------------------------------------

const row = (overrides) => ({
  action: "confirm",
  claim_id: "clm-1",
  claim_version_id: "cv-1",
  statement: "预算上限是一百三十五万。",
  evidence_ref_id: "evr-1",
  quote: "我们最多到一百三十五。",
  evidence_role: "direct",
  ...overrides,
});

test("确认是正标注，否决是负标注，来源分别记着", () => {
  const samples = verdictSamples([
    row({}),
    row({ action: "reject", claim_id: "clm-2", claim_version_id: "cv-2", evidence_ref_id: "evr-2" }),
  ]);
  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((sample) => [sample.actual, sample.labelSource]),
    [[true, "verdict_confirm"], [false, "verdict_reject"]],
  );
  assert.equal(samples[0].claimVersionId, "cv-1");
  assert.equal(samples[0].evidenceRole, "direct");
});

test("一版陈述上挂几条引用就出几条样本，标注一起带下去", () => {
  const samples = verdictSamples([
    row({ evidence_ref_id: "evr-1", quote: "第一句原话。" }),
    row({ evidence_ref_id: "evr-2", quote: "第二句原话。" }),
  ]);
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((sample) => sample.evidenceRefId), ["evr-1", "evr-2"]);
  assert.ok(samples.every((sample) => sample.actual === true));
  assert.ok(samples.every((sample) => sample.statement === "预算上限是一百三十五万。"));
});

test("edit 和 withdraw 不是引用的标注，不进样本", () => {
  // 这两种动作说明陈述本身要改或要撤，跟引用撑不撑得住是两回事。
  const samples = verdictSamples([
    row({ action: "edit", evidence_ref_id: "evr-edit" }),
    row({ action: "withdraw", evidence_ref_id: "evr-withdraw" }),
    row({ action: "confirm", evidence_ref_id: "evr-keep" }),
  ]);
  assert.deepEqual(samples.map((sample) => sample.evidenceRefId), ["evr-keep"]);
});

test("没有原话或没有陈述的行判断不了，直接丢掉", () => {
  const samples = verdictSamples([
    row({ evidence_ref_id: "evr-null", quote: null }),
    row({ evidence_ref_id: "evr-blank", quote: "   " }),
    row({ evidence_ref_id: "evr-nostatement", statement: "" }),
    row({ evidence_ref_id: "evr-ok" }),
  ]);
  assert.deepEqual(samples.map((sample) => sample.evidenceRefId), ["evr-ok"]);
});

test("同一条引用上既有确认又有否决，两边都不要", () => {
  const samples = verdictSamples([
    row({ action: "confirm", evidence_ref_id: "evr-both" }),
    row({ action: "reject", evidence_ref_id: "evr-both" }),
    row({ action: "confirm", evidence_ref_id: "evr-clean" }),
  ]);
  assert.deepEqual(samples.map((sample) => sample.evidenceRefId), ["evr-clean"]);
});

test("陈述和原话两边都去掉首尾空白再用", () => {
  const [sample] = verdictSamples([row({ statement: "  有空格的陈述。 ", quote: "\t有空格的原话。\n" })]);
  assert.equal(sample.statement, "有空格的陈述。");
  assert.equal(sample.quote, "有空格的原话。");
});

test("取标注的 SQL 能在真实迁移出来的表上跑通", async () => {
  // 列名靠 schema 定，不靠记忆。这条跑得通，说明 verdicts 到 claim_versions
  // 再到 evidence_refs 的连接键没写错。
  const database = new DatabaseSync(":memory:");
  // 只测连接键，不测外键完整性：这里不插 claims 和 workspaces。
  database.exec("PRAGMA foreign_keys = OFF;");
  const migrationsDirectory = new URL("drizzle/", repoRoot);
  const files = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const filename of files) {
    const sql = await readFile(new URL(filename, migrationsDirectory), "utf8");
    database.exec(sql.replaceAll("--> statement-breakpoint", ""));
  }

  database.exec(`
    INSERT INTO claim_versions (id, claim_id, version_no, statement, source)
      VALUES ('cv-1', 'clm-1', 1, '屋顶两年前换过。', 'ai');
    INSERT INTO evidence_refs (
      id, workspace_id, project_id, event_id, claim_version_id, kind, quote_raw,
      evidence_role, provenance_grade, structural_validation_status, semantic_support_verdict
    ) VALUES (
      'evr-1', 'ws-1', 'prj-1', 'evt-1', 'cv-1', 'transcript', '屋顶是前年换的。',
      'direct', 'primary', 'valid', 'unreviewed'
    );
    INSERT INTO verdicts (id, workspace_id, project_id, claim_id, action, base_version_id, user_id)
      VALUES ('vd-1', 'ws-1', 'prj-1', 'clm-1', 'confirm', 'cv-1', 'user-1');
    INSERT INTO verdicts (id, workspace_id, project_id, claim_id, action, base_version_id, user_id)
      VALUES ('vd-2', 'ws-1', 'prj-1', 'clm-1', 'edit', 'cv-1', 'user-1');
  `);

  const rows = database.prepare(VERDICT_LABEL_SQL).all();
  database.close();
  assert.equal(rows.length, 1, "只有 confirm 该被取出来");
  const samples = verdictSamples(rows);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].statement, "屋顶两年前换过。");
  assert.equal(samples[0].quote, "屋顶是前年换的。");
  assert.equal(samples[0].labelSource, "verdict_confirm");
});

// ---------------------------------------------------------------------------
// 评估集标注
// ---------------------------------------------------------------------------

test("评估集里的正例和负控制项都能还原成陈述加原话", async () => {
  const samples = await loadEvalSamples(repoRootPath);
  const counts = countBySource(samples);
  assert.ok(counts.eval_positive > 100, `正例太少：${counts.eval_positive}`);
  assert.ok(counts.eval_negative >= 8, `负例太少：${counts.eval_negative}`);
  assert.ok(samples.every((sample) => sample.statement && sample.quote));
  // 图片证据判断方看不到，不该混进来。
  assert.ok(samples.every((sample) => !sample.evidenceRefId.includes(":photo:")));
});

// ---------------------------------------------------------------------------
// 取样
// ---------------------------------------------------------------------------

test("--limit 按来源轮流截，不会把负例整段切掉", () => {
  const make = (labelSource, actual, count) =>
    Array.from({ length: count }, (unused, index) => ({
      evidenceRefId: `${labelSource}-${index}`,
      labelSource,
      actual,
    }));
  const samples = [...make("eval_positive", true, 90), ...make("eval_negative", false, 10)];
  const taken = stratify(samples, 10);
  assert.equal(taken.length, 10);
  const counts = countBySource(taken);
  assert.equal(counts.eval_negative, 5, "轮流取应当让负例进到前十条里");
  assert.equal(counts.eval_positive, 5);
  // 确定性：同样输入两次取出同样的前缀，缓存才能跨次复用。
  assert.deepEqual(stratify(samples, 10), taken);
  assert.deepEqual(stratify(samples, 6), taken.slice(0, 6));
});

// ---------------------------------------------------------------------------
// 结论句
// ---------------------------------------------------------------------------

function calibrationOf(groups) {
  const samples = [];
  const answers = new Map();
  let serial = 0;
  for (const group of groups) {
    for (let index = 0; index < group.count; index += 1) {
      const id = `s-${serial}`;
      serial += 1;
      samples.push({
        evidenceRefId: id,
        labelSource: "eval_positive",
        actual: index < group.trueCount,
      });
      answers.set(id, group.predicted);
    }
  }
  return buildCalibration(samples, answers);
}

test("四道门全过时，结论句说可以接", () => {
  const calibration = calibrationOf([
    { predicted: 0.95, count: 120, trueCount: 114 },
    { predicted: 0.05, count: 120, trueCount: 6 },
  ]);
  assert.equal(calibration.passed, true);
  assert.equal(gateSentence(calibration), "判断方可以接进去了，四道门全过，样本 240 条。");
});

test("样本不够时，结论句直接说还差多少条", () => {
  const calibration = calibrationOf([
    { predicted: 0.95, count: 25, trueCount: 24 },
    { predicted: 0.05, count: 25, trueCount: 1 },
  ]);
  assert.equal(calibration.passed, false);
  assert.equal(
    gateSentence(calibration),
    `判断方还不能接进去：样本不够，还差 ${DEFAULT_JUDGE_GATES.minSamples - 50} 条，校准结论要等样本补齐才算数。`,
  );
  // 样本不够时其余三道一律判负，免得几十条碰巧好看就放行。
  assert.ok(calibration.gates.every((gate) => !gate.passed));
});

test("样本够、准确率也够，但概率给得不准时，结论句点名是哪两道门没过", () => {
  // 说 0.65 的那批里实际有 0.95 支持：分类对，概率不对，阈值没法用。
  const calibration = calibrationOf([{ predicted: 0.65, count: 240, trueCount: 228 }]);
  assert.equal(calibration.passed, false);
  assert.deepEqual(
    calibration.gates.filter((gate) => !gate.passed).map((gate) => gate.name),
    ["calibration_error", "worst_bucket_gap"],
  );
  assert.equal(
    gateSentence(calibration),
    "判断方还不能接进去：校准误差 0.300 超过 0.1；最差单桶偏差 0.300 超过 0.2。",
  );
});

// ---------------------------------------------------------------------------
// --dry-run 跑通全程
// ---------------------------------------------------------------------------

test("--dry-run 用规则桩跑出一份完整报告，四项指标和四道门都在", async () => {
  const samples = stratify(await loadEvalSamples(repoRootPath), 60);
  const judge = lexicalStubJudge();
  const answers = await collectAnswers({ judge, samples, chunkSize: 16 });
  assert.equal(answers.size, samples.length, "规则桩该把每条都答了");

  const calibration = buildCalibration(samples, answers);
  const context = { judgeName: judge.name, dryRun: true, from: ["eval"], date: "2026-09-21" };
  const text = renderReport(calibration, context);
  for (const section of ["样本按标注来源", "准确率", "校准误差 ECE", "最差单桶偏差", "分桶"]) {
    assert.ok(text.includes(section), `报告里缺 ${section}`);
  }
  for (const gate of ["sample_size", "calibration_error", "worst_bucket_gap", "accuracy"]) {
    assert.ok(text.includes(gate), `报告里缺 ${gate} 这道门`);
  }
  assert.ok(text.startsWith("判断方还不能接进去："), "结论要放在最前面");
  assert.ok(text.trimEnd().endsWith("条，校准结论要等样本补齐才算数。"), "结尾也要有那句结论");

  const markdown = renderMarkdown(calibration, context);
  assert.ok(markdown.startsWith("# 2026-09-21 引用支持度判断方校准"));
  assert.ok(markdown.includes("没有调用任何接口"), "dry run 的文档必须写明数字不是 Jev 的成绩");
  // 落盘的只有聚合数字，原话一个字都不能进去。
  for (const sample of samples) assert.ok(!markdown.includes(sample.quote));
});

test("规则桩是确定性的，同样的输入给同样的概率", async () => {
  const judge = lexicalStubJudge();
  const question = {
    claimId: "c", claimVersionId: "cv", evidenceRefId: "e",
    statement: "The buyers require at least three bedrooms.",
    quote: "We need at least three bedrooms.",
    evidenceRole: "direct",
  };
  const [first] = await judge.judge([question]);
  const [second] = await judge.judge([question]);
  assert.equal(first.supportProbability, second.supportProbability);
  assert.ok(first.supportProbability > 0.5, "词面几乎全中该给到 0.5 以上");
});

// ---------------------------------------------------------------------------
// 花钱这件事必须有人点头
// ---------------------------------------------------------------------------

test("不加 --yes 就拿不到真实判断方", () => {
  assert.throws(
    () => resolveJudge({ dryRun: false, yes: false, concurrency: 8 }, { apiKey: "sk-test" }),
    /--yes/u,
  );
  // --dry-run 走规则桩，永远不碰接口。
  assert.equal(resolveJudge({ dryRun: true, yes: false, concurrency: 8 }, {}).name, "stub-lexical");
});

test("付费接口在源码里只有一个入口，而且 --yes 的检查就在它前面", async () => {
  const libSource = await readFile(new URL("scripts/lib/judge-calibration-runner.mjs", repoRoot), "utf8");
  const entrySource = await readFile(new URL("scripts/run-judge-calibration.mjs", repoRoot), "utf8");

  const calls = [...libSource.matchAll(/createJevSupportJudge\(/gu)].length;
  assert.equal(calls, 1, "建真实判断方的地方只能有一处");
  assert.ok(
    !/createJevSupportJudge\(/u.test(entrySource),
    "入口脚本不该绕过 resolveJudge 自己建判断方",
  );

  const guardIndex = libSource.indexOf("if (!options.yes)");
  const callIndex = libSource.indexOf("createJevSupportJudge(");
  assert.ok(guardIndex > 0 && guardIndex < callIndex, "--yes 的检查必须排在建判断方之前");

  // 入口在算完成本之后、拿判断方之前就停住，所以不确认连一个请求都发不出去。
  const stopIndex = entrySource.indexOf("!options.dryRun && !options.yes");
  const resolveIndex = entrySource.indexOf("resolveJudge(");
  assert.ok(stopIndex > 0 && stopIndex < resolveIndex);
});

test("不加 --yes 真的跑一次，只会打印预估成本", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/run-judge-calibration.mjs", "--from=eval", "--limit=5", "--no-write"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.ok(output.includes("预估花费 $0.01"), output);
  assert.ok(output.includes("没加 --yes"), output);
  assert.ok(!output.includes("分桶"), "没确认就不该跑出报告");
});

test("成本预估按条数线性给，好让人看清量级", () => {
  assert.equal(estimateCostUsd(0), 0);
  assert.equal(Number(estimateCostUsd(200).toFixed(2)), 0.2);
});

test("参数解析：默认读线上标注，--from 可以叠加", () => {
  assert.deepEqual(parseArgs([]).from, ["verdicts"]);
  assert.deepEqual(parseArgs(["--from=eval,verdicts"]).from, ["eval", "verdicts"]);
  assert.equal(parseArgs(["--limit=40"]).limit, 40);
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--yes"]).yes, true);
  assert.throws(() => parseArgs(["--from=guess"]), /只认/u);
  assert.throws(() => parseArgs(["--limit=0"]), /正整数/u);
  assert.throws(() => parseArgs(["--nope"]), /不认识的参数/u);
});
