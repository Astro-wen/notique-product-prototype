import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  assertLoopbackBaseUrl,
  importSyntheticFixture,
  validateSyntheticManifest,
} from "../import-synthetic-fixture.mjs";
import { identifyEricDemoFixture } from "./eric-demo-fixtures.mjs";

const SUCCESS_RUN_STATUSES = new Set(["succeeded", "completed_with_warnings"]);
const TERMINAL_RUN_STATUSES = new Set([
  ...SUCCESS_RUN_STATUSES,
  "failed",
  "cancelled",
]);
const VIEW_ROUTES = [
  ["Folder Summary", "views/folder-summary", "view"],
  ["Timeline", "views/timeline", "view"],
  ["Decisions", "views/decisions", "view"],
  ["Preferences", "views/preferences", "view"],
  ["Open Questions", "views/open-questions", "view"],
  ["Risks", "views/risks", "view"],
  ["Agenda", "next-meeting-agenda", "agenda"],
  ["Brief", "brief-card", "brief_card"],
];
const SCENARIO_MATCHER = "all_required_concepts.v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function idempotencyKey(correlationId, scope) {
  return `eric-demo:${correlationId}:${scope}`.slice(0, 200);
}

function writeHeaders(baseUrl, headers = {}) {
  return {
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    ...headers,
  };
}

export class DemoApiError extends Error {
  constructor({ method, pathname, status, code, message, requestId }) {
    super(`${method} ${pathname} failed with ${code}: ${message}${requestId ? ` [request_id=${requestId}]` : ""}`);
    this.name = "DemoApiError";
    this.method = method;
    this.pathname = pathname;
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class DemoNetworkError extends Error {
  constructor({ method, pathname, message }) {
    super(`${method} ${pathname} could not confirm a response from the local server: ${message}`);
    this.name = "DemoNetworkError";
    this.method = method;
    this.pathname = pathname;
    this.status = null;
    this.code = "NETWORK_RESULT_UNKNOWN";
    this.requestId = null;
  }
}

function requestTrace({ method, pathname, status, requestId, phase }) {
  return {
    phase,
    method,
    pathname,
    status,
    request_id: requestId || null,
  };
}

async function apiJson({
  fetchImpl,
  baseUrl,
  method,
  pathname,
  json,
  idempotency,
  phase,
  requests,
  requestTimeoutMs,
}) {
  const headers = writeHeaders(baseUrl, { accept: "application/json" });
  if (json !== undefined) headers["content-type"] = "application/json";
  if (idempotency) headers["idempotency-key"] = idempotency;
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    requests.push(requestTrace({
      method,
      pathname,
      status: null,
      requestId: null,
      phase,
    }));
    throw new DemoNetworkError({
      method,
      pathname,
      message: error instanceof Error ? error.message : "network error",
    });
  }
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${method} ${pathname} returned non-JSON content.`);
  }
  const requestId = body?.request_id ?? response.headers.get("x-request-id") ?? null;
  requests.push(requestTrace({ method, pathname, status: response.status, requestId, phase }));
  if (!response.ok) {
    throw new DemoApiError({
      method,
      pathname,
      status: response.status,
      code: body?.error?.code ?? "HTTP_ERROR",
      message: body?.error?.message ?? `HTTP ${response.status}`,
      requestId,
    });
  }
  invariant(body?.data !== undefined, `${method} ${pathname} returned no data envelope.`);
  return { data: body.data, requestId };
}

function sanitizedError(error) {
  if (error instanceof DemoApiError || error instanceof DemoNetworkError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      status: error.status,
      request_id: error.requestId ?? null,
    };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    code: "DEMO_FAILED",
    message: error instanceof Error ? error.message : String(error),
    status: null,
    request_id: null,
  };
}

async function fixtureManifest(manifestPath) {
  const fixture = identifyEricDemoFixture(manifestPath);
  const bytes = await readFile(fixture.manifestPath);
  const value = validateSyntheticManifest(
    JSON.parse(bytes.toString("utf8")),
  );
  invariant(value.synthetic === true, "The one-click demo only accepts a manifest marked synthetic=true.");
  fixtureScenarioExpectation(value);
  return {
    fixture,
    manifest: value,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function normalizeScenarioText(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[_\p{Pd}]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsScenarioPhrase(normalizedText, phrase) {
  const normalizedPhrase = normalizeScenarioText(phrase);
  return normalizedPhrase !== "" &&
    ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function fixtureScenarioExpectation(manifest) {
  const expected = manifest.scenario?.expected;
  invariant(typeof expected === "string" && expected.trim(), "Synthetic manifest has no scenario.expected value.");
  const semanticAcceptance = manifest.scenario?.semanticAcceptance;
  invariant(
    isRecord(semanticAcceptance) && semanticAcceptance.matcher === SCENARIO_MATCHER,
    `Synthetic manifest scenario.semanticAcceptance.matcher must be ${SCENARIO_MATCHER}.`,
  );
  invariant(
    Array.isArray(semanticAcceptance.requiredConcepts) &&
      semanticAcceptance.requiredConcepts.length >= 2,
    "Synthetic manifest Scenario matcher needs at least two required concepts.",
  );
  const conceptIds = [];
  const requiredConcepts = semanticAcceptance.requiredConcepts.map((concept, index) => {
    invariant(isRecord(concept), `Scenario requiredConcepts[${index}] must be an object.`);
    invariant(
      typeof concept.id === "string" && concept.id.trim(),
      `Scenario requiredConcepts[${index}].id must be a non-empty string.`,
    );
    invariant(
      Array.isArray(concept.phrases) && concept.phrases.length >= 1 &&
        concept.phrases.every((phrase) => typeof phrase === "string" && phrase.trim()),
      `Scenario requiredConcepts[${index}].phrases must contain non-empty strings.`,
    );
    conceptIds.push(concept.id.trim());
    return {
      id: concept.id.trim(),
      phrases: concept.phrases.map((phrase) => phrase.trim()),
    };
  });
  invariant(
    new Set(conceptIds).size === conceptIds.length,
    "Scenario required concept IDs must be unique.",
  );
  const expectation = {
    expected: expected.trim(),
    matcher: SCENARIO_MATCHER,
    requiredConcepts,
  };
  return expectation;
}

function evaluateFixtureScenario(scenario, expectation) {
  const normalized = normalizeScenarioText(scenario);
  const matchedConcepts = [];
  const missingConcepts = [];
  for (const concept of expectation.requiredConcepts) {
    const phrase = concept.phrases.find((candidate) =>
      containsScenarioPhrase(normalized, candidate)
    );
    if (phrase) matchedConcepts.push({ concept: concept.id, phrase });
    else missingConcepts.push(concept.id);
  }
  return {
    accepted: normalized !== "" && missingConcepts.length === 0,
    matchedConcepts,
    missingConcepts,
  };
}

function fixtureScenarioSelection(scenario, expectation, evaluation, reusedExistingVerdict = false) {
  return {
    selected: scenario,
    fixture_expected: expectation.expected,
    semantic_matcher: expectation.matcher,
    matched_concepts: evaluation.matchedConcepts,
    exact_fixture_match: scenario === expectation.expected,
    ...(reusedExistingVerdict ? { reused_existing_verdict: true } : {}),
  };
}

function fixtureScopedCorrelationId(correlationId, fixtureKey, fixtureId) {
  const digest = createHash("sha256")
    .update(correlationId)
    .update("\0")
    .update(fixtureKey)
    .update("\0")
    .update(fixtureId)
    .digest("hex")
    .slice(0, 24);
  return `eric-demo-${digest}`;
}

async function waitForRun({ client, runId, pollMs, timeoutMs }) {
  const started = Date.now();
  let last = null;
  let dispatchAttempts = 0;
  let dispatchUncertainCount = 0;
  while (Date.now() - started <= timeoutMs) {
    const response = await client("GET", `/api/v1/extraction-runs/${encodeURIComponent(runId)}`, {
      phase: "poll-extraction",
    });
    last = response.data.run;
    invariant(last?.id === runId, `Extraction poll returned the wrong Run for ${runId}.`);
    if (TERMINAL_RUN_STATUSES.has(last.status)) {
      return {
        run: last,
        requestId: response.requestId,
        dispatchAttempts,
        dispatchUncertainCount,
      };
    }
    dispatchAttempts += 1;
    try {
      await client("POST", "/api/v1/local/jobs/dispatch", {
        phase: "dispatch-extraction",
        json: {},
      });
    } catch (error) {
      if (!(error instanceof DemoNetworkError)) throw error;
      // The local dispatcher may have accepted the request before the connection broke.
      // The extraction Run already has a stable ID, so polling it is the only safe retry.
      dispatchUncertainCount += 1;
    }
    await sleep(pollMs);
  }
  throw new Error(`Extraction Run ${runId} did not finish within ${timeoutMs} ms. Last status: ${last?.status ?? "unknown"}.`);
}

async function loadOrCreateEventRun({ client, event, correlationId }) {
  const eventResponse = await client(
    "GET",
    `/api/v1/events/${encodeURIComponent(event.id)}`,
    { phase: "load-event-active-run" },
  );
  const persistedEvent = eventResponse.data.event;
  invariant(persistedEvent?.id === event.id, `Event lookup returned the wrong Event for ${event.id}.`);
  invariant(
    Object.prototype.hasOwnProperty.call(persistedEvent, "active_run_id"),
    `Event ${event.id} lookup omitted active_run_id; refusing to create a potentially duplicate Run.`,
  );
  const activeRunId = persistedEvent.active_run_id;
  if (activeRunId !== null) {
    invariant(
      typeof activeRunId === "string" && activeRunId,
      `Event ${event.id} returned an invalid active Run ID.`,
    );
    const existing = await client(
      "GET",
      `/api/v1/extraction-runs/${encodeURIComponent(activeRunId)}`,
      { phase: "load-existing-extraction" },
    );
    const run = existing.data.run;
    invariant(run?.id === activeRunId, `Active Run lookup returned the wrong Run for Event ${event.id}.`);
    invariant(
      TERMINAL_RUN_STATUSES.has(run.status) || run.status === "queued" || run.status === "processing",
      `Existing Extraction Run ${activeRunId} has unsupported status ${run.status}; refusing to create a replacement.`,
    );
    return {
      run,
      reusedExistingRun: true,
      eventRequestId: eventResponse.requestId,
      existingRunRequestId: existing.requestId,
      createRequestId: null,
    };
  }

  const created = await client(
    "POST",
    `/api/v1/events/${encodeURIComponent(event.id)}/extraction-runs`,
    {
      phase: "create-extraction",
      idempotency: idempotencyKey(correlationId, `extract:${event.id}`),
      json: { asset_version_ids: event.asset_version_ids },
    },
  );
  const run = created.data.run;
  invariant(typeof run?.id === "string" && run.id, `Event ${event.id} returned no extraction Run ID.`);
  return {
    run,
    reusedExistingRun: false,
    eventRequestId: eventResponse.requestId,
    existingRunRequestId: null,
    createRequestId: created.requestId,
  };
}

async function loadRunReview({ client, runId }) {
  const review = await client(
    "GET",
    `/api/v1/extraction-runs/${encodeURIComponent(runId)}/claims`,
    { phase: "load-review" },
  );
  invariant(Array.isArray(review.data.claims), `Extraction Run ${runId} review returned no Claims array.`);
  invariant(
    Array.isArray(review.data.occurrence_candidates),
    `Extraction Run ${runId} review returned no Occurrence candidates array.`,
  );
  const claims = review.data.claims;
  const occurrences = review.data.occurrence_candidates;
  invariant(
    claims.length + occurrences.length > 0,
    `Extraction Run ${runId} succeeded but produced no reviewable Claim or Occurrence.`,
  );
  return {
    claims,
    occurrences,
    pendingClaims: claims.filter((claim) => claim.review_status === "pending"),
    pendingOccurrences: occurrences.filter((item) => item.status === "pending"),
    requestId: review.requestId,
  };
}

async function confirmFixtureReview({ client, runId, correlationId, review }) {
  const claims = review.pendingClaims;
  const occurrences = review.pendingOccurrences;

  for (const claim of claims) {
    await client(
      "POST",
      `/api/v1/claims/${encodeURIComponent(claim.id)}/evidence-review-attestations`,
      {
        phase: "attest-synthetic-evidence",
        idempotency: idempotencyKey(correlationId, `attest:${claim.id}:${claim.current_version.id}`),
        json: { base_version_id: claim.current_version.id },
      },
    );
  }
  if (claims.length) {
    await client("POST", "/api/v1/claims/batch-verdicts", {
      phase: "confirm-synthetic-claims",
      idempotency: idempotencyKey(correlationId, `batch:${runId}`),
      json: {
        verdicts: claims.map((claim) => ({
          claim_id: claim.id,
          action: "confirm",
          base_version_id: claim.current_version.id,
          explanation: "Explicit synthetic-fixture demo confirmation.",
        })),
      },
    });
  }
  for (const occurrence of occurrences) {
    await client(
      "POST",
      `/api/v1/occurrence-candidates/${encodeURIComponent(occurrence.id)}/verdicts`,
      {
        phase: "confirm-synthetic-occurrence",
        idempotency: idempotencyKey(correlationId, `occurrence:${occurrence.id}`),
        json: {
          action: "confirm",
          target_base_version_id: occurrence.base_version_id,
        },
      },
    );
  }
  return { confirmed_claims: claims.length, confirmed_occurrences: occurrences.length };
}

async function acceptFixtureScenario({ client, manifest, project, correlationId }) {
  invariant(
    project.scenario_status === "pending_confirmation",
    `Scenario is ${project.scenario_status}; expected pending_confirmation after the first extraction.`,
  );
  const expectation = fixtureScenarioExpectation(manifest);
  const candidates = Array.isArray(project.scenario_candidates) ? project.scenario_candidates : [];
  invariant(
    candidates.length >= 2 && candidates.length <= 3 &&
      candidates.every((candidate) => typeof candidate?.scenario === "string" && candidate.scenario.trim()),
    "The first extraction did not return two or three usable Scenario candidates.",
  );
  const evaluations = candidates.map((candidate) => ({
    candidate,
    evaluation: evaluateFixtureScenario(candidate.scenario, expectation),
  }));
  const accepted = evaluations.filter((item) => item.evaluation.accepted);
  invariant(
    accepted.length >= 1,
    `No Scenario candidate satisfies fixture ${expectation.expected}'s semantic acceptance matcher; refusing to confirm an unrelated candidate.`,
  );
  invariant(
    accepted.length === 1,
    `More than one Scenario candidate satisfies fixture ${expectation.expected}'s semantic acceptance matcher; refusing ambiguous automatic confirmation.`,
  );
  const selected = accepted[0].candidate.scenario.trim();
  const response = await client(
    "POST",
    `/api/v1/projects/${encodeURIComponent(project.id)}/scenario-verdict`,
    {
      phase: "confirm-synthetic-scenario",
      idempotency: idempotencyKey(correlationId, `scenario:${project.scenario_version}`),
      json: {
        scenario_version: project.scenario_version,
        scenario: selected,
        source: "candidate",
      },
    },
  );
  return {
    project: response.data.project,
    selection: fixtureScenarioSelection(
      selected,
      expectation,
      accepted[0].evaluation,
    ),
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function validateRawClaim(claim, path) {
  invariant(isRecord(claim), `${path} must be an object.`);
  invariant(isNonEmptyString(claim.id), `${path}.id must be a non-empty string.`);
  invariant(isNonEmptyString(claim.type), `${path}.type must be a non-empty string.`);
  invariant(
    claim.reviewStatus === "verified",
    `${path}.reviewStatus must be verified because production Views exclude unreviewed Claims.`,
  );
  invariant(
    ["active", "superseded", "resolved", "withdrawn"].includes(claim.lifecycleStatus),
    `${path}.lifecycleStatus is invalid.`,
  );
  invariant(isRecord(claim.version), `${path}.version must be an object.`);
  invariant(isNonEmptyString(claim.version.id), `${path}.version.id must be a non-empty string.`);
  invariant(isNonEmptyString(claim.version.statement), `${path}.version.statement must be a non-empty string.`);
  invariant(
    isStringArray(claim.version.evidenceRefIds),
    `${path}.version.evidenceRefIds must be a string array.`,
  );
}

function validateTimelineDelta(delta, path) {
  invariant(isRecord(delta), `${path} must be an object.`);
  invariant(isNonEmptyString(delta.id), `${path}.id must be a non-empty string.`);
  invariant(
    ["new", "superseded", "resolved", "contradicted", "withdrawn"].includes(delta.type),
    `${path}.type is invalid.`,
  );
  invariant(isNonEmptyString(delta.eventId), `${path}.eventId must be a non-empty string.`);
  invariant(isNonEmptyString(delta.displayText), `${path}.displayText must be a non-empty string.`);
  if (delta.type === "new") {
    invariant(isNonEmptyString(delta.afterClaimVersionId), `${path}.afterClaimVersionId is required.`);
  } else if (delta.type === "withdrawn") {
    invariant(isNonEmptyString(delta.claimVersionId), `${path}.claimVersionId is required.`);
    invariant(isNonEmptyString(delta.withdrawVerdictId), `${path}.withdrawVerdictId is required.`);
  } else {
    invariant(isNonEmptyString(delta.beforeClaimVersionId), `${path}.beforeClaimVersionId is required.`);
    invariant(isNonEmptyString(delta.afterClaimVersionId), `${path}.afterClaimVersionId is required.`);
    invariant(isNonEmptyString(delta.relationId), `${path}.relationId is required.`);
  }
}

function validateClaimProjection(item, path) {
  invariant(isRecord(item), `${path} must be an object.`);
  for (const field of ["claimId", "claimVersionId", "statement"]) {
    invariant(isNonEmptyString(item[field]), `${path}.${field} must be a non-empty string.`);
  }
  invariant(isStringArray(item.evidenceRefIds), `${path}.evidenceRefIds must be a string array.`);
}

function validateAgendaItem(item, path) {
  invariant(isRecord(item), `${path} must be an object.`);
  invariant(isNonEmptyString(item.id), `${path}.id must be a non-empty string.`);
  invariant(
    ["gap", "open_question", "uncertainty", "evidence_gap", "contradiction"].includes(item.sourceKind),
    `${path}.sourceKind is invalid.`,
  );
  if (item.sourceKind === "gap") {
    invariant(isNonEmptyString(item.slot), `${path}.slot is required for a gap.`);
    invariant(isNonEmptyString(item.gapCheckId), `${path}.gapCheckId is required for a gap.`);
    return;
  }
  if (item.sourceKind === "contradiction") {
    for (const field of [
      "relationId",
      "sourceClaimId",
      "targetClaimId",
      "sourceClaimVersionId",
      "targetClaimVersionId",
      "sourceStatement",
      "targetStatement",
    ]) {
      invariant(isNonEmptyString(item[field]), `${path}.${field} is required for a contradiction.`);
    }
    invariant(isStringArray(item.sourceEvidenceRefIds), `${path}.sourceEvidenceRefIds must be a string array.`);
    invariant(isStringArray(item.targetEvidenceRefIds), `${path}.targetEvidenceRefIds must be a string array.`);
    return;
  }
  for (const field of ["claimId", "claimVersionId", "statement"]) {
    invariant(isNonEmptyString(item[field]), `${path}.${field} is required.`);
  }
  invariant(isStringArray(item.evidenceRefIds), `${path}.evidenceRefIds must be a string array.`);
  if (item.sourceKind === "uncertainty") {
    invariant(isNonEmptyString(item.reason), `${path}.reason is required for uncertainty.`);
    invariant(isStringArray(item.alternatives), `${path}.alternatives must be a string array.`);
  }
}

export function validateCollectedViews(views) {
  invariant(isRecord(views), "Collected Views must be an object.");
  invariant(isRecord(views["Folder Summary"]), "Folder Summary must be an object.");
  const summary = views["Folder Summary"];
  invariant(
    isNonEmptyString(summary.projectId) &&
      (summary.scenario === null || isNonEmptyString(summary.scenario)) &&
      Array.isArray(summary.currentClaims) &&
      Array.isArray(summary.recentDeltas) &&
      (summary.emptyReason === null || typeof summary.emptyReason === "string"),
    "Folder Summary must contain currentClaims and recentDeltas arrays.",
  );
  summary.currentClaims.forEach((claim, index) => validateRawClaim(claim, `Folder Summary.currentClaims[${index}]`));
  summary.recentDeltas.forEach((delta, index) => validateTimelineDelta(delta, `Folder Summary.recentDeltas[${index}]`));

  invariant(Array.isArray(views.Timeline), "Timeline must be an array.");
  views.Timeline.forEach((group, groupIndex) => {
    const path = `Timeline[${groupIndex}]`;
    invariant(isRecord(group), `${path} must be an object.`);
    invariant(isRecord(group.event) && isNonEmptyString(group.event.id), `${path}.event.id is required.`);
    invariant(typeof group.summary === "string", `${path}.summary must be a string.`);
    invariant(Array.isArray(group.claims), `${path}.claims must be an array.`);
    invariant(Array.isArray(group.deltas), `${path}.deltas must be an array.`);
    group.claims.forEach((claim, index) => validateRawClaim(claim, `${path}.claims[${index}]`));
    group.deltas.forEach((delta, index) => validateTimelineDelta(delta, `${path}.deltas[${index}]`));
  });

  for (const label of ["Decisions", "Preferences"]) {
    invariant(Array.isArray(views[label]), `${label} must be an array.`);
    views[label].forEach((item, index) => {
      const path = `${label}[${index}]`;
      validateClaimProjection(item, path);
      invariant(isNonEmptyString(item.eventId), `${path}.eventId must be a non-empty string.`);
      invariant(
        ["active", "superseded", "resolved"].includes(item.lifecycleStatus),
        `${path}.lifecycleStatus is invalid.`,
      );
    });
  }

  invariant(Array.isArray(views["Open Questions"]), "Open Questions must be an array.");
  views["Open Questions"].forEach((item, index) => {
    const path = `Open Questions[${index}]`;
    validateClaimProjection(item, path);
    invariant(isNonEmptyString(item.openedAt), `${path}.openedAt must be a non-empty string.`);
    invariant(item.lastRepeatedAt === null || isNonEmptyString(item.lastRepeatedAt), `${path}.lastRepeatedAt is invalid.`);
    invariant(Number.isInteger(item.repeatCount) && item.repeatCount >= 0, `${path}.repeatCount must be a non-negative integer.`);
    invariant(Number.isInteger(item.openDays) && item.openDays >= 0, `${path}.openDays must be a non-negative integer.`);
  });

  invariant(
    isRecord(views.Risks) &&
      Array.isArray(views.Risks.claims) &&
      Array.isArray(views.Risks.contradictions),
    "Risks must contain claims and contradictions arrays.",
  );
  views.Risks.claims.forEach((claim, index) => validateRawClaim(claim, `Risks.claims[${index}]`));
  views.Risks.contradictions.forEach((item, index) => {
    const path = `Risks.contradictions[${index}]`;
    invariant(isRecord(item), `${path} must be an object.`);
    for (const field of [
      "relationId",
      "sourceClaimId",
      "targetClaimId",
      "sourceClaimVersionId",
      "targetClaimVersionId",
      "sourceStatement",
      "targetStatement",
    ]) {
      invariant(isNonEmptyString(item[field]), `${path}.${field} must be a non-empty string.`);
    }
    invariant(isStringArray(item.sourceEvidenceRefIds), `${path}.sourceEvidenceRefIds must be a string array.`);
    invariant(isStringArray(item.targetEvidenceRefIds), `${path}.targetEvidenceRefIds must be a string array.`);
  });

  invariant(isRecord(views.Agenda) && Array.isArray(views.Agenda.items), "Agenda must be an object containing an items array.");
  views.Agenda.items.forEach((item, index) => validateAgendaItem(item, `Agenda.items[${index}]`));

  invariant(
    isRecord(views.Brief) &&
      (isNonEmptyString(views.Brief.stateClaimId) || views.Brief.stateClaimId === null) &&
      Array.isArray(views.Brief.deltaItemIds) &&
      Array.isArray(views.Brief.agendaItemIds) &&
      (isNonEmptyString(views.Brief.riskClaimId) || views.Brief.riskClaimId === null) &&
      isStringArray(views.Brief.deltaItemIds) &&
      isStringArray(views.Brief.agendaItemIds) &&
      views.Brief.deltaItemIds.length <= 2 &&
      views.Brief.agendaItemIds.length <= 2 &&
      Number.isInteger(views.Brief.missingSlotCount) &&
      views.Brief.missingSlotCount >= 0 &&
      views.Brief.missingSlotCount <= 6 &&
      views.Brief.source === "deterministic_fallback",
    "Brief must match the production six-slot deterministic fallback contract.",
  );
  const expectedMissingSlots =
    (views.Brief.stateClaimId === null ? 1 : 0) +
    (2 - views.Brief.deltaItemIds.length) +
    (2 - views.Brief.agendaItemIds.length) +
    (views.Brief.riskClaimId === null ? 1 : 0);
  invariant(
    views.Brief.missingSlotCount === expectedMissingSlots,
    `Brief missingSlotCount is ${views.Brief.missingSlotCount}; expected ${expectedMissingSlots} from its six slots.`,
  );
}

function briefWarningClaim(claim) {
  return claim.type === "risk" ||
    claim.type === "concern" ||
    claim.type === "open_question" ||
    claim.needsAdditionalEvidence === true ||
    claim.version?.uncertainty !== null;
}

export function validateVerifiedOutput({ project, views }) {
  invariant(
    Number.isInteger(project.pending_claim_count) && project.pending_claim_count === 0 &&
      Number.isInteger(project.pending_occurrence_count) && project.pending_occurrence_count === 0,
    "Explicit fixture confirmation finished with pending review items.",
  );
  invariant(
    views["Folder Summary"].currentClaims.length > 0,
    "Explicit fixture confirmation produced no Verified Claim in Folder Summary.",
  );
  invariant(
    views.Timeline.some(
      (group) =>
        isRecord(group) &&
        ((Array.isArray(group.claims) && group.claims.length > 0) ||
          (Array.isArray(group.deltas) && group.deltas.length > 0)),
    ),
    "Explicit fixture confirmation produced no Verified Timeline content.",
  );

  const timelineClaims = views.Timeline.flatMap((group) => group.claims);
  const claimById = new Map(timelineClaims.map((claim) => [claim.id, claim]));
  const currentClaimById = new Map(
    views["Folder Summary"].currentClaims.map((claim) => [claim.id, claim]),
  );
  const claimByVersionId = new Map(timelineClaims.map((claim) => [claim.version.id, claim]));
  const assertProjectionSources = (label, expectedType) => {
    invariant(views[label].length > 0, `Explicit fixture confirmation produced an empty ${label} View.`);
    for (const item of views[label]) {
      const claim = claimById.get(item.claimId);
      invariant(claim?.type === expectedType, `${label} includes a non-${expectedType} Claim ${item.claimId}.`);
      invariant(claim.version.id === item.claimVersionId, `${label} points to a stale Claim version ${item.claimVersionId}.`);
      invariant(item.evidenceRefIds.length > 0, `${label} Claim ${item.claimId} has no evidence.`);
    }
  };
  assertProjectionSources("Decisions", "decision");
  assertProjectionSources("Preferences", "preference");
  assertProjectionSources("Open Questions", "open_question");
  invariant(
    views.Preferences.some((item) => item.lifecycleStatus === "active") &&
      views.Preferences.some((item) => item.lifecycleStatus === "superseded" || item.lifecycleStatus === "resolved"),
    "Preferences must preserve both the current preference and its verified drift history.",
  );
  invariant(
    views.Risks.claims.length + views.Risks.contradictions.length > 0,
    "Explicit fixture confirmation produced an empty Risks View.",
  );
  for (const claim of views.Risks.claims) {
    invariant(
      claim.type === "risk" || claim.type === "concern",
      `Risks includes non-risk Claim ${claim.id}.`,
    );
    invariant(claim.version.evidenceRefIds.length > 0, `Risk Claim ${claim.id} has no evidence.`);
  }
  for (const contradiction of views.Risks.contradictions) {
    invariant(
      contradiction.sourceEvidenceRefIds.length > 0 && contradiction.targetEvidenceRefIds.length > 0,
      `Contradiction ${contradiction.relationId} must expose evidence for both sides.`,
    );
  }

  invariant(views.Agenda.items.length >= 2, "Explicit fixture confirmation produced fewer than two Agenda items.");
  invariant(
    typeof views.Brief.stateClaimId === "string" && views.Brief.stateClaimId,
    "Explicit fixture confirmation produced an empty Brief state.",
  );
  invariant(
    views.Brief.missingSlotCount === 0 &&
      views.Brief.deltaItemIds.length === 2 &&
      views.Brief.agendaItemIds.length === 2 &&
      isNonEmptyString(views.Brief.riskClaimId),
    "Brief must contain all six evidence-backed slots: one state, two deltas, two Agenda items, and one warning.",
  );

  const state = currentClaimById.get(views.Brief.stateClaimId);
  const warning = currentClaimById.get(views.Brief.riskClaimId);
  invariant(state, `Brief state Claim ${views.Brief.stateClaimId} is not in the current verified ledger.`);
  invariant(warning, `Brief warning Claim ${views.Brief.riskClaimId} is not in the current verified ledger.`);
  invariant(state.id !== warning.id, "Brief state and warning must use different Claims.");
  invariant(briefWarningClaim(warning), `Brief warning Claim ${warning.id} contains no verified warning signal.`);
  invariant(state.version.evidenceRefIds.length > 0, `Brief state Claim ${state.id} has no evidence.`);
  invariant(warning.version.evidenceRefIds.length > 0, `Brief warning Claim ${warning.id} has no evidence.`);

  const deltaById = new Map(views.Timeline.flatMap((group) => group.deltas).map((delta) => [delta.id, delta]));
  for (const id of views.Brief.deltaItemIds) {
    const delta = deltaById.get(id);
    invariant(delta, `Brief delta ${id} does not exist in Timeline.`);
    const versionIds = [delta.afterClaimVersionId, delta.beforeClaimVersionId, delta.claimVersionId]
      .filter(isNonEmptyString);
    invariant(
      versionIds.some((versionId) => (claimByVersionId.get(versionId)?.version.evidenceRefIds.length ?? 0) > 0),
      `Brief delta ${id} cannot be traced to Claim evidence.`,
    );
  }
  const agendaById = new Map(views.Agenda.items.map((item) => [item.id, item]));
  for (const id of views.Brief.agendaItemIds) {
    invariant(agendaById.has(id), `Brief Agenda item ${id} does not exist in Agenda.`);
  }
  const sourceKeys = [
    `claim:${state.id}`,
    ...views.Brief.deltaItemIds.map((id) => `timeline_delta:${id}`),
    ...views.Brief.agendaItemIds.map((id) => `agenda_item:${id}`),
    `claim:${warning.id}`,
  ];
  invariant(new Set(sourceKeys).size === 6, "Brief must use six unique source records.");
}

async function collectViews({ client, projectId }) {
  const output = {};
  for (const [label, route, key] of VIEW_ROUTES) {
    const response = await client(
      "GET",
      `/api/v1/projects/${encodeURIComponent(projectId)}/${route}`,
      { phase: "collect-deliverables" },
    );
    output[label] = response.data[key];
  }
  return output;
}

export async function runEricDemo({
  manifestPath,
  baseUrl = "http://localhost:3000",
  fetchImpl = globalThis.fetch,
  importFixture = importSyntheticFixture,
  correlationId = randomUUID(),
  acceptFixtureScenario: shouldAcceptScenario = false,
  confirmReviewedFixture = false,
  pollMs = 1_000,
  timeoutMs = 600_000,
}) {
  invariant(typeof fetchImpl === "function", "A Fetch implementation is required.");
  invariant(typeof importFixture === "function", "A fixture importer is required.");
  const safeBaseUrl = assertLoopbackBaseUrl(baseUrl);
  const loadedFixture = await fixtureManifest(manifestPath);
  const { fixture, manifest } = loadedFixture;
  const scopedCorrelationId = fixtureScopedCorrelationId(correlationId, fixture.key, manifest.id);
  const requests = [];
  const report = {
    schema_version: "notique-eric-demo.v1",
    status: "running",
    correlation_id: correlationId,
    fixture_correlation_id: scopedCorrelationId,
    fixture_key: fixture.key,
    fixture_id: manifest.id,
    fixture_manifest_path: fixture.relativePath,
    fixture_manifest_sha256: loadedFixture.sha256,
    base_url: safeBaseUrl,
    project: null,
    scenario_selection: null,
    extraction_runs: [],
    review_actions: [],
    views: null,
    requests,
    error: null,
    limitations: [
      "Synthetic fixture output is development evidence, not product-concept validation.",
      "Claims remain pending unless --confirm-reviewed-fixture is supplied explicitly.",
    ],
  };

  const requestTimeoutMs = Math.max(timeoutMs + 60_000, 660_000);
  const tracedImportFetch = async (input, options = {}) => {
    const response = await fetchImpl(input, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
    const url = new URL(input);
    requests.push(requestTrace({
      method: options.method ?? "GET",
      pathname: url.pathname,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      phase: "import-fixture",
    }));
    return response;
  };
  const client = (method, pathname, options = {}) => apiJson({
    fetchImpl,
    baseUrl: safeBaseUrl,
    method,
    pathname,
    requests,
    requestTimeoutMs,
    ...options,
  });

  try {
    const imported = await importFixture({
      manifestPath,
      baseUrl: safeBaseUrl,
      fetchImpl: tracedImportFetch,
      runId: scopedCorrelationId,
      probeUnconfiguredProvider: false,
    });
    report.project = imported.project;
    invariant(imported.events.length === manifest.events.length, "Importer returned the wrong number of Events.");

    for (const [index, event] of imported.events.entries()) {
      const resolvedRun = await loadOrCreateEventRun({
        client,
        event,
        correlationId: scopedCorrelationId,
      });
      const runId = resolvedRun.run.id;
      const runReport = {
        event_id: event.id,
        event_title: event.title,
        run_id: runId,
        reused_existing_run: resolvedRun.reusedExistingRun,
        event_request_id: resolvedRun.eventRequestId,
        existing_run_request_id: resolvedRun.existingRunRequestId,
        create_request_id: resolvedRun.createRequestId,
        terminal_request_id: null,
        provider_request_id: null,
        status: resolvedRun.run.status,
        error_code: null,
        dispatch_attempts: 0,
        dispatch_uncertain_count: 0,
        claim_count: 0,
        occurrence_count: 0,
        review_request_id: null,
      };
      report.extraction_runs.push(runReport);

      const terminal = await waitForRun({ client, runId, pollMs, timeoutMs });
      runReport.status = terminal.run.status;
      runReport.error_code = terminal.run.error_code ?? null;
      runReport.terminal_request_id = terminal.requestId;
      runReport.dispatch_attempts = terminal.dispatchAttempts;
      runReport.dispatch_uncertain_count = terminal.dispatchUncertainCount;
      if (!SUCCESS_RUN_STATUSES.has(terminal.run.status)) {
        throw new Error(
          `Extraction Run ${runId} ended as ${terminal.run.status}${terminal.run.error_code ? ` (${terminal.run.error_code})` : ""}.`,
        );
      }
      const debug = await client(
        "GET",
        `/api/v1/extraction-runs/${encodeURIComponent(runId)}/debug`,
        { phase: "load-run-debug" },
      );
      runReport.provider_request_id = debug.data.debug?.provider_request_id ?? null;
      runReport.provider = debug.data.debug?.provider ?? null;
      runReport.model = debug.data.debug?.model ?? null;
      runReport.input_snapshot_hash = debug.data.debug?.input_snapshot_hash ?? null;
      runReport.context_snapshot_hash = debug.data.debug?.context_snapshot_hash ?? null;

      const review = await loadRunReview({ client, runId });
      runReport.claim_count = review.claims.length;
      runReport.occurrence_count = review.occurrences.length;
      runReport.review_request_id = review.requestId;

      if (confirmReviewedFixture) {
        report.review_actions.push({
          event_id: event.id,
          run_id: runId,
          ...(await confirmFixtureReview({ client, runId, correlationId: scopedCorrelationId, review })),
        });
      }

      if (index === 0 && imported.events.length > 1) {
        const projectResponse = await client(
          "GET",
          `/api/v1/projects/${encodeURIComponent(imported.project.id)}`,
          { phase: "load-scenario" },
        );
        let project = projectResponse.data.project;
        if (project.scenario_status !== "confirmed") {
          if (!shouldAcceptScenario) {
            throw new Error(
              "The first Run produced Scenario candidates. Rerun with --accept-fixture-scenario after reviewing the synthetic fixture expectation; later Events are intentionally blocked until Scenario confirmation.",
            );
          }
          const accepted = await acceptFixtureScenario({
            client,
            manifest,
            project,
            correlationId: scopedCorrelationId,
          });
          project = accepted.project;
          report.scenario_selection = accepted.selection;
        } else {
          const expectation = fixtureScenarioExpectation(manifest);
          invariant(
            typeof project.scenario === "string" && project.scenario.trim(),
            "The existing confirmed Scenario is empty.",
          );
          const evaluation = evaluateFixtureScenario(project.scenario, expectation);
          invariant(
            evaluation.accepted,
            `The existing confirmed Scenario ${project.scenario} does not satisfy fixture ${expectation.expected}'s semantic acceptance matcher.`,
          );
          report.scenario_selection = fixtureScenarioSelection(
            project.scenario,
            expectation,
            evaluation,
            true,
          );
        }
        report.project = { id: project.id, name: project.name };
      }
    }

    const finalProject = await client(
      "GET",
      `/api/v1/projects/${encodeURIComponent(imported.project.id)}`,
      { phase: "load-final-project" },
    );
    report.project = finalProject.data.project;
    report.views = await collectViews({ client, projectId: imported.project.id });
    validateCollectedViews(report.views);
    if (confirmReviewedFixture) {
      validateVerifiedOutput({ project: report.project, views: report.views });
      report.status = "succeeded";
    } else {
      report.status = "awaiting_review";
    }
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = sanitizedError(error);
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.demoReport = report;
    throw failure;
  }
}

function displayValue(value, indent = 0) {
  const prefix = "  ".repeat(indent);
  if (value === null || value === undefined) return `${prefix}(none)`;
  if (Array.isArray(value)) {
    if (!value.length) return `${prefix}(empty)`;
    return value.map((item, index) => {
      if (item && typeof item === "object") {
        return `${prefix}${index + 1}.\n${displayValue(item, indent + 1)}`;
      }
      return `${prefix}${index + 1}. ${String(item)}`;
    }).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => key !== "generated_at");
    if (!entries.length) return `${prefix}(empty)`;
    return entries.map(([key, item]) => {
      if (item && typeof item === "object") {
        return `${prefix}${key}:\n${displayValue(item, indent + 1)}`;
      }
      return `${prefix}${key}: ${item ?? "(none)"}`;
    }).join("\n");
  }
  return `${prefix}${String(value)}`;
}

export function formatEricDemoReport(report) {
  const lines = [
    "NOTIQUE ERIC DEMO",
    `Status: ${report.status}`,
    `Correlation ID: ${report.correlation_id}`,
    `Fixture: ${report.fixture_key} (${report.fixture_id})`,
    `Fixture manifest: ${report.fixture_manifest_path}`,
    `Fixture SHA256: ${report.fixture_manifest_sha256}`,
    `Project ID: ${report.project?.id ?? "not created"}`,
  ];
  if (report.extraction_runs.length) {
    lines.push("", "EXTRACTION RUNS");
    for (const run of report.extraction_runs) {
      lines.push(
        `${run.event_title} | run_id=${run.run_id} | status=${run.status}`,
        `  reused_existing_run=${run.reused_existing_run ? "yes" : "no"}`,
        `  event_request_id=${run.event_request_id ?? "none"}`,
        `  existing_run_request_id=${run.existing_run_request_id ?? "none"}`,
        `  create_request_id=${run.create_request_id ?? "none"}`,
        `  terminal_request_id=${run.terminal_request_id ?? "none"}`,
        `  provider_request_id=${run.provider_request_id ?? "none"}`,
        `  review_request_id=${run.review_request_id ?? "none"}`,
        `  reviewable=${run.claim_count ?? 0} claims + ${run.occurrence_count ?? 0} occurrences`,
        `  dispatch_attempts=${run.dispatch_attempts ?? 0} (uncertain=${run.dispatch_uncertain_count ?? 0})`,
      );
    }
  }
  if (report.project && typeof report.project === "object") {
    lines.push(
      "",
      "PROJECT STATE",
      `Scenario: ${report.project.scenario ?? "not confirmed"}`,
      `Pending Claims: ${report.project.pending_claim_count ?? "unknown"}`,
      `Pending Occurrences: ${report.project.pending_occurrence_count ?? "unknown"}`,
    );
  }
  if (report.views) {
    for (const [label] of VIEW_ROUTES) {
      lines.push("", label.toUpperCase(), displayValue(report.views[label]));
    }
  }
  if (report.error) {
    lines.push("", "ERROR", `${report.error.code}: ${report.error.message}`);
  }
  lines.push("", `Request trace entries: ${report.requests.length}`);
  return `${lines.join("\n")}\n`;
}
