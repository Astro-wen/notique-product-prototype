import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluate } from "../scripts/eval-runner.mjs";
import {
  buildCombinedGroundTruth,
  loadSourceDocuments,
  OUTPUT_RELATIVE_PATH,
  serializeCombinedGroundTruth,
  SOURCE_RELATIVE_PATHS,
} from "../scripts/merge-synthetic-transcript-ground-truth.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function oneRunPredictions() {
  return {
    schemaVersion: "notique-eval-predictions.v1",
    metadata: { purpose: "eligibility-guard-test" },
    runs: [{
      id: "single-development-run",
      claims: [],
      relations: [],
      viewLeakageCount: 0,
      brief: { slots: [] },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
    }],
  };
}

test("transcript development package is deterministic and matches the committed output", async () => {
  const sources = await loadSourceDocuments(repositoryRoot);
  const first = buildCombinedGroundTruth(sources);
  const second = buildCombinedGroundTruth(sources);
  assert.deepEqual(first, second);
  assert.deepEqual(SOURCE_RELATIVE_PATHS, [
    "eval/cases/synthetic-realtor-v1/ground-truth.json",
    "eval/cases/synthetic-insurance-v1/ground-truth.json",
  ]);
  assert.equal(first.metadata.sourceDatasets.some((source) => source.path.includes("synthetic-contractor")), false);
  assert.equal(first.metadata.structuralCounts.scenarioCount, 2);
  assert.equal(first.metadata.structuralCounts.eventCount, 8);
  assert.ok(first.metadata.structuralCounts.materialClaimCount >= 40);
  assert.ok(first.metadata.structuralCounts.criticalAmbiguityCount >= 8);
  assert.ok(first.metadata.structuralCounts.relationCount >= 8);
  assert.ok(Object.values(first.metadata.structuralCounts.eventMaterialClaimCounts).every((count) => count >= 5 && count <= 10));
  const committed = await readFile(path.resolve(repositoryRoot, OUTPUT_RELATIVE_PATH), "utf8");
  assert.equal(committed, serializeCombinedGroundTruth(first));
});

test("merge rejects global Claim, Relation, Scenario, and Event identity conflicts", async (t) => {
  const sourceDocuments = await loadSourceDocuments(repositoryRoot);

  await t.test("Claim ID", () => {
    const sources = structuredClone(sourceDocuments);
    sources[1].document.claims[0].id = sources[0].document.claims[0].id;
    assert.throws(() => buildCombinedGroundTruth(sources), /Global claim ID/);
  });

  await t.test("Relation ID", () => {
    const sources = structuredClone(sourceDocuments);
    sources[1].document.relations[0].id = sources[0].document.relations[0].id;
    assert.throws(() => buildCombinedGroundTruth(sources), /Global relation ID/);
  });

  await t.test("Scenario ID", () => {
    const sources = structuredClone(sourceDocuments);
    const collision = sources[0].document.claims[0].scenarioId;
    sources[1].document.claims.forEach((claim) => { claim.scenarioId = collision; });
    assert.throws(() => buildCombinedGroundTruth(sources), /Global scenario ID/);
  });

  await t.test("Event ID", () => {
    const sources = structuredClone(sourceDocuments);
    const oldEventId = sources[1].document.claims[0].eventId;
    const collision = sources[0].document.claims[0].eventId;
    sources[1].document.claims.forEach((claim) => {
      if (claim.eventId === oldEventId) claim.eventId = collision;
    });
    assert.throws(() => buildCombinedGroundTruth(sources), /Global event ID/);
  });
});

test("structural thresholds pass while formal sample eligibility stays false", async () => {
  const combined = buildCombinedGroundTruth(await loadSourceDocuments(repositoryRoot));
  const report = evaluate(combined, oneRunPredictions());
  assert.equal(report.sampleEligibility.scenarioShapeValid, true);
  assert.equal(report.sampleEligibility.eventMaterialShapeValid, true);
  assert.ok(report.sampleEligibility.materialClaimCount >= 40);
  assert.ok(report.sampleEligibility.criticalAmbiguityCount >= 8);
  assert.ok(report.sampleEligibility.relationCount >= 8);
  assert.equal(report.sampleEligibility.doubleAnnotatedCount, 0);
  assert.equal(report.sampleEligibility.criticalClaimsAllDoubleAnnotated, false);
  assert.equal(report.sampleEligibility.hasThreeIndependentRuns, false);
  assert.equal(report.sampleEligibility.meetsTranscriptMinimum, false);
  assert.equal(report.gates.checks.find((item) => item.name === "sample_eligible").passed, false);
  assert.equal(report.gates.pass, false);
});
