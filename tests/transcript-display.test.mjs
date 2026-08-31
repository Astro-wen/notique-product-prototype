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
const {
  activeTranscriptGroupKeyAt,
  groupConsecutiveSpeakerSegments,
  groupReadableTranscriptSegments,
  resolveTranscriptAudioAssetId,
} = cjsModule.exports;

function segment(overrides = {}) {
  return {
    key: "segment-1",
    assetVersionId: "asset-version-1",
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

test("不同素材的同名说话人绝不合并或共用播放音源", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ startMs: null, endMs: null }),
    segment({
      key: "segment-2",
      assetVersionId: "asset-version-2",
      startMs: null,
      endMs: null,
      sourceIds: ["seg-2"],
      text: "This came from another recording.",
    }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].assetVersionId, "asset-version-1");
  assert.equal(groups[1].assetVersionId, "asset-version-2");
});

test("缺少素材版本时保持原始分段", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ assetVersionId: null }),
    segment({ key: "segment-2", assetVersionId: null, startMs: 4_000, sourceIds: ["seg-2"] }),
  ]);
  assert.equal(groups.length, 2);
});

test("独立导入逐字稿绝不借用另一份来源的录音", () => {
  const rawTranscriptVersionIds = new Set(["derived-a", "imported-b"]);
  assert.equal(resolveTranscriptAudioAssetId({
    assetVersionId: "derived-a",
    mappedAudioAssetId: "audio-a",
    rawTranscriptVersionIds,
    eventAudioAssetIds: ["audio-a"],
  }), "audio-a");
  assert.equal(resolveTranscriptAudioAssetId({
    assetVersionId: "imported-b",
    mappedAudioAssetId: null,
    rawTranscriptVersionIds,
    eventAudioAssetIds: ["audio-a"],
  }), null);
});

test("旧数据仅在单逐字稿和单录音时允许安全回退", () => {
  assert.equal(resolveTranscriptAudioAssetId({
    assetVersionId: "legacy-transcript",
    mappedAudioAssetId: null,
    rawTranscriptVersionIds: new Set(["legacy-transcript"]),
    eventAudioAssetIds: ["legacy-audio"],
  }), "legacy-audio");
  assert.equal(resolveTranscriptAudioAssetId({
    assetVersionId: "legacy-transcript",
    mappedAudioAssetId: null,
    rawTranscriptVersionIds: new Set(["legacy-transcript"]),
    eventAudioAssetIds: ["audio-a", "audio-b"],
  }), null);
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

test("易读稿保留短暂插话并按英文标记明显打断", () => {
  const groups = groupReadableTranscriptSegments([
    segment({
      speaker: "Speaker 2",
      text: "Yeah, we've probably got about uh ten twelve thousand, I'd",
      startMs: 86_000,
      endMs: 89_000,
    }),
    segment({
      key: "segment-2",
      speaker: "Speaker 1",
      text: "Okay.",
      startMs: 89_000,
      endMs: 89_400,
      sourceIds: ["seg-2"],
    }),
    segment({
      key: "segment-3",
      speaker: "Speaker 2",
      text: "say, uh available right now. And then in the next couple of months if I need to save up a little more we could.",
      startMs: 89_450,
      endMs: 96_000,
      sourceIds: ["seg-3"],
    }),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].text, "Yeah, we've probably got about ten twelve thousand, I'd");
  assert.equal(groups[1].text, "Okay.");
  assert.equal(groups[1].interruptionMarker, "(interrupt)");
  assert.equal(groups[2].text, "say, available right now. And then in the next couple of months if I need to save up a little more we could.");
  assert.deepEqual(groups.flatMap((group) => group.sourceIds), ["seg-1", "seg-2", "seg-3"]);
});

test("中文插话按中文标记，文本和来源保持原样", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ speaker: "Speaker 1", text: "我们先看预算，然后", startMs: 1_000, endMs: 4_000 }),
    segment({ key: "segment-2", speaker: "Speaker 2", text: "我补充一下。", startMs: 3_500, endMs: 4_500, sourceIds: ["seg-2"] }),
    segment({ key: "segment-3", speaker: "Speaker 1", text: "再确认区域。", startMs: 4_600, endMs: 6_000, sourceIds: ["seg-3"] }),
  ]);
  assert.equal(groups[1].interruptionMarker, "（打断）");
  assert.equal(groups[1].text, "我补充一下。");
  assert.deepEqual(groups[1].sourceIds, ["seg-2"]);
});

test("完整轮次后的普通回应不会误标为打断", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ text: "The budget is twelve thousand.", endMs: 4_000 }),
    segment({ key: "segment-2", speaker: "Speaker 2", text: "Okay.", startMs: 4_200, endMs: 4_600, sourceIds: ["seg-2"] }),
    segment({ key: "segment-3", text: "We can continue.", startMs: 4_800, sourceIds: ["seg-3"] }),
  ]);
  assert.deepEqual(groups.map((group) => group.interruptionMarker), [null, null, null]);
});

test("说话人身份未解决时不会猜测打断关系", () => {
  const groups = groupConsecutiveSpeakerSegments([
    segment({ speaker: "Speaker unknown", endMs: 4_000 }),
    segment({ key: "segment-2", speaker: "Speaker 2", startMs: 3_400, sourceIds: ["seg-2"] }),
  ]);
  assert.deepEqual(groups.map((group) => group.interruptionMarker), [null, null]);
});

test("完整句、不同素材或非白名单插话不会被跨说话人合并", () => {
  const completeTurn = groupReadableTranscriptSegments([
    segment({ text: "The budget is twelve thousand.", endMs: 4_000 }),
    segment({ key: "segment-2", speaker: "Speaker 2", text: "Okay.", startMs: 4_100, endMs: 4_400 }),
    segment({ key: "segment-3", text: "We can continue.", startMs: 4_500 }),
  ]);
  assert.equal(completeTurn.length, 3);

  const differentAsset = groupReadableTranscriptSegments([
    segment({ text: "I would", endMs: 4_000 }),
    segment({ key: "segment-2", speaker: "Speaker 2", text: "Okay.", startMs: 4_100, endMs: 4_400 }),
    segment({ key: "segment-3", assetVersionId: "asset-version-2", text: "say yes.", startMs: 4_500 }),
  ]);
  assert.equal(differentAsset.length, 3);
});

test("原稿安全回退不会再被易读版清理或隐藏", () => {
  const groups = groupReadableTranscriptSegments([
    segment({
      key: "raw_fallback_0_seg-1",
      speaker: "Speaker 1",
      text: "Uh, I would",
      endMs: 4_000,
    }),
    segment({
      key: "raw_fallback_1_seg-2",
      speaker: "Speaker 2",
      text: "Okay.",
      startMs: 4_100,
      endMs: 4_400,
      sourceIds: ["seg-2"],
    }),
    segment({
      key: "raw_fallback_2_seg-3",
      speaker: "Speaker 1",
      text: "say yes.",
      startMs: 4_500,
      sourceIds: ["seg-3"],
    }),
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.text), ["Uh, I would", "Okay.", "say yes."]);
  assert.deepEqual(groups.flatMap((group) => group.sourceIds), ["seg-1", "seg-2", "seg-3"]);
  assert.equal(groups.some((group) => group.edits.some((edit) => edit.kind === "filler")), false);
});
