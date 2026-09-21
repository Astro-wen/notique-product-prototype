import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_SUPPORT_THRESHOLDS,
  decisionsFrom,
  judgeMayWrite,
  supportDecision,
} from "../lib/domain/support-judge.ts";
import {
  DEFAULT_JUDGE_GATES,
  calibrationReport,
  judgeGates,
} from "../lib/domain/judge-calibration.ts";

const question = (id) => ({
  claimId: "claim-1",
  claimVersionId: "cv-1",
  evidenceRefId: id,
  statement: "预算上限是 120 万美元。",
  quote: "我们最多能到一百二。",
  evidenceRole: "direct",
});

test("a judge saying the citation supports the claim changes nothing at all", () => {
  // 这是整个设计的支点：判断只能往「更不可信」的方向推。让系统替人确认，
  // 正是这个产品不能做的事。
  const decision = supportDecision({ evidenceRefId: "evr-1", supportProbability: 0.97 });
  assert.equal(decision.verdict, "fully_supports");
  assert.equal(decision.action, "silent");
});

test("only a confident no reaches the reader, and it blocks quick confirmation", () => {
  const decision = supportDecision({ evidenceRefId: "evr-1", supportProbability: 0.05 });
  assert.equal(decision.verdict, "does_not_support");
  assert.equal(decision.action, "flag");
});

test("an uncertain judge stays quiet instead of adding noise", () => {
  for (const probability of [0.35, 0.5, 0.65]) {
    const decision = supportDecision({ evidenceRefId: "evr-1", supportProbability: probability });
    assert.equal(decision.verdict, "partially_supports");
    // 降一档显示，但不挡操作：拿不准的判断不该打断人。
    assert.equal(decision.action, "downgrade");
  }
});

test("a broken probability degrades to the quiet middle rather than to a verdict", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const decision = supportDecision({ evidenceRefId: "evr-1", supportProbability: bad });
    assert.equal(decision.action, "downgrade");
    assert.equal(decision.supportProbability, 0.5);
  }
  // 越界的概率被夹住，不会让 0 分的答案变成「强烈支持」。
  assert.equal(supportDecision({ evidenceRefId: "e", supportProbability: 4 }).supportProbability, 1);
  assert.equal(supportDecision({ evidenceRefId: "e", supportProbability: -4 }).supportProbability, 0);
});

test("the judge never overwrites a verdict a human already gave", () => {
  assert.equal(judgeMayWrite("unreviewed", "does_not_support"), true);
  assert.equal(judgeMayWrite("unreviewed", "partially_supports"), true);
  // 说「完全支持」不写库：那会让一条没人看过的记录显得被核实过。
  assert.equal(judgeMayWrite("unreviewed", "fully_supports"), false);
  for (const human of ["fully_supports", "partially_supports", "does_not_support"]) {
    assert.equal(judgeMayWrite(human, "does_not_support"), false);
  }
});

test("an unavailable judge leaves the product exactly as it is today", () => {
  const questions = [question("evr-1"), question("evr-2")];
  assert.deepEqual(decisionsFrom(questions, null), []);
  assert.deepEqual(decisionsFrom(questions, []), []);
  // 回答了没问过的条目一律丢弃，判断方不能凭空给别处下结论。
  const stray = decisionsFrom(questions, [{ evidenceRefId: "evr-other", supportProbability: 0.01 }]);
  assert.deepEqual(stray, []);
});

test("calibration separates a well-calibrated judge from a merely accurate one", () => {
  // 说 0.9 的十条里九条真支持，说 0.1 的十条里一条真支持：说什么就是什么。
  const honest = [
    ...Array.from({ length: 10 }, (_, i) => ({ predicted: 0.9, actual: i < 9 })),
    ...Array.from({ length: 10 }, (_, i) => ({ predicted: 0.1, actual: i < 1 })),
  ];
  const honestReport = calibrationReport(honest);
  assert.equal(honestReport.sampleCount, 20);
  assert.equal(honestReport.accuracy, 0.9);
  assert.ok(honestReport.expectedCalibrationError < 0.01);

  // 同样 90% 的准确率，但每次都喊满分。按 0.5 切看不出差别，校准能看出来。
  const overconfident = [
    ...Array.from({ length: 10 }, (_, i) => ({ predicted: 1, actual: i < 9 })),
    ...Array.from({ length: 10 }, (_, i) => ({ predicted: 0, actual: i < 1 })),
  ];
  const overconfidentReport = calibrationReport(overconfident);
  assert.equal(overconfidentReport.accuracy, 0.9);
  assert.ok(overconfidentReport.expectedCalibrationError > 0.09);
});

test("an empty bucket never dilutes the error, and the worst bucket is reported on its own", () => {
  const samples = [
    ...Array.from({ length: 50 }, () => ({ predicted: 0.95, actual: true })),
    // 一桶整体塌陷：说 0.55，实际全不支持。
    ...Array.from({ length: 10 }, () => ({ predicted: 0.55, actual: false })),
  ];
  const report = calibrationReport(samples);
  // 只有两桶有样本，其余八个空桶不进报告也不参与平均。
  assert.equal(report.buckets.length, 2);
  assert.ok(report.maxBucketGap > 0.5);
  // 加权平均被大桶拉低，所以最差桶必须单独看。
  assert.ok(report.expectedCalibrationError < report.maxBucketGap);
});

test("too few samples fail every gate instead of passing on a lucky streak", () => {
  const lucky = Array.from({ length: 12 }, () => ({ predicted: 0.9, actual: true }));
  const { passed, gates } = judgeGates(calibrationReport(lucky));
  assert.equal(passed, false);
  // 样本不够时其余项一并判负，不允许「十二条全对」放行。
  assert.deepEqual(gates.map((gate) => gate.passed), [false, false, false, false]);
});

test("the gates are non-compensating: accuracy cannot buy off bad calibration", () => {
  // 每次都喊 0.99，实际只有 85.5% 对：准确率刚够门槛，校准差 0.135。
  const samples = Array.from({ length: 400 }, (_, index) => ({
    predicted: 0.99,
    actual: index % 7 !== 0,
  }));
  const report = calibrationReport(samples);
  assert.ok(report.accuracy >= DEFAULT_JUDGE_GATES.minAccuracy, "准确率够高");
  const { passed, gates } = judgeGates(report);
  assert.equal(passed, false);
  assert.equal(gates.find((gate) => gate.name === "accuracy").passed, true);
  assert.equal(gates.find((gate) => gate.name === "calibration_error").passed, false);
});

test("the thresholds that drive the UI are stated, not scattered through the code", () => {
  assert.deepEqual(DEFAULT_SUPPORT_THRESHOLDS, { notSupportedBelow: 0.2, fullySupportedAbove: 0.8 });
  assert.equal(DEFAULT_JUDGE_GATES.minSamples, 200);
});

test("the hole this fills is real: nothing in the pipeline ever writes does_not_support", async () => {
  const [processor, verdicts] = await Promise.all([
    readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/db/verdict-repository.ts", import.meta.url), "utf8"),
  ]);
  // 抽取一律写 unreviewed。
  assert.match(processor, /'valid', 'unreviewed'/);
  // 人工确认按 evidence_role 机械映射，不是语义判断。
  assert.match(verdicts, /SET semantic_support_verdict = CASE evidence_role/);
  assert.match(verdicts, /WHEN 'direct' THEN 'fully_supports'/);
  // 这两条路径都写不出 does_not_support，所以这个枚举值此前不可达。
  assert.doesNotMatch(processor, /'does_not_support'/);
  assert.doesNotMatch(verdicts, /THEN 'does_not_support'/);
});

test("no key means no judge, which is not an error path", async () => {
  const { createJevSupportJudge } = await import("../lib/server/ai/jev-support-judge.ts");
  // 没配密钥时返回 null，调用方据此什么都不做。系统表现与今天一致。
  assert.equal(createJevSupportJudge({}), null);
  assert.equal(createJevSupportJudge({ apiKey: "   " }), null);
  assert.equal(createJevSupportJudge({ apiKey: undefined }), null);
});

test("a judge that cannot be reached returns nothing rather than throwing", async () => {
  const { createJevSupportJudge } = await import("../lib/server/ai/jev-support-judge.ts");
  const judge = createJevSupportJudge({
    apiKey: "test-key",
    // 指向一个连不上的地址，模拟服务不可用。
    endpoint: "http://127.0.0.1:1/systemone",
    timeoutMs: 300,
  });
  assert.ok(judge);
  const answers = await judge.judge([question("evr-1"), question("evr-2")]);
  // 整批失败只是没有判断，不是异常。这一层永远不进主链路的成功条件。
  assert.deepEqual(answers, []);
  assert.deepEqual(await judge.judge([]), []);
});

test("the judge is asked only about the pair in hand, never about the transcript", async () => {
  const source = await readFile(
    new URL("../lib/server/ai/jev-support-judge.ts", import.meta.url),
    "utf8",
  );
  // state 只含陈述和那一句原话。判断方看不到的东西就不会拿来发挥。
  assert.match(source, /state: \{\s*\n\s*statement: question\.statement,\s*\n\s*quoted_source_line: question\.quote,/);
  assert.doesNotMatch(source, /transcript_segments|new_event/);
  assert.match(source, /"noul"/);
  assert.match(source, /do not use outside knowledge/);
  // 单条失败只丢这一条。
  assert.match(source, /catch \{[\s\S]*?return null;/);
});
