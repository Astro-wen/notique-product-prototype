import assert from "node:assert/strict";
import test from "node:test";

import { evaluate } from "../scripts/eval-runner.mjs";

const truth = {
  schemaVersion: "notique-ground-truth.v1",
  dataset: "unit-regression-only",
  split: "development",
  claims: [
    {
      id: "gt_budget",
      scenarioId: "s1",
      eventId: "e1",
      material: true,
      critical: true,
      modality: "transcript",
      expectedClassification: "new",
      timestampMs: 10_000,
      annotation: { doubleAnnotated: true },
    },
    {
      id: "gt_repeat",
      scenarioId: "s1",
      eventId: "e2",
      material: true,
      critical: false,
      modality: "transcript",
      expectedClassification: "reaffirmed",
      targetVersionId: "cv1",
      ambiguity: { severity: "critical" },
      annotation: { doubleAnnotated: false },
    },
  ],
  relations: [
    { id: "rel1", type: "informed_by", sourceClaimId: "gt_repeat", targetClaimId: "gt_budget", targetVersionId: "cv1" },
  ],
};

const briefSlots = [
  ["current_status", "claim", "claim-current"],
  ["change_1", "timeline_delta", "delta-1"],
  ["change_2", "timeline_delta", "delta-2"],
  ["question_1", "agenda_item", "agenda-1"],
  ["question_2", "agenda_item", "agenda-2"],
  ["risk", "claim", "claim-risk"],
].map(([slot, sourceKind, sourceId]) => ({ slot, sourceKind, sourceId, sourceValid: true, useful: true }));

function run(id) {
  return {
    id,
    claims: [
      {
        id: `${id}_budget`,
        matchedGroundTruthId: "gt_budget",
        material: false,
        critical: false,
        type: "budget",
        normalizedValue: { amount: 1_500_000 },
        relationSignature: "new",
        classification: "new",
        citationSupport: "fully_supports",
        evidence: [{ kind: "transcript", idValid: true, quoteExact: true, startMs: 9_000, endMs: 12_000 }],
      },
      {
        id: `${id}_repeat`,
        matchedGroundTruthId: "gt_repeat",
        material: false,
        critical: false,
        type: "preference",
        normalizedValue: { value: "quiet" },
        relationSignature: "reaffirmed:cv1",
        classification: "reaffirmed",
        targetVersionId: "cv1",
        ambiguityDetected: true,
        ambiguityAlternatives: ["quiet", "very quiet"],
        ambiguityQuestion: "How quiet must the area be?",
        assertedDefinitively: false,
        citationSupport: "fully_supports",
        evidence: [{ kind: "transcript", idValid: true, quoteExact: true, startMs: 20_000, endMs: 21_000 }],
      },
    ],
    relations: [
      {
        matchedGroundTruthRelationId: "rel1",
        type: "informed_by",
        sourceGroundTruthClaimId: "gt_repeat",
        targetGroundTruthClaimId: "gt_budget",
        targetVersionId: "cv1",
      },
    ],
    viewLeakageCount: 0,
    brief: { slots: structuredClone(briefSlots) },
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01, latencyMs: 500 },
  };
}

function predictionSet() {
  return {
    schemaVersion: "notique-eval-predictions.v1",
    metadata: { model: "test", prompt: "p1", schema: "s1", commitSha: "abc" },
    runs: [run("r1"), run("r2"), run("r3")],
  };
}

test("eval runner derives material and critical status from Ground Truth", () => {
  const report = evaluate(truth, predictionSet());
  assert.equal(report.metrics.materialClaimRecall.value, 1);
  assert.equal(report.metrics.materialClaimPrecision.value, 1);
  assert.equal(report.metrics.criticalCitationSupport.value, 1);
  assert.equal(report.metrics.criticalAmbiguityRecall.value, 1);
  assert.equal(report.metrics.consistency.value, 1);
  assert.equal(report.metrics.briefSourceValidity.value, 1);
  assert.equal(report.metrics.briefUsefulRate.denominator, 6);
  assert.equal(report.sampleEligibility.hasThreeIndependentRuns, true);
  assert.deepEqual(report.sampleEligibility.eventMaterialClaimCounts, { e1: 1, e2: 1 });
  assert.equal(report.sampleEligibility.eventMaterialShapeValid, false);
  assert.equal(report.sampleEligibility.meetsTranscriptMinimum, false);
  assert.equal(report.gates.pass, false);
});

test("duplicate Claim matches and missing Evidence lower the metrics", () => {
  const predictions = predictionSet();
  predictions.runs[0].claims[0].evidence = [];
  predictions.runs[0].claims.push({
    ...structuredClone(predictions.runs[0].claims[0]),
    id: "r1_budget_duplicate",
    evidence: [{ kind: "transcript", idValid: true, quoteExact: true, startMs: 9_000, endMs: 12_000 }],
  });
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.materialClaimRecall.value, 0.5);
  assert.equal(report.metrics.materialClaimPrecision.value, 1 / 3);
  assert.equal(report.metrics.claimsWithEvidence.value, 2 / 3);
  assert.equal(report.metrics.criticalCitationSupport.value, 0);
});

test("variable unmatched hallucinations are included in consistency", () => {
  const predictions = predictionSet();
  predictions.runs.forEach((item, index) => item.claims.push({
    id: `${item.id}_hallucination`,
    matchedGroundTruthId: null,
    statement: `Hallucination ${index}`,
    type: "risk",
    normalizedValue: { value: index },
    classification: "new",
    citationSupport: "fully_supports",
    evidence: [{ kind: "transcript", idValid: true, quoteExact: true, startMs: 30_000, endMs: 31_000 }],
  }));
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.consistency.denominator, 5);
  assert.equal(report.metrics.consistency.numerator, 2);
});

test("formal consistency gate requires at least three independent runs", () => {
  const predictions = predictionSet();
  predictions.runs = [predictions.runs[0]];
  const report = evaluate(truth, predictions);
  assert.equal(report.sampleEligibility.hasThreeIndependentRuns, false);
  assert.equal(report.gates.checks.find((item) => item.name === "three_run_consistency").passed, false);
});

test("timestamp distance does not bridge unrelated evidence intervals", () => {
  const predictions = predictionSet();
  predictions.runs[0].claims[0].evidence = [
    { kind: "transcript", idValid: true, quoteExact: true, startMs: 0, endMs: 1_000 },
    { kind: "transcript", idValid: true, quoteExact: true, startMs: 20_000, endMs: 21_000 },
  ];
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.timestampDistanceMs.max, 9_000);
  assert.equal(report.gates.checks.find((item) => item.name === "timestamp_max").passed, false);
});

test("duplicate Relation matches lower recall and precision", () => {
  const predictions = predictionSet();
  predictions.runs[0].relations.push({ ...predictions.runs[0].relations[0] });
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.relationRecall.value, 0);
  assert.equal(report.metrics.relationPrecision.value, 0);
});

test("Brief requires six unique slot names and valid unique sources", () => {
  const predictions = predictionSet();
  predictions.runs[0].brief.slots = predictions.runs[0].brief.slots.map((slot) => ({
    ...slot,
    sourceKind: "claim",
    sourceId: "same-source",
  }));
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.briefStructurallyComplete, false);
  assert.ok(report.metrics.briefSourceValidity.value < 1);
  assert.equal(report.gates.checks.find((item) => item.name === "brief_sources").passed, false);
});

test("omitted View leakage adjudication does not default to zero", () => {
  const predictions = predictionSet();
  delete predictions.runs[0].viewLeakageCount;
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.viewLeakageCount, null);
  assert.equal(report.gates.checks.find((item) => item.name === "view_leakage").passed, false);
});

test("a weak later run cannot hide behind a strong primary run", () => {
  const predictions = predictionSet();
  predictions.runs[1].claims = predictions.runs[1].claims.filter((claim) => claim.matchedGroundTruthId !== "gt_budget");
  predictions.runs[1].relations = [];
  const report = evaluate(truth, predictions);
  assert.equal(report.metrics.materialClaimRecall.value, 1, "the legacy primary-run metric remains available");
  assert.equal(report.metrics.perRun[0].materialClaimRecall.value, 1);
  assert.equal(report.metrics.perRun[1].materialClaimRecall.value, 0.5);
  assert.equal(report.metrics.worstRun.materialClaimRecall, 0.5);
  assert.equal(report.metrics.worstRun.relationRecall, 0);
  assert.equal(report.gates.checks.find((item) => item.name === "material_recall").passed, false);
  assert.equal(report.gates.checks.find((item) => item.name === "relation_recall").passed, false);
});
