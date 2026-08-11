import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DemoApiError,
  formatEricDemoReport,
  runEricDemo,
} from "../scripts/lib/run-eric-demo.mjs";
import { parseArgs } from "../scripts/run-eric-demo.mjs";

const manifestPath = path.resolve("eval/cases/synthetic-contractor-v1/manifest.json");
const expectedScenario = "contractor_renovation_estimate_and_preconstruction";

function envelope(data, requestId, status = 200) {
  return new Response(JSON.stringify({ data, request_id: requestId }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function failure(code, message, requestId, status) {
  return new Response(JSON.stringify({ error: { code, message }, request_id: requestId }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function demoDouble({
  providerConfigured = true,
  dirtyDispatches = 0,
  omitExpectedScenario = false,
  emptyReview = false,
  emptyViews = false,
  interruptDispatch = false,
} = {}) {
  const calls = [];
  let scenarioConfirmed = false;
  let sequence = 0;
  const claimForRun = new Map();
  const claimStatus = new Map();
  const occurrenceStatus = new Map();
  const runStatus = new Map();
  let dirtyRemaining = dirtyDispatches;
  let dispatchInterrupted = false;

  const importFixture = async ({ fetchImpl, runId }) => {
    await fetchImpl("http://localhost:3000/api/v1/import-trace", { method: "GET" });
    return {
      run_id: runId,
      project: { id: "project-demo", name: "[SYNTHETIC] Oak Street" },
      events: [1, 2, 3].map((number) => ({
        id: `event-${number}`,
        title: `Event ${number}`,
        asset_version_ids: [`asset-version-${number}`],
      })),
    };
  };

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const headers = new Headers(options.headers);
    const body = options.body ? JSON.parse(String(options.body)) : null;
    calls.push({ method, pathname: url.pathname, headers, body });
    sequence += 1;
    const requestId = `req-${sequence}`;

    if (method === "GET" && url.pathname === "/api/v1/import-trace") {
      return envelope({ ok: true }, requestId);
    }
    const extraction = url.pathname.match(/^\/api\/v1\/events\/(event-\d+)\/extraction-runs$/);
    if (method === "POST" && extraction) {
      if (!providerConfigured) {
        return failure(
          "MODEL_PROVIDER_NOT_CONFIGURED",
          "AI provider is not configured. No extraction run was created.",
          requestId,
          503,
        );
      }
      const runId = `run-${extraction[1].at(-1)}`;
      claimForRun.set(runId, `claim-${extraction[1].at(-1)}`);
      claimStatus.set(runId, "pending");
      if (runId === "run-2") occurrenceStatus.set(runId, "pending");
      runStatus.set(runId, "queued");
      return envelope({ run: { id: runId, status: "queued" } }, requestId, 202);
    }
    if (method === "POST" && url.pathname === "/api/v1/local/jobs/dispatch") {
      if (dirtyRemaining > 0) {
        dirtyRemaining -= 1;
        return envelope({ dispatch: { claimed: 1, sent: 1, run_id: `dirty-${dirtyRemaining}` } }, requestId);
      }
      const queued = [...runStatus.entries()].find(([, status]) => status === "queued");
      if (queued) runStatus.set(queued[0], "succeeded");
      if (interruptDispatch && !dispatchInterrupted) {
        dispatchInterrupted = true;
        throw new TypeError("socket closed after request write");
      }
      return envelope({ dispatch: { claimed: queued ? 1 : 0, sent: queued ? 1 : 0 } }, requestId);
    }
    const runRoute = url.pathname.match(/^\/api\/v1\/extraction-runs\/(run-\d+)$/);
    if (method === "GET" && runRoute) {
      return envelope({
        run: {
          id: runRoute[1],
          status: runStatus.get(runRoute[1]) ?? "queued",
          error_code: null,
        },
      }, requestId);
    }
    const debugRoute = url.pathname.match(/^\/api\/v1\/extraction-runs\/(run-\d+)\/debug$/);
    if (method === "GET" && debugRoute) {
      return envelope({
        debug: {
          id: debugRoute[1],
          provider: "openai",
          model: "fixed-test-model",
          provider_request_id: `provider-${debugRoute[1]}`,
          input_snapshot_hash: `input-${debugRoute[1]}`,
          context_snapshot_hash: `context-${debugRoute[1]}`,
        },
      }, requestId);
    }
    const reviewRoute = url.pathname.match(/^\/api\/v1\/extraction-runs\/(run-\d+)\/claims$/);
    if (method === "GET" && reviewRoute) {
      if (emptyReview) {
        return envelope({
          run: { id: reviewRoute[1], status: "succeeded" },
          claims: [],
          occurrence_candidates: [],
        }, requestId);
      }
      const claimId = claimForRun.get(reviewRoute[1]);
      return envelope({
        run: { id: reviewRoute[1], status: "succeeded" },
        claims: [{
          id: claimId,
          review_status: claimStatus.get(reviewRoute[1]),
          current_version: { id: `version-${claimId}` },
        }],
        occurrence_candidates: reviewRoute[1] === "run-2"
          ? [{
              id: "occurrence-2",
              status: occurrenceStatus.get(reviewRoute[1]),
              base_version_id: "target-version-1",
            }]
          : [],
      }, requestId);
    }
    if (
      method === "POST" &&
      /^\/api\/v1\/claims\/claim-\d+\/evidence-review-attestations$/.test(url.pathname)
    ) {
      return envelope({ claim: { id: url.pathname.split("/")[4] } }, requestId);
    }
    if (method === "POST" && url.pathname === "/api/v1/claims/batch-verdicts") {
      for (const item of body.verdicts) {
        const runId = [...claimForRun.entries()].find(([, claimId]) => claimId === item.claim_id)?.[0];
        if (runId) claimStatus.set(runId, "verified");
      }
      return envelope({ verdicts: body.verdicts.map((item) => ({ claim: { id: item.claim_id } })) }, requestId);
    }
    if (method === "POST" && url.pathname === "/api/v1/occurrence-candidates/occurrence-2/verdicts") {
      occurrenceStatus.set("run-2", "confirmed");
      return envelope({ occurrence_verdict: { candidate_id: "occurrence-2", status: "confirm" } }, requestId);
    }
    if (method === "GET" && url.pathname === "/api/v1/projects/project-demo") {
      return envelope({
        project: {
          id: "project-demo",
          name: "[SYNTHETIC] Oak Street",
          scenario: scenarioConfirmed ? expectedScenario : null,
          scenario_status: scenarioConfirmed ? "confirmed" : "pending_confirmation",
          scenario_version: scenarioConfirmed ? 2 : 1,
          scenario_candidates: scenarioConfirmed
            ? []
            : omitExpectedScenario
              ? [
                  { scenario: "property_inspection", confidence: 0.9, reason: "alternative" },
                  { scenario: "insurance_claim", confidence: 0.1, reason: "alternative" },
                ]
              : [
                  { scenario: expectedScenario, confidence: 0.2, reason: "fixture" },
                  { scenario: "property_inspection", confidence: 0.9, reason: "alternative" },
                ],
          pending_claim_count: [...claimStatus.values()].filter((status) => status === "pending").length,
          pending_occurrence_count: [...occurrenceStatus.values()].filter((status) => status === "pending").length,
        },
      }, requestId);
    }
    if (method === "POST" && url.pathname === "/api/v1/projects/project-demo/scenario-verdict") {
      scenarioConfirmed = true;
      return envelope({
        project: {
          id: "project-demo",
          name: "[SYNTHETIC] Oak Street",
          scenario: expectedScenario,
          scenario_status: "confirmed",
          scenario_version: 2,
          scenario_candidates: [],
        },
      }, requestId);
    }
    const projectView = url.pathname.match(
      /^\/api\/v1\/projects\/project-demo\/(views\/(?:folder-summary|timeline|decisions|preferences|open-questions|risks)|next-meeting-agenda|brief-card)$/,
    );
    if (method === "GET" && projectView) {
      const verifiedClaims = [...claimStatus.entries()]
        .filter(([, status]) => status === "verified")
        .map(([runId]) => ({ id: claimForRun.get(runId), statement: "Verified output" }));
      const hasVerified = verifiedClaims.length > 0 && !emptyViews;
      if (projectView[1] === "next-meeting-agenda") {
        return envelope({ agenda: hasVerified ? [{ id: "agenda-1", statement: "Ask one question" }] : [] }, requestId);
      }
      if (projectView[1] === "brief-card") {
        return envelope({ brief_card: {
          stateClaimId: hasVerified ? verifiedClaims[0].id : null,
          deltaItemIds: hasVerified ? ["delta-1"] : [],
          agendaItemIds: hasVerified ? ["agenda-1"] : [],
          riskClaimId: null,
          missingSlotCount: hasVerified ? 3 : 6,
          source: "deterministic_fallback",
        } }, requestId);
      }
      if (projectView[1] === "views/folder-summary") {
        return envelope({ view: {
          projectId: "project-demo",
          scenario: scenarioConfirmed ? expectedScenario : null,
          currentClaims: hasVerified ? verifiedClaims : [],
          recentDeltas: hasVerified ? [{ id: "delta-1", displayText: "新增" }] : [],
          emptyReason: hasVerified ? null : "尚无已确认的当前记录。",
        } }, requestId);
      }
      if (projectView[1] === "views/timeline") {
        return envelope({ view: hasVerified ? [{
          event: { id: "event-1" },
          claims: verifiedClaims,
          deltas: [{ id: "delta-1", displayText: "新增" }],
        }] : [] }, requestId);
      }
      if (projectView[1] === "views/risks") {
        return envelope({ view: { claims: [], contradictions: [] } }, requestId);
      }
      return envelope({ view: [] }, requestId);
    }
    return failure("NOT_FOUND", `${method} ${url.pathname}`, requestId, 404);
  };

  return { calls, fetchImpl, importFixture };
}

test("one-click demo runs three real API extractions and prints all requested views", async () => {
  const api = demoDouble();
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "demo-unit",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "succeeded");
  assert.deepEqual(report.extraction_runs.map((run) => run.run_id), ["run-1", "run-2", "run-3"]);
  assert.deepEqual(report.extraction_runs.map((run) => run.provider_request_id), [
    "provider-run-1",
    "provider-run-2",
    "provider-run-3",
  ]);
  assert.equal(report.review_actions.length, 3);
  assert.equal(report.review_actions[1].confirmed_occurrences, 1);
  assert.deepEqual(report.scenario_selection, {
    selected: expectedScenario,
    fixture_expected: expectedScenario,
    exact_fixture_match: true,
  });
  assert.deepEqual(Object.keys(report.views), [
    "Folder Summary",
    "Timeline",
    "Decisions",
    "Preferences",
    "Open Questions",
    "Risks",
    "Agenda",
    "Brief",
  ]);
  assert.ok(report.requests.every((item) => item.request_id));

  const writes = api.calls.filter((call) => call.method === "POST");
  assert.equal(writes.filter((call) => call.pathname.endsWith("/extraction-runs")).length, 3);
  assert.equal(writes.filter((call) => call.pathname === "/api/v1/local/jobs/dispatch").length, 3);
  assert.equal(writes.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 1);
  assert.equal(writes.filter((call) => call.pathname.endsWith("/evidence-review-attestations")).length, 3);
  assert.equal(writes.filter((call) => call.pathname === "/api/v1/claims/batch-verdicts").length, 3);
  assert.ok(writes.every((call) => call.headers.get("origin") === "http://localhost:3000"));
  assert.ok(
    writes
      .filter((call) => call.pathname !== "/api/v1/local/jobs/dispatch")
      .every((call) => call.headers.has("idempotency-key") || call.pathname === "/api/v1/import-trace"),
  );

  const text = formatEricDemoReport(report);
  assert.match(text, /FOLDER SUMMARY/);
  assert.match(text, /OPEN QUESTIONS/);
  assert.match(text, /AGENDA/);
  assert.match(text, /BRIEF/);
  assert.match(text, /run_id=run-3/);
  assert.match(text, /provider_request_id=provider-run-3/);
});

test("one-click demo never confirms a Scenario or Claim without explicit flags", async () => {
  const api = demoDouble();
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "no-confirm-unit",
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, /--accept-fixture-scenario/);
      assert.equal(error.demoReport.status, "failed");
      assert.equal(error.demoReport.extraction_runs.length, 1);
      return true;
    },
  );
  assert.equal(api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 0);
  assert.equal(api.calls.filter((call) => call.pathname.includes("batch-verdicts")).length, 0);
  assert.equal(api.calls.filter((call) => call.pathname.includes("evidence-review-attestations")).length, 0);
});

test("missing model configuration fails honestly and keeps the server request ID", async () => {
  const api = demoDouble({ providerConfigured: false });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "missing-provider-unit",
      acceptFixtureScenario: true,
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.ok(error instanceof DemoApiError);
      assert.equal(error.code, "MODEL_PROVIDER_NOT_CONFIGURED");
      assert.match(error.message, /request_id=req-2/);
      assert.equal(error.demoReport.error.code, "MODEL_PROVIDER_NOT_CONFIGURED");
      assert.equal(error.demoReport.error.request_id, "req-2");
      return true;
    },
  );
  assert.equal(api.calls.filter((call) => call.pathname === "/api/v1/local/jobs/dispatch").length, 0);
});

test("dirty local queue is drained until this demo Run reaches a terminal state", async () => {
  const api = demoDouble({ dirtyDispatches: 2 });
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "dirty-queue-unit",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });
  assert.equal(report.status, "succeeded");
  assert.equal(report.extraction_runs[0].dispatch_attempts, 3);
  assert.equal(
    api.calls.filter((call) => call.pathname === "/api/v1/local/jobs/dispatch").length,
    5,
  );
});

test("fixture Scenario confirmation fails instead of selecting a different candidate", async () => {
  const api = demoDouble({ omitExpectedScenario: true });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "scenario-mismatch-unit",
      acceptFixtureScenario: true,
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, /refusing to confirm a different candidate/);
      assert.equal(error.demoReport.error.request_id, null);
      return true;
    },
  );
  assert.equal(api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 0);
});

test("a succeeded Run with no Claim or Occurrence is rejected as empty output", async () => {
  const api = demoDouble({ emptyReview: true });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "empty-review-unit",
      acceptFixtureScenario: true,
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    /produced no reviewable Claim or Occurrence/,
  );
});

test("explicit confirmation cannot succeed with empty Verified views", async () => {
  const api = demoDouble({ emptyViews: true });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "empty-views-unit",
      acceptFixtureScenario: true,
      confirmReviewedFixture: true,
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    /produced no Verified Claim in Folder Summary/,
  );
});

test("uncertain dispatch response polls the known Run and never creates it twice", async () => {
  const api = demoDouble({ interruptDispatch: true });
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "dispatch-interruption-unit",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });
  assert.equal(report.status, "succeeded");
  assert.equal(report.extraction_runs[0].dispatch_uncertain_count, 1);
  assert.equal(api.calls.filter((call) => call.pathname.endsWith("/extraction-runs")).length, 3);
  assert.ok(report.requests.some((item) =>
    item.phase === "dispatch-extraction" && item.status === null && item.request_id === null
  ));
});

test("without automatic review the complete extraction is marked awaiting_review", async () => {
  const api = demoDouble();
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "awaiting-review-unit",
    acceptFixtureScenario: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });
  assert.equal(report.status, "awaiting_review");
  assert.equal(report.views["Folder Summary"].currentClaims.length, 0);
});

test("CLI requires separate explicit consent for synthetic review confirmation", () => {
  assert.throws(
    () => parseArgs(["--confirm-reviewed-fixture"], "fixed-id"),
    /requires --accept-fixture-scenario/,
  );
  const parsed = parseArgs([
    "--correlation-id=resume-demo-2026",
    "--accept-fixture-scenario",
    "--confirm-reviewed-fixture",
    "--poll-ms=0",
    "--timeout-ms=1000",
    "--output=outputs/demo.json",
  ], "fixed-id", "invocation-id");
  assert.equal(parsed.correlationId, "resume-demo-2026");
  assert.equal(parsed.acceptFixtureScenario, true);
  assert.equal(parsed.confirmReviewedFixture, true);
  assert.equal(parsed.pollMs, 0);
  assert.equal(parsed.timeoutMs, 1_000);
  assert.match(parsed.outputPath, /outputs\/demo\.json$/);

  const resumed = parseArgs(["--correlation-id=resume-demo-2026"], "unused", "attempt-2");
  assert.match(resumed.outputPath, /resume-demo-2026-attempt-2\.json$/);
  assert.throws(() => parseArgs(["--correlation-id=../unsafe"]), /safe characters/);

  const defaults = parseArgs([], "default-timeout-id", "default-invocation-id");
  assert.equal(defaults.timeoutMs, 600_000);
  assert.match(defaults.outputPath, /default-timeout-id-default-invocation-id\.json$/);
});
