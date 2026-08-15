import assert from "node:assert/strict";
import test from "node:test";

import {
  INVENTORY_SCHEMA_VERSION,
  TWO_STAGE_EXTRACTION_LIMITS,
  VERIFICATION_SCHEMA_VERSION,
  assessVerificationEscalation,
  selectPreferredVerificationForReview,
  toFinalExtractClaimsOutput,
  validateInventoryOutput,
  validateVerificationOutput,
} from "../lib/domain/two-stage-extraction.ts";

function evidence() {
  return [{
    kind: "transcript",
    asset_version_id: "av-1",
    segment_ids: ["seg-1"],
    quote_hint: "The budget cap is one million dollars.",
    evidence_role: "direct",
  }];
}

function candidate(overrides = {}) {
  return {
    inventory_key: "inv-1",
    type: "budget",
    statement: "The budget cap is $1M.",
    normalized_value: { amount: 1_000_000, currency: "USD" },
    materiality: "high",
    critical: true,
    critical_reason: "The budget constrains every recommendation.",
    confidence: 0.98,
    atomicity: "atomic",
    evidence: evidence(),
    ...overrides,
  };
}

function inventory(candidates = [candidate()]) {
  return { schema_version: INVENTORY_SCHEMA_VERSION, event_id: "event-1", candidates };
}

function finalClaim(overrides = {}) {
  return {
    client_claim_key: "claim-1",
    disposition: "new",
    reaffirmed_target_claim_id: null,
    reaffirmed_target_version_id: null,
    type: "budget",
    statement: "The budget cap is $1M.",
    normalized_value: { amount: 1_000_000, currency: "USD" },
    materiality: "high",
    confidence: 0.98,
    needs_additional_evidence: false,
    uncertainty: null,
    evidence: evidence(),
    relations: [],
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    schema_version: VERIFICATION_SCHEMA_VERSION,
    event_id: "event-1",
    scenario_assessment: null,
    claims: [finalClaim()],
    candidate_dispositions: [{
      inventory_key: "inv-1",
      outcome: "included",
      final_claim_keys: ["claim-1"],
      reason: "Retained as a material atomic fact.",
    }],
    draft_link_candidates: [],
    quality_review: {
      unresolved_conflict_keys: [],
      compound_claim_keys: [],
      reaffirmed_issue_claim_keys: [],
    },
    ...overrides,
  };
}

function context(scenario, draftClaims = []) {
  return {
    schema_version: "context-pack.v3",
    project: { id: "project-1", scenario, locale: "en-US", context_version: 1 },
    verified_context: {
      glossary: [],
      active_claims: [],
      recent_history: [],
      open_questions: [],
      active_risks: [],
    },
    draft_context: { enabled: draftClaims.length > 0, claims: draftClaims },
    new_event: {
      event_id: "event-1",
      transcript_segments: [],
      readable_transcript_segments: [],
      photos: [],
      documents: [],
    },
  };
}

test("validates a bounded atomic inventory with evidence", () => {
  const result = validateInventoryOutput(inventory());
  assert.equal(result.valid, true);
  assert.equal(result.output?.candidates.length, 1);
});

test("inventory rejects more than 24 candidates, non-atomic facts, missing evidence, and duplicate keys", () => {
  const overflow = Array.from({ length: TWO_STAGE_EXTRACTION_LIMITS.inventoryCandidates + 1 }, (_, index) =>
    candidate({ inventory_key: `inv-${index}` }));
  assert.equal(validateInventoryOutput(inventory(overflow)).valid, false);

  const malformed = inventory([
    candidate({ atomicity: "compound", evidence: [] }),
    candidate({ critical: false, critical_reason: null }),
  ]);
  const result = validateInventoryOutput(malformed);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".atomicity")));
  assert.ok(result.issues.some((issue) => issue.path.endsWith(".evidence")));
  assert.ok(result.issues.some((issue) => issue.message === "Duplicate inventory key."));
});

test("verifier accepts complete included and merged disposition mapping", () => {
  const source = inventory([
    candidate(),
    candidate({ inventory_key: "inv-2", critical: false, critical_reason: null }),
  ]);
  const result = validateVerificationOutput(verification({
    candidate_dispositions: [
      { inventory_key: "inv-1", outcome: "included", final_claim_keys: ["claim-1"], reason: "Primary wording." },
      { inventory_key: "inv-2", outcome: "merged", final_claim_keys: ["claim-1"], reason: "Same atomic fact." },
    ],
  }), source);
  assert.equal(result.valid, true);
});

test("unassessed context requires two or three scenario candidates", () => {
  const source = inventory();
  const missing = validateVerificationOutput(verification(), source, context(null));
  assert.equal(missing.valid, false);
  assert.ok(missing.issues.some((issue) => issue.path === "$.scenario_assessment"));

  for (const count of [2, 3]) {
    const scenario_assessment = {
      candidates: Array.from({ length: count }, (_, index) => ({
        scenario: `Scenario ${index + 1}`,
        confidence: 0.8 - index * 0.1,
        reason: `Evidence-backed option ${index + 1}.`,
      })),
    };
    assert.equal(
      validateVerificationOutput(verification({ scenario_assessment }), source, context(null)).valid,
      true,
    );
  }
});

test("confirmed context requires null scenario assessment", () => {
  const proposed = verification({
    scenario_assessment: {
      candidates: [
        { scenario: "One", confidence: 0.8, reason: "First option." },
        { scenario: "Two", confidence: 0.7, reason: "Second option." },
      ],
    },
  });
  const result = validateVerificationOutput(proposed, inventory(), context("confirmed-scenario"));
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("must not be reassessed")));
  assert.equal(validateVerificationOutput(verification(), inventory(), context("confirmed-scenario")).valid, true);
});

test("final extraction helper removes verifier bookkeeping and preserves schema v3", () => {
  const verified = verification();
  assert.deepEqual(toFinalExtractClaimsOutput(verified), {
    schema_version: "claim-extraction.v3",
    event_id: "event-1",
    scenario_assessment: null,
    claims: verified.claims,
  });
});

test("draft links are bounded hints and can never become formal relation targets", () => {
  const draft = {
    claimId: "draft-old",
    claimVersionId: "draft-old-v1",
    eventId: "event-old",
    eventSequenceNo: 1,
    type: "preference",
    statement: "The buyer prefers a quiet street.",
    confidence: 0.82,
    evidenceRefIds: ["evidence-old"],
  };
  const linked = verification({
    draft_link_candidates: [{
      final_claim_key: "claim-1",
      target_draft_claim_id: draft.claimId,
      target_draft_claim_version_id: draft.claimVersionId,
      type: "changed",
      reason: "The new preference may replace the earlier unreviewed preference.",
      confidence: 0.91,
    }],
  });
  const validated = validateVerificationOutput(
    linked,
    inventory(),
    context("real_estate_buyer_journey", [draft]),
  );
  assert.equal(validated.valid, true);
  assert.deepEqual(toFinalExtractClaimsOutput(linked).claims, linked.claims);
  assert.equal("draft_link_candidates" in toFinalExtractClaimsOutput(linked), false);

  const formalRelation = verification({
    claims: [finalClaim({
      relations: [{
        type: "supersedes",
        target_claim_id: draft.claimId,
        target_claim_version_id: draft.claimVersionId,
        reason: "A draft must not be a formal relation target.",
        confidence: 0.99,
      }],
    })],
  });
  assert.equal(
    validateVerificationOutput(
      formalRelation,
      inventory(),
      context("real_estate_buyer_journey", [draft]),
    ).valid,
    false,
  );
});

test("all five disposition outcomes are accepted with exact mapping rules", () => {
  const outcomes = ["included", "merged", "duplicate", "unsupported", "lower_priority"];
  const source = inventory(outcomes.map((outcome, index) => candidate({
    inventory_key: `inv-${index}`,
    critical: false,
    critical_reason: null,
  })));
  const result = validateVerificationOutput(verification({
    candidate_dispositions: outcomes.map((outcome, index) => ({
      inventory_key: `inv-${index}`,
      outcome,
      final_claim_keys: outcome === "included" || outcome === "merged" ? ["claim-1"] : [],
      reason: `Disposition ${outcome}.`,
    })),
  }), source);
  assert.equal(result.valid, true);
});

test("verifier rejects missing, duplicate, unknown, and invalid final mappings", () => {
  const source = inventory([
    candidate(),
    candidate({ inventory_key: "inv-2", critical: false, critical_reason: null }),
  ]);
  const result = validateVerificationOutput(verification({
    candidate_dispositions: [
      { inventory_key: "inv-1", outcome: "included", final_claim_keys: [], reason: "Missing final key." },
      { inventory_key: "inv-1", outcome: "lower_priority", final_claim_keys: ["missing"], reason: "Invalid mapping." },
      { inventory_key: "unknown", outcome: "unsupported", final_claim_keys: [], reason: "Unknown source." },
    ],
  }), source);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.message.includes("Missing disposition for inventory key inv-2")));
  assert.ok(result.issues.some((issue) => issue.message === "Duplicate inventory disposition."));
  assert.ok(result.issues.some((issue) => issue.message === "Unknown inventory key."));
  assert.ok(result.issues.some((issue) => issue.message === "Unknown final claim key."));
});

test("verifier reuses the existing claim contract and enforces the 10-claim bound", () => {
  const claims = Array.from({ length: TWO_STAGE_EXTRACTION_LIMITS.finalClaims + 1 }, (_, index) =>
    finalClaim({ client_claim_key: `claim-${index}` }));
  const result = validateVerificationOutput(verification({ claims }), inventory());
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.claims"));
});

test("clean verification does not escalate", () => {
  const result = assessVerificationEscalation(inventory(), verification());
  assert.deepEqual(result, {
    required: false,
    reasons: [],
    unmappedInventoryKeys: [],
    droppedCriticalInventoryKeys: [],
    lowConfidenceRelationClaimKeys: [],
  });
});

test("unmapped and dropped critical inventory candidates deterministically escalate", () => {
  const missing = verification({ candidate_dispositions: [] });
  const result = assessVerificationEscalation(inventory(), missing);
  assert.equal(result.required, true);
  assert.ok(result.reasons.includes("verification_contract_invalid"));
  assert.ok(result.reasons.includes("inventory_candidate_unmapped"));
  assert.ok(result.reasons.includes("critical_candidate_dropped"));
  assert.deepEqual(result.unmappedInventoryKeys, ["inv-1"]);
  assert.deepEqual(result.droppedCriticalInventoryKeys, ["inv-1"]);

  const explicitDrop = verification({
    candidate_dispositions: [{ inventory_key: "inv-1", outcome: "lower_priority", final_claim_keys: [], reason: "Dropped." }],
  });
  const dropped = assessVerificationEscalation(inventory(), explicitDrop);
  assert.equal(dropped.reasons.includes("critical_candidate_dropped"), true);
  assert.equal(dropped.reasons.includes("verification_contract_invalid"), false);
});

test("relation confidence below 0.85 escalates while 0.85 passes", () => {
  const low = verification({ claims: [finalClaim({ relations: [{
    type: "informed_by",
    target_claim_id: "old-claim",
    target_claim_version_id: "old-version",
    reason: "The earlier approved scope informed this budget.",
    confidence: 0.849,
  }] })] });
  const lowResult = assessVerificationEscalation(inventory(), low);
  assert.ok(lowResult.reasons.includes("low_confidence_relation"));
  assert.deepEqual(lowResult.lowConfidenceRelationClaimKeys, ["claim-1"]);

  low.claims[0].relations[0].confidence = 0.85;
  const threshold = assessVerificationEscalation(inventory(), low);
  assert.equal(threshold.reasons.includes("low_confidence_relation"), false);
});

test("unresolved conflicts, compound claims, and reaffirmed issues each escalate", () => {
  const result = assessVerificationEscalation(inventory(), verification({
    quality_review: {
      unresolved_conflict_keys: ["conflict-1"],
      compound_claim_keys: ["claim-1"],
      reaffirmed_issue_claim_keys: ["claim-1"],
    },
  }));
  assert.ok(result.reasons.includes("unresolved_conflict"));
  assert.ok(result.reasons.includes("compound_claim"));
  assert.ok(result.reasons.includes("reaffirmed_issue"));
});

test("quality flags are bounded and may only reference final claim keys", () => {
  const result = validateVerificationOutput(verification({
    quality_review: {
      unresolved_conflict_keys: Array.from({ length: TWO_STAGE_EXTRACTION_LIMITS.qualityFlags + 1 }, (_, index) => `conflict-${index}`),
      compound_claim_keys: ["not-a-final-claim"],
      reaffirmed_issue_claim_keys: [],
    },
  }), inventory());
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.quality_review.unresolved_conflict_keys"));
  assert.ok(result.issues.some((issue) => issue.message === "Unknown final claim key."));
});

test("a compound escalation cannot replace a more atomic base review queue", () => {
  const source = inventory([
    candidate(),
    candidate({ inventory_key: "inv-2" }),
  ]);
  const base = verification({
    candidate_dispositions: [
      { inventory_key: "inv-1", outcome: "included", final_claim_keys: ["claim-1"], reason: "Included." },
      { inventory_key: "inv-2", outcome: "lower_priority", final_claim_keys: [], reason: "Outside the cap." },
    ],
  });
  const compound = verification({
    candidate_dispositions: [
      { inventory_key: "inv-1", outcome: "merged", final_claim_keys: ["claim-1"], reason: "Merged." },
      { inventory_key: "inv-2", outcome: "merged", final_claim_keys: ["claim-1"], reason: "Merged." },
    ],
    quality_review: {
      unresolved_conflict_keys: [],
      compound_claim_keys: ["claim-1"],
      reaffirmed_issue_claim_keys: [],
    },
  });

  const selected = selectPreferredVerificationForReview(source, base, compound);
  assert.equal(selected.selected, "base");
  assert.equal(selected.output, base);
});

test("a clean escalation replaces a base output that drops a critical fact", () => {
  const source = inventory([
    candidate(),
    candidate({ inventory_key: "inv-2" }),
  ]);
  const base = verification({
    candidate_dispositions: [
      { inventory_key: "inv-1", outcome: "included", final_claim_keys: ["claim-1"], reason: "Included." },
      { inventory_key: "inv-2", outcome: "lower_priority", final_claim_keys: [], reason: "Outside the cap." },
    ],
  });
  const improved = verification({
    claims: [finalClaim(), finalClaim({ client_claim_key: "claim-2" })],
    candidate_dispositions: [
      { inventory_key: "inv-1", outcome: "included", final_claim_keys: ["claim-1"], reason: "Included." },
      { inventory_key: "inv-2", outcome: "included", final_claim_keys: ["claim-2"], reason: "Included." },
    ],
  });

  const selected = selectPreferredVerificationForReview(source, base, improved);
  assert.equal(selected.selected, "candidate");
  assert.equal(selected.output, improved);
  assert.equal(selected.assessment.required, false);
});
