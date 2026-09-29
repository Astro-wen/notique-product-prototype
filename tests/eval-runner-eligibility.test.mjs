import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluate } from "../scripts/eval-runner.mjs";

const combinedPath = new URL("../eval/combined/synthetic-transcript-development-v1.ground-truth.json", import.meta.url);

function predictions() {
  return {
    schemaVersion: "notique-eval-predictions.v1",
    metadata: { independentRunsVerified: true },
    runs: Array.from({ length: 3 }, (_, index) => ({
      id: `independent-run-${index + 1}`,
      projectId: "fixed-project",
      eventId: "fixed-evaluation-case",
      claims: [],
      relations: [],
      frozen: {
        inputSnapshotHash: "fixed-input",
        inputManifest: [{ sha256: "fixed-material" }],
        contextVersion: 1,
        contextSnapshotHash: "fixed-context",
        provider: "test-provider",
        model: "fixed-model",
        promptVersion: "fixed-prompt",
        schemaVersion: "fixed-schema",
        parserVersion: "fixed-parser",
        modelParameters: { reasoning: "high" },
        startedAt: `2026-09-29T00:00:0${index}Z`,
      },
    })),
  };
}

async function structurallyEligibleTruth() {
  const truth = JSON.parse(await readFile(combinedPath, "utf8"));
  for (const claim of truth.claims) {
    if (claim.critical === true || truth.claims.indexOf(claim) < 24) {
      claim.annotation = { doubleAnnotated: true, adjudication: { decision: "agreed" } };
    }
  }
  return truth;
}

test("a structurally complete synthetic development set cannot pass formal sample eligibility", async () => {
  const truth = await structurallyEligibleTruth();
  const report = evaluate(truth, predictions());
  assert.equal(report.sampleEligibility.scenarioShapeValid, true);
  assert.equal(report.sampleEligibility.eventMaterialShapeValid, true);
  assert.equal(report.sampleEligibility.criticalClaimsAllAdjudicated, true);
  assert.equal(report.sampleEligibility.independentRunsVerified, true);
  assert.equal(report.sampleEligibility.sourceIsNonSynthetic, false);
  assert.equal(report.sampleEligibility.meetsTranscriptMinimum, false);
  assert.equal(report.gates.checks.find((gate) => gate.name === "sample_eligible").passed, false);
});

test("formal eligibility needs documented authorized blind provenance and adjudicated annotations", async () => {
  const truth = await structurallyEligibleTruth();
  truth.metadata.synthetic = false;
  truth.metadata.authorization = { approved: true, reference: "local-review-record" };
  truth.metadata.evaluationMaterialCount = 30;
  truth.metadata.blindSetFrozenAt = "2026-09-28T00:00:00Z";
  truth.split = "blind";
  const runs = predictions();
  const ready = evaluate(truth, runs);
  assert.equal(ready.sampleEligibility.meetsTranscriptMinimum, true);
  assert.equal(ready.gates.pass, false, "eligible sample does not imply accurate predictions");

  truth.metadata.evaluationMaterialCount = 29;
  assert.equal(evaluate(truth, runs).sampleEligibility.meetsTranscriptMinimum, false);
  truth.metadata.evaluationMaterialCount = 30;

  delete truth.claims.find((claim) => claim.critical).annotation.adjudication;
  assert.equal(evaluate(truth, runs).sampleEligibility.meetsTranscriptMinimum, false);
  truth.claims.find((claim) => claim.critical).annotation.adjudication = { decision: "agreed" };
  runs.runs[1].frozen.inputSnapshotHash = "changed-input";
  assert.equal(evaluate(truth, runs).sampleEligibility.independentRunsVerified, false);
  assert.equal(evaluate(truth, runs).sampleEligibility.meetsTranscriptMinimum, false);
});

test("unreported token and latency usage remain unknown", async () => {
  const truth = await structurallyEligibleTruth();
  const runs = predictions();
  runs.runs[0].usage = { inputTokens: 10, outputTokens: 2, cachedTokens: 1, latencyMs: 100, costUsd: 0 };
  runs.runs[1].usage = { inputTokens: 20, outputTokens: 4, cachedTokens: 2, latencyMs: 200, costUsd: 0 };
  const report = evaluate(truth, runs);
  assert.equal(report.metrics.perRun[2].usage.inputTokens, null);
  assert.equal(report.metrics.usage.inputTokens, null);
  assert.equal(report.metrics.usage.outputTokens, null);
  assert.equal(report.metrics.usage.cachedTokens, null);
  assert.equal(report.metrics.usage.latencyMs, null);
  assert.equal(report.metrics.usage.costUsd, null);
});
