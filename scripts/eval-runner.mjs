#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function ratio(numerator, denominator) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function shortestTimestampDistance(prediction, truth) {
  if (!Number.isFinite(truth.timestampMs)) return null;
  const distances = prediction.evidence.flatMap((item) => {
    if (!Number.isFinite(item.startMs)) return [];
    const start = item.startMs;
    const end = Number.isFinite(item.endMs) ? item.endMs : start;
    if (truth.timestampMs >= start && truth.timestampMs <= end) return [0];
    return [Math.min(Math.abs(truth.timestampMs - start), Math.abs(truth.timestampMs - end))];
  });
  return distances.length ? Math.min(...distances) : null;
}

function groupBy(items, keyOf) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key == null) continue;
    const group = result.get(key) ?? [];
    group.push(item);
    result.set(key, group);
  }
  return result;
}

function supported(prediction) {
  return prediction.evidence.length > 0 && prediction.citationSupport === "fully_supports";
}

const BRIEF_SLOTS = new Map([
  ["current_status", "claim"],
  ["change_1", "timeline_delta"],
  ["change_2", "timeline_delta"],
  ["question_1", "agenda_item"],
  ["question_2", "agenda_item"],
  ["risk", "claim"],
]);

function validateBrief(brief) {
  const slots = Array.isArray(brief?.slots) ? brief.slots : [];
  const slotNames = new Set();
  const sourceKeys = new Set();
  let valid = 0;
  let useful = 0;
  for (const slot of slots) {
    const expectedSource = BRIEF_SLOTS.get(slot.slot);
    const sourceKey = `${slot.sourceKind ?? ""}:${slot.sourceId ?? ""}`;
    const itemValid =
      expectedSource != null &&
      expectedSource === slot.sourceKind &&
      typeof slot.sourceId === "string" &&
      slot.sourceId.length > 0 &&
      slot.sourceValid === true &&
      !slotNames.has(slot.slot) &&
      !sourceKeys.has(sourceKey);
    slotNames.add(slot.slot);
    sourceKeys.add(sourceKey);
    if (itemValid) valid += 1;
    if (itemValid && slot.useful === true) useful += 1;
  }
  return {
    slots,
    sourceValidity: ratio(valid, 6),
    usefulRate: ratio(useful, 6),
    structurallyComplete: slots.length === 6 && valid === 6 && slotNames.size === 6 && sourceKeys.size === 6,
  };
}

function validateInput(groundTruth, predictionSet) {
  invariant(groundTruth?.schemaVersion === "notique-ground-truth.v1", "Unsupported Ground Truth schemaVersion.");
  invariant(predictionSet?.schemaVersion === "notique-eval-predictions.v1", "Unsupported prediction schemaVersion.");
  invariant(Array.isArray(groundTruth.claims), "Ground Truth claims must be an array.");
  invariant(Array.isArray(groundTruth.relations), "Ground Truth relations must be an array.");
  invariant(Array.isArray(predictionSet.runs) && predictionSet.runs.length > 0, "At least one prediction run is required.");

  const truthIds = new Set();
  for (const claim of groundTruth.claims) {
    invariant(typeof claim.id === "string" && claim.id, "Every Ground Truth claim needs an id.");
    invariant(!truthIds.has(claim.id), `Duplicate Ground Truth claim id: ${claim.id}`);
    truthIds.add(claim.id);
  }
  const relationIds = new Set();
  for (const relation of groundTruth.relations) {
    invariant(typeof relation.id === "string" && relation.id, "Every Ground Truth relation needs an id.");
    invariant(!relationIds.has(relation.id), `Duplicate Ground Truth relation id: ${relation.id}`);
    relationIds.add(relation.id);
  }
  const runIds = new Set();
  for (const run of predictionSet.runs) {
    invariant(typeof run.id === "string" && run.id, "Every prediction run needs an id.");
    invariant(!runIds.has(run.id), `Duplicate prediction run id: ${run.id}`);
    runIds.add(run.id);
    invariant(Array.isArray(run.claims), `Run ${run.id} claims must be an array.`);
    const predictionIds = new Set();
    for (const claim of run.claims) {
      invariant(typeof claim.id === "string" && claim.id, `Every prediction in ${run.id} needs an id.`);
      invariant(!predictionIds.has(claim.id), `Duplicate prediction id in ${run.id}: ${claim.id}`);
      predictionIds.add(claim.id);
      if (claim.matchedGroundTruthId != null) {
        invariant(truthIds.has(claim.matchedGroundTruthId), `Run ${run.id} references unknown Ground Truth id ${claim.matchedGroundTruthId}.`);
      }
      invariant(Array.isArray(claim.evidence), `Prediction ${claim.id} evidence must be an array.`);
    }
  }
}

function buildConsistency(predictionSet) {
  const candidates = new Map();
  for (const run of predictionSet.runs) {
    for (const claim of run.claims) {
      const unmatchedFingerprint = claim.semanticKey ?? canonical({
        type: claim.type ?? null,
        statement: claim.statement ?? null,
        normalizedValue: claim.normalizedValue ?? null,
        classification: claim.classification ?? null,
      });
      const key = claim.matchedGroundTruthId ? `truth:${claim.matchedGroundTruthId}` : `unmatched:${unmatchedFingerprint}`;
      const signature = canonical({
        type: claim.type ?? null,
        normalizedValue: claim.normalizedValue ?? null,
        classification: claim.classification ?? null,
        targetVersionId: claim.targetVersionId ?? null,
        relationSignature: claim.relationSignature ?? null,
      });
      const byRun = candidates.get(key) ?? new Map();
      const signatures = byRun.get(run.id) ?? [];
      signatures.push(signature);
      byRun.set(run.id, signatures);
      candidates.set(key, byRun);
    }
  }
  const consistent = [...candidates.values()].filter((byRun) => {
    if (byRun.size !== predictionSet.runs.length) return false;
    const signatures = [...byRun.values()];
    return signatures.every((items) => items.length === 1) && new Set(signatures.map((items) => items[0])).size === 1;
  }).length;
  return ratio(consistent, candidates.size);
}

function gate(name, passed, actual, expected) {
  return { name, passed: passed === true, actual, expected };
}

export function evaluate(groundTruth, predictionSet) {
  validateInput(groundTruth, predictionSet);
  const truthById = new Map(groundTruth.claims.map((claim) => [claim.id, claim]));
  const primaryRun = predictionSet.runs[0];
  const materialTruth = groundTruth.claims.filter((claim) => claim.material === true);
  const criticalTruth = materialTruth.filter((claim) => claim.critical === true);
  const predictionGroups = groupBy(primaryRun.claims, (claim) => claim.matchedGroundTruthId);
  const uniqueMaterialMatches = materialTruth.filter((truth) => predictionGroups.get(truth.id)?.length === 1);
  const supportedUniqueMaterial = uniqueMaterialMatches.filter((truth) => supported(predictionGroups.get(truth.id)[0]));
  const supportedCritical = criticalTruth.filter((truth) => {
    const matches = predictionGroups.get(truth.id) ?? [];
    return matches.length === 1 && supported(matches[0]);
  });

  const evidence = primaryRun.claims.flatMap((claim) => claim.evidence);
  const missingEvidenceClaims = primaryRun.claims.filter((claim) => claim.evidence.length === 0).length;
  const transcriptChecks = primaryRun.claims.flatMap((prediction) => {
    const truth = truthById.get(prediction.matchedGroundTruthId);
    const refs = prediction.evidence.filter((item) => item.kind === "transcript");
    if (truth?.modality === "transcript" && refs.length === 0) return [{ quoteExact: false }];
    return refs;
  });

  const criticalAmbiguities = groundTruth.claims.filter((claim) => claim.ambiguity?.severity === "critical");
  const ambiguityHits = criticalAmbiguities.filter((truth) => {
    const matches = predictionGroups.get(truth.id) ?? [];
    return matches.length === 1 && matches[0].ambiguityDetected === true && matches[0].assertedDefinitively !== true &&
      Array.isArray(matches[0].ambiguityAlternatives) && matches[0].ambiguityAlternatives.length >= 2 &&
      typeof matches[0].ambiguityQuestion === "string" && matches[0].ambiguityQuestion.length > 0;
  });

  const relationTruthById = new Map(groundTruth.relations.map((relation) => [relation.id, relation]));
  const relationPredictions = primaryRun.relations ?? [];
  const validRelationPredictions = relationPredictions.filter((prediction) => {
    const truth = relationTruthById.get(prediction.matchedGroundTruthRelationId);
    return truth && truth.type === prediction.type && truth.sourceClaimId === prediction.sourceGroundTruthClaimId &&
      truth.targetClaimId === prediction.targetGroundTruthClaimId &&
      (truth.targetVersionId == null || truth.targetVersionId === prediction.targetVersionId);
  });
  const validRelationGroups = groupBy(validRelationPredictions, (relation) => relation.matchedGroundTruthRelationId);
  const uniqueCorrectRelations = groundTruth.relations.filter((truth) => validRelationGroups.get(truth.id)?.length === 1);

  const repeatOpportunities = groundTruth.claims.filter((claim) => claim.expectedClassification === "duplicate" || claim.expectedClassification === "reaffirmed");
  const wronglyCreatedRepeats = repeatOpportunities.filter((truth) =>
    (predictionGroups.get(truth.id) ?? []).some((prediction) => prediction.classification === "new"),
  );
  const reaffirmedTruth = groundTruth.claims.filter((claim) => claim.expectedClassification === "reaffirmed");
  const correctReaffirmed = reaffirmedTruth.filter((truth) => {
    const matches = predictionGroups.get(truth.id) ?? [];
    return matches.length === 1 && matches[0].classification === "reaffirmed" && matches[0].targetVersionId === truth.targetVersionId;
  });

  const timestampDistances = uniqueMaterialMatches.flatMap((truth) => {
    const distance = shortestTimestampDistance(predictionGroups.get(truth.id)[0], truth);
    return distance == null ? [] : [distance];
  });
  const consistency = buildConsistency(predictionSet);
  const brief = validateBrief(primaryRun.brief);
  const imageTruth = materialTruth.filter((claim) => claim.modality === "image");
  const imageMatches = imageTruth.filter((truth) => predictionGroups.get(truth.id)?.length === 1);
  const visualPredictions = primaryRun.claims.filter((claim) =>
    truthById.get(claim.matchedGroundTruthId)?.modality === "image" || claim.evidence.some((item) => item.kind === "photo"),
  );
  const visualClaimsAllAdjudicated = visualPredictions.every((claim) => typeof claim.unsupportedVisualClaim === "boolean");

  const totals = predictionSet.runs.reduce((result, run) => ({
    inputTokens: result.inputTokens + (run.usage?.inputTokens ?? 0),
    outputTokens: result.outputTokens + (run.usage?.outputTokens ?? 0),
    costUsd: result.costUsd + (run.usage?.costUsd ?? 0),
    latencyMs: result.latencyMs + (run.usage?.latencyMs ?? 0),
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 });

  const doubleAnnotated = groundTruth.claims.filter((claim) => claim.annotation?.doubleAnnotated === true);
  const scenarios = groupBy(groundTruth.claims, (claim) => claim.scenarioId);
  const scenarioEventCounts = Object.fromEntries([...scenarios].map(([id, claims]) => [id, new Set(claims.map((claim) => claim.eventId)).size]));
  const scenarioShapeValid = Object.keys(scenarioEventCounts).length >= 2 && Object.values(scenarioEventCounts).every((count) => count >= 3 && count <= 5);
  const eventMaterialClaimCounts = Object.fromEntries(
    [...groupBy(materialTruth, (claim) => claim.eventId)]
      .map(([eventId, claims]) => [eventId, claims.length]),
  );
  // Eric's exercise caps review at ten material Claims per Event. A Ground Truth
  // set with more than ten makes the recall gate mathematically impossible and
  // must be fixed before it is allowed to produce a formal score.
  const eventMaterialShapeValid = Object.values(eventMaterialClaimCounts)
    .every((count) => count >= 5 && count <= 10);
  const sampleEligibility = {
    scenarioCount: scenarios.size,
    scenarioEventCounts,
    scenarioShapeValid,
    eventMaterialClaimCounts,
    eventMaterialShapeValid,
    eventCount: new Set(groundTruth.claims.map((claim) => claim.eventId)).size,
    materialClaimCount: materialTruth.length,
    criticalClaimCount: criticalTruth.length,
    criticalAmbiguityCount: criticalAmbiguities.length,
    relationCount: groundTruth.relations.length,
    imageFactCount: imageTruth.length,
    doubleAnnotatedCount: doubleAnnotated.length,
    runCount: predictionSet.runs.length,
    hasThreeIndependentRuns: predictionSet.runs.length >= 3,
    criticalClaimsAllDoubleAnnotated: criticalTruth.every((claim) => claim.annotation?.doubleAnnotated === true),
    semanticSampleDoubleAnnotatedRate: groundTruth.claims.length === 0 ? null : doubleAnnotated.length / groundTruth.claims.length,
    meetsTranscriptMinimum: scenarioShapeValid && eventMaterialShapeValid &&
      materialTruth.length >= 40 && criticalTruth.length >= 10 &&
      criticalAmbiguities.length >= 8 && groundTruth.relations.length >= 8 &&
      doubleAnnotated.length / Math.max(1, groundTruth.claims.length) >= 0.2 &&
      criticalTruth.every((claim) => claim.annotation?.doubleAnnotated === true) && predictionSet.runs.length >= 3,
    meetsImageMinimum: imageTruth.length >= 12,
  };

  const metrics = {
    materialClaimRecall: ratio(uniqueMaterialMatches.length, materialTruth.length),
    materialClaimPrecision: ratio(uniqueMaterialMatches.length, primaryRun.claims.length),
    claimsWithEvidence: ratio(primaryRun.claims.length - missingEvidenceClaims, primaryRun.claims.length),
    evidenceIdValidity: ratio(evidence.filter((item) => item.idValid === true).length, evidence.length + missingEvidenceClaims),
    transcriptQuoteExactMatch: ratio(transcriptChecks.filter((item) => item.quoteExact === true).length, transcriptChecks.length),
    citationSupportPrecision: ratio(supportedUniqueMaterial.length, primaryRun.claims.length),
    criticalCitationSupport: ratio(supportedCritical.length, criticalTruth.length),
    criticalAmbiguityRecall: ratio(ambiguityHits.length, criticalAmbiguities.length),
    relationRecall: ratio(uniqueCorrectRelations.length, groundTruth.relations.length),
    relationPrecision: ratio(uniqueCorrectRelations.length, relationPredictions.length),
    duplicateCreationRate: ratio(wronglyCreatedRepeats.length, repeatOpportunities.length),
    reaffirmedClassificationAccuracy: ratio(correctReaffirmed.length, reaffirmedTruth.length),
    imageFactRecall: ratio(imageMatches.length, imageTruth.length),
    unsupportedVisualClaimCount: visualPredictions.filter((claim) => claim.unsupportedVisualClaim === true).length,
    visualClaimsAllAdjudicated,
    viewLeakageCount: Number.isInteger(primaryRun.viewLeakageCount) ? primaryRun.viewLeakageCount : null,
    consistency,
    timestampDistanceMs: {
      sampleCount: timestampDistances.length,
      mean: average(timestampDistances),
      max: timestampDistances.length ? Math.max(...timestampDistances) : null,
      withinFiveSeconds: ratio(timestampDistances.filter((value) => value < 5_000).length, timestampDistances.length),
    },
    briefSourceValidity: brief.sourceValidity,
    briefUsefulRate: brief.usefulRate,
    briefStructurallyComplete: brief.structurallyComplete,
    usage: totals,
  };

  const checks = [
    gate("sample_eligible", sampleEligibility.meetsTranscriptMinimum, sampleEligibility.meetsTranscriptMinimum, true),
    gate("material_recall", metrics.materialClaimRecall.value >= 0.8, metrics.materialClaimRecall.value, ">= 0.80"),
    gate("material_precision", metrics.materialClaimPrecision.value >= 0.85, metrics.materialClaimPrecision.value, ">= 0.85"),
    gate("claims_have_evidence", metrics.claimsWithEvidence.value === 1, metrics.claimsWithEvidence.value, "1.00"),
    gate("evidence_id_validity", metrics.evidenceIdValidity.value === 1, metrics.evidenceIdValidity.value, "1.00"),
    gate("transcript_quote_exact", metrics.transcriptQuoteExactMatch.value === 1, metrics.transcriptQuoteExactMatch.value, "1.00"),
    gate("citation_support", metrics.citationSupportPrecision.value >= 0.95, metrics.citationSupportPrecision.value, ">= 0.95"),
    gate("critical_citation_support", metrics.criticalCitationSupport.value === 1, metrics.criticalCitationSupport.value, "1.00"),
    gate("critical_ambiguity", metrics.criticalAmbiguityRecall.value === 1, metrics.criticalAmbiguityRecall.value, "1.00"),
    gate("relation_recall", metrics.relationRecall.value === 1, metrics.relationRecall.value, "1.00"),
    gate("relation_precision", metrics.relationPrecision.value === 1, metrics.relationPrecision.value, "1.00"),
    gate("duplicate_creation", metrics.duplicateCreationRate.value != null && metrics.duplicateCreationRate.value < 0.1, metrics.duplicateCreationRate.value, "< 0.10"),
    gate("reaffirmed_accuracy", metrics.reaffirmedClassificationAccuracy.value === 1, metrics.reaffirmedClassificationAccuracy.value, "1.00"),
    gate("visual_adjudication", visualClaimsAllAdjudicated, visualClaimsAllAdjudicated, true),
    gate("unsupported_visual", metrics.unsupportedVisualClaimCount === 0, metrics.unsupportedVisualClaimCount, 0),
    gate("view_leakage", metrics.viewLeakageCount === 0, metrics.viewLeakageCount, 0),
    gate("three_run_consistency", sampleEligibility.hasThreeIndependentRuns && metrics.consistency.value >= 0.85, metrics.consistency.value, ">= 0.85 across >= 3 runs"),
    gate("timestamp_max", metrics.timestampDistanceMs.sampleCount > 0 && metrics.timestampDistanceMs.max < 5_000, metrics.timestampDistanceMs.max, "< 5000 ms"),
    gate("brief_sources", metrics.briefStructurallyComplete && metrics.briefSourceValidity.value === 1, metrics.briefSourceValidity.value, "6/6 unique valid sources"),
    gate("brief_useful", metrics.briefUsefulRate.value >= 5 / 6, metrics.briefUsefulRate.value, ">= 5/6"),
  ];
  if (imageTruth.length > 0) checks.push(gate("image_fact_recall", sampleEligibility.meetsImageMinimum && metrics.imageFactRecall.value >= 0.8, metrics.imageFactRecall.value, ">= 0.80 with >= 12 image facts"));

  return {
    schemaVersion: "notique-eval-report.v1",
    generatedAt: new Date().toISOString(),
    metadata: predictionSet.metadata,
    dataset: groundTruth.dataset,
    split: groundTruth.split,
    sampleEligibility,
    metrics,
    gates: { pass: checks.every((item) => item.passed), checks },
  };
}

async function main() {
  const [groundTruthPath, predictionsPath, outputPath] = process.argv.slice(2);
  if (!groundTruthPath || !predictionsPath) {
    console.error("Usage: node scripts/eval-runner.mjs <ground-truth.json> <predictions.json> [report.json]");
    process.exitCode = 2;
    return;
  }
  const [groundTruth, predictions] = await Promise.all([
    readFile(groundTruthPath, "utf8").then(JSON.parse),
    readFile(predictionsPath, "utf8").then(JSON.parse),
  ]);
  const report = evaluate(groundTruth, predictions);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
