import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  DemoApiError,
  formatEricDemoReport,
  runEricDemo,
  validateCollectedViews,
  validateVerifiedOutput,
} from "../scripts/lib/run-eric-demo.mjs";
import { parseArgs } from "../scripts/run-eric-demo.mjs";

const manifestPath = path.resolve("eval/cases/synthetic-contractor-v1/manifest.json");
const expectedScenario = "contractor_renovation_estimate_and_preconstruction";
const naturalContractorScenario =
  "A contractor pre-construction site visit to define and price a kitchen renovation before final authorization.";
const actualContractorScenarioCandidates = [
  {
    scenario:
      "A residential kitchen renovation involving removal of a partition between the kitchen and dining area, with related finish, electrical, and lighting work.",
    confidence: 0.88,
    reason: "Broad project description",
  },
  {
    scenario: naturalContractorScenario,
    confidence: 0.82,
    reason: "Contractor workflow description",
  },
  {
    scenario:
      "A feasibility and authorization review for a potential kitchen-dining reconfiguration that may depend on structural and concealed-services findings.",
    confidence: 0.72,
    reason: "Feasibility description",
  },
];
const actualRealtorScenarioCandidates = [
  {
    scenario:
      "A residential home-purchase search for Lena and Evan, with Priya facilitating property screening and pre-offer planning.",
    confidence: 0.94,
    reason:
      "The event is explicitly identified as a first home-search consultation and covers price filtering, offer approval, and lender preapproval.",
  },
  {
    scenario:
      "A multigenerational owner-occupied home search on the San Francisco Peninsula, where an in-law unit, commute, and school district are key screening criteria.",
    confidence: 0.86,
    reason:
      "Lena identifies potential occupancy by her mother, a South San Francisco commute limit, and unresolved school-district boundaries.",
  },
  {
    scenario:
      "A joint-buyer pre-offer qualification stage in which the search cannot progress to an offer until price and school criteria are confirmed and the preapproval letter is refreshed.",
    confidence: 0.78,
    reason:
      "The top price and school scope remain unresolved, and the buyers state that a refreshed preapproval letter is required before making an offer.",
  },
];
const actualInsuranceScenarioCandidates = [
  {
    scenario:
      "Residential property-insurance first-loss handling for a kitchen water claim with resulting floor and basement-ceiling damage.",
    confidence: 0.98,
    reason:
      "The event explicitly describes a first-loss call for a kitchen water claim and discusses a carrier, deductible, declarations page, and named insureds.",
  },
  {
    scenario:
      "Insurance coverage and causation investigation for a suspected dishwasher shutoff water loss, including a pending lower-cabinet coverage determination.",
    confidence: 0.9,
    reason:
      "The source describes an initially suspected dishwasher shutoff leak, physical water damage, an unclear deductible, and an unresolved coverage question.",
  },
  {
    scenario:
      "Emergency water-remediation and permanent-repair coordination for a kitchen, with drying allowed but demolition held pending authorization and joint insured approval.",
    confidence: 0.82,
    reason:
      "DryRight remediation, the preference to avoid kitchen closure, continued drying, and the permanent-demolition restriction support this operational scenario.",
  },
];
const fixtureCases = [
  {
    key: "contractor",
    id: "synthetic-contractor-v1",
    path: "eval/cases/synthetic-contractor-v1/manifest.json",
    scenario: expectedScenario,
    candidate: naturalContractorScenario,
    eventCount: 3,
  },
  {
    key: "realtor",
    id: "synthetic-realtor-v1",
    path: "eval/cases/synthetic-realtor-v1/manifest.json",
    scenario: "real_estate_buyer_journey",
    candidate: actualRealtorScenarioCandidates[0].scenario,
    eventCount: 4,
  },
  {
    key: "insurance",
    id: "synthetic-insurance-v1",
    path: "eval/cases/synthetic-insurance-v1/manifest.json",
    scenario: "insurance_water_damage_claim_assessment",
    candidate: actualInsuranceScenarioCandidates[0].scenario,
    eventCount: 4,
  },
];

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
  emptyReview = false,
  emptyViews = false,
  interruptDispatch = false,
  scenarioCandidates = null,
  existingConfirmedScenario = null,
  existingRuns = {},
  projectContextVersion = 2,
  eventCount = 3,
} = {}) {
  const calls = [];
  const imports = [];
  let confirmedScenario = existingConfirmedScenario;
  let scenarioConfirmed = confirmedScenario !== null;
  let sequence = 0;
  const claimForRun = new Map();
  const claimStatus = new Map();
  const occurrenceStatus = new Map();
  const runStatus = new Map();
  const runContextVersion = new Map();
  const activeRunByEvent = new Map();
  let dirtyRemaining = dirtyDispatches;
  let dispatchInterrupted = false;

  for (const [eventId, existingRun] of Object.entries(existingRuns)) {
    const eventNumber = eventId.match(/^event-(\d+)$/)?.[1];
    assert.ok(eventNumber, `Invalid existing Event fixture ID: ${eventId}`);
    const runId = `run-${eventNumber}`;
    const config = typeof existingRun === "string"
      ? { status: existingRun, contextVersion: projectContextVersion }
      : existingRun;
    activeRunByEvent.set(eventId, runId);
    runStatus.set(runId, config.status);
    runContextVersion.set(runId, config.contextVersion ?? projectContextVersion);
    claimForRun.set(runId, `claim-${eventNumber}`);
    claimStatus.set(
      runId,
      config.status === "succeeded" || config.status === "completed_with_warnings"
        ? "verified"
        : "pending",
    );
    if (eventId === "event-2") occurrenceStatus.set(runId, "pending");
  }

  const importFixture = async ({ fetchImpl, runId }) => {
    imports.push({ runId });
    await fetchImpl("http://localhost:3000/api/v1/import-trace", { method: "GET" });
    return {
      run_id: runId,
      project: { id: "project-demo", name: "[SYNTHETIC] Oak Street" },
      events: Array.from({ length: eventCount }, (_, index) => index + 1).map((number) => ({
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
    const eventRoute = url.pathname.match(/^\/api\/v1\/events\/(event-\d+)$/);
    if (method === "GET" && eventRoute) {
      return envelope({
        event: {
          id: eventRoute[1],
          active_run_id: activeRunByEvent.get(eventRoute[1]) ?? null,
        },
        assets: [],
      }, requestId);
    }
    const extraction = url.pathname.match(/^\/api\/v1\/events\/(event-\d+)\/extraction-runs$/);
    if (method === "POST" && extraction) {
      if (activeRunByEvent.has(extraction[1])) {
        return failure(
          "IDEMPOTENCY_CONFLICT",
          `Event ${extraction[1]} already has an active extraction Run.`,
          requestId,
          409,
        );
      }
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
      runContextVersion.set(runId, projectContextVersion);
      activeRunByEvent.set(extraction[1], runId);
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
          context_version: runContextVersion.get(runRoute[1]) ?? projectContextVersion,
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
          scenario: confirmedScenario,
          scenario_status: scenarioConfirmed ? "confirmed" : "pending_confirmation",
          scenario_version: scenarioConfirmed ? 2 : 1,
          scenario_candidates: scenarioConfirmed
            ? []
            : scenarioCandidates ?? actualContractorScenarioCandidates,
          context_version: projectContextVersion,
          pending_claim_count: [...claimStatus.values()].filter((status) => status === "pending").length,
          pending_occurrence_count: [...occurrenceStatus.values()].filter((status) => status === "pending").length,
        },
      }, requestId);
    }
    if (method === "POST" && url.pathname === "/api/v1/projects/project-demo/scenario-verdict") {
      scenarioConfirmed = true;
      confirmedScenario = body.scenario;
      return envelope({
        project: {
          id: "project-demo",
          name: "[SYNTHETIC] Oak Street",
          scenario: confirmedScenario,
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
      const hasVerified = [...claimStatus.values()].some((status) => status === "verified") && !emptyViews;
      const makeClaim = ({ id, type, statement, lifecycleStatus = "active", needsAdditionalEvidence = false }) => ({
        id,
        projectId: "project-demo",
        eventId: "event-1",
        type,
        reviewStatus: "verified",
        lifecycleStatus,
        currentVersionId: `${id}-v1`,
        materiality: "high",
        confidenceBp: 9000,
        needsAdditionalEvidence,
        openedAt: type === "open_question" ? "2026-08-01T00:00:00.000Z" : null,
        lastRepeatedAt: null,
        repeatCount: 0,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        version: {
          id: `${id}-v1`,
          claimId: id,
          versionNo: 1,
          statement,
          normalizedValue: null,
          uncertainty: null,
          source: "ai",
          evidenceRefIds: [`evidence-${id}`],
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      });
      const currentClaims = hasVerified ? [
        makeClaim({ id: "decision-1", type: "decision", statement: "Proceed with the selected scope." }),
        makeClaim({ id: "decision-2", type: "decision", statement: "Keep the existing cabinets." }),
        makeClaim({ id: "preference-new", type: "preference", statement: "Use matte white porcelain." }),
        makeClaim({ id: "question-1", type: "open_question", statement: "Who will approve the change order?", needsAdditionalEvidence: true }),
        makeClaim({ id: "risk-1", type: "risk", statement: "Authorization remains incomplete.", needsAdditionalEvidence: true }),
      ] : [];
      const oldPreference = makeClaim({
        id: "preference-old",
        type: "preference",
        statement: "Use warm off-white quartz.",
        lifecycleStatus: "superseded",
      });
      const timelineClaims = hasVerified ? [...currentClaims, oldPreference] : [];
      const deltas = hasVerified ? [
        {
          id: "delta-preference",
          type: "superseded",
          eventId: "event-1",
          displayText: "Use warm off-white quartz. 更新为 Use matte white porcelain.",
          beforeClaimVersionId: "preference-old-v1",
          afterClaimVersionId: "preference-new-v1",
          relationId: "relation-preference",
        },
        {
          id: "delta-decision",
          type: "new",
          eventId: "event-1",
          displayText: "新增：Keep the existing cabinets.",
          afterClaimVersionId: "decision-2-v1",
        },
      ] : [];
      const projection = (claim) => ({
        claimId: claim.id,
        claimVersionId: claim.version.id,
        eventId: claim.eventId,
        lifecycleStatus: claim.lifecycleStatus,
        statement: claim.version.statement,
        evidenceRefIds: claim.version.evidenceRefIds,
      });
      const agendaItems = hasVerified ? [
        {
          id: "agenda-question",
          sourceKind: "open_question",
          claimId: "question-1",
          claimVersionId: "question-1-v1",
          statement: "Who will approve the change order?",
          evidenceRefIds: ["evidence-question-1"],
        },
        {
          id: "agenda-risk-evidence",
          sourceKind: "evidence_gap",
          claimId: "risk-1",
          claimVersionId: "risk-1-v1",
          statement: "补充证据：Authorization remains incomplete.",
          evidenceRefIds: ["evidence-risk-1"],
        },
      ] : [];
      if (projectView[1] === "next-meeting-agenda") {
        return envelope({ agenda: { items: agendaItems } }, requestId);
      }
      if (projectView[1] === "brief-card") {
        return envelope({ brief_card: {
          stateClaimId: hasVerified ? "decision-1" : null,
          deltaItemIds: hasVerified ? deltas.map((item) => item.id) : [],
          agendaItemIds: hasVerified ? agendaItems.map((item) => item.id) : [],
          riskClaimId: hasVerified ? "risk-1" : null,
          missingSlotCount: hasVerified ? 0 : 6,
          source: "deterministic_fallback",
        } }, requestId);
      }
      if (projectView[1] === "views/folder-summary") {
        return envelope({ view: {
          projectId: "project-demo",
          scenario: confirmedScenario,
          currentClaims,
          recentDeltas: deltas,
          emptyReason: hasVerified ? null : "尚无已确认的当前记录。",
        } }, requestId);
      }
      if (projectView[1] === "views/timeline") {
        return envelope({ view: hasVerified ? [{
          event: { id: "event-1", title: "First meeting" },
          summary: "Verified meeting summary.",
          claims: timelineClaims,
          deltas,
        }] : [] }, requestId);
      }
      if (projectView[1] === "views/decisions") {
        return envelope({ view: hasVerified ? currentClaims.filter((claim) => claim.type === "decision").map(projection) : [] }, requestId);
      }
      if (projectView[1] === "views/preferences") {
        return envelope({ view: hasVerified ? [oldPreference, currentClaims.find((claim) => claim.id === "preference-new")].map(projection) : [] }, requestId);
      }
      if (projectView[1] === "views/open-questions") {
        const question = currentClaims.find((claim) => claim.id === "question-1");
        return envelope({ view: hasVerified ? [{
          ...projection(question),
          openedAt: question.openedAt,
          lastRepeatedAt: null,
          repeatCount: 0,
          openDays: 1,
        }] : [] }, requestId);
      }
      if (projectView[1] === "views/risks") {
        return envelope({ view: {
          claims: hasVerified ? [currentClaims.find((claim) => claim.id === "risk-1")] : [],
          contradictions: [],
        } }, requestId);
      }
      return envelope({ view: [] }, requestId);
    }
    return failure("NOT_FOUND", `${method} ${url.pathname}`, requestId, 404);
  };

  return { calls, imports, fetchImpl, importFixture };
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
  assert.equal(report.fixture_key, "contractor");
  assert.equal(report.fixture_id, "synthetic-contractor-v1");
  assert.equal(report.fixture_manifest_path, "eval/cases/synthetic-contractor-v1/manifest.json");
  assert.match(report.fixture_manifest_sha256, /^[a-f0-9]{64}$/);
  assert.match(report.fixture_correlation_id, /^eric-demo-[a-f0-9]{24}$/);
  assert.equal(api.imports[0].runId, report.fixture_correlation_id);
  assert.deepEqual(report.extraction_runs.map((run) => run.run_id), ["run-1", "run-2", "run-3"]);
  assert.deepEqual(report.extraction_runs.map((run) => run.provider_request_id), [
    "provider-run-1",
    "provider-run-2",
    "provider-run-3",
  ]);
  assert.equal(report.review_actions.length, 3);
  assert.equal(report.review_actions[1].confirmed_occurrences, 1);
  assert.deepEqual(report.scenario_selection, {
    selected: naturalContractorScenario,
    fixture_expected: expectedScenario,
    semantic_matcher: "all_required_concepts.v1",
    matched_concepts: [
      { concept: "space", phrase: "kitchen" },
      { concept: "work", phrase: "renovation" },
      { concept: "contractor_workflow", phrase: "contractor" },
    ],
    exact_fixture_match: false,
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
  assert.equal(Array.isArray(report.views.Agenda.items), true);
  assert.doesNotThrow(() => validateCollectedViews(report.views));
  assert.ok(report.requests.every((item) => item.request_id));

  const writes = api.calls.filter((call) => call.method === "POST");
  assert.equal(writes.filter((call) => call.pathname.endsWith("/extraction-runs")).length, 3);
  assert.equal(writes.filter((call) => call.pathname === "/api/v1/local/jobs/dispatch").length, 3);
  assert.equal(writes.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 1);
  assert.equal(
    writes.find((call) => call.pathname.endsWith("/scenario-verdict")).body.scenario,
    naturalContractorScenario,
  );
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

test("view validation matches all eight production response shapes and rejects the legacy Agenda array", async () => {
  const api = demoDouble();
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "production-view-contract-unit",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.doesNotThrow(() => validateCollectedViews(report.views));
  assert.doesNotThrow(() => validateVerifiedOutput({ project: report.project, views: report.views }));

  const legacyAgenda = structuredClone(report.views);
  legacyAgenda.Agenda = legacyAgenda.Agenda.items;
  assert.throws(
    () => validateCollectedViews(legacyAgenda),
    /Agenda must be an object containing an items array/,
  );
});

test("verified-output validation rejects Preference leakage and an incomplete six-slot Brief", async () => {
  const api = demoDouble();
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "view-fail-closed-unit",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  const leakedPreferences = structuredClone(report.views);
  leakedPreferences.Preferences.push({
    ...leakedPreferences.Decisions[0],
    lifecycleStatus: "active",
  });
  assert.throws(
    () => validateVerifiedOutput({ project: report.project, views: leakedPreferences }),
    /Preferences includes a non-preference Claim/,
  );

  const incompleteBrief = structuredClone(report.views);
  incompleteBrief.Brief.riskClaimId = null;
  incompleteBrief.Brief.missingSlotCount = 1;
  assert.doesNotThrow(() => validateCollectedViews(incompleteBrief));
  assert.throws(
    () => validateVerifiedOutput({ project: report.project, views: incompleteBrief }),
    /Brief must contain all six evidence-backed slots/,
  );
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
      assert.match(error.message, /request_id=req-3/);
      assert.equal(error.demoReport.error.code, "MODEL_PROVIDER_NOT_CONFIGURED");
      assert.equal(error.demoReport.error.request_id, "req-3");
      return true;
    },
  );
  assert.equal(api.calls.filter((call) => call.pathname === "/api/v1/local/jobs/dispatch").length, 0);
});

test("resume reuses a succeeded Run from the prior context and proceeds to the next Event", async () => {
  const api = demoDouble({
    existingRuns: {
      "event-1": { status: "succeeded", contextVersion: 1 },
    },
    projectContextVersion: 2,
  });
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "resume-after-context-change-unit",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "succeeded");
  assert.equal(report.extraction_runs[0].run_id, "run-1");
  assert.equal(report.extraction_runs[0].reused_existing_run, true);
  assert.equal(report.extraction_runs[0].create_request_id, null);
  assert.equal(report.extraction_runs[1].run_id, "run-2");
  assert.equal(report.extraction_runs[1].reused_existing_run, false);
  const extractionPosts = api.calls.filter(
    (call) => call.method === "POST" && call.pathname.endsWith("/extraction-runs"),
  );
  assert.deepEqual(
    extractionPosts.map((call) => call.pathname),
    [
      "/api/v1/events/event-2/extraction-runs",
      "/api/v1/events/event-3/extraction-runs",
    ],
  );
});

test("resume reuses an in-flight Run and dispatches it without creating another Run", async () => {
  const api = demoDouble({
    existingRuns: {
      "event-1": "queued",
      "event-2": "succeeded",
      "event-3": "succeeded",
    },
    existingConfirmedScenario: naturalContractorScenario,
  });
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "resume-in-flight-unit",
    acceptFixtureScenario: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "awaiting_review");
  assert.equal(report.extraction_runs[0].reused_existing_run, true);
  assert.equal(report.extraction_runs[0].status, "succeeded");
  assert.equal(report.extraction_runs[0].dispatch_attempts, 1);
  assert.equal(
    api.calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/extraction-runs")).length,
    0,
  );
});

test("resume fails closed when an Event active Run already failed", async () => {
  const api = demoDouble({
    existingRuns: { "event-1": "failed" },
  });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "resume-failed-run-unit",
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.match(error.message, /Extraction Run run-1 ended as failed/);
      assert.equal(error.demoReport.extraction_runs[0].reused_existing_run, true);
      assert.equal(error.demoReport.extraction_runs[0].create_request_id, null);
      return true;
    },
  );
  assert.equal(
    api.calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/extraction-runs")).length,
    0,
  );
  assert.equal(api.calls.filter((call) => call.pathname === "/api/v1/local/jobs/dispatch").length, 0);
});

test("an Event without an active Run creates exactly one extraction Run", async () => {
  const api = demoDouble({
    existingRuns: {
      "event-2": "succeeded",
      "event-3": "succeeded",
    },
    existingConfirmedScenario: naturalContractorScenario,
  });
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "fresh-run-unit",
    acceptFixtureScenario: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "awaiting_review");
  assert.equal(report.extraction_runs[0].reused_existing_run, false);
  assert.ok(report.extraction_runs[0].create_request_id);
  assert.equal(
    api.calls.filter((call) => call.method === "POST" && call.pathname.endsWith("/extraction-runs")).length,
    1,
  );
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

test("fixture Scenario confirmation rejects unrelated candidates regardless of confidence", async () => {
  const api = demoDouble({
    scenarioCandidates: [
      { scenario: "Property inspection", confidence: 0.99, reason: "unrelated" },
      { scenario: "Insurance claim assessment", confidence: 0.01, reason: "unrelated" },
    ],
  });
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
      assert.match(error.message, /refusing to confirm an unrelated candidate/);
      assert.equal(error.demoReport.error.request_id, null);
      return true;
    },
  );
  assert.equal(api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 0);
});

test("fixture Scenario confirmation fails closed when two natural candidates match", async () => {
  const api = demoDouble({
    scenarioCandidates: [
      { scenario: naturalContractorScenario, confidence: 0.2, reason: "valid" },
      {
        scenario: "A contractor estimate for a kitchen renovation and remodeling project.",
        confidence: 0.9,
        reason: "also valid",
      },
    ],
  });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "scenario-ambiguous-unit",
      acceptFixtureScenario: true,
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    /refusing ambiguous automatic confirmation/,
  );
  assert.equal(api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 0);
});

test("an existing confirmed natural Scenario is semantically checked and reused", async () => {
  const api = demoDouble({ existingConfirmedScenario: naturalContractorScenario });
  const report = await runEricDemo({
    manifestPath,
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "existing-scenario-unit",
    acceptFixtureScenario: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "awaiting_review");
  assert.equal(report.scenario_selection.selected, naturalContractorScenario);
  assert.equal(report.scenario_selection.reused_existing_verdict, true);
  assert.equal(report.scenario_selection.exact_fixture_match, false);
  assert.equal(api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict")).length, 0);
});

test("an unrelated existing confirmed Scenario is rejected", async () => {
  const api = demoDouble({ existingConfirmedScenario: "Insurance claim assessment" });
  await assert.rejects(
    runEricDemo({
      manifestPath,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      correlationId: "existing-scenario-mismatch-unit",
      acceptFixtureScenario: true,
      pollMs: 0,
      timeoutMs: 1_000,
    }),
    /existing confirmed Scenario .* does not satisfy fixture/,
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
    "--fixture=realtor",
    "--correlation-id=resume-demo-2026",
    "--accept-fixture-scenario",
    "--confirm-reviewed-fixture",
    "--poll-ms=0",
    "--timeout-ms=1000",
    "--output=outputs/demo.json",
  ], "fixed-id", "invocation-id");
  assert.equal(parsed.correlationId, "resume-demo-2026");
  assert.equal(parsed.fixtureKey, "realtor");
  assert.match(parsed.manifestPath, /synthetic-realtor-v1\/manifest\.json$/);
  assert.equal(parsed.acceptFixtureScenario, true);
  assert.equal(parsed.confirmReviewedFixture, true);
  assert.equal(parsed.pollMs, 0);
  assert.equal(parsed.timeoutMs, 1_000);
  assert.match(parsed.outputPath, /outputs\/demo\.json$/);

  const resumed = parseArgs(["--correlation-id=resume-demo-2026"], "unused", "attempt-2");
  assert.match(resumed.outputPath, /contractor-resume-demo-2026-attempt-2\.json$/);
  assert.throws(() => parseArgs(["--correlation-id=../unsafe"]), /safe characters/);
  assert.throws(() => parseArgs(["--fixture=other"]), /must be one of/);
  assert.throws(
    () => parseArgs(["--fixture=contractor", "--fixture=realtor"]),
    /only be supplied once/,
  );

  const defaults = parseArgs([], "default-timeout-id", "default-invocation-id");
  assert.equal(defaults.fixtureKey, "contractor");
  assert.match(defaults.manifestPath, /synthetic-contractor-v1\/manifest\.json$/);
  assert.equal(defaults.timeoutMs, 600_000);
  assert.match(defaults.outputPath, /contractor-default-timeout-id-default-invocation-id\.json$/);
});

test("each approved fixture is selectable, traceable, and gets its own idempotency correlation", async () => {
  const correlations = new Set();
  for (const fixture of fixtureCases) {
    const parsed = parseArgs([`--fixture=${fixture.key}`], "shared-human-correlation", `invoke-${fixture.key}`);
    assert.equal(parsed.fixtureKey, fixture.key);
    assert.equal(parsed.fixturePath, fixture.path);
    assert.equal(parsed.manifestPath, path.resolve(fixture.path));

    const api = demoDouble({
      scenarioCandidates: [
        { scenario: fixture.candidate, confidence: 0.2, reason: "fixture" },
        { scenario: "Property inspection", confidence: 0.9, reason: "alternative" },
      ],
      eventCount: fixture.eventCount,
    });
    const report = await runEricDemo({
      ...parsed,
      fetchImpl: api.fetchImpl,
      importFixture: api.importFixture,
      acceptFixtureScenario: true,
      confirmReviewedFixture: true,
      pollMs: 0,
      timeoutMs: 1_000,
    });

    assert.equal(report.status, "succeeded");
    assert.equal(report.fixture_key, fixture.key);
    assert.equal(report.fixture_id, fixture.id);
    assert.equal(report.fixture_manifest_path, fixture.path);
    assert.match(report.fixture_manifest_sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.scenario_selection.selected, fixture.candidate);
    assert.equal(report.scenario_selection.fixture_expected, fixture.scenario);
    assert.equal(report.scenario_selection.exact_fixture_match, false);
    assert.equal(api.imports[0].runId, report.fixture_correlation_id);
    correlations.add(report.fixture_correlation_id);
  }
  assert.equal(correlations.size, fixtureCases.length);
});

test("Realtor home-purchase regression accepts only the correct natural candidate", async () => {
  const realtor = fixtureCases.find((fixture) => fixture.key === "realtor");
  const api = demoDouble({
    scenarioCandidates: actualRealtorScenarioCandidates,
    eventCount: realtor.eventCount,
  });
  const report = await runEricDemo({
    manifestPath: path.resolve(realtor.path),
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "realtor-home-purchase-regression",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "succeeded");
  assert.equal(report.scenario_selection.selected, actualRealtorScenarioCandidates[0].scenario);
  assert.deepEqual(report.scenario_selection.matched_concepts, [
    { concept: "client_role", phrase: "home purchase" },
    { concept: "property_search", phrase: "home purchase" },
    { concept: "journey_stage", phrase: "search" },
  ]);
  const verdicts = api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict"));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].body.scenario, actualRealtorScenarioCandidates[0].scenario);
});

test("Insurance first-loss regression accepts only the intake-stage candidate", async () => {
  const insurance = fixtureCases.find((fixture) => fixture.key === "insurance");
  const api = demoDouble({
    scenarioCandidates: actualInsuranceScenarioCandidates,
    eventCount: insurance.eventCount,
  });
  const report = await runEricDemo({
    manifestPath: path.resolve(insurance.path),
    fetchImpl: api.fetchImpl,
    importFixture: api.importFixture,
    correlationId: "insurance-first-loss-regression",
    acceptFixtureScenario: true,
    confirmReviewedFixture: true,
    pollMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(report.status, "succeeded");
  assert.equal(report.scenario_selection.selected, actualInsuranceScenarioCandidates[0].scenario);
  assert.deepEqual(report.scenario_selection.matched_concepts, [
    { concept: "insurance_workflow", phrase: "insurance" },
    { concept: "water_loss", phrase: "water" },
    { concept: "assessment", phrase: "claim" },
    { concept: "intake_stage", phrase: "first-loss" },
  ]);
  const verdicts = api.calls.filter((call) => call.pathname.endsWith("/scenario-verdict"));
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].body.scenario, actualInsuranceScenarioCandidates[0].scenario);
});

test("one-click runner refuses a manifest path outside the repository whitelist", async () => {
  await assert.rejects(
    runEricDemo({
      manifestPath: "/tmp/unreviewed-fixture/manifest.json",
      fetchImpl: async () => {
        throw new Error("network must not be reached");
      },
      importFixture: async () => {
        throw new Error("import must not be reached");
      },
    }),
    /only accepts repository fixture manifests/,
  );
});
