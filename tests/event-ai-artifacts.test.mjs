import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { uiSource } from "./helpers/ui-source.mjs";
import {
  chunkReadableTranscriptSource,
  eventAiArtifactContractMismatch,
  mergeReadableTranscriptChunks,
  readableTranscriptSegmentsForVerification,
  validateEventSummaryOutput,
  validateEventSummaryProviderOutput,
  validateReadableTranscriptOutput,
} from "../lib/domain/event-ai-artifacts.ts";

const raw = [
  {
    id: "seg_1", assetVersionId: "av_1", eventId: "evt_1", ordinal: 0,
    speaker: "Alex", startMs: 1_000, endMs: 4_000,
    textRaw: "we cannot spend more than $12,500", textNormalized: "we cannot spend more than $12,500",
    parserVersion: "test.v1",
  },
  {
    id: "seg_2", assetVersionId: "av_1", eventId: "evt_1", ordinal: 1,
    speaker: "Alex", startMs: 4_100, endMs: 8_000,
    textRaw: "and it needs approval on September 8", textNormalized: "and it needs approval on September 8",
    parserVersion: "test.v1",
  },
];

function readable(overrides = {}) {
  return {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [
      {
        readable_key: "read_1",
        source_segment_ids: ["seg_1", "seg_2"],
        speaker: "Alex",
        start_ms: 1_000,
        end_ms: 8_000,
        readable_text: "We cannot spend more than $12,500, and it needs approval on September 8.",
        edits: [{ kind: "punctuation", original: "$12,500 and", replacement: "$12,500, and", reason: "Sentence punctuation.", confidence: 0.99 }],
        needs_human_check: false,
        ...overrides,
      },
    ],
  };
}

function validateSingleReadable({
  rawText,
  readableText,
  edits,
  needsHumanCheck = false,
  speaker = "Alex",
  assetVersionId = "av_1",
}) {
  const source = [{
    ...raw[0],
    assetVersionId,
    speaker,
    textRaw: rawText,
    textNormalized: rawText,
  }];
  return validateReadableTranscriptOutput({
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_safety_case",
      source_segment_ids: ["seg_1"],
      speaker,
      start_ms: 1_000,
      end_ms: 4_000,
      readable_text: readableText,
      edits: edits.map((edit) => ({
        reason: "Safety regression case.",
        confidence: 1,
        ...edit,
      })),
      needs_human_check: needsHumanCheck,
    }],
  }, { eventId: "evt_1", segments: source });
}

function assertReadableWithheld(result, label) {
  assert.equal(result.valid, true, `${label}: ${JSON.stringify(result.issues)}`);
  assert.equal(result.output.segments[0].needs_human_check, true, label);
  assert.deepEqual(readableTranscriptSegmentsForVerification(result.output), [], label);
}

test("readable transcript covers every raw segment once and keeps lineage", () => {
  const result = validateReadableTranscriptOutput(readable(), { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, true);
  assert.deepEqual(result.output.segments[0].source_segment_ids, ["seg_1", "seg_2"]);
  assert.equal(result.output.segments[0].start_ms, 1_000);
  assert.equal(result.output.segments[0].end_ms, 8_000);
});

test("readable transcript fails closed when money or negation changes", () => {
  const result = validateReadableTranscriptOutput(readable({
    readable_text: "We can spend more than $15,000, and it needs approval on September 8.",
  }), { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".readable_text")));
});

test("readable transcript preserves protected-token order and local meaning", () => {
  const orderedRaw = [{
    ...raw[0],
    textRaw: "The cap is $500 not $600",
    textNormalized: "The cap is $500 not $600",
  }];
  const swappedValues = validateReadableTranscriptOutput({
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_order_swap",
      source_segment_ids: ["seg_1"],
      speaker: "Alex",
      start_ms: 1_000,
      end_ms: 4_000,
      readable_text: "The cap is $600, not $500.",
      edits: [{
        kind: "context_correction",
        original: "$500 not $600",
        replacement: "$600, not $500",
        reason: "Unsafe value swap.",
        confidence: 1,
      }],
      needs_human_check: true,
    }],
  }, { eventId: "evt_1", segments: orderedRaw });
  assert.equal(swappedValues.valid, false);

  const changedNamedDate = validateReadableTranscriptOutput(readable({
    readable_text: "We cannot spend more than $12,500, and it needs approval on Tuesday 8.",
    edits: [{
      kind: "context_correction",
      original: "September",
      replacement: "Tuesday",
      reason: "Unsafe date change.",
      confidence: 1,
    }],
    needs_human_check: true,
  }), { eventId: "evt_1", segments: raw });
  assert.equal(changedNamedDate.valid, false);

  const semanticRaw = [{
    ...raw[0],
    textRaw: "The inspection budget is $500 and the repair deposit is $600",
    textNormalized: "The inspection budget is $500 and the repair deposit is $600",
  }];
  const semanticSwap = {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_swap",
      source_segment_ids: ["seg_1"],
      speaker: "Alex",
      start_ms: 1_000,
      end_ms: 4_000,
      readable_text: "The repair deposit is $500, and the inspection budget is $600.",
      edits: [{
        kind: "context_correction",
        original: "The inspection budget is $500 and the repair deposit is $600",
        replacement: "The repair deposit is $500, and the inspection budget is $600.",
        reason: "Unsafe semantic swap.",
        confidence: 1,
      }],
      needs_human_check: true,
    }],
  };
  const semanticResult = validateReadableTranscriptOutput(semanticSwap, {
    eventId: "evt_1",
    segments: semanticRaw,
  });
  assert.equal(semanticResult.valid, true, JSON.stringify(semanticResult.issues));
  assert.equal(semanticResult.output.segments[0].needs_human_check, true);
  assert.deepEqual(readableTranscriptSegmentsForVerification(semanticResult.output), []);
});

test("readable transcript treats ASCII and Unicode apostrophes as the same negation", () => {
  const apostropheRaw = [{
    ...raw[0],
    textRaw: "we can't exceed $500",
    textNormalized: "we can't exceed $500",
  }];
  const typographyOnly = {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_apostrophe",
      source_segment_ids: ["seg_1"],
      speaker: "Alex",
      start_ms: 1_000,
      end_ms: 4_000,
      readable_text: "We can’t exceed $500.",
      edits: [{
        kind: "punctuation",
        original: "can't",
        replacement: "can’t",
        reason: "Typographic punctuation.",
        confidence: 1,
      }],
      needs_human_check: false,
    }],
  };
  assert.equal(validateReadableTranscriptOutput(typographyOnly, {
    eventId: "evt_1",
    segments: apostropheRaw,
  }).valid, true);

  typographyOnly.segments[0].readable_text = "We can exceed $500.";
  typographyOnly.segments[0].edits[0].replacement = "can";
  assert.equal(validateReadableTranscriptOutput(typographyOnly, {
    eventId: "evt_1",
    segments: apostropheRaw,
  }).valid, false);
});

test("readable transcript protects English number-word money and duration phrases", () => {
  const validatePhrase = (rawText, readableText, original, replacement) => {
    const source = [{ ...raw[0], textRaw: rawText, textNormalized: rawText }];
    return validateReadableTranscriptOutput({
      schema_version: "readable-transcript.v1",
      event_id: "evt_1",
      segments: [{
        readable_key: "read_words",
        source_segment_ids: ["seg_1"],
        speaker: "Alex",
        start_ms: 1_000,
        end_ms: 4_000,
        readable_text: readableText,
        edits: [{
          kind: "context_correction",
          original,
          replacement,
          reason: "Number-word regression case.",
          confidence: 1,
        }],
        needs_human_check: true,
      }],
    }, { eventId: "evt_1", segments: source });
  };

  assert.equal(validatePhrase(
    "The budget is one million one hundred fifty thousand dollars",
    "The budget is one million five hundred thousand dollars.",
    "one million one hundred fifty thousand dollars",
    "one million five hundred thousand dollars",
  ).valid, false);
  assert.equal(validatePhrase(
    "The HOA is three hundred fifty dollars",
    "The HOA is three hundred dollars.",
    "three hundred fifty dollars",
    "three hundred dollars",
  ).valid, false);
  assert.equal(validatePhrase(
    "the commute is forty-five minutes",
    "The commute is forty five minutes.",
    "forty-five",
    "forty five",
  ).valid, true);
  assert.equal(validatePhrase(
    "Our top price is one point ... [audio drops] ... five million.",
    "Our top price is one point one five million.",
    "one point ... [audio drops] ... five million",
    "one point one five million",
  ).valid, false);
  assert.equal(validatePhrase(
    "We need at least three bedrooms.",
    "We need at least four bedrooms.",
    "three bedrooms",
    "four bedrooms",
  ).valid, false);
});

test("readable transcript may remove the filler phrase I mean without loosening amount binding", () => {
  const fillerRaw = [{
    ...raw[0],
    textRaw: "the inspection budget is, I mean, $500",
    textNormalized: "the inspection budget is, I mean, $500",
  }];
  const fillerOutput = {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_filler",
      source_segment_ids: ["seg_1"],
      speaker: "Alex",
      start_ms: 1_000,
      end_ms: 4_000,
      readable_text: "The inspection budget is $500.",
      edits: [{
        kind: "filler",
        original: "I mean, ",
        replacement: "",
        reason: "Remove a discourse filler.",
        confidence: 1,
      }],
      needs_human_check: false,
    }],
  };
  const fillerResult = validateReadableTranscriptOutput(fillerOutput, {
    eventId: "evt_1",
    segments: fillerRaw,
  });
  assert.equal(fillerResult.valid, true);
  assert.equal(fillerResult.output.segments[0].needs_human_check, true);
  assert.deepEqual(readableTranscriptSegmentsForVerification(fillerResult.output), []);
  fillerOutput.segments[0].readable_text = "The repair deposit is $500.";
  assert.equal(validateReadableTranscriptOutput(fillerOutput, {
    eventId: "evt_1",
    segments: fillerRaw,
  }).valid, false);
});

test("readable transcript cannot omit, repeat, or reorder raw segments", () => {
  const output = readable();
  output.segments[0].source_segment_ids = ["seg_2"];
  const result = validateReadableTranscriptOutput(output, { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("Every raw segment")));
});

test("readable transcript exposes every change and flags semantic corrections", () => {
  assert.equal(
    validateReadableTranscriptOutput(readable({ edits: [] }), { eventId: "evt_1", segments: raw }).valid,
    false,
  );
  const silentCorrection = readable({
    edits: [{
      kind: "context_correction",
      original: "needs approval",
      replacement: "requires approval",
      reason: "Context cleanup.",
      confidence: 0.95,
    }],
    readable_text: "We cannot spend more than $12,500, and it requires approval on September 8.",
    needs_human_check: false,
  });
  const result = validateReadableTranscriptOutput(silentCorrection, { eventId: "evt_1", segments: raw });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith("needs_human_check")));
});

test("readable provider may fall back only an invalid text/edit group to its exact raw source", () => {
  const candidate = readable();
  candidate.segments[0].readable_text = "";
  candidate.segments[0].edits = [{
    kind: "filler",
    original: "cannot spend",
    replacement: "",
    reason: "unsafe model cleanup",
    confidence: 0.9,
  }];
  const strict = validateReadableTranscriptOutput(candidate, { eventId: "evt_1", segments: raw });
  assert.equal(strict.valid, false);

  const repaired = validateReadableTranscriptOutput(
    candidate,
    { eventId: "evt_1", segments: raw },
    { allowRawFallback: true },
  );
  assert.equal(repaired.valid, true);
  assert.equal(
    repaired.output.segments[0].readable_text,
    raw.map((segment) => segment.textRaw).join(" "),
  );
  assert.deepEqual(repaired.output.segments[0].edits, []);
  assert.equal(repaired.output.segments[0].needs_human_check, false);
});

test("readable provider replaces wrong timing and cross-speaker grouping with raw-safe rows", () => {
  const crossSpeakerRaw = [raw[0], { ...raw[1], speaker: "Blair" }];
  const candidate = readable({ end_ms: 7_999 });
  const strictTiming = validateReadableTranscriptOutput(candidate, { eventId: "evt_1", segments: raw });
  assert.equal(strictTiming.valid, false);
  const repairedTiming = validateReadableTranscriptOutput(
    candidate,
    { eventId: "evt_1", segments: raw },
    { allowRawFallback: true },
  );
  assert.equal(repairedTiming.valid, true);
  assert.equal(repairedTiming.output.segments[0].end_ms, 8_000);
  assert.equal(repairedTiming.output.segments[0].readable_text, raw.map((segment) => segment.textRaw).join(" "));

  const crossSpeaker = readable({ speaker: "Alex" });
  const repairedSpeakers = validateReadableTranscriptOutput(
    crossSpeaker,
    { eventId: "evt_1", segments: crossSpeakerRaw },
    { allowRawFallback: true },
  );
  assert.equal(repairedSpeakers.valid, true);
  assert.deepEqual(
    repairedSpeakers.output.segments.map((segment) => segment.source_segment_ids),
    [["seg_1"], ["seg_2"]],
  );
  assert.deepEqual(
    repairedSpeakers.output.segments.map((segment) => segment.speaker),
    ["Alex", "Blair"],
  );
});

test("readable transcript rejects a responsible-party swap disguised as punctuation", () => {
  const responsibilityRaw = [{
    ...raw[0],
    textRaw: "Alice is responsible for the inspection and Bob approves the offer",
    textNormalized: "Alice is responsible for the inspection and Bob approves the offer",
  }];
  const result = validateReadableTranscriptOutput({
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_responsibility_swap",
      source_segment_ids: ["seg_1"],
      speaker: "Alex",
      start_ms: 1_000,
      end_ms: 4_000,
      readable_text: "Bob is responsible for the inspection, and Alice approves the offer.",
      edits: [{
        kind: "punctuation",
        original: "Alice is responsible for the inspection and Bob approves the offer",
        replacement: "Bob is responsible for the inspection, and Alice approves the offer.",
        reason: "Incorrectly labelled as punctuation.",
        confidence: 1,
      }],
      needs_human_check: false,
    }],
  }, { eventId: "evt_1", segments: responsibilityRaw });

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) =>
    issue.path.endsWith(".kind") && issue.message.includes("cannot add, remove, reorder, or replace")));
  assert.ok(result.issues.some((issue) =>
    issue.path.endsWith("needs_human_check") && issue.message.includes("responsibility")));
});

test("high-risk responsibility changes are retained for UI but excluded from Agent B", () => {
  const responsibilityRaw = [
    {
      ...raw[0],
      id: "seg_owner",
      ordinal: 0,
      textRaw: "Alice is responsible for the inspection",
      textNormalized: "Alice is responsible for the inspection",
    },
    {
      ...raw[1],
      id: "seg_timing",
      ordinal: 1,
      textRaw: "the meeting starts tomorrow",
      textNormalized: "the meeting starts tomorrow",
    },
  ];
  const artifact = {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [
      {
        readable_key: "read_owner_flagged",
        source_segment_ids: ["seg_owner"],
        speaker: "Alex",
        start_ms: 1_000,
        end_ms: 4_000,
        readable_text: "Bob is responsible for the inspection.",
        edits: [{
          kind: "context_correction",
          original: "Alice",
          replacement: "Bob",
          reason: "Possible speaker correction requiring review.",
          confidence: 0.7,
        }],
        needs_human_check: true,
      },
      {
        readable_key: "read_timing_safe",
        source_segment_ids: ["seg_timing"],
        speaker: "Alex",
        start_ms: 4_100,
        end_ms: 8_000,
        readable_text: "The meeting starts tomorrow.",
        edits: [{
          kind: "punctuation",
          original: "the meeting starts tomorrow",
          replacement: "The meeting starts tomorrow.",
          reason: "Sentence casing and punctuation.",
          confidence: 1,
        }],
        needs_human_check: false,
      },
    ],
  };
  const validated = validateReadableTranscriptOutput(artifact, {
    eventId: "evt_1",
    segments: responsibilityRaw,
  });
  assert.equal(validated.valid, true);
  assert.equal(validated.output.segments.length, 2, "the flagged row remains in the UI artifact");

  const verificationSegments = readableTranscriptSegmentsForVerification(validated.output);
  assert.deepEqual(verificationSegments.map((segment) => segment.readableSegmentKey), ["read_timing_safe"]);
  assert.equal(verificationSegments[0].requiresAttention, false);
  assert.doesNotMatch(JSON.stringify(verificationSegments), /Bob is responsible/);
  assert.deepEqual(
    responsibilityRaw.map((segment) => segment.textRaw),
    ["Alice is responsible for the inspection", "the meeting starts tomorrow"],
    "filtering the readability aid never mutates or removes raw evidence",
  );

  const allFlagged = {
    ...validated.output,
    segments: validated.output.segments.map((segment) => ({
      ...segment,
      needs_human_check: true,
    })),
  };
  assert.deepEqual(readableTranscriptSegmentsForVerification(allFlagged), []);
});

test("unflagged readability aid permits layout only and withholds lexical cleanup", () => {
  const cases = [
    {
      rawText: "hello there",
      readableText: "Hello\nthere.",
      edit: { kind: "paragraphing", original: "hello there", replacement: "Hello\nthere." },
    },
    {
      rawText: "we will um need a yard",
      readableText: "We will need a yard.",
      edit: { kind: "filler", original: "um ", replacement: "" },
    },
    {
      rawText: "we we need a yard",
      readableText: "We need a yard.",
      edit: { kind: "repetition", original: "we we", replacement: "We" },
    },
    {
      rawText: "the company is Open AI",
      readableText: "The company is OpenAI.",
      edit: { kind: "glossary", original: "Open AI", replacement: "OpenAI" },
    },
  ];
  for (const [index, example] of cases.entries()) {
    const source = [{
      ...raw[0],
      textRaw: example.rawText,
      textNormalized: example.rawText,
    }];
    const result = validateReadableTranscriptOutput({
      schema_version: "readable-transcript.v1",
      event_id: "evt_1",
      segments: [{
        readable_key: `read_safe_${index}`,
        source_segment_ids: ["seg_1"],
        speaker: "Alex",
        start_ms: 1_000,
        end_ms: 4_000,
        readable_text: example.readableText,
        edits: [{ ...example.edit, reason: "Safe readability edit.", confidence: 1 }],
        needs_human_check: false,
      }],
    }, { eventId: "evt_1", segments: source });
    assert.equal(result.valid, true, `${example.edit.kind}: ${JSON.stringify(result.issues)}`);
    const expectedAttention = ["filler", "repetition", "glossary"].includes(example.edit.kind);
    assert.equal(result.output.segments[0].needs_human_check, expectedAttention, example.edit.kind);
    assert.equal(readableTranscriptSegmentsForVerification(result.output).length, expectedAttention ? 0 : 1);
  }
});

test("lexical cleanup near unchanged number words stays visible but cannot aid Agent B", () => {
  const cases = [
    {
      label: "adjacent repetition beside a protected quantity",
      rawText: "we we need three bedrooms",
      readableText: "We need three bedrooms.",
      edit: { kind: "repetition", original: "we we", replacement: "We" },
    },
    {
      label: "glossary spelling beside protected money words",
      rawText: "Open AI budget is five hundred dollars",
      readableText: "OpenAI budget is five hundred dollars.",
      edit: { kind: "glossary", original: "Open AI", replacement: "OpenAI" },
    },
  ];
  for (const example of cases) {
    const result = validateSingleReadable({
      rawText: example.rawText,
      readableText: example.readableText,
      edits: [example.edit],
    });
    assertReadableWithheld(result, example.label);
  }
});

test("untrusted glossary edits cannot swap roles, polarity, conditions, or concerns into Agent B", () => {
  const cases = [
    {
      label: "role swap",
      rawText: "Alice handles inspection and Bob handles financing",
      readableText: "Bob handles inspection and Alice handles financing.",
      original: "Alice handles inspection and Bob handles financing",
      replacement: "Bob handles inspection and Alice handles financing",
    },
    {
      label: "preference polarity",
      rawText: "the client likes Beverly Hills",
      readableText: "The client dislikes Beverly Hills.",
      original: "likes",
      replacement: "dislikes",
    },
    {
      label: "condition subject",
      rawText: "If inspection is clean we can proceed",
      readableText: "If appraisal is clean, we can proceed.",
      original: "inspection",
      replacement: "appraisal",
    },
    {
      label: "concern polarity",
      rawText: "water damage is a concern",
      readableText: "Water damage is acceptable.",
      original: "a concern",
      replacement: "acceptable",
    },
  ];
  for (const example of cases) {
    const result = validateSingleReadable({
      rawText: example.rawText,
      readableText: example.readableText,
      edits: [{ kind: "glossary", original: example.original, replacement: example.replacement }],
    });
    assertReadableWithheld(result, example.label);
  }
});

test("semantic punctuation, numeric sign/range, and non-initial casing never enter Agent B", () => {
  const cases = [
    ["declarative to question", "Alice will submit the offer", "Alice will submit the offer?"],
    ["approval to question", "the offer is approved", "The offer is approved?"],
    ["split negation scope", "Do not approve", "Do not? Approve."],
    ["currency sign removed", "-$500 is the adjustment", "$500 is the adjustment."],
    ["quantity sign removed", "-500 dollars is the adjustment", "500 dollars is the adjustment."],
    ["range changed to list", "$500-$600 is expected", "$500, $600 is expected."],
    ["modal changed to month casing", "We may submit", "We May submit."],
    ["comma changes attachment", "Alice said Bob is responsible", "Alice, said Bob, is responsible."],
    ["comma changes negation reading", "No price is too high", "No, price is too high."],
    ["comma changes addressee", "Let us eat grandma", "Let us eat, grandma."],
    ["ellipsis changes certainty", "The buyer agreed", "The buyer agreed..."],
  ];
  for (const [label, rawText, readableText] of cases) {
    const result = validateSingleReadable({
      rawText,
      readableText,
      edits: [{
        kind: label.includes("casing") ? "capitalization" : "punctuation",
        original: rawText,
        replacement: readableText,
      }],
    });
    assertReadableWithheld(result, label);
  }
});

test("filler, repetition, empty insertion, and chained glossary tricks fail closed", () => {
  const lexicalCases = [
    {
      label: "semantic I mean",
      rawText: "I mean business",
      readableText: "Business.",
      edits: [{ kind: "filler", original: "I mean ", replacement: "" }],
    },
    {
      label: "AH is a name",
      rawText: "AH approves",
      readableText: "Approves.",
      edits: [{ kind: "filler", original: "AH ", replacement: "" }],
    },
    {
      label: "non-adjacent repetition",
      rawText: "we need we need a yard",
      readableText: "We need a yard.",
      edits: [{ kind: "repetition", original: "we need we need a yard", replacement: "We need a yard" }],
    },
    {
      label: "empty glossary insertion",
      rawText: "budget discussed",
      readableText: "OpenAI budget discussed.",
      edits: [{ kind: "glossary", original: "", replacement: "OpenAI " }],
    },
  ];
  for (const example of lexicalCases) {
    assertReadableWithheld(validateSingleReadable(example), example.label);
  }

  const chained = validateSingleReadable({
    rawText: "Open AI discussed the budget",
    readableText: "OpenAI discussed the budget.",
    edits: [
      { kind: "glossary", original: "Open AI", replacement: "OpenAI" },
      { kind: "glossary", original: "OpenAI", replacement: "OpenAI" },
    ],
  });
  assert.equal(chained.valid, false, "a second edit cannot use model-created text as raw source");
});

test("readable groups cannot cross Asset Versions or Speakers, while same-source fragments may merge", () => {
  const source = [
    {
      ...raw[0], id: "seg_a", ordinal: 0, assetVersionId: "av_1", speaker: "Alice",
      textRaw: "will you approve", textNormalized: "will you approve",
    },
    {
      ...raw[1], id: "seg_b", ordinal: 1, assetVersionId: "av_1", speaker: "Bob",
      textRaw: "yes", textNormalized: "yes",
    },
  ];
  const grouped = {
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: [{
      readable_key: "read_group",
      source_segment_ids: ["seg_a", "seg_b"],
      speaker: null,
      start_ms: 1_000,
      end_ms: 8_000,
      readable_text: "Will you approve? Yes.",
      edits: [{
        kind: "punctuation",
        original: "will you approve yes",
        replacement: "Will you approve? Yes.",
        reason: "Unsafe merge.",
        confidence: 1,
      }],
      needs_human_check: false,
    }],
  };
  const mixedSpeaker = validateReadableTranscriptOutput(grouped, { eventId: "evt_1", segments: source });
  assert.equal(mixedSpeaker.valid, false);
  assert.ok(mixedSpeaker.issues.some((issue) => issue.message.includes("different Speakers")));

  const mixedAssetSource = source.map((segment, index) => ({
    ...segment,
    speaker: "Alice",
    assetVersionId: `av_${index + 1}`,
  }));
  const mixedAsset = validateReadableTranscriptOutput({
    ...grouped,
    segments: [{ ...grouped.segments[0], speaker: "Alice" }],
  }, { eventId: "evt_1", segments: mixedAssetSource });
  assert.equal(mixedAsset.valid, false);
  assert.ok(mixedAsset.issues.some((issue) => issue.message.includes("different raw Asset Versions")));

  const sameSource = mixedAssetSource.map((segment, index) => ({
    ...segment,
    assetVersionId: "av_1",
    speaker: "Alice",
    textRaw: index === 0 ? "we should" : "submit tomorrow",
    textNormalized: index === 0 ? "we should" : "submit tomorrow",
  }));
  const sameSourceResult = validateReadableTranscriptOutput({
    ...grouped,
    segments: [{
      ...grouped.segments[0],
      speaker: "Alice",
      readable_text: "We should submit tomorrow.",
      edits: [{
        kind: "punctuation",
        original: "we should submit tomorrow",
        replacement: "We should submit tomorrow.",
        reason: "Safe same-source merge.",
        confidence: 1,
      }],
    }],
  }, { eventId: "evt_1", segments: sameSource });
  assert.equal(sameSourceResult.valid, true, JSON.stringify(sameSourceResult.issues));
  assert.equal(sameSourceResult.output.segments[0].needs_human_check, false);
  assert.equal(readableTranscriptSegmentsForVerification(sameSourceResult.output).length, 1);
});

test("long readable transcripts split deterministically and merge in raw order", () => {
  const segments = Array.from({ length: 7 }, (_, index) => ({
    ...raw[index % raw.length],
    id: `seg_${index}`,
    ordinal: index,
    textRaw: `segment ${index}`,
    textNormalized: `segment ${index}`,
  }));
  const chunks = chunkReadableTranscriptSource(segments, { segments: 3, characters: 10_000 });
  assert.deepEqual(chunks.map((chunk) => chunk.segments.map((segment) => segment.id)), [
    ["seg_0", "seg_1", "seg_2"],
    ["seg_3", "seg_4", "seg_5"],
    ["seg_6"],
  ]);
  assert.deepEqual(
    chunkReadableTranscriptSource(segments, { segments: 3, characters: 10_000 }),
    chunks,
  );
  const merged = mergeReadableTranscriptChunks("evt_1", chunks.map((chunk) => ({
    schema_version: "readable-transcript.v1",
    event_id: "evt_1",
    segments: chunk.segments.map((segment) => ({
      readable_key: "local_key",
      source_segment_ids: [segment.id],
      speaker: segment.speaker,
      start_ms: segment.startMs,
      end_ms: segment.endMs,
      readable_text: segment.textRaw,
      edits: [],
      needs_human_check: false,
    })),
  })));
  assert.deepEqual(
    merged.segments.flatMap((segment) => segment.source_segment_ids),
    segments.map((segment) => segment.id),
  );
  assert.equal(new Set(merged.segments.map((segment) => segment.readable_key)).size, 7);
});

test("artifact backlog gives Summary a stable tie-break without serializing targeted pairs", async () => {
  const jobs = await readFile(new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url), "utf8");
  assert.match(jobs, /ORDER BY next_attempt_at,[\s\S]*CASE kind WHEN 'summary' THEN 0 ELSE 1 END,[\s\S]*created_at, id LIMIT \?/);
  assert.match(jobs, /input\?\.extractionRunId \? 2 : 2/);
  assert.match(jobs, /await Promise\.all\(\(rows\.results \?\? \[\]\)\.map/);
});

test("summary provider output gets a deterministic raw quote before persistence", () => {
  const valid = validateEventSummaryProviderOutput({
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{
        item_key: "sum_1",
        text: "The budget cannot exceed $12,500.",
        source_segment_ids: ["seg_1"],
        source_character_span: null,
      }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(valid.valid, true);
  assert.equal(valid.output.sections[0].items[0].support_quote, raw[0].textRaw);
  assert.equal(valid.output.sections[0].items[0].support_status, "source_linked_unverified");

  // The enriched artifact contract is checked again immediately before it is
  // persisted. The raw quote must match byte-for-byte, not just semantically.
  assert.equal(validateEventSummaryOutput(valid.output, { eventId: "evt_1", segments: raw }).valid, true);
  const tamperedArtifact = structuredClone(valid.output);
  tamperedArtifact.sections[0].items[0].support_quote = "The buyer's budget is $12,500.";
  const tampered = validateEventSummaryOutput(tamperedArtifact, { eventId: "evt_1", segments: raw });
  assert.equal(tampered.valid, false);
  assert.ok(tampered.issues.some((issue) => issue.path.endsWith(".support_quote")));
  const falselyVerifiedArtifact = structuredClone(valid.output);
  falselyVerifiedArtifact.sections[0].items[0].support_status = "verified";
  const falselyVerified = validateEventSummaryOutput(falselyVerifiedArtifact, { eventId: "evt_1", segments: raw });
  assert.equal(falselyVerified.valid, false);
  assert.ok(falselyVerified.issues.some((issue) => issue.path.endsWith(".support_status")));

  const multiSegment = validateEventSummaryProviderOutput({
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{
        item_key: "sum_2",
        text: "Budget and approval remain linked.",
        source_segment_ids: ["seg_1", "seg_2"],
        source_character_span: null,
      }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(multiSegment.valid, true);
  assert.equal(multiSegment.output.sections[0].items[0].support_quote, `${raw[0].textRaw}\n${raw[1].textRaw}`);
});

test("summary provider no longer authors a support quote", () => {
  const paraphrasedProviderOutput = validateEventSummaryProviderOutput({
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{
        item_key: "sum_1",
        text: "The budget cannot exceed $12,500.",
        support_quote: "The buyer's budget is $12,500.",
        source_segment_ids: ["seg_1"],
        source_character_span: null,
      }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(paraphrasedProviderOutput.valid, false);
  assert.ok(paraphrasedProviderOutput.issues.some((issue) =>
    issue.path.endsWith(".support_quote") && issue.message === "Unexpected field."));
});

test("summary source spans preserve ordered raw excerpts but fail closed for missing, cross-Event, duplicate, unordered, and cross-Asset IDs", () => {
  const segments = [
    raw[0],
    raw[1],
    { ...raw[1], id: "seg_3", ordinal: 2, startMs: 8_100, endMs: 9_000, textRaw: "the closing date remains open", textNormalized: "the closing date remains open" },
    { ...raw[1], id: "seg_4", assetVersionId: "av_2", ordinal: 0, startMs: 9_100, endMs: 10_000, textRaw: "a pasted note from the same meeting", textNormalized: "a pasted note from the same meeting" },
  ];
  const providerOutput = (source_segment_ids) => ({
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "key_fact",
      title: "Facts",
      items: [{ item_key: "sum_1", text: "Summary", source_segment_ids, source_character_span: null }],
    }],
  });

  for (const ids of [
    ["seg_missing"],
    ["seg_1", "seg_1"],
    ["seg_2", "seg_1"],
    ["seg_3", "seg_4"],
  ]) {
    const result = validateEventSummaryProviderOutput(providerOutput(ids), { eventId: "evt_1", segments });
    assert.equal(result.valid, false, `expected ${ids.join(",")} to fail closed`);
  }

  const skippedBackchannel = validateEventSummaryProviderOutput(
    providerOutput(["seg_1", "seg_3"]),
    { eventId: "evt_1", segments },
  );
  assert.equal(skippedBackchannel.valid, true);
  assert.deepEqual(
    skippedBackchannel.output.sections[0].items[0].source_segment_ids,
    ["seg_1", "seg_3"],
  );
  assert.equal(
    skippedBackchannel.output.sections[0].items[0].support_quote,
    `${segments[0].textRaw}\n…\n${segments[2].textRaw}`,
  );

  const crossEvent = validateEventSummaryProviderOutput(providerOutput(["seg_1"]), {
    eventId: "evt_1",
    segments: [{ ...segments[0], eventId: "evt_other" }, ...segments.slice(1)],
  });
  assert.equal(crossEvent.valid, false);
  assert.ok(crossEvent.issues.some((issue) => issue.message.includes("different Event")));
});

test("summary resolves a bounded Unicode code-point span from a raw Segment longer than 12k", () => {
  const prefix = "😀".repeat(12_001);
  const longSegment = {
    ...raw[0],
    textRaw: `${prefix}TARGET raw suffix`,
    textNormalized: `${prefix}TARGET raw suffix`,
  };
  const base = {
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "key_fact",
      title: "Facts",
      items: [{
        item_key: "sum_long",
        text: "Target fact.",
        source_segment_ids: ["seg_1"],
        source_character_span: {
          segment_id: "seg_1",
          start_codepoint: 12_001,
          end_codepoint: 12_007,
        },
      }],
    }],
  };
  const valid = validateEventSummaryProviderOutput(base, {
    eventId: "evt_1",
    segments: [longSegment],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.output.sections[0].items[0].support_quote, "TARGET");
  assert.deepEqual(valid.output.sections[0].items[0].source_character_span, {
    segment_id: "seg_1",
    start_codepoint: 12_001,
    end_codepoint: 12_007,
  });
  assert.equal(validateEventSummaryOutput(valid.output, {
    eventId: "evt_1",
    segments: [longSegment],
  }).valid, true);

  const withoutSpan = structuredClone(base);
  withoutSpan.sections[0].items[0].source_character_span = null;
  const oversized = validateEventSummaryProviderOutput(withoutSpan, {
    eventId: "evt_1",
    segments: [longSegment],
  });
  assert.equal(oversized.valid, false);
  assert.ok(oversized.issues.some((issue) => issue.message.includes("12000 Unicode code points")));
});

test("summary character spans reject empty, reversed, out-of-bounds, mismatched, and multi-Segment ranges", () => {
  const segments = [
    raw[0],
    raw[1],
  ];
  const providerOutput = (sourceSegmentIds, span) => ({
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "key_fact",
      title: "Facts",
      items: [{
        item_key: "sum_span",
        text: "Summary",
        source_segment_ids: sourceSegmentIds,
        source_character_span: span,
      }],
    }],
  });
  for (const [ids, span] of [
    [["seg_1"], { segment_id: "seg_1", start_codepoint: 2, end_codepoint: 2 }],
    [["seg_1"], { segment_id: "seg_1", start_codepoint: 3, end_codepoint: 2 }],
    [["seg_1"], { segment_id: "seg_1", start_codepoint: 0, end_codepoint: 10_000 }],
    [["seg_1"], { segment_id: "seg_1", start_codepoint: "0", end_codepoint: 2 }],
    [["seg_1"], { segment_id: "seg_2", start_codepoint: 0, end_codepoint: 2 }],
    [["seg_1", "seg_2"], { segment_id: "seg_1", start_codepoint: 0, end_codepoint: 2 }],
  ]) {
    const result = validateEventSummaryProviderOutput(providerOutput(ids, span), {
      eventId: "evt_1",
      segments,
    });
    assert.equal(result.valid, false, `expected ${JSON.stringify({ ids, span })} to fail closed`);
  }
});

test("summary rejects an unknown raw segment instead of fabricating a quote", () => {
  const unsupported = validateEventSummaryProviderOutput({
    schema_version: "event-summary.v2",
    event_id: "evt_1",
    sections: [{
      kind: "decision",
      title: "Decisions",
      items: [{
        item_key: "sum_1",
        text: "Unsupported",
        source_segment_ids: ["seg_other"],
        source_character_span: null,
      }],
    }],
  }, { eventId: "evt_1", segments: raw });
  assert.equal(unsupported.valid, false);
});

test("artifact jobs use durable Background Responses and independent retries", async () => {
  const [jobs, worker, repository] = await Promise.all([
    readFile(new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/db/event-ai-artifact-repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(jobs, /resumeProviderResponseId/);
  assert.match(jobs, /ModelBackgroundPendingError/);
  assert.match(jobs, /provider_request_id = \?/);
  assert.match(worker, /dispatchEventAiArtifactsForExtraction/);
  assert.match(worker, /kind === "artifact"/);
  assert.match(repository, /createEventAiArtifactRetry/);
  assert.match(repository, /Only a failed AI artifact can be regenerated/);
  assert.match(repository, /Start this event's analysis first/);
  assert.match(repository, /409,[\s\S]*"EVENT_NOT_READY"/);
  assert.match(repository, /reason: "analysis_required"/);
  assert.match(repository, /er\.status IN \('succeeded','completed','completed_with_warnings'\)/);
  assert.match(repository, /listEventAiArtifactRunDebug/);
  assert.match(repository, /SELECT canonical_value, aliases_json, category/);
  assert.doesNotMatch(repository, /variants_json/);
  assert.match(repository, /mutation_guards[\s\S]*event_ai_artifact_runs[\s\S]*lease_owner/);
  assert.match(repository, /status = 'processing' AND lease_owner = \?/);
  assert.match(jobs, /chunkReadableTranscriptSource/);
  assert.match(jobs, /readable_transcript:chunk:\$\{chunk\.chunk_index\}/);
  assert.match(jobs, /listReadableTranscriptChunks/);
  assert.match(repository, /event_ai_artifact_chunks/);
  assert.match(repository, /READABLE_TRANSCRIPT_CHUNK_INPUT_CHANGED/);
  assert.match(repository, /persistReadableTranscriptChunk/);
});

test("Summary v2 provider schema and prompt request locations, never model-authored quotes", async () => {
  const provider = await readFile(
    new URL("../lib/server/ai/model-provider.ts", import.meta.url),
    "utf8",
  );
  const schemaBlock = provider.slice(
    provider.indexOf("function eventSummaryJsonSchema"),
    provider.indexOf("function readableTranscriptJsonSchema"),
  );
  assert.match(schemaBlock, /required: \["item_key", "text", "source_segment_ids", "source_character_span"\]/);
  assert.doesNotMatch(schemaBlock, /support_quote/);
  assert.match(provider, /Do not return support_quote/);
  assert.match(provider, /start_codepoint and exclusive end_codepoint offsets counted in Unicode code points/);
  assert.match(provider, /validateEventSummaryProviderOutput\(result\.value/);
});

test("artifact dispatch accepts only the exact frozen provider contract for each kind", async () => {
  assert.equal(eventAiArtifactContractMismatch({
    kind: "summary",
    prompt_version: "event-summary-prompt.v2",
    schema_version: "event-summary.v2",
  }), null);
  assert.equal(eventAiArtifactContractMismatch({
    kind: "readable_transcript",
    prompt_version: "readable-transcript-prompt.v2",
    schema_version: "readable-transcript.v1",
  }), null);
  for (const legacy of [
    { kind: "summary", prompt_version: "event-summary-prompt.v1", schema_version: "event-summary.v1" },
    { kind: "summary", prompt_version: "event-summary-prompt.v2", schema_version: "event-summary.v1" },
    { kind: "readable_transcript", prompt_version: "readable-transcript-prompt.v1", schema_version: "readable-transcript.v1" },
    { kind: "readable_transcript", prompt_version: "readable-transcript-prompt.v0", schema_version: "readable-transcript.v1" },
    { kind: "unknown", prompt_version: "v1", schema_version: "v1" },
  ]) {
    assert.ok(eventAiArtifactContractMismatch(legacy), `${legacy.kind} legacy contract must fail closed`);
  }

  const jobs = await readFile(
    new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url),
    "utf8",
  );
  const processing = jobs.slice(
    jobs.indexOf("async function processLeasedRun"),
    jobs.indexOf("export async function dispatchDueEventAiArtifactRuns"),
  );
  assert.ok(
    processing.indexOf("eventAiArtifactContractMismatch(run)") <
      processing.indexOf("sourceSegmentsForArtifactRun"),
    "frozen contract must be checked before loading input or selecting a provider",
  );
  assert.ok(
    processing.indexOf("eventAiArtifactContractMismatch(run)") <
      processing.indexOf("createModelProvider"),
    "legacy runs must fail before any provider path can be used",
  );
  assert.match(jobs, /STALE_ARTIFACT_MODEL_CONTRACT/);
  assert.match(jobs, /retry the single artifact to create the current contract/);
  assert.match(
    jobs,
    /"status IN \('queued', 'processing'\)"/,
    "succeeded legacy artifacts remain read-only and are never re-dispatched",
  );
});

test("artifact prompt cache keys stay within the OpenAI 64-character limit", async () => {
  const jobs = await readFile(
    new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url),
    "utf8",
  );
  const extractionRunId = `run_${"a".repeat(32)}`;
  const summaryKey = `notique:${extractionRunId}:event-artifacts`;
  const readableKey = `notique:${extractionRunId}:readable:0`;

  assert.match(
    jobs,
    /promptCacheKey: `notique:\$\{run\.extraction_run_id\}:event-artifacts`/,
  );
  assert.match(
    jobs,
    /promptCacheKey: `notique:\$\{run\.extraction_run_id\}:readable:\$\{chunk\.chunk_index\}`/,
  );
  assert.equal(summaryKey.length, 60);
  assert.equal(readableKey.length, 55);
  assert.ok(summaryKey.length <= 64);
  assert.ok(readableKey.length <= 64);
});

test("artifact retry refreshes the panel and dispatches only the requested artifact", async () => {
  assert.match(
    uiSource,
    /await onRetryArtifact\(event\.id, "summary"\);\s*await load\(true\);/,
  );
  assert.match(
    uiSource,
    /await onRetryArtifact\(event\.id, "readable_transcript"\);\s*await load\(true\);/,
  );
  assert.match(uiSource, /retryEventAiArtifact[\s\S]*kickDispatcher\(\{ kind: "artifact", runId: artifactRun\.id \}\)/);
});

test("fact extraction defaults to raw-only while readable remains an optional mapped aid", async () => {
  const [processor, provider, context, coreRepository, exampleEnvironment, workerConfig] = await Promise.all([
    readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/ai/model-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/domain/context-pack.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/db/core-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(exampleEnvironment, /^AI_VERIFICATION_USES_READABLE=0$/m);
  assert.match(workerConfig, /"AI_VERIFICATION_USES_READABLE": "0"/);
  assert.match(processor, /frozen\.verification_uses_readable === false \|\| getBindings\(\)\.AI_VERIFICATION_USES_READABLE === "0"[\s\S]{0,80}return base/);
  assert.match(processor, /inventoryProvider\.inventoryClaims\(\s*inventoryContext/);
  assert.match(processor, /draft_context: \{ enabled: false, claims: \[\] \}/);
  assert.match(processor, /contextWithReadableTranscript/);
  assert.match(
    processor,
    /ORDER BY ar\.created_at ASC, ar\.id ASC LIMIT 1/,
    "Agent B must stay bound to the first Readable Run created for this Extraction Run",
  );
  assert.doesNotMatch(
    processor,
    /ORDER BY ar\.attempt_no/,
    "mutable dispatch attempts cannot choose which Readable Run belongs to Agent B",
  );
  assert.doesNotMatch(
    processor,
    /WHERE ar\.extraction_run_id = \? AND ar\.kind = 'readable_transcript'[\s\S]{0,300}ORDER BY ar\.created_at DESC/,
    "a later UI-only Readable retry must not replace an in-flight Agent B input",
  );
  assert.match(processor, /readableTranscriptSegmentsForVerification\(validation\.output\)/);
  assert.match(processor, /if \(safeSegments\.length === 0\) return base/);
  assert.match(processor, /readable_transcript_segments: safeSegments/);
  assert.match(processor, /\["queued", "processing"\][\s\S]*ReadableTranscriptPendingError/);
  assert.match(processor, /releaseRunForReadableTranscriptPoll/);
  assert.match(processor, /last_error_code = 'READABLE_TRANSCRIPT_PENDING'/);
  assert.match(processor, /attempt = CASE WHEN attempt > 0 THEN attempt - 1 ELSE 0 END/);
  assert.match(processor, /verifierProvider\.verifyClaims\(\s*verificationContext/);
  assert.match(provider, /not Evidence[\s\S]*authoritative raw transcript_segments IDs/i);
  assert.match(processor, /readable_transcript_segments: verificationContext\.new_event\.readable_transcript_segments[\s\S]*stage: "verify"/);
  assert.match(context, /readable_transcript_segments/);
  assert.match(coreRepository, /metadata\.analysis_source === false \|\| metadata\.artifact_kind === "readable_transcript"/);
  assert.match(coreRepository, /AI-readable transcripts cannot replace raw source material for fact extraction/);
});

test("Agent B keeps the first Readable Run when a later retry has a lower mutable attempt", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE event_ai_artifact_runs (
      id TEXT PRIMARY KEY,
      extraction_run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      attempt_no INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE event_ai_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      content_json TEXT
    );
    INSERT INTO event_ai_artifact_runs VALUES
      ('earun-original', 'run-frozen', 'readable_transcript', 'failed', 'MODEL_OUTPUT_INVALID', 1, '2026-08-15T10:00:00.000Z'),
      ('earun-retry', 'run-frozen', 'readable_transcript', 'succeeded', NULL, 0, '2026-08-15T10:05:00.000Z');
    INSERT INTO event_ai_artifacts VALUES
      ('artifact-retry', 'earun-retry', '{"schema_version":"readable-transcript.v1"}');
  `);
  const selected = database.prepare(`
    SELECT ar.id, ar.status, ar.attempt_no, a.content_json
      FROM event_ai_artifact_runs ar
      LEFT JOIN event_ai_artifacts a ON a.run_id = ar.id
     WHERE ar.extraction_run_id = ? AND ar.kind = 'readable_transcript'
     ORDER BY ar.created_at ASC, ar.id ASC LIMIT 1
  `).get("run-frozen");
  assert.equal(selected.id, "earun-original");
  assert.equal(selected.status, "failed");
  assert.equal(selected.attempt_no, 1);
  assert.equal(selected.content_json, null);
});

test("raw Transcript listing and human-added Evidence exclude readable derived segments", async () => {
  const repository = await readFile(
    new URL("../lib/server/db/ai-draft-repository.ts", import.meta.url),
    "utf8",
  );
  const predicateMatch = repository.match(
    /const RAW_TRANSCRIPT_ASSET_PREDICATE = `([\s\S]*?)`;/,
  );
  assert.ok(predicateMatch, "the raw Transcript boundary must be a shared SQL predicate");
  const predicate = predicateMatch[1];

  assert.match(predicate, /a\.kind IN \('transcript', 'text'\)/);
  assert.match(predicate, /json_extract\(a\.metadata_json, '\$\.analysis_source'\)/);
  assert.match(predicate, /<> 0/);
  assert.match(predicate, /json_extract\(a\.metadata_json, '\$\.artifact_kind'\)/);
  assert.match(predicate, /<> 'readable_transcript'/);

  const listBlock = repository.slice(
    repository.indexOf("export async function listEventTranscriptSegments"),
    repository.indexOf("export async function createManualClaim"),
  );
  const manualBlock = repository.slice(
    repository.indexOf("export async function createManualClaim"),
  );
  for (const block of [listBlock, manualBlock]) {
    assert.match(block, /JOIN assets a ON a\.id = ts\.asset_id/);
    assert.match(block, /\$\{RAW_TRANSCRIPT_ASSET_PREDICATE\}/);
  }
  assert.match(manualBlock, /selected passages are not raw Transcript evidence/);

  // D1 uses SQLite semantics. Execute the exact production predicate against
  // raw, readable, legacy-marked, and non-Transcript segment owners.
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE text_segments (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL
    );
    INSERT INTO assets VALUES
      ('raw-default', 'transcript', '{}'),
      ('raw-explicit', 'transcript', '{"analysis_source":true}'),
      ('readable-false', 'transcript', '{"analysis_source":false,"artifact_kind":"readable_transcript"}'),
      ('readable-kind', 'transcript', '{"analysis_source":true,"artifact_kind":"readable_transcript"}'),
      ('text-file', 'text', '{}'),
      ('photo-file', 'photo', '{}');
    INSERT INTO text_segments VALUES
      ('seg-raw-default', 'raw-default', 'evt', 'ws', 0),
      ('seg-raw-explicit', 'raw-explicit', 'evt', 'ws', 1),
      ('seg-readable-false', 'readable-false', 'evt', 'ws', 2),
      ('seg-readable-kind', 'readable-kind', 'evt', 'ws', 3),
      ('seg-text-file', 'text-file', 'evt', 'ws', 4),
      ('seg-photo-file', 'photo-file', 'evt', 'ws', 5);
  `);
  const rows = database.prepare(`
    SELECT ts.id
      FROM text_segments ts
      JOIN assets a ON a.id = ts.asset_id
     WHERE ts.event_id = ? AND ts.workspace_id = ?
       AND ${predicate}
     ORDER BY ts.ordinal
  `).all("evt", "ws");
  assert.deepEqual(rows.map((row) => row.id), [
    "seg-raw-default",
    "seg-raw-explicit",
    "seg-text-file",
  ]);
});

test("Summary source loading accepts raw Transcript and pasted text but excludes readable derived segments", async () => {
  const repository = await readFile(
    new URL("../lib/server/db/event-ai-artifact-repository.ts", import.meta.url),
    "utf8",
  );
  const predicateMatch = repository.match(
    /const RAW_ARTIFACT_SOURCE_ASSET_PREDICATE = `([\s\S]*?)`;/,
  );
  assert.ok(predicateMatch, "Summary source loading must have an explicit raw-only predicate");
  const predicate = predicateMatch[1];
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    INSERT INTO assets VALUES
      ('raw-transcript', 'transcript', '{}'),
      ('pasted-text', 'text', '{}'),
      ('raw-explicit', 'transcript', '{"analysis_source":true}'),
      ('readable-false', 'transcript', '{"analysis_source":false,"artifact_kind":"readable_transcript"}'),
      ('readable-kind', 'transcript', '{"analysis_source":true,"artifact_kind":"readable_transcript"}'),
      ('photo', 'photo', '{}');
  `);
  const rows = database.prepare(`SELECT id FROM assets a WHERE ${predicate} ORDER BY id`).all();
  assert.deepEqual(rows.map((row) => row.id), ["pasted-text", "raw-explicit", "raw-transcript"]);
  assert.match(repository, /ts\.event_id = \? AND ts\.workspace_id = \?/);
  assert.match(repository, /AND \$\{RAW_ARTIFACT_SOURCE_ASSET_PREDICATE\}/);
  assert.match(repository, /expectedInputHash[\s\S]*ARTIFACT_INPUT_HASH_CHANGED/);
  assert.match(repository, /JOIN extraction_runs er[\s\S]*er\.event_id = ar\.event_id/);
  assert.match(repository, /av\.content_sha256[\s\S]*a\.workspace_id = \?[\s\S]*a\.project_id = \?[\s\S]*a\.event_id = \?/);
  assert.match(repository, /ARTIFACT_INPUT_MANIFEST_CHANGED/);
});

test("project deletion is reversible, blocks active jobs, and deletes R2 before D1", async () => {
  const [repository, route, uiSource] = await Promise.all([
    readFile(new URL("../lib/server/db/core-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/[...segments]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(repository, /active_job_count[\s\S]*event_ai_artifact_runs/);
  assert.match(repository, /INSERT INTO mutation_guards[\s\S]*UPDATE projects SET deleted_at/);
  assert.match(repository, /Promise\.all\(keyRows\.map[\s\S]*DELETE FROM projects/);
  assert.match(repository, /project-purge:\$\{projectId\}[\s\S]*NOT EXISTS \(SELECT 1 FROM mutation_guards WHERE id = \?\)/);
  assert.match(repository, /Stored project files could not be fully deleted[\s\S]*remains locked in the recycle bin/);
  assert.match(route, /segments\[1\] === "trash"/);
  assert.match(route, /segments\[2\] === "restore"/);
  assert.match(route, /segments\[2\] === "permanent"/);
  assert.match(uiSource, /输入完整项目名称确认/);
  assert.match(uiSource, /已移到回收站[\s\S]*撤销/);
});
