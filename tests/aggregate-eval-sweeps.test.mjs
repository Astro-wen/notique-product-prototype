import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { aggregateSweeps } from "../scripts/aggregate-eval-sweeps.mjs";
import { evaluate } from "../scripts/eval-runner.mjs";
import { applyAdjudication } from "../scripts/apply-eval-adjudication.mjs";

function fixture() {
  const eventIds = Array.from({ length: 9 }, (_, i) => `event-${i}`);
  const materials = eventIds.flatMap((eventId, index) => Array.from({ length: index < 3 ? 4 : 3 }, (_, i) => ({ id: `${eventId}-material-${i}`, sha256: createHash("sha256").update(`${eventId}-material-${i}`).digest("hex") })));
  const truth = {
    schemaVersion: "notique-ground-truth.v1", dataset: "unit-aggregate-only", split: "blind",
    metadata: { synthetic: false, authorization: { approved: true, reference: "unit-authorization" }, evaluationMaterialCount: 30, blindSetFrozenAt: "2026-09-28T00:00:00Z" },
    claims: eventIds.flatMap((eventId, i) => Array.from({ length: 6 }, (_, j) => ({
      id: `${eventId}-truth-${j}`, eventId, scenarioId: `scenario-${Math.floor(i / 3)}`,
      material: true, critical: j < 2, modality: "transcript", type: "requirement",
      statement: `${eventId} fact ${j}`, normalizedValue: { value: j }, timestampMs: 1_000 + j * 1_000,
      expectedClassification: j === 5 ? "reaffirmed" : "new", targetVersionId: j === 5 ? `${eventId}-old-version` : null,
      ambiguity: j === 0 ? { severity: "critical" } : null,
      annotation: { doubleAnnotated: true, adjudication: { decision: "agreed" } },
    }))),
    relations: eventIds.map((eventId) => ({ id: `${eventId}-relation`, type: "informed_by", sourceClaimId: `${eventId}-truth-1`, targetClaimId: `${eventId}-truth-0` })),
  };
  const packages = Object.fromEntries(eventIds.map((eventId, i) => [eventId, {
    schemaVersion: "notique-eval-predictions.v1", metadata: { commitSha: "unit-commit", adjudication: { groundTruthEventId: eventId, reference: "unit-review", reviewedBy: ["reviewer"], completedAt: "2026-09-29T04:00:00Z" } },
    runs: Array.from({ length: 3 }, (_, sweep) => ({
      id: `${eventId}-run-${sweep}`, projectId: `project-${Math.floor(i / 3)}`, eventId: `production-${eventId}`,
      claims: truth.claims.filter((claim) => claim.eventId === eventId).map((claim) => ({
        id: claim.id.replace("truth", "prediction"), matchedGroundTruthId: claim.id,
        type: claim.type, normalizedValue: claim.normalizedValue, classification: claim.expectedClassification, targetVersionId: claim.targetVersionId,
        citationSupport: "fully_supports", ambiguityDetected: true, ambiguityAlternatives: ["A", "B"], ambiguityQuestion: "Which?", assertedDefinitively: false,
        evidence: [{ id: `${claim.id}-evidence`, kind: "transcript", startMs: claim.timestampMs, endMs: claim.timestampMs + 500, idValid: true, quoteExact: true, semanticSupportVerdict: "fully_supports" }],
      })),
      relations: [{ id: "same-id-across-events", matchedGroundTruthRelationId: `${eventId}-relation`, type: "informed_by", sourceGroundTruthClaimId: `${eventId}-truth-1`, targetGroundTruthClaimId: `${eventId}-truth-0` }],
      brief: { slots: [["current_status", "claim"], ["change_1", "timeline_delta"], ["change_2", "timeline_delta"], ["question_1", "agenda_item"], ["question_2", "agenda_item"], ["risk", "claim"]].map(([slot, sourceKind]) => ({ slot, sourceKind, sourceId: `${eventId}-${slot}`, sourceValid: true, useful: true })) },
      viewLeakageCount: 0,
      usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 1, latencyMs: 100, costUsd: 0.01 },
      adjudication: { claimMatchesComplete: true, relationMatchesComplete: true, claimReviewsComplete: true, viewReviewed: true, briefReviewed: true },
      frozen: { provider: "unit-provider", model: "unit-model", promptVersion: "unit-prompt", schemaVersion: "unit-schema", parserVersion: "unit-parser", modelParameters: { reasoning: "high" }, inputSnapshotHash: `${eventId}-input`, inputManifest: materials.filter((material) => material.id.startsWith(`${eventId}-`)), contextVersion: 1, contextSnapshotHash: `${eventId}-context`, startedAt: `2026-09-29T0${sweep + 1}:00:0${i}Z` },
    })),
  }]));
  const manifest = {
    schemaVersion: "notique-eval-sweep-manifest.v1", dataset: truth.dataset,
    materials,
    verification: { independentRunsVerified: true, reference: "unit-run-audit" },
    cases: eventIds.map((groundTruthEventId) => ({ groundTruthEventId, predictionsPath: `${groundTruthEventId}.json` })),
    sweeps: Array.from({ length: 3 }, (_, index) => ({ id: `sweep-${index}`, runIds: Object.fromEntries(eventIds.map((id) => [id, `${id}-run-${index}`])) })),
  };
  return { groundTruth: truth, manifest, packages };
}

test("three complete independent sweeps preserve every Event and are compatible with formal scoring", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  const output = aggregateSweeps(input);
  const report = evaluate(input.groundTruth, output);
  assert.equal(output.runs.length, 3);
  assert.equal(output.runs[0].claims.length, 54);
  assert.equal(new Set(output.runs[0].relations.map((item) => item.id)).size, 9);
  assert.equal(output.runs[0].aggregate.sourceRuns.length, 9);
  assert.equal(output.metadata.independentRunsVerified, true);
  assert.equal(report.sampleEligibility.independentRunsVerified, true);
  assert.equal(report.sampleEligibility.meetsTranscriptMinimum, true);
  assert.equal(report.gates.pass, true, "unit labels exercise the contract only, not model quality");
  assert.equal(report.metrics.usage.inputTokens, 270);
  assert.equal(JSON.stringify(input), before, "aggregation leaves exported and adjudicated inputs intact");
});

test("the actual adjudication output composes with sweep aggregation and scoring", () => {
  const input = fixture();
  for (const [eventId, exported] of Object.entries(input.packages)) {
    const decisions = {
      schemaVersion: "notique-eval-adjudication.v1", groundTruthEventId: eventId,
      metadata: { reference: "unit-explicit-review", reviewedBy: ["reviewer"], completedAt: "2026-09-29T04:00:00Z" },
      runs: exported.runs.map((run) => ({
        id: run.id,
        claimMatches: Object.fromEntries(run.claims.map((claim) => [claim.id, claim.matchedGroundTruthId])),
        claimReviews: Object.fromEntries(run.claims.map((claim) => [claim.id, { citationSupport: "fully_supports", evidenceSupport: Object.fromEntries(claim.evidence.map((evidence) => [evidence.id, "fully_supports"])) }])),
        relationMatches: Object.fromEntries(run.relations.map((relation) => [relation.id, relation.matchedGroundTruthRelationId])),
        viewLeakageCount: 0, usefulBriefSlots: run.brief.slots.map((slot) => slot.slot),
      })),
    };
    const raw = structuredClone(exported);
    delete raw.metadata.adjudication;
    for (const run of raw.runs) {
      delete run.adjudication;
      for (const claim of run.claims) { claim.matchedGroundTruthId = null; claim.citationSupport = "unreviewed"; }
    }
    input.packages[eventId] = applyAdjudication(raw, decisions, input.groundTruth).predictions;
  }
  const output = aggregateSweeps(input);
  assert.equal(output.metadata.independentRunsVerified, true);
  assert.equal(evaluate(input.groundTruth, output).gates.pass, true);
});

test("missing or additional Events and duplicate case ids are rejected", () => {
  const missing = fixture(); missing.manifest.cases.pop();
  assert.throws(() => aggregateSweeps(missing), /cover every Ground Truth Event/);
  const duplicate = fixture(); duplicate.manifest.cases.push(duplicate.manifest.cases[0]);
  assert.throws(() => aggregateSweeps(duplicate), /Duplicate or missing manifest Event/);
  const missingSweep = fixture(); delete missingSweep.manifest.sweeps[1].runIds["event-4"];
  assert.throws(() => aggregateSweeps(missingSweep), /Sweep sweep-1 must cover every Event/);
});

test("source Runs cannot be reused, duplicated, dropped or selected from another Event", () => {
  const reused = fixture(); reused.manifest.sweeps[1].runIds["event-0"] = "event-0-run-0";
  assert.throws(() => aggregateSweeps(reused), /reused across sweeps/);
  const duplicate = fixture(); duplicate.packages["event-1"].runs[0].id = "event-0-run-0";
  assert.throws(() => aggregateSweeps(duplicate), /Duplicate or missing source Run/);
  const dropped = fixture(); dropped.packages["event-0"].runs.pop();
  assert.throws(() => aggregateSweeps(dropped), /exactly one Run per sweep/);
  const crossed = fixture(); crossed.manifest.sweeps[0].runIds["event-0"] = "event-1-run-0";
  assert.throws(() => aggregateSweeps(crossed), /unknown Run/);
});

test("changed model settings, source commit, input or context invalidate comparison", () => {
  for (const key of ["model", "promptVersion", "schemaVersion", "parserVersion", "provider", "modelParameters"]) {
    const input = fixture(); input.packages["event-2"].runs[1].frozen[key] = "changed";
    assert.throws(() => aggregateSweeps(input), /same provider, model/);
  }
  for (const key of ["inputSnapshotHash", "contextSnapshotHash", "contextVersion", "inputManifest"]) {
    const input = fixture(); input.packages["event-2"].runs[1].frozen[key] = "changed";
    assert.throws(() => aggregateSweeps(input), /changed input, context/);
  }
  const commit = fixture(); commit.packages["event-2"].metadata.commitSha = "different";
  assert.throws(() => aggregateSweeps(commit), /Source commits differ/);
});

test("missing proof remains unknown and cannot qualify a formal report", () => {
  for (const modify of [
    (input) => { delete input.manifest.verification; },
    (input) => { delete input.packages["event-0"].metadata.adjudication.reference; },
    (input) => { input.packages["event-0"].runs[1].adjudication.claimReviewsComplete = false; },
    (input) => { input.packages["event-0"].runs[1].frozen.startedAt = input.packages["event-0"].runs[0].frozen.startedAt; },
    (input) => { input.packages["event-0"].runs.forEach((run) => { run.frozen.contextSnapshotHash = null; }); },
    (input) => { Object.values(input.packages).forEach((item) => { item.metadata.commitSha = "unknown"; }); },
    (input) => { delete input.manifest.materials; },
    (input) => { input.manifest.materials[0] = { ...input.manifest.materials[0], sha256: "a".repeat(64) }; },
    (input) => { input.manifest.materials.push(input.manifest.materials[0]); },
    (input) => { input.groundTruth.metadata.blindSetFrozenAt = "2026-09-30T00:00:00Z"; },
  ]) {
    const input = fixture(); modify(input);
    const output = aggregateSweeps(input);
    assert.equal(output.metadata.independentRunsVerified, null);
    assert.ok(output.metadata.qualification.issues.length > 0);
    assert.equal(evaluate(input.groundTruth, output).sampleEligibility.meetsTranscriptMinimum, false);
  }
});

test("unknown cost and token use remain unknown after aggregation", () => {
  const input = fixture();
  input.packages["event-2"].runs[2].usage.costUsd = null;
  delete input.packages["event-1"].runs[1].usage.inputTokens;
  const output = aggregateSweeps(input);
  const report = evaluate(input.groundTruth, output);
  assert.equal(output.runs[2].usage.costUsd, null);
  assert.equal(output.runs[1].usage.inputTokens, null);
  assert.equal(report.metrics.usage.costUsd, null);
  assert.equal(report.metrics.usage.inputTokens, null);
  assert.equal(output.runs[0].usage.latencyMs, 900);
});

test("weak Event Briefs and view leakage survive dataset aggregation", () => {
  const input = fixture();
  input.packages["event-2"].runs[0].brief.slots[0].useful = false;
  input.packages["event-2"].runs[0].brief.slots[1].useful = false;
  input.packages["event-3"].runs[1].brief.slots.pop();
  input.packages["event-4"].runs[2].viewLeakageCount = 1;
  const output = aggregateSweeps(input);
  const report = evaluate(input.groundTruth, output);
  assert.equal(output.runs[0].aggregate.briefEventId, "event-2");
  assert.equal(output.runs[1].aggregate.briefEventId, "event-3");
  assert.equal(output.runs[2].viewLeakageCount, 1);
  for (const name of ["brief_sources", "brief_useful", "view_leakage"]) assert.equal(report.gates.checks.find((gate) => gate.name === name).passed, false);
});

test("unmatched fingerprints are separate for different Events while remaining comparable across sweeps", () => {
  const input = fixture();
  for (const eventId of ["event-0", "event-1"]) {
    for (const run of input.packages[eventId].runs) run.claims.push({ id: "unmatched", matchedGroundTruthId: null, type: "risk", statement: "same words", normalizedValue: null, classification: "new", citationSupport: "fully_supports", evidence: [] });
  }
  const output = aggregateSweeps(input);
  const unmatched = output.runs[0].claims.filter((claim) => claim.matchedGroundTruthId == null);
  assert.equal(new Set(unmatched.map((claim) => claim.semanticKey)).size, 2);
  assert.equal(evaluate(input.groundTruth, output).metrics.consistency.value, 1);
});

test("cross-Event truth matches are rejected", () => {
  const input = fixture(); input.packages["event-0"].runs[0].claims[0].matchedGroundTruthId = "event-1-truth-0";
  assert.throws(() => aggregateSweeps(input), /matched to another Event/);
});

test("CLI reads relative Event paths offline and protects existing output", async () => {
  const input = fixture();
  const directory = await mkdtemp(join(tmpdir(), "notique-eval-sweep-"));
  try {
    await writeFile(join(directory, "truth.json"), JSON.stringify(input.groundTruth));
    await writeFile(join(directory, "manifest.json"), JSON.stringify(input.manifest));
    for (const [eventId, predictions] of Object.entries(input.packages)) await writeFile(join(directory, `${eventId}.json`), JSON.stringify(predictions));
    const args = ["scripts/aggregate-eval-sweeps.mjs", join(directory, "truth.json"), join(directory, "manifest.json"), join(directory, "output.json")];
    execFileSync(process.execPath, args, { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(JSON.parse(await readFile(join(directory, "output.json"), "utf8")).runs.length, 3);
    assert.throws(() => execFileSync(process.execPath, args, { cwd: new URL("..", import.meta.url), stdio: "pipe" }), /Command failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
