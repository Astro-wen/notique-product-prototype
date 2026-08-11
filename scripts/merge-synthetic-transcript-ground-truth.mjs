#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_RELATIVE_PATHS = Object.freeze([
  "eval/cases/synthetic-realtor-v1/ground-truth.json",
  "eval/cases/synthetic-insurance-v1/ground-truth.json",
]);

export const OUTPUT_RELATIVE_PATH =
  "eval/combined/synthetic-transcript-development-v1.ground-truth.json";

const EXPECTED_DATASETS = new Set([
  "synthetic-realtor-v1",
  "synthetic-insurance-v1",
]);

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
  invariant(!source.path.includes("synthetic-contractor"), "The contractor pressure fixture must not enter this transcript development package.");

  const scenarioIds = new Set(document.claims.map((claim) => nonEmptyString(claim.scenarioId, `${prefix}.claims[].scenarioId`)));
  invariant(scenarioIds.size === 1, `${dataset} must contain exactly one scenario.`);
  const scenarioId = [...scenarioIds][0];
  const eventIds = [...new Set(document.claims.map((claim) => nonEmptyString(claim.eventId, `${prefix}.claims[].eventId`)))];
  invariant(eventIds.length >= 3 && eventIds.length <= 5, `${dataset} must contain 3 to 5 events.`);

  return { dataset, scenarioId, eventIds };
}

export function buildCombinedGroundTruth(sources) {
  invariant(Array.isArray(sources) && sources.length === 2, "Exactly two transcript source datasets are required.");
  const sourcePaths = sources.map((source, index) => nonEmptyString(source.path, `sources[${index}].path`));
  invariant(new Set(sourcePaths).size === sourcePaths.length, "Source paths must be unique.");

  const summaries = sources.map(sourceSummary);
  invariant(new Set(summaries.map((item) => item.dataset)).size === EXPECTED_DATASETS.size, "Both required datasets must be present exactly once.");

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
    for (const [claimIndex, claim] of source.document.claims.entries()) {
      addUnique(claimIds, claim.id, `claim ID at sources[${sourceIndex}].claims[${claimIndex}]`);
      invariant(claim.modality === "transcript", `Claim ${claim.id} is not transcript-only.`);
      invariant(Array.isArray(claim.acceptableEvidenceIds) && claim.acceptableEvidenceIds.length > 0, `Claim ${claim.id} has no acceptable Evidence.`);
      invariant(claim.annotation && typeof claim.annotation === "object", `Claim ${claim.id} has no annotation record.`);
      claims.push(structuredClone(claim));
    }
    for (const [relationIndex, relation] of source.document.relations.entries()) {
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
  const criticalAmbiguityCount = claims.filter((claim) => claim.ambiguity?.severity === "critical").length;
  const doubleAnnotatedCount = claims.filter((claim) => claim.annotation?.doubleAnnotated === true).length;
  invariant(scenarioIds.size === 2, "The combined package must contain exactly two scenarios.");
  invariant(eventIds.size === 8, "The combined package must contain exactly eight events.");
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
      excludedDatasets: ["synthetic-contractor-v1"],
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
