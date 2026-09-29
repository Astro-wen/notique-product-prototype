import assert from "node:assert/strict";
import test from "node:test";

import { evaluate } from "../scripts/eval-runner.mjs";

const syntheticTruth = {
  schemaVersion: "notique-ground-truth.v1",
  dataset: "cost-regression-synthetic",
  split: "development-synthetic",
  claims: [],
  relations: [],
};

function report(costs) {
  return evaluate(syntheticTruth, {
    schemaVersion: "notique-eval-predictions.v1",
    runs: costs.map((cost, index) => ({
      id: `run-${index + 1}`,
      claims: [],
      relations: [],
      usage: cost === undefined ? {} : { costUsd: cost },
    })),
  });
}

test("the report sums complete estimated costs and preserves an explicit zero", () => {
  const result = report([0.01, 0, 0.02]);
  assert.equal(result.metrics.perRun[1].usage.costUsd, 0);
  assert.equal(result.metrics.usage.costUsd, 0.03);
  assert.equal(result.metrics.usage.costUsdBasis, "estimated");
  assert.equal(result.metrics.usage.costUsdComplete, true);
  assert.equal(result.gates.pass, false, "a synthetic cost fixture is not a formal quality result");
});

test("unknown or invalid run costs make the total unknown, not zero", () => {
  for (const costs of [[0.01, null, 0.02], [0.01, undefined, 0.02], [0.01, -1, 0.02], [0.01, Infinity, 0.02]]) {
    const result = report(costs);
    assert.equal(result.metrics.perRun[1].usage.costUsd, null);
    assert.equal(result.metrics.perRun[1].usage.costUsdBasis, "estimated");
    assert.equal(result.metrics.usage.costUsd, null);
    assert.equal(result.metrics.usage.costUsdComplete, false);
  }
});

test("zero is a known total only when every run explicitly records zero", () => {
  const result = report([0, 0, 0]);
  assert.equal(result.metrics.usage.costUsd, 0);
  assert.equal(result.metrics.usage.costUsdComplete, true);
});
