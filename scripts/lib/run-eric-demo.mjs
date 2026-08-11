import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertLoopbackBaseUrl,
  importSyntheticFixture,
  validateSyntheticManifest,
} from "../import-synthetic-fixture.mjs";

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
  const value = validateSyntheticManifest(
    JSON.parse(await readFile(path.resolve(manifestPath), "utf8")),
  );
  invariant(value.synthetic === true, "The one-click demo only accepts a manifest marked synthetic=true.");
  return value;
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
  const expected = manifest.scenario?.expected;
  invariant(typeof expected === "string" && expected, "Synthetic manifest has no scenario.expected value.");
  const candidates = Array.isArray(project.scenario_candidates) ? project.scenario_candidates : [];
  invariant(
    candidates.length >= 2 && candidates.length <= 3 &&
      candidates.every((candidate) => typeof candidate?.scenario === "string" && candidate.scenario.trim()),
    "The first extraction did not return two or three usable Scenario candidates.",
  );
  const expectedCandidate = candidates.find(
    (candidate) => candidate.scenario.trim() === expected,
  );
  invariant(
    expectedCandidate,
    `The first extraction did not offer the fixed fixture Scenario ${expected}; refusing to confirm a different candidate.`,
  );
  const selected = expected;
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
    selection: {
      selected,
      fixture_expected: expected,
      exact_fixture_match: selected === expected,
    },
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCollectedViews(views) {
  invariant(isRecord(views["Folder Summary"]), "Folder Summary must be an object.");
  invariant(
    Array.isArray(views["Folder Summary"].currentClaims) &&
      Array.isArray(views["Folder Summary"].recentDeltas),
    "Folder Summary must contain currentClaims and recentDeltas arrays.",
  );
  invariant(Array.isArray(views.Timeline), "Timeline must be an array.");
  for (const label of ["Decisions", "Preferences", "Open Questions"]) {
    invariant(Array.isArray(views[label]), `${label} must be an array.`);
  }
  invariant(
    isRecord(views.Risks) &&
      Array.isArray(views.Risks.claims) &&
      Array.isArray(views.Risks.contradictions),
    "Risks must contain claims and contradictions arrays.",
  );
  invariant(Array.isArray(views.Agenda), "Agenda must be an array.");
  invariant(
    isRecord(views.Brief) &&
      (typeof views.Brief.stateClaimId === "string" || views.Brief.stateClaimId === null) &&
      Array.isArray(views.Brief.deltaItemIds) &&
      Array.isArray(views.Brief.agendaItemIds) &&
      (typeof views.Brief.riskClaimId === "string" || views.Brief.riskClaimId === null),
    "Brief must contain stateClaimId, deltaItemIds, agendaItemIds, and riskClaimId.",
  );
}

function validateVerifiedOutput({ project, views }) {
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
  invariant(
    typeof views.Brief.stateClaimId === "string" && views.Brief.stateClaimId,
    "Explicit fixture confirmation produced an empty Brief state.",
  );
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
  const manifest = await fixtureManifest(manifestPath);
  const requests = [];
  const report = {
    schema_version: "notique-eric-demo.v1",
    status: "running",
    correlation_id: correlationId,
    fixture_id: manifest.id,
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
      runId: correlationId,
      probeUnconfiguredProvider: false,
    });
    report.project = imported.project;
    invariant(imported.events.length === manifest.events.length, "Importer returned the wrong number of Events.");

    for (const [index, event] of imported.events.entries()) {
      const created = await client(
        "POST",
        `/api/v1/events/${encodeURIComponent(event.id)}/extraction-runs`,
        {
          phase: "create-extraction",
          idempotency: idempotencyKey(correlationId, `extract:${event.id}`),
          json: { asset_version_ids: event.asset_version_ids },
        },
      );
      const runId = created.data.run?.id;
      invariant(typeof runId === "string" && runId, `Event ${event.id} returned no extraction Run ID.`);
      const runReport = {
        event_id: event.id,
        event_title: event.title,
        run_id: runId,
        create_request_id: created.requestId,
        terminal_request_id: null,
        provider_request_id: null,
        status: created.data.run.status,
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
          ...(await confirmFixtureReview({ client, runId, correlationId, review })),
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
          const accepted = await acceptFixtureScenario({ client, manifest, project, correlationId });
          project = accepted.project;
          report.scenario_selection = accepted.selection;
        } else {
          invariant(
            project.scenario === manifest.scenario?.expected,
            `The existing confirmed Scenario ${project.scenario ?? "(none)"} does not match the fixed fixture expectation.`,
          );
          report.scenario_selection = {
            selected: project.scenario,
            fixture_expected: manifest.scenario.expected,
            exact_fixture_match: true,
            reused_existing_verdict: true,
          };
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
    `Project ID: ${report.project?.id ?? "not created"}`,
  ];
  if (report.extraction_runs.length) {
    lines.push("", "EXTRACTION RUNS");
    for (const run of report.extraction_runs) {
      lines.push(
        `${run.event_title} | run_id=${run.run_id} | status=${run.status}`,
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
