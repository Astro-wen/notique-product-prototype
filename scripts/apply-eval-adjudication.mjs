#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function mapById(items, label) {
  const result = new Map();
  for (const item of items) {
    invariant(typeof item?.id === "string" && item.id, `${label} item is missing an id.`);
    invariant(!result.has(item.id), `Duplicate ${label} id: ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

const SUPPORT_VERDICTS = new Set(["fully_supports", "partially_supports", "does_not_support"]);

function supportReview(value, previous, label) {
  if (value == null) return previous ?? "unreviewed";
  invariant(SUPPORT_VERDICTS.has(value), `Invalid support verdict for ${label}.`);
  return value;
}

function own(object, key) {
  return Object.hasOwn(object ?? {}, key);
}

export function applyAdjudication(raw, decisions, groundTruth) {
  invariant(raw?.schemaVersion === "notique-eval-predictions.v1", "Unsupported prediction schema.");
  invariant(decisions?.schemaVersion === "notique-eval-adjudication.v1", "Unsupported adjudication schema.");
  invariant(groundTruth?.schemaVersion === "notique-ground-truth.v1", "Unsupported Ground Truth schema.");
  const truthById = mapById(groundTruth.claims, "Ground Truth Claim");
  const relationTruthById = mapById(groundTruth.relations, "Ground Truth Relation");
  const eventId = decisions.groundTruthEventId;
  invariant(typeof eventId === "string" && eventId, "groundTruthEventId is required.");
  const decisionRuns = mapById(decisions.runs, "adjudication Run");
  const rawRuns = mapById(raw.runs, "prediction Run");
  invariant(decisionRuns.size === rawRuns.size, "Every exported Run must have exactly one adjudication entry.");

  const output = structuredClone(raw);
  output.metadata = {
    ...output.metadata,
    adjudication: {
      groundTruthEventId: eventId,
      reference: decisions.metadata?.reference ?? null,
      reviewedBy: decisions.metadata?.reviewedBy ?? null,
      completedAt: decisions.metadata?.completedAt ?? null,
    },
  };
  for (const run of output.runs) {
    const decision = decisionRuns.get(run.id);
    invariant(decision, `Missing adjudication for Run ${run.id}.`);
    const claimMappings = new Map(Object.entries(decision.claimMatches ?? {}));
    const relationMappings = new Map(Object.entries(decision.relationMatches ?? {}));
    const claimIds = new Set(run.claims.map((item) => item.id));
    const relationIds = new Set((run.relations ?? []).map((item) => item.id));
    for (const claimId of claimMappings.keys()) invariant(claimIds.has(claimId), `Unknown Claim ${claimId} in Run ${run.id}.`);
    for (const relationId of relationMappings.keys()) invariant(relationIds.has(relationId), `Unknown Relation ${relationId} in Run ${run.id}.`);
    for (const claimId of Object.keys(decision.claimReviews ?? {})) invariant(claimIds.has(claimId), `Unknown Claim review ${claimId} in Run ${run.id}.`);

    for (const claim of run.claims) {
      const truthId = claimMappings.get(claim.id) ?? null;
      if (truthId != null) invariant(truthById.has(truthId), `Unknown Ground Truth Claim ${truthId}.`);
      if (truthId != null) invariant(truthById.get(truthId).eventId === eventId, `Claim ${claim.id} matches a different Ground Truth Event.`);
      claim.matchedGroundTruthId = truthId;
      const review = decision.claimReviews?.[claim.id];
      claim.citationSupport = supportReview(review?.citationSupport ?? decision.citationSupport, claim.citationSupport, claim.id);
      const visualReview = review?.unsupportedVisualClaim ?? decision.unsupportedVisualClaim;
      if (visualReview != null) invariant(typeof visualReview === "boolean", `Invalid visual review for ${claim.id}.`);
      claim.unsupportedVisualClaim = visualReview ?? claim.unsupportedVisualClaim ?? null;
      const evidenceIds = new Set(claim.evidence.map((evidence, index) => evidence.id ?? `#${index}`));
      for (const id of Object.keys(review?.evidenceSupport ?? {})) invariant(evidenceIds.has(id), `Unknown Evidence ${id} in Claim ${claim.id}.`);
      for (const [index, evidence] of claim.evidence.entries()) {
        evidence.semanticSupportVerdict = supportReview(
          review?.evidenceSupport?.[evidence.id ?? `#${index}`] ?? decision.evidenceSupport,
          evidence.semanticSupportVerdict,
          `${claim.id} evidence ${index}`,
        );
      }
      const truth = truthId == null ? null : truthById.get(truthId);
      if (truth?.expectedClassification === "reaffirmed" && truth.targetVersionId) {
        claim.productionTargetVersionId = claim.targetVersionId;
        claim.targetVersionId = truth.targetVersionId;
      }
    }

    for (const relation of run.relations ?? []) {
      const truthId = relationMappings.get(relation.id) ?? null;
      relation.matchedGroundTruthRelationId = truthId;
      if (truthId == null) {
        relation.sourceGroundTruthClaimId = null;
        relation.targetGroundTruthClaimId = null;
        continue;
      }
      const truth = relationTruthById.get(truthId);
      invariant(truth, `Unknown Ground Truth Relation ${truthId}.`);
      invariant(truthById.get(truth.sourceClaimId)?.eventId === eventId, `Relation ${relation.id} matches a different Ground Truth Event.`);
      relation.sourceGroundTruthClaimId = truth.sourceClaimId;
      relation.targetGroundTruthClaimId = truth.targetClaimId;
      relation.productionTargetVersionId = relation.targetVersionId;
      relation.targetVersionId = truth.targetVersionId ?? relation.targetVersionId;
    }
    run.viewLeakageCount = decision.viewLeakageCount;
    invariant(Number.isInteger(run.viewLeakageCount) && run.viewLeakageCount >= 0, `Run ${run.id} requires an adjudicated viewLeakageCount.`);
    const usefulSlots = new Set(decision.usefulBriefSlots ?? []);
    for (const slot of run.brief?.slots ?? []) slot.useful = usefulSlots.has(slot.slot);
    run.adjudication = {
      claimMatchesComplete: run.claims.every((claim) => own(decision.claimMatches, claim.id)),
      relationMatchesComplete: (run.relations ?? []).every((relation) => own(decision.relationMatches, relation.id)),
      claimReviewsComplete: run.claims.every((claim) => {
        const review = decision.claimReviews?.[claim.id];
        return SUPPORT_VERDICTS.has(review?.citationSupport) &&
          claim.evidence.every((evidence, index) => SUPPORT_VERDICTS.has(review?.evidenceSupport?.[evidence.id ?? `#${index}`])) &&
          (!claim.evidence.some((evidence) => evidence.kind === "photo") || typeof review?.unsupportedVisualClaim === "boolean");
      }),
      viewReviewed: Number.isInteger(decision.viewLeakageCount),
      briefReviewed: Array.isArray(decision.usefulBriefSlots),
    };
  }

  const eventClaims = groundTruth.claims.filter((claim) => claim.eventId === eventId);
  const eventClaimIds = new Set(eventClaims.map((claim) => claim.id));
  invariant(eventClaims.length > 0, `No Ground Truth Claims found for Event ${eventId}.`);
  const eventRelations = groundTruth.relations.filter((relation) => eventClaimIds.has(relation.sourceClaimId));
  const slicedGroundTruth = {
    ...structuredClone(groundTruth),
    dataset: `${groundTruth.dataset}:${eventId}`,
    sourceDataset: groundTruth.dataset,
    claims: eventClaims,
    relations: eventRelations,
  };
  return { predictions: output, groundTruth: slicedGroundTruth };
}

async function main() {
  const [rawPath, decisionsPath, groundTruthPath, predictionsOutputPath, groundTruthOutputPath] = process.argv.slice(2);
  if (!groundTruthOutputPath) {
    console.error("Usage: node scripts/apply-eval-adjudication.mjs RAW DECISIONS GROUND_TRUTH PREDICTIONS_OUT GROUND_TRUTH_OUT");
    process.exitCode = 2;
    return;
  }
  const [raw, decisions, groundTruth] = await Promise.all([
    readFile(rawPath, "utf8").then(JSON.parse),
    readFile(decisionsPath, "utf8").then(JSON.parse),
    readFile(groundTruthPath, "utf8").then(JSON.parse),
  ]);
  const result = applyAdjudication(raw, decisions, groundTruth);
  await Promise.all([
    writeFile(predictionsOutputPath, `${JSON.stringify(result.predictions, null, 2)}\n`, "utf8"),
    writeFile(groundTruthOutputPath, `${JSON.stringify(result.groundTruth, null, 2)}\n`, "utf8"),
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
