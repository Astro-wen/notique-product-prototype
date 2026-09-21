import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fallbackChapters, shouldUseFallbackChapters } from "../lib/domain/chapter-fallback.ts";

function seg(id, startMs, speaker, text, extra = {}) {
  return { id, text, speaker, start_ms: startMs, end_ms: startMs + 4_000, asset_version_id: "av-1", ...extra };
}

test("a long recording is cut at speaker turns once the target length is reached", () => {
  const segments = [];
  // 两位说话人交替，每 30 秒一段，共 20 分钟。
  for (let index = 0; index < 40; index += 1) {
    segments.push(seg(`s${index}`, index * 30_000, index % 2 ? "Buyer" : "Agent", `第 ${index} 段。后面还有话。`));
  }
  const chapters = fallbackChapters(segments, { targetMs: 5 * 60_000 });
  assert.equal(chapters.length, 4);
  assert.equal(chapters[0].title, "00:00–04:34");
  assert.equal(chapters[0].summary, "第 0 段。");
  assert.deepEqual(chapters[0].source_segment_ids.slice(0, 2), ["s0", "s1"]);
  assert.ok(chapters.every((chapter) => chapter.fallback === true));
  // 每段的时间区间前后衔接，没有重叠也没有漏段。
  const all = chapters.flatMap((chapter) => chapter.source_segment_ids);
  assert.deepEqual(all, segments.map((segment) => segment.id));
});

test("a hard pause always starts a new chapter, even inside a short one", () => {
  const segments = [
    seg("a", 0, "Agent", "开场。"),
    seg("b", 10_000, "Agent", "继续。"),
    seg("c", 10_000 + 4_000 + 120_000, "Agent", "停了两分钟以后。"),
  ];
  const chapters = fallbackChapters(segments);
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters[1].source_segment_ids, ["c"]);
  assert.equal(chapters[1].summary, "停了两分钟以后。");
});

test("segments without timestamps ride along and never form their own chapter", () => {
  const segments = [
    seg("a", 0, "Agent", "有时间点。"),
    { id: "note", text: "手写补充", speaker: null, start_ms: null, asset_version_id: "av-1" },
    seg("b", 20_000, "Buyer", "还是第一段。"),
  ];
  const chapters = fallbackChapters(segments);
  assert.equal(chapters.length, 1);
  assert.deepEqual(chapters[0].source_segment_ids, ["a", "note", "b"]);
  // 只有一位说话人时标题带上名字，两位以上只留时间。
  assert.equal(chapters[0].title, "00:00–00:24");
});

test("chapters never cross material versions and untimed transcripts get none", () => {
  const segments = [
    seg("a1", 0, "Agent", "录音一。"),
    seg("b1", 0, "Agent", "录音二。", { asset_version_id: "av-2" }),
    { id: "t1", text: "纯文本导入", speaker: null, start_ms: null, asset_version_id: "av-3" },
  ];
  const chapters = fallbackChapters(segments);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "00:00–00:04 · Agent");
  assert.deepEqual(chapters.map((chapter) => chapter.source_segment_ids), [["a1"], ["b1"]]);
});

test("the chapter count is capped by merging the shortest neighbours", () => {
  const segments = [];
  for (let index = 0; index < 30; index += 1) {
    // 每段之间停 100 秒，硬断开 30 次。
    segments.push(seg(`s${index}`, index * 110_000, "Agent", `段 ${index}。`));
  }
  const chapters = fallbackChapters(segments, { maxChapters: 6 });
  assert.equal(chapters.length, 6);
  const all = chapters.flatMap((chapter) => chapter.source_segment_ids);
  assert.deepEqual(all, segments.map((segment) => segment.id));
});

test("the fallback only steps in when the model chapters are not coming", () => {
  const base = { generatedCount: 0, analysisRunning: false, timedSegmentCount: 12 };
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: "failed" }), true);
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: null }), true);
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: "processing" }), false);
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: "queued" }), false);
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: null, analysisRunning: true }), false);
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: "failed", generatedCount: 3 }), false);
  assert.equal(shouldUseFallbackChapters({ ...base, summaryRunStatus: "failed", timedSegmentCount: 0 }), false);
});

test("the reading workspace shows fallback chapters only when the model ones are not coming, and says so", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  // 拆开之后章节看自己那条流水线的状态，不再跟着四合一的 summary Run 走。
  assert.match(page, /shouldUseFallbackChapters\(\{[\s\S]*?summaryRunStatus: viewRunStatus\(chaptersPair\),[\s\S]*?analysisRunning,/);
  assert.match(page, /useFallbackChapters \? fallbackChapters\(availableRawSegments\) : generatedChapters/);
  assert.match(page, /const chapterAnchors = displayChapters\.flatMap/);
  // 兜底章节必须标出来，不能冒充 AI 章节。
  assert.match(page, /useFallbackChapters && <p className="rail-muted chapter-fallback-note">/);
});
