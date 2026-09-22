import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  READING_ARTIFACT_DEFINITIONS,
  readingArtifactDefinition,
  readingArtifactReadiness,
  readingArtifactWaves,
  readingViewState,
} from "../lib/domain/reading-pipeline.ts";

const allSucceeded = () => "succeeded";
const status = (map) => (dependency) => map[dependency] ?? "missing";

test("transcript first, then all four views start together, each reading the transcript", () => {
  // 顺序只有一句话：录音转成逐字稿，四个 agent 同时开工。没有谁等谁。
  assert.deepEqual(READING_ARTIFACT_DEFINITIONS.map((item) => item.kind), ["chapters", "speakers", "key_points", "overview"]);
  for (const definition of READING_ARTIFACT_DEFINITIONS) {
    assert.deepEqual(definition.dependsOn, [], `${definition.kind} 不该等别的视图`);
    assert.equal(definition.readsFullTranscript, true, `${definition.kind} 应该自己读原文`);
  }
  // 发言总结和要点回顾开工时章节已经出来就拿来当目录，没出来不等。
  assert.deepEqual(readingArtifactDefinition("speakers").optionalUpstream, ["chapters"]);
  assert.deepEqual(readingArtifactDefinition("key_points").optionalUpstream, ["chapters"]);
});

test("the readable transcript agent is gone", () => {
  // 它只给原稿加标点，一次五到七万 token，不进任何后续步骤。
  assert.equal(READING_ARTIFACT_DEFINITIONS.some((item) => item.kind === "readable_transcript"), false);
  assert.throws(() => readingArtifactDefinition("readable_transcript"));
});

test("dispatch runs every view in one wave", () => {
  const waves = readingArtifactWaves();
  assert.equal(waves.length, 1);
  assert.deepEqual(new Set(waves[0]), new Set(["chapters", "speakers", "key_points", "overview"]));
});

test("no view ever waits, even while chapters are still running or failed", () => {
  for (const chapters of ["processing", "queued", "failed", "missing"]) {
    for (const kind of ["speakers", "key_points", "overview"]) {
      assert.deepEqual(readingArtifactReadiness(kind, status({ chapters })), { state: "ready", degraded: false });
    }
  }
  assert.deepEqual(readingArtifactReadiness("chapters", allSucceeded), { state: "ready", degraded: false });
});

test("a view shows 内容生成中 until its own run settles, and only a real failure is a failure", () => {
  const generating = { hasContent: false, noReadingWillCome: false };
  assert.equal(readingViewState({ ...generating, runStatus: "queued" }), "generating");
  assert.equal(readingViewState({ ...generating, runStatus: "processing" }), "generating");
  // 任务还没取到页面上：逐字稿刚出来，四个 agent 正在建，这时不能下结论。
  assert.equal(readingViewState({ ...generating, runStatus: undefined }), "generating");
  assert.equal(readingViewState({ ...generating, runStatus: "failed" }), "failed");
  assert.equal(readingViewState({ hasContent: true, runStatus: "failed", noReadingWillCome: false }), "ready");
  // 分析都结束了、一条阅读任务都没有：不会再来了，别转个没完。
  assert.equal(readingViewState({ hasContent: false, runStatus: undefined, noReadingWillCome: true }), "failed");
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

test("the job still honours the readiness rule and passes optional upstream", async () => {
  const job = await readFile(
    new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url),
    "utf8",
  );
  assert.match(job, /readingArtifactReadiness\(kind, \(dependency\) => statuses\[dependency\] \?\? "missing"\)/);
  assert.match(job, /readingUpstreamContent\(String\(run\.event_id\), \[\s*\.\.\.definition\.dependsOn,\s*\.\.\.\(definition\.optionalUpstream \?\? \[\]\),\s*\]\)/);
  assert.match(job, /provider\.summarizeReadingView\(/);
  // 归属判断读概要和章节，由后完成的那个触发。
  assert.match(job, /kind === "overview" \|\| kind === "chapters"[\s\S]{0,400}statuses\.overview === "succeeded" && statuses\.chapters === "succeeded"[\s\S]{0,120}scheduleProjectRoutingSuggestion/);
});

test("every view, the overview included, is written from the transcript", async () => {
  const provider = await readFile(
    new URL("../lib/server/ai/model-provider.ts", import.meta.url),
    "utf8",
  );
  const method = provider.slice(
    provider.indexOf("async summarizeReadingView("),
    provider.indexOf("async refineTranscript("),
  );
  assert.doesNotMatch(method, /if \(kind === "overview"\) \{[\s\S]*?payload\.chapters = upstream\.chapters/);
  assert.match(method, /payload\.transcript_segments = input\.new_event\.transcript_segments/);
  assert.match(method, /\(kind === "speakers" \|\| kind === "key_points"\) && upstream\.chapters\?\.length/);
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
