import { createHash } from "node:crypto";

export const REALTOR_AB_SCHEMA_VERSION = "notique-realtor-draft-context-ab.v1";
export const REALTOR_AB_ARM_SCHEMA_VERSION = "notique-realtor-draft-context-ab-arm.v1";
export const REALTOR_AB_ADJUDICATION_SCHEMA_VERSION =
  "notique-realtor-draft-context-ab-adjudication.v1";

export const REALTOR_AB_CONTRACT = Object.freeze({
  fixtureId: "synthetic-realtor-v1",
  contextSchema: "context-pack.v3",
  runPrompt: "claim-extraction-prompt.v9",
  runSchema: "claim-extraction.v3",
  inventoryPrompt: "claim-extraction-prompt.v9:inventory",
  inventorySchema: "claim-inventory.v3",
  inventoryEffort: "xhigh",
  verifyPrompt: "claim-extraction-prompt.v9:verify",
  verifySchema: "claim-verification.v4",
  verifyEffort: "high",
  summaryPrompt: "event-summary-prompt.v2",
  summarySchema: "event-summary.v2",
  readablePrompt: "readable-transcript-prompt.v2",
  readableSchema: "readable-transcript.v1",
  artifactEffort: "high",
});

const DRAFT_LINK_RELATION_TYPE = Object.freeze({
  same: "informed_by",
  changed: "supersedes",
  conflicting: "contradicts",
  possibly_answered: "resolves",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function uniqueBy(items, keyOf) {
  const output = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const values = output.get(key) ?? [];
    values.push(item);
    output.set(key, values);
  }
  return output;
}

function byId(items, label) {
  const output = new Map();
  for (const item of items) {
    invariant(typeof item?.id === "string" && item.id, `${label} item is missing an id.`);
    invariant(!output.has(item.id), `Duplicate ${label} id: ${item.id}`);
    output.set(item.id, item);
  }
  return output;
}

function inputContentManifest(run) {
  return (run.prediction.frozen.inputManifest ?? []).map((item) => ({
    kind: item.kind ?? null,
    sha256: item.sha256 ?? item.content_sha256 ?? null,
    sizeBytes: item.size_bytes ?? item.sizeBytes ?? null,
  }));
}

function modelParametersWithoutDraft(value) {
  const copy = structuredClone(value ?? {});
  delete copy.draft_context;
  delete copy.draft_context_manifest;
  // This reservation is derived from the selected Context Pack, so it is
  // expected to grow when the treatment includes Draft Memory. It is an
  // outcome to report, not a second experimental variable.
  delete copy.reserved_input_tokens;
  return copy;
}

function latestSucceededStage(run, stageName) {
  const candidates = (run.stages ?? [])
    .filter((stage) => stage.stage === stageName && stage.status === "succeeded")
    .sort((left, right) => finite(right.attempt) - finite(left.attempt));
  return candidates[0] ?? null;
}

function assertRunContract(run, expectedDraftContext) {
  const frozen = run.prediction?.frozen;
  invariant(frozen, `Run ${run.runId} has no frozen prediction metadata.`);
  invariant(
    frozen.promptVersion === REALTOR_AB_CONTRACT.runPrompt,
    `Run ${run.runId} prompt is ${frozen.promptVersion}; expected ${REALTOR_AB_CONTRACT.runPrompt}.`,
  );
  invariant(
    frozen.schemaVersion === REALTOR_AB_CONTRACT.runSchema,
    `Run ${run.runId} schema is ${frozen.schemaVersion}; expected ${REALTOR_AB_CONTRACT.runSchema}.`,
  );
  invariant(
    frozen.modelParameters?.two_pass_pipeline === true,
    `Run ${run.runId} did not freeze the two-pass pipeline.`,
  );
  invariant(
    frozen.modelParameters?.draft_context === expectedDraftContext,
    `Run ${run.runId} draft_context does not match its A/B arm.`,
  );

  const inventory = latestSucceededStage(run, "inventory");
  const verify = latestSucceededStage(run, "verify");
  invariant(inventory, `Run ${run.runId} has no succeeded inventory stage.`);
  invariant(verify, `Run ${run.runId} has no succeeded verify stage.`);
  invariant(
    inventory.prompt_version === REALTOR_AB_CONTRACT.inventoryPrompt &&
      inventory.schema_version === REALTOR_AB_CONTRACT.inventorySchema &&
      inventory.reasoning_effort === REALTOR_AB_CONTRACT.inventoryEffort,
    `Run ${run.runId} inventory contract is not v9/v3/xhigh.`,
  );
  invariant(
    verify.prompt_version === REALTOR_AB_CONTRACT.verifyPrompt &&
      verify.schema_version === REALTOR_AB_CONTRACT.verifySchema &&
      verify.reasoning_effort === REALTOR_AB_CONTRACT.verifyEffort,
    `Run ${run.runId} verify contract is not v9/v4/high.`,
  );
  const artifacts = new Map((run.artifactRuns ?? []).map((artifact) => [artifact.kind, artifact]));
  const summary = artifacts.get("summary");
  const readable = artifacts.get("readable_transcript");
  invariant(summary?.status === "succeeded", `Run ${run.runId} Summary artifact did not succeed.`);
  invariant(readable?.status === "succeeded", `Run ${run.runId} Readable Transcript artifact did not succeed.`);
  invariant(
    summary.prompt_version === REALTOR_AB_CONTRACT.summaryPrompt &&
      summary.schema_version === REALTOR_AB_CONTRACT.summarySchema &&
      summary.reasoning_effort === REALTOR_AB_CONTRACT.artifactEffort,
    `Run ${run.runId} Summary contract does not match ${REALTOR_AB_CONTRACT.summaryPrompt} / ${REALTOR_AB_CONTRACT.summarySchema} / ${REALTOR_AB_CONTRACT.artifactEffort}.`,
  );
  invariant(
    readable.prompt_version === REALTOR_AB_CONTRACT.readablePrompt &&
      readable.schema_version === REALTOR_AB_CONTRACT.readableSchema &&
      readable.reasoning_effort === REALTOR_AB_CONTRACT.artifactEffort,
    `Run ${run.runId} Readable Transcript contract does not match ${REALTOR_AB_CONTRACT.readablePrompt} / ${REALTOR_AB_CONTRACT.readableSchema} / ${REALTOR_AB_CONTRACT.artifactEffort}.`,
  );
}

export function validateArmSnapshot(arm) {
  invariant(arm?.schemaVersion === REALTOR_AB_ARM_SCHEMA_VERSION, "Unsupported A/B arm schema.");
  invariant(arm.arm === "control" || arm.arm === "treatment", "A/B arm must be control or treatment.");
  const enabled = arm.arm === "treatment";
  invariant(arm.draftContextEnabled === enabled, `${arm.arm} has the wrong draftContextEnabled flag.`);
  invariant(arm.fixtureId === REALTOR_AB_CONTRACT.fixtureId, "A/B runner only accepts the fixed Realtor fixture.");
  invariant(arm.contextSchema === REALTOR_AB_CONTRACT.contextSchema, "A/B arm did not freeze Context Pack v3.");
  invariant(Array.isArray(arm.runs) && arm.runs.length === 4, `${arm.arm} must contain exactly four Event runs.`);
  const eventIds = new Set();
  for (const run of arm.runs) {
    invariant(typeof run.runId === "string" && run.runId, `${arm.arm} has a Run without an ID.`);
    invariant(typeof run.eventKey === "string" && run.eventKey, `${run.runId} has no fixture Event key.`);
    invariant(!eventIds.has(run.eventKey), `${arm.arm} repeats fixture Event ${run.eventKey}.`);
    eventIds.add(run.eventKey);
    assertRunContract(run, enabled);
  }
  if (enabled) {
    invariant(
      arm.runs.slice(1).every((run) =>
        Array.isArray(run.prediction.frozen.modelParameters.draft_context_manifest) &&
        run.prediction.frozen.modelParameters.draft_context_manifest.length > 0),
      "Treatment Events 2-4 did not receive prior draft candidates.",
    );
  } else {
    invariant(
      arm.runs.every((run) =>
        !Array.isArray(run.prediction.frozen.modelParameters.draft_context_manifest) ||
        run.prediction.frozen.modelParameters.draft_context_manifest.length === 0),
      "Control unexpectedly froze draft candidates.",
    );
  }
  return arm;
}

export function validateComparableArms(control, treatment) {
  validateArmSnapshot(control);
  validateArmSnapshot(treatment);
  invariant(control.arm === "control", "First arm must be control.");
  invariant(treatment.arm === "treatment", "Second arm must be treatment.");
  invariant(control.fixtureSha256 === treatment.fixtureSha256, "A/B arms used different fixture manifests.");
  invariant(control.groundTruthSha256 === treatment.groundTruthSha256, "A/B arms used different Ground Truth.");
  invariant(control.actionGroundTruthSha256 === treatment.actionGroundTruthSha256, "A/B arms used different action Ground Truth.");
  invariant(control.commitSha === treatment.commitSha, "A/B arms used different source commits.");
  const treatmentByEvent = new Map(treatment.runs.map((run) => [run.eventKey, run]));
  for (const controlRun of control.runs) {
    const treatmentRun = treatmentByEvent.get(controlRun.eventKey);
    invariant(treatmentRun, `Treatment is missing ${controlRun.eventKey}.`);
    invariant(
      canonical(inputContentManifest(controlRun)) === canonical(inputContentManifest(treatmentRun)),
      `${controlRun.eventKey} used different source material across A/B arms.`,
    );
    invariant(
      canonical(modelParametersWithoutDraft(controlRun.prediction.frozen.modelParameters)) ===
        canonical(modelParametersWithoutDraft(treatmentRun.prediction.frozen.modelParameters)),
      `${controlRun.eventKey} changed model parameters beyond draft_context.`,
    );
    for (const key of ["provider", "model", "promptVersion", "schemaVersion", "parserVersion"]) {
      invariant(
        controlRun.prediction.frozen[key] === treatmentRun.prediction.frozen[key],
        `${controlRun.eventKey} changed ${key} across A/B arms.`,
      );
    }
  }
  return { comparable: true, eventCount: control.runs.length };
}

function stageTelemetry(run) {
  return (run.stages ?? []).map((stage) => ({
    stage: stage.stage,
    attempt: stage.attempt,
    status: stage.status,
    reasoningEffort: stage.reasoning_effort,
    inputTokens: stage.input_tokens,
    outputTokens: stage.output_tokens,
    cachedTokens: stage.cached_tokens,
    estimatedCostUsd: stage.estimated_cost_usd,
    durationMs: stage.duration_ms,
    errorCode: stage.error_code,
  }));
}

export function summarizeArm(arm) {
  validateArmSnapshot(arm);
  const predictions = arm.runs.flatMap((run) => run.prediction.claims);
  const evidence = predictions.flatMap((claim) => claim.evidence ?? []);
  const formalRelations = arm.runs.flatMap((run) => run.prediction.relations ?? []);
  const stages = arm.runs.flatMap(stageTelemetry);
  const factUsage = arm.runs.reduce((total, run) => ({
    inputTokens: total.inputTokens + finite(run.prediction.usage?.inputTokens),
    outputTokens: total.outputTokens + finite(run.prediction.usage?.outputTokens),
    cachedTokens: total.cachedTokens + finite(run.prediction.usage?.cachedTokens),
    costUsd: total.costUsd + finite(run.prediction.usage?.costUsd),
    latencyMs: total.latencyMs + finite(run.prediction.usage?.latencyMs),
  }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, latencyMs: 0 });
  const artifactUsage = arm.runs.flatMap((run) => run.artifactRuns ?? []).reduce((total, run) => ({
    inputTokens: total.inputTokens + finite(run.input_tokens),
    outputTokens: total.outputTokens + finite(run.output_tokens),
    cachedTokens: total.cachedTokens + finite(run.cached_tokens),
    costUsd: total.costUsd + finite(run.estimated_cost_usd),
    modelDurationMs: total.modelDurationMs + finite(run.duration_ms),
  }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, modelDurationMs: 0 });
  const usage = {
    inputTokens: factUsage.inputTokens + artifactUsage.inputTokens,
    outputTokens: factUsage.outputTokens + artifactUsage.outputTokens,
    cachedTokens: factUsage.cachedTokens + artifactUsage.cachedTokens,
    costUsd: factUsage.costUsd + artifactUsage.costUsd,
    // Extraction end-to-end latency already includes any wait for the parallel
    // Readable Transcript. Do not double-count artifact duration as wall time.
    latencyMs: factUsage.latencyMs,
  };
  return {
    arm: arm.arm,
    draftContextEnabled: arm.draftContextEnabled,
    runCount: arm.runs.length,
    claimCount: predictions.length,
    claimTypeCounts: Object.fromEntries(
      [...uniqueBy(predictions, (claim) => claim.type).entries()]
        .map(([type, claims]) => [type, claims.length]),
    ),
    occurrenceCount: predictions.filter((claim) => claim.classification === "reaffirmed").length,
    formalRelationSuggestionCount: formalRelations.length,
    draftLinkSuggestionCount: arm.draftMemory?.links?.length ?? 0,
    nextActionSuggestionCount: predictions.filter((claim) => claim.type === "next_action").length,
    claimsWithoutEvidence: predictions.filter((claim) => !claim.evidence?.length).length,
    evidence: {
      count: evidence.length,
      validIdCount: evidence.filter((item) => item.idValid === true).length,
      exactQuoteCount: evidence.filter((item) =>
        item.kind !== "transcript" && item.kind !== "text" ? true : item.quoteExact === true).length,
    },
    usage,
    factUsage,
    artifactUsage,
    stages,
  };
}

function allRelationSuggestions(arm) {
  const predictionByProductionClaimId = new Map();
  for (const run of arm.runs) {
    for (const claim of run.prediction.claims) {
      // Reaffirmed Occurrences point back to an earlier production Claim. Keep
      // the original Claim prediction as the relation target instead of
      // overwriting it with a later Occurrence prediction.
      if (claim.productionClaimId && !predictionByProductionClaimId.has(claim.productionClaimId)) {
        predictionByProductionClaimId.set(claim.productionClaimId, claim.id);
      }
    }
  }
  const formal = arm.runs.flatMap((run) =>
    (run.prediction.relations ?? []).map((relation) => ({
      id: `formal:${relation.id}`,
      kind: "formal_relation_suggestion",
      type: relation.type,
      sourcePredictionId: relation.sourcePredictionId,
      targetPredictionId: predictionByProductionClaimId.get(relation.targetProductionClaimId) ?? null,
      reason: relation.reason,
    })),
  );
  const draft = (arm.draftMemory?.links ?? []).map((link) => ({
    id: `draft:${link.id}`,
    kind: "draft_link_suggestion",
    type: DRAFT_LINK_RELATION_TYPE[link.type] ?? null,
    draftLinkType: link.type,
    sourcePredictionId: predictionByProductionClaimId.get(link.source_claim_id) ?? null,
    targetPredictionId: predictionByProductionClaimId.get(link.target_draft_claim_id) ?? null,
    reason: link.reason,
  }));
  return [...formal, ...draft];
}

export function buildAdjudicationTemplate(arm, groundTruth, actionGroundTruth) {
  validateArmSnapshot(arm);
  invariant(groundTruth?.schemaVersion === "notique-ground-truth.v1", "Unsupported Realtor Ground Truth.");
  invariant(
    actionGroundTruth?.schemaVersion === "notique-realtor-action-ground-truth.v1",
    "Unsupported Realtor action Ground Truth.",
  );
  const runs = arm.runs.map((run) => {
    const truthClaims = groundTruth.claims.filter((claim) => claim.eventId === run.eventKey);
    const actionTruth = actionGroundTruth.actions.filter((action) => action.eventId === run.eventKey);
    return {
      runId: run.runId,
      eventKey: run.eventKey,
      claimOptions: truthClaims.map((claim) => ({
        id: claim.id,
        type: claim.type,
        statement: claim.statement,
        expectedClassification: claim.expectedClassification,
        acceptableEvidenceIds: claim.acceptableEvidenceIds,
      })),
      actionOptions: actionTruth,
      claims: Object.fromEntries(run.prediction.claims.map((claim) => [claim.id, {
        statement: claim.statement,
        type: claim.type,
        matchedGroundTruthId: null,
        citationSupport: "unreviewed",
        reaffirmedTargetCorrect: claim.classification === "reaffirmed" ? null : true,
        matchedActionExpectationId: null,
        actionOwnerCorrect: claim.type === "next_action" ? null : true,
        actionDueCorrect: claim.type === "next_action" ? null : true,
        actionSourceCorrect: claim.type === "next_action" ? null : true,
        notes: "",
      }])),
    };
  });
  const relations = Object.fromEntries(allRelationSuggestions(arm).map((relation) => [relation.id, {
    ...relation,
    matchedGroundTruthRelationId: null,
    notes: "",
  }]));
  return {
    schemaVersion: REALTOR_AB_ADJUDICATION_SCHEMA_VERSION,
    arm: arm.arm,
    fixtureId: arm.fixtureId,
    sourceArmSha256: sha256Json(arm),
    instructions: [
      "Read the original transcript before mapping any prediction.",
      "Map each prediction to at most one Ground Truth Claim; leave false positives as null.",
      "Mark citationSupport fully_supports only when the cited original Evidence supports the whole Claim.",
      "For reaffirmed predictions, reaffirmedTargetCorrect must confirm the production target is the intended earlier fact.",
      "For next_action, map the action expectation and independently check owner, due/deadline, and original source.",
      "Map formal Relations and draft links to Ground Truth Relations; do not treat a proposed draft link as activated state.",
    ],
    runs,
    relations,
    formalStateChangeErrorCount: null,
    reviewer: "",
    reviewedAt: null,
  };
}

export function sha256Json(value) {
  return createHash("sha256").update(`${canonical(value)}\n`).digest("hex");
}

function timestampDistance(prediction, truth) {
  if (!Number.isFinite(truth.timestampMs)) return null;
  const distances = (prediction.evidence ?? []).flatMap((item) => {
    if (!Number.isFinite(item.startMs)) return [];
    const start = item.startMs;
    const end = Number.isFinite(item.endMs) ? item.endMs : start;
    if (truth.timestampMs >= start && truth.timestampMs <= end) return [0];
    return [Math.min(Math.abs(truth.timestampMs - start), Math.abs(truth.timestampMs - end))];
  });
  return distances.length ? Math.min(...distances) : null;
}

function decisionMap(adjudication, arm) {
  invariant(
    adjudication?.schemaVersion === REALTOR_AB_ADJUDICATION_SCHEMA_VERSION,
    "Unsupported Realtor A/B adjudication schema.",
  );
  invariant(adjudication.arm === arm.arm, "Adjudication belongs to the wrong A/B arm.");
  invariant(adjudication.sourceArmSha256 === sha256Json(arm), "A/B arm changed after its adjudication template was created.");
  invariant(typeof adjudication.reviewer === "string" && adjudication.reviewer.trim(), "Adjudication requires a reviewer name.");
  invariant(
    typeof adjudication.reviewedAt === "string" && Number.isFinite(Date.parse(adjudication.reviewedAt)),
    "Adjudication requires a valid reviewedAt timestamp.",
  );
  const runDecisions = new Map(adjudication.runs.map((run) => [run.runId, run]));
  const claims = new Map();
  for (const run of arm.runs) {
    const decisions = runDecisions.get(run.runId);
    invariant(decisions, `Missing adjudication for Run ${run.runId}.`);
    for (const claim of run.prediction.claims) {
      const decision = decisions.claims?.[claim.id];
      invariant(decision, `Missing adjudication for Claim ${claim.id}.`);
      invariant(
        ["fully_supports", "partially_supports", "does_not_support"].includes(decision.citationSupport),
        `Claim ${claim.id} requires a citationSupport decision.`,
      );
      if (claim.classification === "reaffirmed") {
        invariant(
          typeof decision.reaffirmedTargetCorrect === "boolean",
          `Reaffirmed Claim ${claim.id} requires reaffirmedTargetCorrect.`,
        );
      }
      if (claim.type === "next_action") {
        invariant(
          typeof decision.actionOwnerCorrect === "boolean" &&
            typeof decision.actionDueCorrect === "boolean" &&
            typeof decision.actionSourceCorrect === "boolean",
          `Next Action ${claim.id} requires owner, due, and source decisions.`,
        );
      }
      claims.set(claim.id, decision);
    }
  }
  const relationSuggestions = allRelationSuggestions(arm);
  const relations = new Map();
  for (const relation of relationSuggestions) {
    const decision = adjudication.relations?.[relation.id];
    invariant(decision, `Missing adjudication for relation suggestion ${relation.id}.`);
    relations.set(relation.id, decision);
  }
  invariant(
    Number.isInteger(adjudication.formalStateChangeErrorCount) &&
      adjudication.formalStateChangeErrorCount >= 0,
    "formalStateChangeErrorCount must be reviewed and set to a non-negative integer.",
  );
  return { claims, relations, relationSuggestions };
}

function validRelationSuggestion(suggestion, relationTruth, claimDecisionById) {
  if (!relationTruth || suggestion.type !== relationTruth.type) return false;
  const sourceTruth = claimDecisionById.get(suggestion.sourcePredictionId)?.matchedGroundTruthId ?? null;
  const targetTruth = claimDecisionById.get(suggestion.targetPredictionId)?.matchedGroundTruthId ?? null;
  return sourceTruth === relationTruth.sourceClaimId && targetTruth === relationTruth.targetClaimId;
}

export function scoreArm(arm, adjudication, groundTruth, actionGroundTruth) {
  validateArmSnapshot(arm);
  const decisions = decisionMap(adjudication, arm);
  const truthById = byId(groundTruth.claims, "Ground Truth Claim");
  const relationTruthById = byId(groundTruth.relations, "Ground Truth Relation");
  const actionTruthById = byId(actionGroundTruth.actions, "Action Ground Truth");
  const predictions = arm.runs.flatMap((run) => run.prediction.claims);
  const predictionById = byId(predictions, "prediction Claim");
  const matchedClaims = uniqueBy(
    predictions.filter((prediction) => decisions.claims.get(prediction.id).matchedGroundTruthId),
    (prediction) => decisions.claims.get(prediction.id).matchedGroundTruthId,
  );
  for (const truthId of matchedClaims.keys()) {
    invariant(truthById.has(truthId), `Adjudication references unknown Ground Truth Claim ${truthId}.`);
  }
  const uniquelySupported = new Map(
    [...matchedClaims.entries()].filter(([, matched]) =>
      matched.length === 1 && decisions.claims.get(matched[0].id).citationSupport === "fully_supports"),
  );
  const materialTruth = groundTruth.claims.filter((claim) => claim.material === true);
  const criticalTruth = materialTruth.filter((claim) => claim.critical === true);
  const evidence = predictions.flatMap((claim) => claim.evidence ?? []);
  const transcriptEvidence = evidence.filter((item) => item.kind === "transcript" || item.kind === "text");
  const timestampDistances = [];
  let timestampExpectationCount = 0;
  for (const [truthId, matched] of uniquelySupported) {
    const truth = truthById.get(truthId);
    if (Number.isFinite(truth.timestampMs)) timestampExpectationCount += 1;
    const distance = timestampDistance(matched[0], truth);
    if (distance != null) timestampDistances.push(distance);
  }

  const relationMatches = uniqueBy(
    decisions.relationSuggestions.filter((suggestion) =>
      decisions.relations.get(suggestion.id).matchedGroundTruthRelationId),
    (suggestion) => decisions.relations.get(suggestion.id).matchedGroundTruthRelationId,
  );
  const correctRelations = new Map();
  for (const [truthId, suggestions] of relationMatches) {
    invariant(relationTruthById.has(truthId), `Adjudication references unknown Ground Truth Relation ${truthId}.`);
    if (
      suggestions.length === 1 &&
      validRelationSuggestion(suggestions[0], relationTruthById.get(truthId), decisions.claims)
    ) {
      correctRelations.set(truthId, suggestions[0]);
    }
  }

  const reaffirmedTruth = groundTruth.claims.filter((claim) => claim.expectedClassification === "reaffirmed");
  const correctReaffirmed = reaffirmedTruth.filter((truth) => {
    const matched = uniquelySupported.get(truth.id) ?? [];
    if (matched.length !== 1) return false;
    const prediction = matched[0];
    return prediction.classification === "reaffirmed" &&
      decisions.claims.get(prediction.id).reaffirmedTargetCorrect === true;
  });

  const actionPredictions = predictions.filter((claim) => claim.type === "next_action");
  const actionMatches = uniqueBy(
    actionPredictions.filter((prediction) =>
      decisions.claims.get(prediction.id).matchedActionExpectationId),
    (prediction) => decisions.claims.get(prediction.id).matchedActionExpectationId,
  );
  for (const actionId of actionMatches.keys()) {
    invariant(actionTruthById.has(actionId), `Adjudication references unknown Action Ground Truth ${actionId}.`);
  }
  const correctActions = new Map(
    [...actionMatches.entries()].filter(([, matched]) => {
      if (matched.length !== 1) return false;
      const decision = decisions.claims.get(matched[0].id);
      return decision.actionOwnerCorrect === true &&
        decision.actionDueCorrect === true &&
        decision.actionSourceCorrect === true;
    }),
  );
  const uniquelyMatchedActions = new Map(
    [...actionMatches.entries()].filter(([, matched]) => matched.length === 1),
  );
  const actionOwnerCorrect = [...uniquelyMatchedActions.values()].filter(([prediction]) =>
    decisions.claims.get(prediction.id).actionOwnerCorrect === true).length;
  const actionDueCorrect = [...uniquelyMatchedActions.values()].filter(([prediction]) =>
    decisions.claims.get(prediction.id).actionDueCorrect === true).length;
  const actionSourceCorrect = [...uniquelyMatchedActions.values()].filter(([prediction]) =>
    decisions.claims.get(prediction.id).actionSourceCorrect === true).length;

  const summary = summarizeArm(arm);
  const metrics = {
    claimPrecision: ratio(uniquelySupported.size, predictions.length),
    materialRecall: ratio(
      materialTruth.filter((truth) => uniquelySupported.has(truth.id)).length,
      materialTruth.length,
    ),
    criticalRecall: ratio(
      criticalTruth.filter((truth) => uniquelySupported.has(truth.id)).length,
      criticalTruth.length,
    ),
    claimsWithEvidence: ratio(
      predictions.filter((claim) => claim.evidence?.length > 0).length,
      predictions.length,
    ),
    evidenceIdAccuracy: ratio(evidence.filter((item) => item.idValid === true).length, evidence.length),
    transcriptQuoteAccuracy: ratio(
      transcriptEvidence.filter((item) => item.quoteExact === true).length,
      transcriptEvidence.length,
    ),
    timestampAccuracy: {
      expectedCount: timestampExpectationCount,
      sampleCount: timestampDistances.length,
      maxDistanceMs: timestampDistances.length ? Math.max(...timestampDistances) : null,
      withinFiveSeconds: ratio(
        timestampDistances.filter((distance) => distance < 5_000).length,
        timestampDistances.length,
      ),
    },
    relationPrecision: ratio(correctRelations.size, decisions.relationSuggestions.length),
    relationRecall: ratio(correctRelations.size, groundTruth.relations.length),
    reaffirmedAccuracy: ratio(correctReaffirmed.length, reaffirmedTruth.length),
    actionPrecision: ratio(correctActions.size, actionPredictions.length),
    actionRecall: ratio(correctActions.size, actionGroundTruth.actions.length),
    actionOwnerAccuracy: ratio(actionOwnerCorrect, actionGroundTruth.actions.length),
    actionDueAccuracy: ratio(actionDueCorrect, actionGroundTruth.actions.length),
    actionSourceAccuracy: ratio(actionSourceCorrect, actionGroundTruth.actions.length),
    actionFieldAccuracy: ratio(correctActions.size, actionGroundTruth.actions.length),
    formalStateChangeErrorCount: adjudication.formalStateChangeErrorCount,
    usage: summary.usage,
    factUsage: summary.factUsage,
    artifactUsage: summary.artifactUsage,
  };
  const checks = [
    ["claim_precision", metrics.claimPrecision.value >= 0.95, metrics.claimPrecision.value, ">= 0.95"],
    ["material_recall", metrics.materialRecall.value >= 0.9, metrics.materialRecall.value, ">= 0.90"],
    ["critical_recall", metrics.criticalRecall.value === 1, metrics.criticalRecall.value, "1.00"],
    ["claims_have_evidence", metrics.claimsWithEvidence.value === 1, metrics.claimsWithEvidence.value, "1.00"],
    ["evidence_id_accuracy", metrics.evidenceIdAccuracy.value === 1, metrics.evidenceIdAccuracy.value, "1.00"],
    ["quote_accuracy", metrics.transcriptQuoteAccuracy.value === 1, metrics.transcriptQuoteAccuracy.value, "1.00"],
    ["timestamp_accuracy", metrics.timestampAccuracy.sampleCount === metrics.timestampAccuracy.expectedCount && metrics.timestampAccuracy.maxDistanceMs != null && metrics.timestampAccuracy.maxDistanceMs < 5_000, metrics.timestampAccuracy, "complete coverage and < 5000 ms"],
    ["relation_precision", metrics.relationPrecision.value >= 0.9, metrics.relationPrecision.value, ">= 0.90"],
    ["relation_recall", metrics.relationRecall.value >= 0.9, metrics.relationRecall.value, ">= 0.90"],
    ["reaffirmed_accuracy", metrics.reaffirmedAccuracy.value >= 0.95, metrics.reaffirmedAccuracy.value, ">= 0.95"],
    ["action_precision", metrics.actionPrecision.value >= 0.95, metrics.actionPrecision.value, ">= 0.95"],
    ["action_recall", metrics.actionRecall.value === 1, metrics.actionRecall.value, "1.00"],
    ["action_owner", metrics.actionOwnerAccuracy.value === 1, metrics.actionOwnerAccuracy.value, "1.00"],
    ["action_due", metrics.actionDueAccuracy.value === 1, metrics.actionDueAccuracy.value, "1.00"],
    ["action_source", metrics.actionSourceAccuracy.value === 1, metrics.actionSourceAccuracy.value, "1.00"],
    ["no_formal_state_error", metrics.formalStateChangeErrorCount === 0, metrics.formalStateChangeErrorCount, 0],
  ].map(([name, passed, actual, expected]) => ({ name, passed, actual, expected }));
  return {
    arm: arm.arm,
    metrics,
    gates: { pass: checks.every((check) => check.passed), checks },
    counts: {
      predictions: predictions.length,
      uniquelySupportedClaims: uniquelySupported.size,
      relationSuggestions: decisions.relationSuggestions.length,
      correctRelations: correctRelations.size,
      actionSuggestions: actionPredictions.length,
      correctActions: correctActions.size,
    },
    unadjudicatedIds: [...predictionById.keys()].filter((id) =>
      decisions.claims.get(id).citationSupport === "unreviewed"),
  };
}

function nondecreasing(treatment, control) {
  if (treatment == null || control == null) return false;
  return treatment >= control;
}

export function buildScoredComparison({ control, treatment, controlAdjudication, treatmentAdjudication, groundTruth, actionGroundTruth }) {
  const comparable = validateComparableArms(control, treatment);
  const controlScore = scoreArm(control, controlAdjudication, groundTruth, actionGroundTruth);
  const treatmentScore = scoreArm(treatment, treatmentAdjudication, groundTruth, actionGroundTruth);
  const controlTokens = controlScore.metrics.usage.inputTokens + controlScore.metrics.usage.outputTokens;
  const treatmentTokens = treatmentScore.metrics.usage.inputTokens + treatmentScore.metrics.usage.outputTokens;
  const tokenIncrease = controlTokens === 0 ? null : (treatmentTokens - controlTokens) / controlTokens;
  const controlFactTokens = controlScore.metrics.factUsage.inputTokens + controlScore.metrics.factUsage.outputTokens;
  const treatmentFactTokens = treatmentScore.metrics.factUsage.inputTokens + treatmentScore.metrics.factUsage.outputTokens;
  const factTokenIncrease = controlFactTokens === 0
    ? null
    : (treatmentFactTokens - controlFactTokens) / controlFactTokens;
  const latencyIncrease = controlScore.metrics.usage.latencyMs === 0
    ? null
    : (treatmentScore.metrics.usage.latencyMs - controlScore.metrics.usage.latencyMs) /
      controlScore.metrics.usage.latencyMs;
  const trustedMetrics = [
    "claimPrecision",
    "materialRecall",
    "criticalRecall",
    "evidenceIdAccuracy",
    "transcriptQuoteAccuracy",
    "relationPrecision",
    "relationRecall",
    "reaffirmedAccuracy",
    "actionPrecision",
    "actionRecall",
    "actionOwnerAccuracy",
    "actionDueAccuracy",
    "actionSourceAccuracy",
    "actionFieldAccuracy",
  ];
  const regressionChecks = trustedMetrics.map((name) => ({
    name: `no_regression:${name}`,
    control: controlScore.metrics[name].value,
    treatment: treatmentScore.metrics[name].value,
    passed: nondecreasing(treatmentScore.metrics[name].value, controlScore.metrics[name].value),
  }));
  const checks = [
    { name: "comparable_inputs", passed: comparable.comparable, actual: comparable.comparable, expected: true },
    { name: "treatment_quality_gates", passed: treatmentScore.gates.pass, actual: treatmentScore.gates.pass, expected: true },
    { name: "token_increase", passed: tokenIncrease != null && tokenIncrease <= 0.25, actual: tokenIncrease, expected: "<= 0.25" },
    { name: "fact_token_increase", passed: factTokenIncrease != null && factTokenIncrease <= 0.25, actual: factTokenIncrease, expected: "<= 0.25" },
    ...regressionChecks,
  ];
  return {
    schemaVersion: "notique-realtor-draft-context-ab-score.v1",
    generatedAt: new Date().toISOString(),
    comparable,
    control: controlScore,
    treatment: treatmentScore,
    comparison: {
      tokenIncrease,
      factTokenIncrease,
      latencyIncrease,
      trustedMetricRegressions: regressionChecks.filter((check) => !check.passed).map((check) => check.name),
    },
    enableDraftContext: checks.every((check) => check.passed),
    gates: { pass: checks.every((check) => check.passed), checks },
    limitations: [
      "This four-Event synthetic A/B is a development regression, not real-buyer concept validation.",
      "One Run per arm does not establish the three-run semantic stability gate.",
      "Latency is reported but has no pass threshold until a product SLO is frozen.",
    ],
  };
}
