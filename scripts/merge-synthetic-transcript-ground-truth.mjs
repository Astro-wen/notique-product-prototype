#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_RELATIVE_PATHS = Object.freeze([
  "eval/cases/synthetic-realtor-v1/ground-truth.json",
  "eval/cases/synthetic-insurance-v1/ground-truth.json",
  "eval/cases/synthetic-contractor-v1/ground-truth.json",
]);

export const OUTPUT_RELATIVE_PATH =
  "eval/combined/synthetic-transcript-development-v1.ground-truth.json";

const EXPECTED_DATASETS = new Set([
  "synthetic-realtor-v1",
  "synthetic-insurance-v1",
  "synthetic-contractor-v1",
]);

/**
 * The raw Contractor fixture intentionally contains 13 to 14 transcript facts
 * plus image observations per Event. It remains the exhaustive multimodal
 * pressure test. Eric's review exercise, however, allows at most ten cards per
 * Event. This explicit, pre-model allowlist is the single-author development
 * annotation for the review queue. It never deletes or relabels the source
 * fixture and must still receive independent annotation before formal use.
 */
export const CONTRACTOR_REVIEW_PRIORITY_IDS = Object.freeze({
  "event-01-estimate": Object.freeze([
    "gt-e1-scope",
    "gt-e1-surface-quartz",
    "gt-e1-budget-18000",
    "gt-e1-pendant-remove",
    "gt-e1-outlet-condition",
    "gt-e1-hidden-change-order",
    "gt-e1-decision-makers",
    "gt-e1-loadbearing-open",
    "gt-e1-labor-allowance-ambiguous",
    "gt-e1-appliance-move-open",
  ]),
  "event-02-scope-followup": Object.freeze([
    "gt-e2-budget-21500",
    "gt-e2-surface-porcelain",
    "gt-e2-opening-72",
    "gt-e2-loadbearing-reaffirmed",
    "gt-e2-pendant-keep",
    "gt-e2-outlet-relocate",
    "gt-e2-change-order-due",
    "gt-e2-appliance-split",
    "gt-e2-moisture-source-open",
    "gt-e2-tile-buyer-open",
  ]),
  "event-03-preconstruction": Object.freeze([
    "gt-e3-wall-not-loadbearing",
    "gt-e3-header-sketch",
    "gt-e3-budget-reaffirmed",
    "gt-e3-pendant-final",
    "gt-e3-moisture-cause",
    "gt-e3-moisture-recheck",
    "gt-e3-tile-approved",
    "gt-e3-labor-allowance-6500",
    "gt-e3-appliances-both-crew",
    "gt-e3-inspection-slot-open",
  ]),
});

const CONTRACTOR_REVIEW_PRIORITY_ID_SET = new Set(
  Object.values(CONTRACTOR_REVIEW_PRIORITY_IDS).flat(),
);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, field) {
  invariant(typeof value === "string" && value.trim(), `${field} must be a non-empty string.`);
  return value.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function addUnique(set, value, field) {
  const text = nonEmptyString(value, field);
  invariant(!set.has(text), `Global ${field} conflict: ${text}`);
  set.add(text);
  return text;
}

function sourceSummary(source, index) {
  const prefix = `sources[${index}]`;
  const document = source.document;
  invariant(document && typeof document === "object" && !Array.isArray(document), `${prefix} must contain a JSON object.`);
  invariant(document.schemaVersion === "notique-ground-truth.v1", `${prefix} has an unsupported schemaVersion.`);
  invariant(Array.isArray(document.claims) && document.claims.length > 0, `${prefix}.claims must not be empty.`);
  invariant(Array.isArray(document.relations), `${prefix}.relations must be an array.`);
  const dataset = nonEmptyString(document.dataset, `${prefix}.dataset`);
  invariant(EXPECTED_DATASETS.has(dataset), `Dataset ${dataset} is not allowed in the transcript development package.`);

  const scenarioIds = new Set(document.claims.map((claim) => nonEmptyString(claim.scenarioId, `${prefix}.claims[].scenarioId`)));
  invariant(scenarioIds.size === 1, `${dataset} must contain exactly one scenario.`);
  const scenarioId = [...scenarioIds][0];
  const eventIds = [...new Set(document.claims.map((claim) => nonEmptyString(claim.eventId, `${prefix}.claims[].eventId`)))];
  invariant(eventIds.length >= 3 && eventIds.length <= 5, `${dataset} must contain 3 to 5 events.`);

  return { dataset, scenarioId, eventIds };
}

export function buildCombinedGroundTruth(sources) {
  invariant(Array.isArray(sources) && sources.length === 3, "Exactly three source datasets are required.");
  const sourcePaths = sources.map((source, index) => nonEmptyString(source.path, `sources[${index}].path`));
  invariant(new Set(sourcePaths).size === sourcePaths.length, "Source paths must be unique.");

  const summaries = sources.map(sourceSummary);
  invariant(new Set(summaries.map((item) => item.dataset)).size === EXPECTED_DATASETS.size, "All required datasets must be present exactly once.");

  const scenarioIds = new Set();
  const eventIds = new Set();
  const claimIds = new Set();
  const relationIds = new Set();
  for (const summary of summaries) {
    addUnique(scenarioIds, summary.scenarioId, "scenario ID");
    for (const eventId of summary.eventIds) addUnique(eventIds, eventId, "event ID");
  }

  const claims = [];
  const relations = [];
  const transcriptNegativeControls = [];
  for (const [sourceIndex, source] of sources.entries()) {
    const contractorProjection = source.document.dataset === "synthetic-contractor-v1";
    if (contractorProjection) {
      const sourceClaimById = new Map(source.document.claims.map((claim) => [claim.id, claim]));
      for (const [eventId, selectedIds] of Object.entries(CONTRACTOR_REVIEW_PRIORITY_IDS)) {
        invariant(selectedIds.length === 10 && new Set(selectedIds).size === 10, `${eventId} must select exactly ten unique review priorities.`);
        for (const selectedId of selectedIds) {
          const selected = sourceClaimById.get(selectedId);
          invariant(selected, `Unknown Contractor review-priority Claim: ${selectedId}`);
          invariant(selected.eventId === eventId, `Contractor review-priority Claim ${selectedId} belongs to the wrong Event.`);
          invariant(selected.material === true, `Contractor review-priority Claim ${selectedId} was not material in the source fixture.`);
          invariant(selected.modality === "transcript", `Contractor review-priority Claim ${selectedId} is not transcript-only.`);
        }
      }
    }
    for (const [claimIndex, claim] of source.document.claims.entries()) {
      if (contractorProjection && claim.modality !== "transcript") continue;
      addUnique(claimIds, claim.id, `claim ID at sources[${sourceIndex}].claims[${claimIndex}]`);
      invariant(claim.modality === "transcript", `Claim ${claim.id} is not transcript-only.`);
      invariant(Array.isArray(claim.acceptableEvidenceIds) && claim.acceptableEvidenceIds.length > 0, `Claim ${claim.id} has no acceptable Evidence.`);
      invariant(claim.annotation && typeof claim.annotation === "object", `Claim ${claim.id} has no annotation record.`);
      const projected = structuredClone(claim);
      if (contractorProjection) {
        projected.material = CONTRACTOR_REVIEW_PRIORITY_ID_SET.has(claim.id);
        projected.critical = projected.material && claim.critical === true;
      }
      claims.push(projected);
    }
    for (const [relationIndex, relation] of source.document.relations.entries()) {
      if (
        contractorProjection &&
        (!CONTRACTOR_REVIEW_PRIORITY_ID_SET.has(relation.sourceClaimId) ||
          !CONTRACTOR_REVIEW_PRIORITY_ID_SET.has(relation.targetClaimId))
      ) continue;
      addUnique(relationIds, relation.id, `relation ID at sources[${sourceIndex}].relations[${relationIndex}]`);
      relations.push(structuredClone(relation));
    }
    for (const control of source.document.transcriptNegativeControls ?? []) {
      transcriptNegativeControls.push(structuredClone(control));
    }
  }

  for (const relation of relations) {
    invariant(claimIds.has(relation.sourceClaimId), `Relation ${relation.id} has an unknown source Claim.`);
    invariant(claimIds.has(relation.targetClaimId), `Relation ${relation.id} has an unknown target Claim.`);
  }

  const eventMaterialClaimCounts = Object.fromEntries(
    [...eventIds].sort().map((eventId) => [
      eventId,
      claims.filter((claim) => claim.eventId === eventId && claim.material === true).length,
    ]),
  );
  invariant(
    Object.values(eventMaterialClaimCounts).every((count) => count >= 5 && count <= 10),
    `Every Event must contain 5 to 10 material Claims: ${JSON.stringify(eventMaterialClaimCounts)}`,
  );

  const materialClaimCount = claims.filter((claim) => claim.material === true).length;
  const criticalClaimCount = claims.filter((claim) => claim.material === true && claim.critical === true).length;
  const criticalAmbiguityCount = claims.filter(
    (claim) => claim.material === true && claim.ambiguity?.severity === "critical",
  ).length;
  const doubleAnnotatedCount = claims.filter((claim) => claim.annotation?.doubleAnnotated === true).length;
  invariant(scenarioIds.size === 3, "The combined package must contain exactly three scenarios.");
  invariant(eventIds.size === 11, "The combined package must contain exactly eleven events.");
  invariant(materialClaimCount >= 40, "The combined package must contain at least 40 material Claims.");
  invariant(criticalClaimCount >= 10, "The combined package must contain at least 10 critical material Claims.");
  invariant(criticalAmbiguityCount >= 8, "The combined package must contain at least eight critical ambiguities.");
  invariant(relations.length >= 8, "The combined package must contain at least eight Relations.");

  const sourceMetadata = sources.map((source, index) => ({
    dataset: summaries[index].dataset,
    path: source.path,
    sha256: sha256(source.raw),
    scenarioId: summaries[index].scenarioId,
    eventIds: [...summaries[index].eventIds].sort(),
    ...(summaries[index].dataset === "synthetic-contractor-v1"
      ? {
          projection: "single-author-review-priority-v1",
          selectedMaterialClaimIds: Object.fromEntries(
            Object.entries(CONTRACTOR_REVIEW_PRIORITY_IDS).map(([eventId, ids]) => [eventId, [...ids]]),
          ),
          sourceFixturePurpose: "exhaustive-multimodal-pressure-test",
        }
      : {}),
  }));

  return {
    schemaVersion: "notique-ground-truth.v1",
    dataset: "synthetic-transcript-development-v1",
    split: "development-synthetic",
    status: "single-author-development-package-not-concept-validation",
    metadata: {
      synthetic: true,
      modality: "transcript-only",
      purpose: "development-evaluation-and-regression-only",
      sourceDatasets: sourceMetadata,
      sourceProjectionNotice: "The Contractor source is projected to ten preselected transcript review priorities per Event; its raw multimodal pressure fixture is unchanged.",
      structuralCounts: {
        scenarioCount: scenarioIds.size,
        eventCount: eventIds.size,
        materialClaimCount,
        criticalClaimCount,
        criticalAmbiguityCount,
        relationCount: relations.length,
        doubleAnnotatedCount,
        independentRunCount: 0,
        eventMaterialClaimCounts,
      },
      eligibility: {
        structuralMinimumsMet: true,
        sampleEligible: false,
        blockers: [
          "Ground Truth has not completed required double annotation and adjudication.",
          "No three independent model runs are included in this package.",
          "This development set is not a blind set and cannot establish product concept validation.",
        ],
      },
    },
    scenarios: summaries.map((summary) => ({
      id: summary.scenarioId,
      dataset: summary.dataset,
      eventIds: [...summary.eventIds].sort(),
    })),
    claims,
    relations,
    transcriptNegativeControls,
  };
}

export async function loadSourceDocuments(repositoryRoot) {
  return Promise.all(SOURCE_RELATIVE_PATHS.map(async (relativePath) => {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const expectedRoot = `${path.resolve(repositoryRoot)}${path.sep}`;
    invariant(absolutePath.startsWith(expectedRoot), `Source path escapes the repository: ${relativePath}`);
    const raw = await readFile(absolutePath, "utf8");
    return { path: relativePath, raw, document: JSON.parse(raw) };
  }));
}

export function serializeCombinedGroundTruth(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function mergeSyntheticTranscriptGroundTruth(repositoryRoot) {
  const sources = await loadSourceDocuments(repositoryRoot);
  const document = buildCombinedGroundTruth(sources);
  const outputPath = path.resolve(repositoryRoot, OUTPUT_RELATIVE_PATH);
  const allowedOutputRoot = `${path.resolve(repositoryRoot, "eval", "combined")}${path.sep}`;
  invariant(outputPath.startsWith(allowedOutputRoot), "Combined output path must remain under eval/combined.");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeCombinedGroundTruth(document), "utf8");
  return { document, outputPath };
}

async function main() {
  invariant(process.argv.length === 2, "This command does not accept custom source or output paths.");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDirectory, "..");
  const { document, outputPath } = await mergeSyntheticTranscriptGroundTruth(repositoryRoot);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(repositoryRoot, outputPath),
    ...document.metadata.structuralCounts,
    sampleEligible: document.metadata.eligibility.sampleEligible,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
