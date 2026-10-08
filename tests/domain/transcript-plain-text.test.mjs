import assert from 'node:assert/strict';
import test from 'node:test';
import {parseTranscript, parsePlainTranscriptCue, transcriptUploadFormat} from '../../lib/domain/transcript.ts';

const parse = content => parseTranscript({assetVersionId: 'synthetic-txt-v1', eventId: 'synthetic-event', filename: 'meeting.txt', content});
const fields = rows => rows.map(({speaker, startMs, endMs, textRaw}) => ({speaker, startMs, endMs, textRaw}));

test('generic TXT upload preserves WEBVTT correction speakers and timestamps', () => {
  const filename = 'meeting.txt';
  const content = '\uFEFFWEBVTT\r\n\r\n00:49:36.000 --> 00:49:47.000\r\nJohn: Did we get a dozen orders?\r\n\r\n00:49:48.000 --> 00:49:53.000\r\nLori: Not that many.\r\n';
  const rows = parseTranscript({assetVersionId:'uploaded-vtt',eventId:'event',filename,content,format:transcriptUploadFormat(filename,'text/plain')});
  assert.deepEqual(fields(rows), [
    {speaker:'John',startMs:2976000,endMs:2987000,textRaw:'Did we get a dozen orders?'},
    {speaker:'Lori',startMs:2988000,endMs:2993000,textRaw:'Not that many.'},
  ]);
});

test('generic text upload detects SRT without consuming timestamps as speech', () => {
  const filename = 'export.txt';
  const content = '1\n00:00:01,000 --> 00:00:02,000\nSpeaker A: Initial estimate.\n\n2\n00:00:03,000 --> 00:00:04,000\nSpeaker B: Revised estimate.\n';
  const rows = parseTranscript({assetVersionId:'uploaded-srt',eventId:'event',filename,content,format:transcriptUploadFormat(filename,'text/plain')});
  assert.deepEqual(fields(rows), [
    {speaker:'Speaker A',startMs:1000,endMs:2000,textRaw:'Initial estimate.'},
    {speaker:'Speaker B',startMs:3000,endMs:4000,textRaw:'Revised estimate.'},
  ]);
});

test('generic text upload keeps untimed speaker blocks untimed', () => {
  const filename = 'meeting.txt';
  const content = 'Speaker A:\nFirst statement.\n\nSpeaker B:\nSecond statement.';
  const rows = parseTranscript({assetVersionId:'uploaded-text',eventId:'event',filename,content,format:transcriptUploadFormat(filename,'text/plain')});
  assert.deepEqual(fields(rows), [
    {speaker:'Speaker A',startMs:null,endMs:null,textRaw:'First statement.'},
    {speaker:'Speaker B',startMs:null,endMs:null,textRaw:'Second statement.'},
  ]);
});

for (const [name, header] of [
  ['bracketed time and speaker header', '[00:00] Speaker A:'],
  ['screenshot time and speaker header', '0:00 Speaker A:'],
  ['speaker then time', 'Speaker A:\n00:00'],
  ['time then speaker', '00:00\nSpeaker A:'],
]) test(`TXT binds ${name} to the next body`, () => {
  const rows = parse(`${header}\n新人培训预算为八千元。\n\n[00:30] Speaker B:\n会议室设备尚未确认。`);
  assert.deepEqual(fields(rows), [
    {speaker: 'Speaker A', startMs: 0, endMs: null, textRaw: '新人培训预算为八千元。'},
    {speaker: 'Speaker B', startMs: 30000, endMs: null, textRaw: '会议室设备尚未确认。'},
  ]);
  assert.deepEqual(rows.map(row => row.id), ['seg_synthetic-txt-v1_00000', 'seg_synthetic-txt-v1_00001']);
  assert.ok(rows.every(row => row.parserVersion === 'transcript-parser.v1'));
});

test('TXT keeps multiline bodies together and changes speaker/time only at explicit cues', () => {
  const rows = parse('Speaker A:\n00:00\n预算: 八千元。\n教材是否包含尚未明确。\nSpeaker B:\n00:10\n先检查投影。\n再决定会议室。');
  assert.deepEqual(fields(rows), [
    {speaker: 'Speaker A', startMs: 0, endMs: null, textRaw: '预算: 八千元。\n教材是否包含尚未明确。'},
    {speaker: 'Speaker B', startMs: 10000, endMs: null, textRaw: '先检查投影。\n再决定会议室。'},
  ]);
});

test('TXT never copies a previous turn time into an untimed speaker or unmarked paragraph', () => {
  assert.deepEqual(fields(parse('[00:00] Speaker A:\n已问讲师。\nSpeaker B:\n仍需审批。\n\n没有标签的普通正文。')), [
    {speaker: 'Speaker A', startMs: 0, endMs: null, textRaw: '已问讲师。'},
    {speaker: 'Speaker B', startMs: null, endMs: null, textRaw: '仍需审批。'},
    {speaker: null, startMs: null, endMs: null, textRaw: '没有标签的普通正文。'},
  ]);
});

test('TXT preserves ordinary colon prose, field headers and URLs instead of consuming them as speakers', () => {
  const lines = ['预算: 八千元。', '项目安排： 下午开会。', 'Note: not spoken metadata', 'Warning:', 'https://example.test/path', '这是普通说明: 还要审批。'];
  const rows = parse(lines.join('\n'));
  assert.deepEqual(rows.map(row => row.textRaw), lines);
  assert.ok(rows.every(row => row.speaker === null && row.startMs === null));
  for (const line of lines) assert.equal(parsePlainTranscriptCue(line), null);
});

test('TXT time markers do not remove ordinary colon body prefixes or invent a speaker', () => {
  assert.deepEqual(fields(parse('[00:02] 预算: 八千元。\n00:03 Note: still provisional')), [
    {speaker: null, startMs: 2000, endMs: null, textRaw: '预算: 八千元。'},
    {speaker: null, startMs: 3000, endMs: null, textRaw: 'Note: still provisional'},
  ]);
});

test('TXT preserves existing inline cues, stable IDs and plain per-line segmentation', () => {
  const content = '00:01 Buyer: We can go up to $1.5 million.\n00:04 Agent: Understood.\n普通正文第一行。\n普通正文第二行。';
  const first = parse(content);
  assert.deepEqual(first, parse(content));
  assert.deepEqual(fields(first).slice(0, 2), [
    {speaker: 'Buyer', startMs: 1000, endMs: null, textRaw: 'We can go up to $1.5 million.'},
    {speaker: 'Agent', startMs: 4000, endMs: null, textRaw: 'Understood.'},
  ]);
  assert.equal(first.length, 4);
  assert.deepEqual(first.map(row => row.id), Array.from({length: 4}, (_, ordinal) => `seg_synthetic-txt-v1_${String(ordinal).padStart(5, '0')}`));
});

test('TXT handles mixed inline/body headers, CRLF, BOM and full-width speaker colons', () => {
  const rows = parse('\uFEFFSpeaker A：\r\n00:00\r\n第一段正文。\r\n00:02 Speaker B: 第二段正文。\r\n00:03\r\nSpeaker A:\r\n第三段正文。');
  assert.deepEqual(fields(rows), [
    {speaker: 'Speaker A', startMs: 0, endMs: null, textRaw: '第一段正文。'},
    {speaker: 'Speaker B', startMs: 2000, endMs: null, textRaw: '第二段正文。'},
    {speaker: 'Speaker A', startMs: 3000, endMs: null, textRaw: '第三段正文。'},
  ]);
});

test('TXT invalid timestamps remain source text, while metadata without a body is not a fake segment', () => {
  assert.deepEqual(fields(parse('[00:99] Speaker A:\n普通正文。')), [
    {speaker: null, startMs: null, endMs: null, textRaw: '[00:99] Speaker A:'},
    {speaker: null, startMs: null, endMs: null, textRaw: '普通正文。'},
  ]);
  assert.throws(() => parse('00:00\nSpeaker A:'), /no readable segments/);
});
