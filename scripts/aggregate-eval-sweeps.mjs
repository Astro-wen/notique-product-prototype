#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { evaluate } from "./eval-runner.mjs";

const FORMAT = "notique-eval-sweep-manifest.v1";
const SUPPORT = new Set(["fully_supports", "partially_supports", "does_not_support"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value) {
  return text(value) && Number.isFinite(Date.parse(value));
}

function sumMeasured(values) {
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total : null;
}

function configuration(run) {
  return {
    provider: run.frozen?.provider ?? null,
    model: run.frozen?.model ?? null,
    promptVersion: run.frozen?.promptVersion ?? null,
    schemaVersion: run.frozen?.schemaVersion ?? null,
    parserVersion: run.frozen?.parserVersion ?? null,
    modelParameters: run.frozen?.modelParameters ?? null,
  };
}

function inputCase(run) {
  return {
    projectId: run.projectId ?? null,
    eventId: run.eventId ?? null,
    inputSnapshotHash: run.frozen?.inputSnapshotHash ?? null,
    inputManifest: run.frozen?.inputManifest ?? null,
    contextVersion: run.frozen?.contextVersion ?? null,
    contextSnapshotHash: run.frozen?.contextSnapshotHash ?? null,
  };
}

function humanReviewComplete(predictions, eventId) {
  const audit = predictions.metadata?.adjudication;
  return audit?.groundTruthEventId === eventId && text(audit.reference) && timestamp(audit.completedAt) &&
    Array.isArray(audit.reviewedBy) && audit.reviewedBy.length > 0 && audit.reviewedBy.every(text);
}

function runReviewComplete(run) {
  return ["claimMatchesComplete", "relationMatchesComplete", "claimReviewsComplete", "viewReviewed", "briefReviewed"]
    .every((key) => run.adjudication?.[key] === true) &&
    run.claims.every((claim) => SUPPORT.has(claim.citationSupport) &&
      claim.evidence.every((evidence) => SUPPORT.has(evidence.semanticSupportVerdict)));
}

function sliceTruth(truth, eventId) {
  const claims = truth.claims.filter((claim) => claim.eventId === eventId);
  const ids = new Set(claims.map((claim) => claim.id));
  return { ...truth, claims, relations: truth.relations.filter((relation) => ids.has(relation.sourceClaimId)) };
}

export function aggregateSweeps({ groundTruth, manifest, packages }) {
  invariant(groundTruth?.schemaVersion === "notique-ground-truth.v1", "Unsupported Ground Truth schema.");
  invariant(manifest?.schemaVersion === FORMAT, "Unsupported sweep manifest schema.");
  invariant(manifest.dataset === groundTruth.dataset, "Manifest dataset must match Ground Truth.");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length > 0, "At least one Event case is required.");
  invariant(Array.isArray(manifest.sweeps) && manifest.sweeps.length >= 3, "At least three complete sweeps are required.");
  const eventIds = [...new Set(groundTruth.claims.map((claim) => claim.eventId))].sort();
  invariant(eventIds.every(text), "Every Ground Truth Claim needs an Event id.");
  const cases = new Map();
  const runIds = new Set();
  const allRuns = [];
  for (const item of manifest.cases) {
    invariant(text(item.groundTruthEventId) && !cases.has(item.groundTruthEventId), "Duplicate or missing manifest Event id.");
    const predictions = packages[item.groundTruthEventId];
    invariant(predictions?.schemaVersion === "notique-eval-predictions.v1", `Invalid predictions for ${item.groundTruthEventId}.`);
    invariant(Array.isArray(predictions.runs) && predictions.runs.length === manifest.sweeps.length, `Event ${item.groundTruthEventId} needs exactly one Run per sweep.`);
    const byId = new Map();
    for (const run of predictions.runs) {
      invariant(text(run.id) && !runIds.has(run.id), `Duplicate or missing source Run id: ${run.id}.`);
      invariant(Array.isArray(run.claims) && Array.isArray(run.relations ?? []), `Invalid Run ${run.id}.`);
      runIds.add(run.id);
      byId.set(run.id, run);
      allRuns.push(run);
    }
    const first = predictions.runs[0];
    invariant(predictions.runs.every((run) => canonical(inputCase(run)) === canonical(inputCase(first))), `Event ${item.groundTruthEventId} changed input, context, Project or Event across sweeps.`);
    const truthIds = new Set(groundTruth.claims.filter((claim) => claim.eventId === item.groundTruthEventId).map((claim) => claim.id));
    for (const run of predictions.runs) {
      for (const claim of run.claims) {
        invariant(claim.matchedGroundTruthId == null || truthIds.has(claim.matchedGroundTruthId), `Run ${run.id} has a Claim matched to another Event.`);
      }
      // The existing runner validates Claim ids, evidence arrays and all Ground Truth references.
      evaluate(groundTruth, { schemaVersion: "notique-eval-predictions.v1", runs: [run] });
    }
    cases.set(item.groundTruthEventId, { predictions, byId });
  }
  invariant(canonical([...cases.keys()].sort()) === canonical(eventIds), "Manifest must cover every Ground Truth Event exactly once.");
  const config = configuration(allRuns[0]);
  invariant(allRuns.every((run) => canonical(configuration(run)) === canonical(config)), "All Events and sweeps must use the same provider, model, prompt, schema, parser and model parameters.");
  const commits = [...new Set([...cases.values()].map((item) => item.predictions.metadata?.commitSha ?? null))];
  invariant(commits.length === 1, "Source commits differ across Event packages.");
  const sweepIds = new Set();
  const selectedRunIds = new Set();
  const resultRuns = [];
  for (const sweep of manifest.sweeps) {
    invariant(text(sweep.id) && !sweepIds.has(sweep.id), "Duplicate or missing sweep id.");
    sweepIds.add(sweep.id);
    invariant(canonical(Object.keys(sweep.runIds ?? {}).sort()) === canonical(eventIds), `Sweep ${sweep.id} must cover every Event exactly once.`);
    const components = eventIds.map((eventId) => {
      const entry = cases.get(eventId);
      const run = entry.byId.get(sweep.runIds[eventId]);
      invariant(run, `Sweep ${sweep.id} references unknown Run for ${eventId}.`);
      invariant(!selectedRunIds.has(run.id), `Run ${run.id} is reused across sweeps.`);
      selectedRunIds.add(run.id);
      return { groundTruthEventId: eventId, run };
    });
    const perEvent = components.map(({ groundTruthEventId, run }) => ({
      groundTruthEventId,
      runId: run.id,
      metrics: evaluate(sliceTruth(groundTruth, groundTruthEventId), { schemaVersion: "notique-eval-predictions.v1", runs: [run] }).metrics,
    }));
    const weakestBrief = [...perEvent].sort((a, b) =>
      Number(a.metrics.briefStructurallyComplete) - Number(b.metrics.briefStructurallyComplete) ||
      a.metrics.briefUsefulRate.value - b.metrics.briefUsefulRate.value ||
      a.metrics.briefSourceValidity.value - b.metrics.briefSourceValidity.value)[0];
    const briefRun = components.find((item) => item.run.id === weakestBrief.runId).run;
    const snapshot = components.map(({ groundTruthEventId, run }) => ({ groundTruthEventId, ...inputCase(run) }));
    const starts = components.map(({ run }) => run.frozen?.startedAt);
    const startedAt = starts.every(timestamp) ? starts.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : null;
    resultRuns.push({
      id: sweep.id,
      projectId: `evaluation:${hash(snapshot)}`,
      eventId: `dataset:${groundTruth.dataset}`,
      claims: components.flatMap(({ groundTruthEventId, run }) => run.claims.map((claim) => ({
        ...structuredClone(claim),
        id: `${groundTruthEventId}:${run.id}:${claim.id}`,
        productionPredictionId: claim.id,
        productionRunId: run.id,
        groundTruthEventId,
        semanticKey: claim.matchedGroundTruthId ? claim.semanticKey : canonical({ groundTruthEventId, semanticKey: claim.semanticKey ?? { type: claim.type ?? null, statement: claim.statement ?? null, normalizedValue: claim.normalizedValue ?? null, classification: claim.classification ?? null } }),
      }))),
      relations: components.flatMap(({ groundTruthEventId, run }) => (run.relations ?? []).map((relation) => ({
        ...structuredClone(relation), id: `${groundTruthEventId}:${run.id}:${relation.id}`, productionRunId: run.id, groundTruthEventId,
      }))),
      brief: structuredClone(briefRun.brief ?? { slots: [] }),
      viewLeakageCount: components.every(({ run }) => Number.isInteger(run.viewLeakageCount) && run.viewLeakageCount >= 0)
        ? components.reduce((total, { run }) => total + run.viewLeakageCount, 0) : null,
      usage: Object.fromEntries(["inputTokens", "outputTokens", "cachedTokens", "costUsd", "latencyMs"]
        .map((key) => [key, sumMeasured(components.map(({ run }) => run.usage?.[key]))])),
      frozen: {
        ...structuredClone(config),
        inputSnapshotHash: hash(snapshot.map(({ groundTruthEventId, inputSnapshotHash, inputManifest }) => ({ groundTruthEventId, inputSnapshotHash, inputManifest }))),
        inputManifest: snapshot,
        contextVersion: 1,
        contextSnapshotHash: hash(snapshot.map(({ groundTruthEventId, contextVersion, contextSnapshotHash }) => ({ groundTruthEventId, contextVersion, contextSnapshotHash }))),
        startedAt,
      },
      aggregate: {
        briefEventId: weakestBrief.groundTruthEventId,
        perEvent,
        sourceRuns: components.map(({ groundTruthEventId, run }) => ({ groundTruthEventId, id: run.id, projectId: run.projectId, eventId: run.eventId, frozen: structuredClone(run.frozen), adjudication: structuredClone(run.adjudication ?? null) })),
      },
    });
  }
  invariant(selectedRunIds.size === allRuns.length, "Every source Run must be assigned to exactly one sweep.");
  const issues = [];
  if (manifest.verification?.independentRunsVerified !== true || !text(manifest.verification.reference)) issues.push("independent-run verification record is missing");
  if (!text(commits[0]) || commits[0] === "unknown") issues.push("source commit is unknown");
  if (![config.provider, config.model, config.promptVersion, config.schemaVersion, config.parserVersion].every(text) || config.modelParameters == null) issues.push("frozen model configuration is incomplete");
  const inputHashes = new Set([...cases.values()].flatMap(({ predictions }) => (predictions.runs[0].frozen?.inputManifest ?? [])
    .map((item) => item.sha256).filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)).map((value) => value.toLowerCase())));
  const materials = manifest.materials;
  const materialProofComplete = Array.isArray(materials) && materials.length > 0 &&
    materials.every((item) => text(item.id) && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256) && inputHashes.has(item.sha256.toLowerCase())) &&
    new Set(materials.map((item) => item.id)).size === materials.length &&
    new Set(materials.map((item) => item.sha256.toLowerCase())).size === materials.length &&
    groundTruth.metadata?.evaluationMaterialCount === materials.length;
  if (!materialProofComplete) issues.push("source material count or hashes are not supported by the frozen input manifests");
  for (const [eventId, entry] of cases) {
    if (!humanReviewComplete(entry.predictions, eventId)) issues.push(`${eventId}: human adjudication record is incomplete`);
    if (!entry.predictions.runs.every(runReviewComplete)) issues.push(`${eventId}: per-Claim, Evidence, relation, view or Brief review is incomplete`);
    const first = entry.predictions.runs[0];
    if (!text(first.projectId) || !text(first.eventId) || !text(first.frozen?.inputSnapshotHash) || !text(first.frozen?.contextSnapshotHash) ||
      !Array.isArray(first.frozen?.inputManifest) || first.frozen.inputManifest.length === 0 || !Number.isSafeInteger(first.frozen?.contextVersion)) issues.push(`${eventId}: frozen input or context is incomplete`);
    const starts = entry.predictions.runs.map((run) => run.frozen?.startedAt);
    if (!starts.every(timestamp) || new Set(starts).size !== starts.length) issues.push(`${eventId}: distinct source Run start times are missing`);
    const frozenAt = groundTruth.metadata?.blindSetFrozenAt;
    if (groundTruth.split === "blind" && (!timestamp(frozenAt) || starts.some((start) => !timestamp(start) || Date.parse(start) <= Date.parse(frozenAt)))) issues.push(`${eventId}: Blind Set was not frozen before all source Runs`);
  }
  if (new Set(resultRuns.map((run) => run.frozen.startedAt)).size !== resultRuns.length) issues.push("sweep start times are not distinct");
  return {
    schemaVersion: "notique-eval-predictions.v1",
    metadata: {
      commitSha: commits[0],
      exportFormat: "notique-eval-sweep-aggregate.v1",
      dataset: groundTruth.dataset,
      groundTruthHash: hash(groundTruth),
      manifestHash: hash(manifest),
      independentRunsVerified: issues.length === 0 ? true : null,
      verification: structuredClone(manifest.verification ?? null),
      qualification: { verified: issues.length === 0 ? true : null, issues },
      materialProof: { verified: materialProofComplete ? true : null, materialCount: materialProofComplete ? materials.length : null, frozenInputHashCount: inputHashes.size },
      adjudications: eventIds.map((eventId) => ({ eventId, ...structuredClone(cases.get(eventId).predictions.metadata?.adjudication ?? {}) })),
      sampleProvenance: structuredClone(groundTruth.metadata ?? null),
      briefPolicy: "Each sweep uses its structurally weakest Event Brief, or the least useful complete Brief when all are structurally valid.",
      latencyPolicy: "Sum of source Run elapsed times, not concurrent wall-clock duration.",
    },
    runs: resultRuns,
  };
}

async function main() {
  const [groundTruthPath, manifestPath, outputPath] = process.argv.slice(2);
  invariant(outputPath, "Usage: node scripts/aggregate-eval-sweeps.mjs GROUND_TRUTH MANIFEST PREDICTIONS_OUT");
  const [groundTruth, manifest] = await Promise.all([groundTruthPath, manifestPath].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const packages = Object.fromEntries(await Promise.all((manifest.cases ?? []).map(async (item) => {
    invariant(text(item.predictionsPath), "Every Event case needs a predictionsPath.");
    return [item.groundTruthEventId, JSON.parse(await readFile(resolve(dirname(manifestPath), item.predictionsPath), "utf8"))];
  })));
  const output = aggregateSweeps({ groundTruth, manifest, packages });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`Wrote ${outputPath}\nIndependent sweep verification: ${output.metadata.independentRunsVerified === true ? "verified" : "unknown"}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
