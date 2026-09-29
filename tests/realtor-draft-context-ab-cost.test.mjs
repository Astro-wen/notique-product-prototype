import assert from "node:assert/strict";
import test from "node:test";

import {
  REALTOR_AB_ARM_SCHEMA_VERSION,
  REALTOR_AB_CONTRACT,
  summarizeArm,
} from "../scripts/lib/realtor-draft-context-ab.mjs";

function stage(stageName) {
  const inventory = stageName === "inventory";
  return {
    stage: stageName,
    attempt: 1,
    status: "succeeded",
    prompt_version: inventory ? REALTOR_AB_CONTRACT.inventoryPrompt : REALTOR_AB_CONTRACT.verifyPrompt,
    schema_version: inventory ? REALTOR_AB_CONTRACT.inventorySchema : REALTOR_AB_CONTRACT.verifySchema,
    reasoning_effort: inventory ? REALTOR_AB_CONTRACT.inventoryEffort : REALTOR_AB_CONTRACT.verifyEffort,
  };
}

function artifact(kind, costUsd) {
  const summary = kind === "summary";
  return {
    kind,
    status: "succeeded",
    prompt_version: summary ? REALTOR_AB_CONTRACT.summaryPrompt : REALTOR_AB_CONTRACT.readablePrompt,
    schema_version: summary ? REALTOR_AB_CONTRACT.summarySchema : REALTOR_AB_CONTRACT.readableSchema,
    reasoning_effort: REALTOR_AB_CONTRACT.artifactEffort,
    ...(costUsd === undefined ? {} : { estimated_cost_usd: costUsd }),
  };
}

function arm({ factCosts = [0, 0, 0, 0], artifactCosts = Array(8).fill(0) } = {}) {
  return {
    schemaVersion: REALTOR_AB_ARM_SCHEMA_VERSION,
    arm: "control",
    draftContextEnabled: false,
    fixtureId: REALTOR_AB_CONTRACT.fixtureId,
    contextSchema: REALTOR_AB_CONTRACT.contextSchema,
    runs: Array.from({ length: 4 }, (_, index) => ({
      runId: `run-${index + 1}`,
      eventKey: `event-${index + 1}`,
      prediction: {
        claims: [],
        relations: [],
        usage: factCosts[index] === undefined ? {} : { costUsd: factCosts[index] },
        frozen: {
          promptVersion: REALTOR_AB_CONTRACT.runPrompt,
          schemaVersion: REALTOR_AB_CONTRACT.runSchema,
          modelParameters: { two_pass_pipeline: true, draft_context: false },
        },
      },
      stages: [stage("inventory"), stage("verify")],
      artifactRuns: [
        artifact("summary", artifactCosts[index * 2]),
        artifact("readable_transcript", artifactCosts[index * 2 + 1]),
      ],
    })),
  };
}

test("A/B reports complete costs as estimates and preserves explicit zero", () => {
  const zero = summarizeArm(arm());
  assert.equal(zero.factUsage.costUsd, 0);
  assert.equal(zero.artifactUsage.costUsd, 0);
  assert.equal(zero.usage.costUsd, 0);
  assert.equal(zero.usage.costUsdBasis, "estimated");
  assert.equal(zero.usage.costUsdComplete, true);

  const mixed = summarizeArm(arm({
    factCosts: [0.25, 0, 0, 0],
    artifactCosts: [0.5, 0, 0, 0, 0, 0, 0, 0],
  }));
  assert.equal(mixed.factUsage.costUsd, 0.25);
  assert.equal(mixed.artifactUsage.costUsd, 0.5);
  assert.equal(mixed.usage.costUsd, 0.75);
});

test("a missing or invalid fact-stage estimate makes the total unknown", () => {
  for (const missing of [null, undefined, -1, Infinity]) {
    const factCosts = [0, missing, 0, 0];
    const result = summarizeArm(arm({ factCosts }));
    assert.equal(result.factUsage.costUsd, null);
    assert.equal(result.factUsage.costUsdComplete, false);
    assert.equal(result.artifactUsage.costUsd, 0);
    assert.equal(result.usage.costUsd, null);
    assert.equal(result.usage.costUsdComplete, false);
  }
});

test("a missing artifact estimate makes the total unknown even when facts are priced", () => {
  const artifactCosts = [0, undefined, 0, 0, 0, 0, 0, 0];
  const result = summarizeArm(arm({ artifactCosts }));
  assert.equal(result.factUsage.costUsd, 0);
  assert.equal(result.artifactUsage.costUsd, null);
  assert.equal(result.artifactUsage.costUsdComplete, false);
  assert.equal(result.usage.costUsd, null);
  assert.equal(result.usage.costUsdComplete, false);
});
