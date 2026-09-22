import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  READING_ARTIFACT_DEFINITIONS,
  readingArtifactDefinition,
  readingArtifactReadiness,
  readingArtifactWaves,
} from "../lib/domain/reading-pipeline.ts";

const allSucceeded = () => "succeeded";
const status = (map) => (dependency) => map[dependency] ?? "missing";

test("chapters are the spine: only they and the readable pass read the whole transcript", () => {
  const readsAll = READING_ARTIFACT_DEFINITIONS
    .filter((item) => item.readsFullTranscript)
    .map((item) => item.kind);
  // 全文概要不读原文，这是整个重排省钱的地方：它只吃上游的几千 token。
  assert.ok(!readsAll.includes("overview"));
  assert.equal(readingArtifactDefinition("overview").readsFullTranscript, false);
  assert.deepEqual(readingArtifactDefinition("overview").dependsOn, ["chapters", "speakers", "key_points"]);
  // 发言总结和要点回顾不等章节：章节是可选目录，有就用，没有就整篇读。
  assert.deepEqual(readingArtifactDefinition("speakers").dependsOn, []);
  assert.deepEqual(readingArtifactDefinition("key_points").dependsOn, []);
  assert.deepEqual(readingArtifactDefinition("speakers").optionalUpstream, ["chapters"]);
  assert.deepEqual(readingArtifactDefinition("key_points").optionalUpstream, ["chapters"]);
  assert.deepEqual(readingArtifactDefinition("readable_transcript").dependsOn, []);
  // 章节读的是原始分段，从没用过易读版；挂在它后面只是白等三万 token 生成完。
  assert.deepEqual(readingArtifactDefinition("chapters").dependsOn, []);
});

test("dispatch order follows the dependency graph and parallelises each wave", () => {
  const waves = readingArtifactWaves();
  // 四个读原文的同一波并行，只有概要等它们。阅读线从四跳变成两跳。
  assert.deepEqual(new Set(waves[0]), new Set(["readable_transcript", "chapters", "speakers", "key_points"]));
  assert.deepEqual(waves.slice(1), [["overview"]]);
});

test("a kind with no dependency is always ready", () => {
  assert.deepEqual(readingArtifactReadiness("readable_transcript", allSucceeded), {
    state: "ready",
    degraded: false,
  });
});

test("a running dependency makes the downstream wait instead of racing it", () => {
  // 章节只是可选目录：它还在跑，发言总结照样立刻开工。
  assert.deepEqual(
    readingArtifactReadiness("speakers", status({ chapters: "processing" })),
    { state: "ready", degraded: false },
  );
  assert.deepEqual(
    readingArtifactReadiness("overview", status({ chapters: "succeeded", speakers: "queued", key_points: "succeeded" })),
    { state: "wait", blockedBy: ["speakers"] },
  );
});

test("a missing optional upstream never marks the run degraded", () => {
  // 章节不是硬依赖，没出来就整篇读，这是正常路径，不算降级。
  assert.deepEqual(
    readingArtifactReadiness("speakers", status({ chapters: "failed" })),
    { state: "ready", degraded: false },
  );
  assert.deepEqual(
    readingArtifactReadiness("key_points", status({ chapters: "missing" })),
    { state: "ready", degraded: false },
  );
});

test("the overview writes a thinner pass while any upstream survived", () => {
  assert.deepEqual(
    readingArtifactReadiness("overview", status({ chapters: "succeeded", speakers: "failed", key_points: "failed" })),
    { state: "ready", degraded: true, missing: ["speakers", "key_points"] },
  );
});

test("the overview is abandoned rather than run blind when every upstream is gone", () => {
  // 它不读原文，上游全废就无从写起。直接标失败，省下这一次调用。
  assert.deepEqual(
    readingArtifactReadiness("overview", status({ chapters: "failed", speakers: "failed", key_points: "missing" })),
    { state: "abandon", missing: ["chapters", "speakers", "key_points"] },
  );
});

test("every declared dependency is itself a declared kind, and the graph has no cycle", () => {
  const kinds = new Set(READING_ARTIFACT_DEFINITIONS.map((item) => item.kind));
  for (const definition of READING_ARTIFACT_DEFINITIONS) {
    for (const dependency of definition.dependsOn) {
      assert.ok(kinds.has(dependency), `${definition.kind} depends on unknown ${dependency}`);
    }
  }
  assert.doesNotThrow(() => readingArtifactWaves());
  assert.equal(readingArtifactWaves().flat().length, READING_ARTIFACT_DEFINITIONS.length);
});

test("the four views are created as separate runs; the old four-in-one is no longer produced", async () => {
  const repository = await readFile(
    new URL("../lib/server/db/event-ai-artifact-repository.ts", import.meta.url),
    "utf8",
  );
  const creation = repository.slice(
    repository.indexOf("export async function ensureEventAiArtifactRuns"),
    repository.indexOf("export async function listEventAiArtifacts"),
  );
  assert.match(creation, /READING_ARTIFACT_DEFINITIONS/);
  // 四合一的 summary 不再排作业；历史产物仍可读，所以种类本身保留。
  assert.doesNotMatch(creation, /kind: "summary"/);
  // 产物身份是内容，不是碰巧创建它的那次抽取。
  assert.match(creation, /const idempotencyKey = inputHash;/);
  assert.doesNotMatch(creation, /\$\{input\.extractionRunId\}:\$\{definition\.kind\}/);
});

test("a downstream view waits for its upstream instead of racing or wasting a call", async () => {
  const job = await readFile(
    new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url),
    "utf8",
  );
  assert.match(job, /readingArtifactReadiness\(kind, \(dependency\) => statuses\[dependency\] \?\? "missing"\)/);
  assert.match(job, /if \(readiness\.state === "wait"\)[\s\S]*?return "pending";/);
  assert.match(job, /if \(readiness\.state === "abandon"\)[\s\S]*?ARTIFACT_UPSTREAM_UNAVAILABLE/);
  // 下游吃上游的产物，而不是回头重读原文。
  // 可选上游一并取：readingUpstreamContent 只返回已成功的，没成功的自然不在。
  assert.match(job, /readingUpstreamContent\(String\(run\.event_id\), \[\s*\.\.\.definition\.dependsOn,\s*\.\.\.\(definition\.optionalUpstream \?\? \[\]\),\s*\]\)/);
  assert.match(job, /provider\.summarizeReadingView\(/);
});

test("the overview is written from upstream artifacts, never from the raw transcript", async () => {
  const provider = await readFile(
    new URL("../lib/server/ai/model-provider.ts", import.meta.url),
    "utf8",
  );
  const method = provider.slice(
    provider.indexOf("async summarizeReadingView("),
    provider.indexOf("async refineTranscript("),
  );
  // 这是拆开之后仍然更省的原因：全文概要只吃几千 token 的上游产物。
  assert.match(method, /if \(kind === "overview"\) \{[\s\S]*?payload\.chapters = upstream\.chapters/);
  assert.match(method, /payload\.transcript_segments = input\.new_event\.transcript_segments/);
  assert.match(method, /if \(kind !== "chapters" && upstream\.chapters\?\.length\) payload\.chapters = upstream\.chapters/);
  // 单视图结果包回完整信封，复用同一个校验器，不另起一套引用检查。
  assert.match(method, /validateEventSummaryProviderOutput\(ordered, summaryInput\)/);
});

test("the reader merges per-kind artifacts and still reads the legacy four-in-one", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /const chaptersPair = readingPairFor\("chapters"\)/);
  assert.match(page, /const overviewPair = readingPairFor\("overview"\)/);
  // 旧 summary 四个字段都填着，正好当兜底来源。
  assert.match(page, /return own\.length \? own : recordArray\(legacySummaryContent\?\.\[field\]\)/);
  assert.match(page, /const generatedChapters = viewField\(chaptersPair, "chapters"\)/);
  assert.match(page, /const keyPoints = viewField\(keyPointsPair, "key_points"\)/);
});
