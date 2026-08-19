import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/transcript-display.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const cjsModule = { exports: {} };
new Function("module", "exports", compiled)(cjsModule, cjsModule.exports);
const { activeTranscriptGroupKeyAt, groupConsecutiveSpeakerSegments } = cjsModule.exports;

function segment(overrides = {}) {
  return {
    key: "segment-1",
    speaker: "Speaker 1",
    text: "All right. Hey, Curtis, thanks for coming on in today.",
    startMs: 2_000,
    endMs: 3_800,
    sourceIds: ["seg-1"],
    edits: [],
    needsCheck: false,
    ...overrides,
  };
}

test("连续同一说话人的短句合成一个自然段", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment(),
    segment({
      key: "segment-2",
      text: "How are you doing today?",
      startMs: 4_000,
      endMs: 5_000,
      sourceIds: ["seg-2"],
    }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].text, "All right. Hey, Curtis, thanks for coming on in today. How are you doing today?");
  assert.deepEqual(groups[0].sourceIds, ["seg-1", "seg-2"]);
  assert.equal(groups[0].segmentCount, 2);
});

test("说话人变化或明显停顿时保持分段", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment(),
    segment({ key: "segment-2", speaker: "Speaker 2", startMs: 4_000 }),
    segment({ key: "segment-3", startMs: 10_000, endMs: 11_000 }),
  ]);
  assert.equal(groups.length, 3);
});

test("待确认说话人不会被自动合并", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ speaker: "Speaker unknown" }),
    segment({ key: "segment-2", speaker: "Speaker unknown", startMs: 4_000 }),
  ]);
  assert.equal(groups.length, 2);
});

test("合并时保留全部修改、关注状态和原始锚点", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ edits: [{ kind: "punctuation" }] }),
    segment({
      key: "segment-2",
      text: "Second line.",
      startMs: 4_000,
      sourceIds: ["seg-2"],
      edits: [{ kind: "capitalization" }],
      needsCheck: true,
    }),
  ]);
  assert.equal(groups[0].edits.length, 2);
  assert.equal(groups[0].needsCheck, true);
  assert.deepEqual(groups[0].sourceIds, ["seg-1", "seg-2"]);
});

test("中文连续文本不会插入多余空格", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ text: "今天先看预算，" }),
    segment({ key: "segment-2", text: "然后再看区域。", startMs: 4_000 }),
  ]);
  assert.equal(groups[0].text, "今天先看预算，然后再看区域。");
});

test("播放位置只激活已经到达的最新段落", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment(),
    segment({ key: "segment-2", speaker: "Speaker 2", text: "Fine.", startMs: 5_000, endMs: 6_000 }),
    segment({ key: "segment-3", speaker: "Speaker 1", text: "Great.", startMs: 8_000, endMs: 9_000 }),
  ]);
  assert.equal(activeTranscriptGroupKeyAt(groups, 2_000), "segment-1");
  assert.equal(activeTranscriptGroupKeyAt(groups, 5_050), "segment-2");
  assert.equal(activeTranscriptGroupKeyAt(groups, 7_500), "segment-2");
  assert.equal(activeTranscriptGroupKeyAt(groups, 8_000), "segment-3");
});
