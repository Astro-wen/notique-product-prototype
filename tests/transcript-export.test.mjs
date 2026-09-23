import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTranscriptSrt,
  buildTranscriptText,
  clockTimestamp,
  exportFilename,
  srtTimestamp,
} from "../lib/domain/transcript-export.ts";

test("clocks render like a player and like an SRT cue", () => {
  assert.equal(clockTimestamp(0), "0:00:00");
  assert.equal(clockTimestamp(65_500), "0:01:05");
  assert.equal(clockTimestamp(3_725_000), "1:02:05");
  assert.equal(srtTimestamp(0), "00:00:00,000");
  assert.equal(srtTimestamp(65_500), "00:01:05,500");
  assert.equal(srtTimestamp(3_725_042), "01:02:05,042");
  assert.equal(srtTimestamp(-5), "00:00:00,000", "a negative clock clamps instead of exporting garbage");
});

test("the text export keeps every turn and drops only what it cannot know", () => {
  const text = buildTranscriptText("第一次沟通 · 易读版", [
    { speaker: "Speaker 1", startMs: 0, text: "How are you?" },
    { speaker: "Speaker 2", startMs: null, text: "I'm doing great." },
    { speaker: "Speaker 1", startMs: 80_000, text: "  padded  " },
    { speaker: "Speaker 2", startMs: 90_000, text: "   " },
  ]);
  assert.match(text, /^第一次沟通 · 易读版\n\n/);
  assert.match(text, /\[0:00:00\] Speaker 1\nHow are you\?/);
  // No timestamp → no clock, never an invented one.
  assert.match(text, /\n\nSpeaker 2\nI'm doing great\./);
  assert.match(text, /\[0:01:20\] Speaker 1\npadded/);
  assert.doesNotMatch(text, /0:01:30/, "an empty turn exports nothing");
});

test("SRT cues borrow the next start when a segment has no end", () => {
  const srt = buildTranscriptSrt([
    { speaker: "Speaker 1", startMs: 0, endMs: 4_000, text: "First." },
    { speaker: "Speaker 2", startMs: 5_000, endMs: null, text: "Second." },
    { speaker: "Speaker 1", startMs: 9_000, endMs: 2_000, text: "Bad end." },
    { speaker: "Speaker 2", startMs: null, endMs: null, text: "Untimed." },
  ]);
  const cues = srt.trim().split("\n\n");
  assert.equal(cues.length, 3, "an untimed segment cannot be placed on a subtitle clock");
  assert.match(cues[0], /^1\n00:00:00,000 --> 00:00:04,000\nSpeaker 1: First\.$/);
  assert.match(cues[1], /^2\n00:00:05,000 --> 00:00:09,000\nSpeaker 2: Second\.$/, "missing end borrows the next start");
  assert.match(cues[2], /^3\n00:00:09,000 --> 00:00:12,000\nSpeaker 1: Bad end\.$/, "an end before its start falls back to a fixed duration");
});

test("filenames stay readable and file-system safe", () => {
  assert.equal(exportFilename("第一次沟通", "易读版", "txt"), "第一次沟通 · 易读版.txt");
  assert.equal(exportFilename('a/b\\c:d*e?f"g<h>i|j', "原文", "txt"), "a b c d e f g h i j · 原文.txt");
  assert.equal(exportFilename("", "字幕", "srt"), "逐字稿 · 字幕.srt");
  assert.equal(exportFilename("x".repeat(120), "原文", "txt").length, 80 + " · 原文.txt".length);
});
