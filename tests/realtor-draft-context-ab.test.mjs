import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REALTOR_AB_ADJUDICATION_SCHEMA_VERSION,
  REALTOR_AB_ARM_SCHEMA_VERSION,
  buildAdjudicationTemplate,
  buildScoredComparison,
  validateArmSnapshot,
  validateComparableArms,
} from "../scripts/lib/realtor-draft-context-ab.mjs";
import {
  localServerConfiguration,
  parseArgs as parseRunArgs,
  realtorAbFixtureImportOptions,
} from "../scripts/run-realtor-draft-context-ab.mjs";
import { parseArgs as parseScoreArgs } from "../scripts/score-realtor-draft-context-ab.mjs";

const truth = {
  schemaVersion: "notique-ground-truth.v1",
  claims: [
    { id: "g1", eventId: "event-1", type: "next_action", statement: "Follow up.", material: true, critical: true, expectedClassification: "new", timestampMs: 1_000, acceptableEvidenceIds: ["tx:1"] },
    { id: "g2", eventId: "event-2", type: "requirement", statement: "Still required.", material: true, critical: true, expectedClassification: "reaffirmed", targetVersionId: "gtv-1", timestampMs: 2_000, acceptableEvidenceIds: ["tx:2"] },
    { id: "g3", eventId: "event-3", type: "preference", statement: "Preference.", material: true, critical: true, expectedClassification: "new", timestampMs: 3_000, acceptableEvidenceIds: ["tx:3"] },
    { id: "g4", eventId: "event-4", type: "decision", statement: "Decision.", material: true, critical: true, expectedClassification: "new", timestampMs: 4_000, acceptableEvidenceIds: ["tx:4"] },
  ],
  relations: [
    { id: "gr1", type: "informed_by", sourceClaimId: "g2", targetClaimId: "g1", targetVersionId: "gtv-1" },
  ],
};

const actionTruth = {
  schemaVersion: "notique-realtor-action-ground-truth.v1",
  actions: [{ id: "a1", eventId: "event-1", statement: "Follow up.", owner: "Priya", dueAt: null }],
};

function prediction(index, arm) {
  const id = `${arm}-p${index}`;
  return {
    id,
    productionClaimId: `${arm}-prod${index}`,
    type: index === 1 ? "next_action" : index === 2 ? "requirement" : index === 3 ? "preference" : "decision",
    statement: `Prediction ${index}`,
    classification: index === 2 ? "reaffirmed" : "new",
    targetVersionId: index === 2 ? `${arm}-prod-version-1` : null,
    evidence: [{
      id: `${arm}-e${index}`,
      kind: "transcript",
      idValid: true,
      quoteExact: true,
      startMs: index * 1_000,
      endMs: index * 1_000 + 100,
    }],
  };
}

function arm(name, tokenScale = 1) {
  const enabled = name === "treatment";
  const predictions = [1, 2, 3, 4].map((index) => prediction(index, name));
  const runs = predictions.map((claim, index) => ({
    runId: `${name}-run-${index + 1}`,
    eventId: `${name}-event-${index + 1}`,
    eventKey: `event-${index + 1}`,
    prediction: {
      claims: [claim],
      relations: index === 1 ? [{
        id: `${name}-relation-1`,
        type: "informed_by",
        sourcePredictionId: claim.id,
        targetProductionClaimId: predictions[0].productionClaimId,
        reason: "continuity",
      }] : [],
      usage: { inputTokens: 100 * tokenScale, outputTokens: 20 * tokenScale, cachedTokens: 0, costUsd: 0, latencyMs: 1_000 * tokenScale },
      frozen: {
        provider: "openai",
        model: "gpt-test",
        promptVersion: "claim-extraction-prompt.v9",
        schemaVersion: "claim-extraction.v3",
        parserVersion: "parser-v1",
        inputManifest: [{ asset_version_id: `${name}-asset-${index + 1}`, kind: "transcript", sha256: `sha-${index + 1}`, size_bytes: 100 }],
        modelParameters: {
          two_pass_pipeline: true,
          reasoning_effort: "xhigh",
          verifier_reasoning_effort: "high",
          reserved_input_tokens: enabled ? 1_200 : 1_000,
          draft_context: enabled,
          draft_context_manifest: enabled && index > 0 ? [`${name}-p1`] : [],
        },
      },
    },
    stages: [
      { stage: "inventory", attempt: 1, status: "succeeded", reasoning_effort: "xhigh", prompt_version: "claim-extraction-prompt.v9:inventory", schema_version: "claim-inventory.v3", input_tokens: 60, output_tokens: 10, duration_ms: 500 },
      { stage: "verify", attempt: 1, status: "succeeded", reasoning_effort: "high", prompt_version: "claim-extraction-prompt.v9:verify", schema_version: "claim-verification.v4", input_tokens: 40, output_tokens: 10, duration_ms: 500 },
    ],
    artifactRuns: [
      { kind: "summary", status: "succeeded", reasoning_effort: "high", prompt_version: "event-summary-prompt.v1", schema_version: "event-summary.v1" },
      { kind: "readable_transcript", status: "succeeded", reasoning_effort: "high", prompt_version: "readable-transcript-prompt.v1", schema_version: "readable-transcript.v1" },
    ],
  }));
  return {
    schemaVersion: REALTOR_AB_ARM_SCHEMA_VERSION,
    arm: name,
    draftContextEnabled: enabled,
    fixtureId: "synthetic-realtor-v1",
    fixtureSha256: "fixture",
    groundTruthSha256: "truth",
    actionGroundTruthSha256: "action-truth",
    commitSha: "abc123",
    contextSchema: "context-pack.v3",
    runs,
    draftMemory: { claims: [], links: [] },
  };
}

function completeAdjudication(snapshot) {
  const template = buildAdjudicationTemplate(snapshot, truth, actionTruth);
  assert.equal(template.schemaVersion, REALTOR_AB_ADJUDICATION_SCHEMA_VERSION);
  for (const [index, run] of template.runs.entries()) {
    const [claim] = Object.values(run.claims);
    claim.matchedGroundTruthId = `g${index + 1}`;
    claim.citationSupport = "fully_supports";
    if (index === 1) claim.reaffirmedTargetCorrect = true;
    if (index === 0) {
      claim.matchedActionExpectationId = "a1";
      claim.actionOwnerCorrect = true;
      claim.actionDueCorrect = true;
      claim.actionSourceCorrect = true;
    }
  }
  const relation = Object.values(template.relations)[0];
  relation.matchedGroundTruthRelationId = "gr1";
  template.formalStateChangeErrorCount = 0;
  template.reviewer = "Fixture reviewer";
  template.reviewedAt = "2026-08-15T12:00:00.000Z";
  return template;
}

test("A/B arms freeze the same inputs and only vary Draft Context", () => {
  const control = arm("control");
  const treatment = arm("treatment", 1.2);
  assert.equal(validateArmSnapshot(control), control);
  assert.deepEqual(validateComparableArms(control, treatment), { comparable: true, eventCount: 4 });
  treatment.runs[0].prediction.frozen.inputManifest[0].sha256 = "different";
  assert.throws(() => validateComparableArms(control, treatment), /different source material/);
});

test("adjudication templates are deliberately unscored until a human completes every decision", () => {
  const control = arm("control");
  const treatment = arm("treatment", 1.2);
  const draft = buildAdjudicationTemplate(control, truth, actionTruth);
  assert.equal(draft.runs[0].claims["control-p1"].matchedGroundTruthId, null);
  assert.equal(draft.runs[0].claims["control-p1"].citationSupport, "unreviewed");
  assert.throws(
    () => buildScoredComparison({
      control,
      treatment,
      controlAdjudication: draft,
      treatmentAdjudication: buildAdjudicationTemplate(treatment, truth, actionTruth),
      groundTruth: truth,
      actionGroundTruth: actionTruth,
    }),
    /reviewer name/,
  );
});

test("completed A/B adjudication calculates hard gates and the 25 percent token ceiling", () => {
  const control = arm("control");
  const treatment = arm("treatment", 1.2);
  const report = buildScoredComparison({
    control,
    treatment,
    controlAdjudication: completeAdjudication(control),
    treatmentAdjudication: completeAdjudication(treatment),
    groundTruth: truth,
    actionGroundTruth: actionTruth,
  });
  assert.equal(report.control.gates.pass, true);
  assert.equal(report.treatment.gates.pass, true);
  assert.equal(report.comparison.tokenIncrease, 0.2);
  assert.equal(report.enableDraftContext, true);
  assert.equal(report.treatment.metrics.actionOwnerAccuracy.value, 1);
  assert.equal(report.treatment.metrics.actionDueAccuracy.value, 1);
  assert.equal(report.treatment.metrics.actionSourceAccuracy.value, 1);
  assert.equal(report.treatment.metrics.actionFieldAccuracy.value, 1);
});

test("CLIs require an explicit paid-call flag and resolve an offline scoring directory", () => {
  const plan = parseRunArgs(["--output=outputs/example"], "invocation");
  assert.equal(plan.allowPaidModelCalls, false);
  assert.equal(plan.port, 3187);
  assert.match(plan.outputPath, /outputs\/example$/);
  assert.throws(() => parseRunArgs(["--port=80"]), /1024/);
  const score = parseScoreArgs(["--run-dir=outputs/example"]);
  assert.match(score.outputPath, /outputs\/example\/score\.json$/);
});

test("A/B uses one explicit IPv4 loopback endpoint and the fixed buyer-project profile", () => {
  const server = localServerConfiguration(3187);
  assert.equal(server.baseUrl, "http://127.0.0.1:3187");
  assert.deepEqual(server.commandArgs.slice(-5), [
    "dev",
    "--port",
    "3187",
    "--hostname",
    "127.0.0.1",
  ]);

  const fixtureOptions = realtorAbFixtureImportOptions({
    manifestPath: "/fixture/manifest.json",
    baseUrl: server.baseUrl,
  });
  assert.deepEqual(fixtureOptions, {
    manifestPath: "/fixture/manifest.json",
    baseUrl: server.baseUrl,
    projectProfile: "real_estate_buyer_journey",
  });
});

test("A/B reports that the buyer Scenario is fixed at project creation", async () => {
  const source = await readFile(
    new URL("../scripts/run-realtor-draft-context-ab.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /created with the fixed real-estate buyer journey Scenario/);
  assert.doesNotMatch(source, /Scenario was explicitly accepted only to unblock/);
});

test("paid A/B refuses tracked and untracked source drift", async () => {
  const source = await readFile(
    new URL("../scripts/run-realtor-draft-context-ab.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /gitValue\(\["status", "--porcelain", "--untracked-files=all"\]\)/);
  assert.doesNotMatch(source, /--untracked-files=no/);
  assert.match(source, /requires a completely clean worktree/);
});
