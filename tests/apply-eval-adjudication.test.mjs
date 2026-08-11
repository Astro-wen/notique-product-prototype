import assert from "node:assert/strict";
import test from "node:test";

import { applyAdjudication } from "../scripts/apply-eval-adjudication.mjs";

const raw = {
  schemaVersion: "notique-eval-predictions.v1",
  runs: [{
    id: "run-1",
    claims: [{ id: "p1", matchedGroundTruthId: null, classification: "reaffirmed", targetVersionId: "production-v1", citationSupport: "unreviewed", unsupportedVisualClaim: null, evidence: [{ semanticSupportVerdict: "unreviewed" }] }],
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
  runs: [{ id: "run-1", claimMatches: { p1: "gt1" }, relationMatches: { pr1: "gr1" }, viewLeakageCount: 0, usefulBriefSlots: ["current_status"] }],
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
});

test("adjudication rejects unknown prediction IDs", () => {
  const invalid = structuredClone(decisions);
  invalid.runs[0].claimMatches.missing = "gt1";
  assert.throws(() => applyAdjudication(raw, invalid, truth), /Unknown Claim missing/);
});
