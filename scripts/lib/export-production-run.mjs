const TERMINAL_SUCCESS_STATUSES = new Set(["succeeded", "completed_with_warnings"]);
const VIEW_PATHS = [
  ["folderSummary", "views/folder-summary"],
  ["timeline", "views/timeline"],
  ["decisions", "views/decisions"],
  ["preferences", "views/preferences"],
  ["openQuestions", "views/open-questions"],
  ["risks", "views/risks"],
  ["gapCheck", "gap-check"],
  ["agenda", "next-meeting-agenda"],
  ["briefCard", "brief-card"],
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return value;
}

function array(value, label) {
  invariant(Array.isArray(value), `${label} must be an array.`);
  return value;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function string(value) {
  return typeof value === "string" ? value : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => key !== "generated_at" && key !== "request_id")
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonical(value) {
  return JSON.stringify(stableValue(value));
}

function localHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function normalizeApiRoot({ baseUrl, environment, allowedTestHost }) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("--base-url must be an absolute HTTP or HTTPS URL.");
  }
  invariant(url.protocol === "http:" || url.protocol === "https:", "Only HTTP or HTTPS API URLs are allowed.");
  invariant(!url.username && !url.password, "Credentials must not be embedded in --base-url.");
  invariant(!url.search && !url.hash, "--base-url must not contain a query string or fragment.");
  invariant(
    url.pathname === "/" || url.pathname === "" || url.pathname.replace(/\/$/, "") === "/api/v1",
    "--base-url may only point to the site root or /api/v1.",
  );

  if (!localHostname(url.hostname)) {
    invariant(environment === "test", "Non-local API hosts require --environment test.");
    invariant(url.protocol === "https:", "Non-local test exports require HTTPS.");
    invariant(
      typeof allowedTestHost === "string" && allowedTestHost === url.host,
      "Non-local test exports require --allow-test-host with the exact host and port.",
    );
  }

  url.pathname = "/api/v1/";
  url.search = "";
  url.hash = "";
  return url;
}

function apiClient(apiRoot, fetchImpl) {
  return async (path) => {
    const url = new URL(path.replace(/^\//, ""), apiRoot);
    invariant(url.origin === apiRoot.origin, "API path escaped the configured origin.");
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Error(`GET ${url.pathname} failed: ${error instanceof Error ? error.message : "network error"}`);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`GET ${url.pathname} did not return JSON.`);
    }
    if (!response.ok) {
      const code = body?.error?.code ? ` (${body.error.code})` : "";
      throw new Error(`GET ${url.pathname} failed with HTTP ${response.status}${code}.`);
    }
    return record(body?.data, `GET ${url.pathname} response data`);
  };
}

function evidenceIdentity(item) {
  const kind = item.kind === "document" ? "document" : item.kind;
  if (kind === "transcript" || kind === "text") {
    return canonical({
      kind,
      assetVersionId: item.asset_version_id ?? item.assetVersionId ?? null,
      segmentIds: item.segment_ids ?? item.segmentIds ?? [],
    });
  }
  if (kind === "photo") {
    return canonical({
      kind,
      assetVersionId: item.asset_version_id ?? item.assetVersionId ?? null,
      bbox: item.bbox ?? item.bbox_norm ?? null,
      observation: item.observation ?? null,
    });
  }
  return canonical({
    kind,
    assetVersionId: item.asset_version_id ?? item.assetVersionId ?? null,
    pageNumber: item.page_number ?? null,
    observation: item.observation ?? null,
  });
}

function persistedEvidence(item) {
  return {
    id: String(item.id),
    kind: String(item.kind),
    assetVersionId: string(item.asset_version_id),
    segmentIds: Array.isArray(item.segment_ids) ? item.segment_ids.map(String) : [],
    quoteRaw: string(item.quote_raw),
    startMs: finiteNumber(item.start_ms),
    endMs: finiteNumber(item.end_ms),
    pageNumber: finiteNumber(item.page_number),
    bbox: Array.isArray(item.bbox) ? item.bbox : null,
    observation: string(item.observation),
    evidenceRole: string(item.evidence_role),
    idValid: item.structural_validation_status === "valid",
    quoteExact:
      (item.kind === "transcript" || item.kind === "text") &&
      item.structural_validation_status === "valid" &&
      typeof item.quote_raw === "string",
    semanticSupportVerdict: string(item.semantic_support_verdict) ?? "unreviewed",
  };
}

function occurrenceEvidence(candidate, item, index) {
  return {
    id: `${candidate.id}:evidence:${index + 1}`,
    kind: String(item.kind),
    assetVersionId: string(item.asset_version_id),
    segmentIds: Array.isArray(item.segment_ids) ? item.segment_ids.map(String) : [],
    quoteRaw: string(item.quote_raw),
    startMs: finiteNumber(item.start_ms),
    endMs: finiteNumber(item.end_ms),
    pageNumber: finiteNumber(item.page_number),
    bbox: Array.isArray(item.bbox) ? item.bbox : null,
    observation: string(item.observation),
    evidenceRole: string(item.evidence_role),
    idValid: true,
    quoteExact:
      (item.kind === "transcript" || item.kind === "text") &&
      typeof item.quote_raw === "string",
    semanticSupportVerdict: "unreviewed",
  };
}

function rawEvidence(runId, claimKey, item, index) {
  const kind = String(item.kind);
  return {
    id: `${runId}:${claimKey}:raw-evidence:${index + 1}`,
    kind,
    assetVersionId: string(item.asset_version_id),
    segmentIds: Array.isArray(item.segment_ids) ? item.segment_ids.map(String) : [],
    quoteRaw: kind === "transcript" || kind === "text" ? string(item.quote_hint) : null,
    startMs: null,
    endMs: null,
    pageNumber: finiteNumber(item.page_number),
    bbox: Array.isArray(item.bbox_norm) ? item.bbox_norm : null,
    observation: string(item.observation),
    evidenceRole: string(item.evidence_role),
    idValid: false,
    quoteExact: false,
    semanticSupportVerdict: "unreviewed",
  };
}

function supportVerdict(evidence) {
  if (!evidence.length) return "unreviewed";
  const verdicts = evidence.map((item) => item.semanticSupportVerdict);
  if (verdicts.every((value) => value === "fully_supports")) return "fully_supports";
  if (verdicts.every((value) => value === "does_not_support")) return "does_not_support";
  if (verdicts.every((value) => value === "fully_supports" || value === "partially_supports")) {
    return "partially_supports";
  }
  return "unreviewed";
}

function normalizedClaimKey(type, statement, normalizedValue) {
  return canonical({ normalizedValue, statement, type });
}

function chooseAndRemove(map, key) {
  const values = map.get(key) ?? [];
  const result = values.shift() ?? null;
  if (values.length) map.set(key, values);
  else map.delete(key);
  return result;
}

async function collectRun(get, runId, expectedProjectId) {
  const [runEnvelope, debugEnvelope, runClaimsEnvelope] = await Promise.all([
    get(`extraction-runs/${encodeURIComponent(runId)}`),
    get(`extraction-runs/${encodeURIComponent(runId)}/debug`),
    get(`extraction-runs/${encodeURIComponent(runId)}/claims`),
  ]);
  const run = record(runEnvelope.run, "run");
  const debug = record(debugEnvelope.debug, "debug");
  invariant(run.id === runId, `API returned a different run for ${runId}.`);
  invariant(TERMINAL_SUCCESS_STATUSES.has(run.status), `Run ${runId} is not a successful terminal run.`);
  invariant(debug.id === runId, `Debug snapshot does not belong to run ${runId}.`);
  invariant(runClaimsEnvelope.run?.id === runId, `Claim snapshot does not belong to run ${runId}.`);
  if (expectedProjectId) {
    invariant(run.project_id === expectedProjectId, `Run ${runId} does not belong to project ${expectedProjectId}.`);
  }

  const projectId = String(run.project_id);
  const eventId = String(run.event_id);
  const [projectEnvelope, eventEnvelope, ...viewEnvelopes] = await Promise.all([
    get(`projects/${encodeURIComponent(projectId)}`),
    get(`events/${encodeURIComponent(eventId)}`),
    ...VIEW_PATHS.map(([, path]) => get(`projects/${encodeURIComponent(projectId)}/${path}`)),
  ]);
  const project = record(projectEnvelope.project, "project");
  const event = record(eventEnvelope.event, "event");
  invariant(project.id === projectId, "Project snapshot does not match the run.");
  invariant(event.id === eventId && event.project_id === projectId, "Event snapshot does not match the run.");

  const persistedClaims = array(runClaimsEnvelope.claims, "run claims");
  const occurrenceCandidates = array(runClaimsEnvelope.occurrence_candidates, "occurrence candidates");
  const evidenceRefIds = [...new Set(persistedClaims.flatMap((claim) =>
    Array.isArray(claim.evidence_ref_ids) ? claim.evidence_ref_ids.map(String) : [],
  ))].sort();
  const evidenceEnvelopes = await Promise.all(
    evidenceRefIds.map((id) => get(`evidence-refs/${encodeURIComponent(id)}`)),
  );
  const evidenceById = new Map(
    evidenceEnvelopes.map((envelope) => {
      const ref = record(envelope.evidence_ref, "evidence ref");
      return [String(ref.id), ref];
    }),
  );

  const persistedByClaimKey = new Map();
  for (const claim of persistedClaims) {
    const version = record(claim.current_version, "claim current version");
    const key = normalizedClaimKey(claim.type, version.statement, version.normalized_value ?? null);
    const refs = (claim.evidence_ref_ids ?? []).map((id) => evidenceById.get(String(id))).filter(Boolean);
    const entry = {
      productionClaimId: String(claim.id),
      productionClaimVersionId: String(version.id),
      evidence: refs,
    };
    persistedByClaimKey.set(key, [...(persistedByClaimKey.get(key) ?? []), entry]);
  }

  const occurrencesByClaimKey = new Map();
  for (const candidate of occurrenceCandidates) {
    const statement = candidate.proposed_statement ?? candidate.target_statement;
    const type = candidate.proposed_type ?? candidate.target_type;
    const key = normalizedClaimKey(type, statement, null);
    occurrencesByClaimKey.set(key, [...(occurrencesByClaimKey.get(key) ?? []), candidate]);
  }

  const validatedOutput = record(debug.validated_output, "validated model output");
  invariant(validatedOutput.event_id === eventId, "Validated output event does not match the run.");
  const modelClaims = array(validatedOutput.claims, "validated model claims");
  const claimContexts = [];
  const claims = modelClaims.map((modelClaim, claimIndex) => {
    const claim = record(modelClaim, `validated claim ${claimIndex + 1}`);
    const clientClaimKey = String(claim.client_claim_key);
    const predictionId = `${runId}:${clientClaimKey}`;
    const normalizedValue = claim.normalized_value ?? null;
    const persisted = claim.disposition === "new"
      ? chooseAndRemove(
          persistedByClaimKey,
          normalizedClaimKey(claim.type, claim.statement, normalizedValue),
        )
      : null;
    const occurrence = claim.disposition === "reaffirmed"
      ? chooseAndRemove(
          occurrencesByClaimKey,
          normalizedClaimKey(claim.type, claim.statement, null),
        )
      : null;
    const candidateEvidence = persisted
      ? persisted.evidence.map(persistedEvidence)
      : occurrence
        ? (occurrence.evidence ?? []).map((item, index) => occurrenceEvidence(occurrence, item, index))
        : [];
    const byIdentity = new Map(candidateEvidence.map((item) => [evidenceIdentity(item), item]));
    const evidence = array(claim.evidence, `validated claim ${clientClaimKey} evidence`).map(
      (item, index) => byIdentity.get(evidenceIdentity(item)) ?? rawEvidence(runId, clientClaimKey, item, index),
    );
    const uncertainty = claim.uncertainty && typeof claim.uncertainty === "object"
      ? claim.uncertainty
      : null;
    claimContexts.push({ claim, predictionId });
    return {
      id: predictionId,
      clientClaimKey,
      productionClaimId: persisted?.productionClaimId ?? occurrence?.target_claim_id ?? null,
      productionClaimVersionId:
        persisted?.productionClaimVersionId ?? occurrence?.target_claim_version_id ?? null,
      productionOccurrenceCandidateId: occurrence?.id ?? null,
      matchedGroundTruthId: null,
      semanticKey: canonical({
        classification: claim.disposition,
        normalizedValue,
        statement: claim.statement,
        type: claim.type,
      }),
      type: claim.type,
      statement: claim.statement,
      normalizedValue,
      materiality: claim.materiality,
      classification: claim.disposition,
      targetVersionId: claim.reaffirmed_target_version_id ?? null,
      evidence,
      citationSupport: supportVerdict(evidence),
      ambiguityDetected: uncertainty !== null,
      ambiguityAlternatives: uncertainty?.alternatives ?? [],
      ambiguityQuestion: uncertainty?.question ?? null,
      assertedDefinitively: uncertainty === null,
      unsupportedVisualClaim: null,
    };
  });

  const relations = claimContexts.flatMap(({ claim, predictionId }) =>
    array(claim.relations, `validated claim ${claim.client_claim_key} relations`).map((relation, index) => ({
      id: `${predictionId}:relation:${index + 1}`,
      matchedGroundTruthRelationId: null,
      type: relation.type,
      sourcePredictionId: predictionId,
      sourceGroundTruthClaimId: null,
      targetProductionClaimId: relation.target_claim_id,
      targetGroundTruthClaimId: null,
      targetVersionId: relation.target_claim_version_id,
      reason: relation.reason,
      confidence: relation.confidence,
      relationSignature: canonical({
        source: predictionId,
        target: relation.target_claim_version_id,
        type: relation.type,
      }),
    })),
  );

  const views = Object.fromEntries(VIEW_PATHS.map(([name], index) => {
    const envelope = viewEnvelopes[index];
    const value = envelope.view ?? envelope.gap_check ?? envelope.agenda ?? envelope.brief_card;
    return [name, stableValue(value)];
  }));
  const briefCard = record(views.briefCard, "brief card");
  const briefSlot = (slot, sourceKind, sourceId) => ({
    slot,
    sourceKind,
    sourceId: typeof sourceId === "string" ? sourceId : "",
    sourceValid: typeof sourceId === "string" && sourceId.length > 0,
    useful: false,
  });
  const deltaIds = Array.isArray(briefCard.deltaItemIds) ? briefCard.deltaItemIds : [];
  const agendaIds = Array.isArray(briefCard.agendaItemIds) ? briefCard.agendaItemIds : [];
  const startedAt = Date.parse(String(debug.started_at ?? ""));
  const finishedAt = Date.parse(String(debug.finished_at ?? ""));
  const latencyMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
    ? finishedAt - startedAt
    : null;

  return {
    id: runId,
    projectId,
    eventId,
    claims,
    relations,
    viewLeakageCount: null,
    brief: {
      slots: [
        briefSlot("current_status", "claim", briefCard.stateClaimId),
        briefSlot("change_1", "timeline_delta", deltaIds[0]),
        briefSlot("change_2", "timeline_delta", deltaIds[1]),
        briefSlot("question_1", "agenda_item", agendaIds[0]),
        briefSlot("question_2", "agenda_item", agendaIds[1]),
        briefSlot("risk", "claim", briefCard.riskClaimId),
      ],
    },
    usage: {
      inputTokens: finiteNumber(debug.input_tokens),
      outputTokens: finiteNumber(debug.output_tokens),
      cachedTokens: finiteNumber(debug.cached_tokens),
      costUsd: finiteNumber(debug.estimated_cost_usd),
      latencyMs,
    },
    frozen: {
      provider: string(debug.provider),
      model: string(debug.model),
      promptVersion: String(debug.prompt_version),
      schemaVersion: String(debug.schema_version),
      parserVersion: String(debug.parser_version),
      modelParameters: stableValue(debug.model_params ?? {}),
      inputHash: String(debug.input_hash),
      inputSnapshotHash: String(debug.input_snapshot_hash),
      inputManifest: stableValue(debug.input_manifest ?? []),
      contextVersion: Number(debug.context_version),
      contextSnapshotHash: String(debug.context_snapshot_hash),
      createdAt: String(debug.created_at),
      startedAt: string(debug.started_at),
      finishedAt: string(debug.finished_at),
    },
    project: stableValue({
      id: project.id,
      name: project.name,
      locale: project.locale,
      scenario: project.scenario,
      scenarioStatus: project.scenario_status,
      scenarioVersion: project.scenario_version,
      ledgerVersion: project.ledger_version,
      contextVersion: project.context_version,
    }),
    event: stableValue({
      id: event.id,
      eventType: event.event_type,
      title: event.title,
      occurredAt: event.occurred_at,
      sequenceNo: event.sequence_no,
    }),
    views,
    reviewRequired: [
      "Fill matchedGroundTruthId and matchedGroundTruthRelationId by deterministic matching or human adjudication.",
      "Review citationSupport and unsupportedVisualClaim; the exporter does not make semantic judgments.",
      "Review viewLeakageCount and each Brief slot's usefulness before scoring.",
    ],
  };
}

function frozenConfiguration(run) {
  return canonical({
    model: run.frozen.model,
    modelParameters: run.frozen.modelParameters,
    parserVersion: run.frozen.parserVersion,
    promptVersion: run.frozen.promptVersion,
    provider: run.frozen.provider,
    schemaVersion: run.frozen.schemaVersion,
  });
}

function assertSameEvaluationCase(runs) {
  const first = runs[0];
  for (const run of runs.slice(1)) {
    const mismatches = [];
    if (run.projectId !== first.projectId) mismatches.push("projectId");
    if (run.eventId !== first.eventId) mismatches.push("eventId");
    if (run.frozen.inputSnapshotHash !== first.frozen.inputSnapshotHash) {
      mismatches.push("inputSnapshotHash");
    }
    if (canonical(run.frozen.inputManifest) !== canonical(first.frozen.inputManifest)) {
      mismatches.push("inputManifest");
    }
    if (run.frozen.contextSnapshotHash !== first.frozen.contextSnapshotHash) {
      mismatches.push("contextSnapshotHash");
    }
    if (run.frozen.contextVersion !== first.frozen.contextVersion) {
      mismatches.push("contextVersion");
    }
    invariant(
      mismatches.length === 0,
      `Run ${run.id} cannot be combined with ${first.id}: ${mismatches.join(", ")} must match exactly.`,
    );
  }
}

export async function buildPredictionPackage({
  baseUrl,
  environment,
  allowedTestHost,
  projectId = null,
  runIds,
  commitSha = "unknown",
  fetchImpl = globalThis.fetch,
}) {
  invariant(Array.isArray(runIds) && runIds.length > 0, "At least one --run-id is required.");
  invariant(new Set(runIds).size === runIds.length, "--run-id values must be unique.");
  invariant(typeof fetchImpl === "function", "A Fetch implementation is required.");
  const apiRoot = normalizeApiRoot({ baseUrl, environment, allowedTestHost });
  const get = apiClient(apiRoot, fetchImpl);
  const runs = [];
  for (const runId of runIds) runs.push(await collectRun(get, runId, projectId));
  assertSameEvaluationCase(runs);
  const configuration = frozenConfiguration(runs[0]);
  invariant(
    runs.every((run) => frozenConfiguration(run) === configuration),
    "All exported runs must use the same provider, model, prompt, schema, parser, and model parameters.",
  );
  const first = runs[0];
  return stableValue({
    schemaVersion: "notique-eval-predictions.v1",
    metadata: {
      commitSha,
      model: first.frozen.model,
      prompt: first.frozen.promptVersion,
      schema: first.frozen.schemaVersion,
      parameters: first.frozen.modelParameters,
      environment,
      provider: first.frozen.provider,
      exportFormat: "notique-production-run-export.v1",
    },
    runs,
  });
}
