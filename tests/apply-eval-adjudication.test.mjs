import assert from "node:assert/strict";
import test from "node:test";

import { applyAdjudication } from "../scripts/apply-eval-adjudication.mjs";

const raw = {
  schemaVersion: "notique-eval-predictions.v1",
  runs: [{
    id: "run-1",
    claims: [{ id: "p1", matchedGroundTruthId: null, classification: "reaffirmed", targetVersionId: "production-v1", citationSupport: "unreviewed", unsupportedVisualClaim: null, evidence: [{ id: "ev1", semanticSupportVerdict: "unreviewed" }] }],
    relations: [{ id: "pr1", matchedGroundTruthRelationId: null, targetVersionId: "production-v1" }],
    brief: { slots: [{ slot: "current_status", useful: false }] },
  }],
};
const truth = {
  schemaVersion: "notique-ground-truth.v1",
  dataset: "unit",
  claims: [{ id: "gt1", eventId: "e2", material: true, expectedClassification: "reaffirmed", targetVersionId: "gt-v1" }],
  relations: [{ id: "gr1", type: "resolves", sourceClaimId: "gt1", targetClaimId: "old", targetVersionId: "gt-old" }],
};
const decisions = {
  schemaVersion: "notique-eval-adjudication.v1",
  groundTruthEventId: "e2",
  metadata: { reference: "unit-review", reviewedBy: ["reviewer"], completedAt: "2026-09-29T01:00:00Z" },
  runs: [{ id: "run-1", claimMatches: { p1: "gt1" }, claimReviews: { p1: { citationSupport: "fully_supports", evidenceSupport: { ev1: "fully_supports" } } }, relationMatches: { pr1: "gr1" }, viewLeakageCount: 0, usefulBriefSlots: ["current_status"] }],
};

test("adjudication preserves production targets while applying Ground Truth IDs", () => {
  const result = applyAdjudication(raw, decisions, truth);
  const claim = result.predictions.runs[0].claims[0];
  const relation = result.predictions.runs[0].relations[0];
  assert.equal(claim.matchedGroundTruthId, "gt1");
  assert.equal(claim.productionTargetVersionId, "production-v1");
  assert.equal(claim.targetVersionId, "gt-v1");
  assert.equal(claim.citationSupport, "fully_supports");
  assert.equal(claim.evidence[0].semanticSupportVerdict, "fully_supports");
  assert.equal(relation.matchedGroundTruthRelationId, "gr1");
  assert.equal(relation.productionTargetVersionId, "production-v1");
  assert.equal(relation.targetVersionId, "gt-old");
  assert.equal(relation.sourceGroundTruthClaimId, "gt1");
  assert.equal(relation.targetGroundTruthClaimId, "old");
  assert.equal(result.predictions.runs[0].brief.slots[0].useful, true);
  assert.equal(result.groundTruth.claims.length, 1);
  assert.equal(result.groundTruth.relations.length, 1);
  assert.equal(result.predictions.metadata.adjudication.reference, "unit-review");
  assert.equal(result.predictions.runs[0].adjudication.claimReviewsComplete, true);
});

test("unreviewed citation and visual judgments stay unreviewed when no explicit review is supplied", () => {
  const incomplete = structuredClone(decisions);
  delete incomplete.runs[0].claimReviews;
  const run = applyAdjudication(raw, incomplete, truth).predictions.runs[0];
  assert.equal(run.claims[0].citationSupport, "unreviewed");
  assert.equal(run.claims[0].evidence[0].semanticSupportVerdict, "unreviewed");
  assert.equal(run.claims[0].unsupportedVisualClaim, null);
  assert.equal(run.adjudication.claimReviewsComplete, false);
});

test("different Claims and Evidence retain their own support verdicts", () => {
  const mixedRaw = structuredClone(raw);
  mixedRaw.runs[0].claims.push({ id: "p2", evidence: [{ id: "ev2", semanticSupportVerdict: "unreviewed" }], citationSupport: "unreviewed" });
  const mixed = structuredClone(decisions);
  mixed.runs[0].claimMatches.p2 = null;
  mixed.runs[0].claimReviews.p2 = { citationSupport: "does_not_support", evidenceSupport: { ev2: "partially_supports" } };
  const run = applyAdjudication(mixedRaw, mixed, truth).predictions.runs[0];
  assert.equal(run.claims[0].citationSupport, "fully_supports");
  assert.equal(run.claims[1].citationSupport, "does_not_support");
  assert.equal(run.claims[1].evidence[0].semanticSupportVerdict, "partially_supports");
  assert.equal(run.adjudication.claimMatchesComplete, true);
  assert.equal(run.adjudication.claimReviewsComplete, true);
});

test("claim review rejects unknown evidence and invalid support labels", () => {
  const unknown = structuredClone(decisions);
  unknown.runs[0].claimReviews.p1.evidenceSupport.missing = "fully_supports";
  assert.throws(() => applyAdjudication(raw, unknown, truth), /Unknown Evidence missing/);
  const invalid = structuredClone(decisions);
  invalid.runs[0].claimReviews.p1.citationSupport = "looks-good";
  assert.throws(() => applyAdjudication(raw, invalid, truth), /Invalid support verdict/);
});

test("adjudication prevents mapping a Claim to another Event", () => {
  const wrongEvent = structuredClone(truth);
  wrongEvent.claims[0].eventId = "other-event";
  assert.throws(() => applyAdjudication(raw, decisions, wrongEvent), /different Ground Truth Event/);
});

test("adjudication rejects unknown prediction IDs", () => {
  const invalid = structuredClone(decisions);
  invalid.runs[0].claimMatches.missing = "gt1";
  assert.throws(() => applyAdjudication(raw, invalid, truth), /Unknown Claim missing/);
});
