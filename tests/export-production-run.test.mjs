import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPredictionPackage,
  normalizeApiRoot,
  stableStringify,
} from "../scripts/lib/export-production-run.mjs";
import { parseArgs } from "../scripts/export-production-run.mjs";

const run = {
  id: "run-1",
  project_id: "project-1",
  event_id: "event-1",
  status: "succeeded",
  model: "gpt-test-fixed",
  prompt_version: "prompt-v1",
  schema_version: "schema-v1",
};

const debug = {
  ...run,
  provider: "openai",
  parser_version: "parser-v1",
  model_params: { reasoning_effort: "max", max_output_tokens: 1_000 },
  input_hash: "input-hash",
  input_snapshot_hash: "input-snapshot-hash",
  input_manifest: [
    { asset_version_id: "asset-version-1", kind: "transcript", sha256: "asset-hash" },
  ],
  context_version: 3,
  context_snapshot_hash: "context-snapshot-hash",
  input_tokens: 120,
  output_tokens: 40,
  cached_tokens: 20,
  estimated_cost_usd: null,
  created_at: "2026-08-10T10:00:00.000Z",
  started_at: "2026-08-10T10:00:01.000Z",
  finished_at: "2026-08-10T10:00:03.500Z",
  validated_output: {
    schema_version: "schema-v1",
    event_id: "event-1",
    scenario_assessment: null,
    claims: [
      {
        client_claim_key: "claim-key-1",
        disposition: "new",
        reaffirmed_target_claim_id: null,
        reaffirmed_target_version_id: null,
        type: "requirement",
        statement: "Client requires written approval.",
        normalized_value: { approval: "written" },
        materiality: "high",
        confidence: 0.9,
        needs_additional_evidence: false,
        uncertainty: null,
        evidence: [
          {
            kind: "transcript",
            asset_version_id: "asset-version-1",
            segment_ids: ["segment-1"],
            quote_hint: "We need written approval.",
            evidence_role: "direct",
          },
        ],
        relations: [],
      },
    ],
  },
};

function response(data, status = 200) {
  return new Response(JSON.stringify(status < 400 ? { data, request_id: "volatile" } : data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixtureFetch() {
  const routes = new Map([
    ["/api/v1/extraction-runs/run-1", { run }],
    ["/api/v1/extraction-runs/run-1/debug", { debug }],
    ["/api/v1/extraction-runs/run-1/claims", {
      run,
      claims: [
        {
          id: "production-claim-1",
          type: "requirement",
          current_version: {
            id: "claim-version-1",
            statement: "Client requires written approval.",
            normalized_value: { approval: "written" },
          },
          evidence_ref_ids: ["evidence-1"],
        },
      ],
      occurrence_candidates: [],
    }],
    ["/api/v1/projects/project-1", {
      project: {
        id: "project-1",
        name: "Fixture project",
        locale: "en-US",
        scenario: "contractor_estimate",
        scenario_status: "confirmed",
        scenario_version: 2,
        ledger_version: 4,
        context_version: 3,
      },
    }],
    ["/api/v1/events/event-1", {
      event: {
        id: "event-1",
        project_id: "project-1",
        event_type: "estimate",
        title: "Estimate visit",
        occurred_at: "2026-08-10T09:00:00.000Z",
        sequence_no: 1,
      },
      assets: [],
    }],
    ["/api/v1/evidence-refs/evidence-1", {
      evidence_ref: {
        id: "evidence-1",
        kind: "transcript",
        asset_version_id: "asset-version-1",
        segment_ids: ["segment-1"],
        quote_raw: "We need written approval.",
        start_ms: 1_000,
        end_ms: 2_000,
        page_number: null,
        bbox: null,
        observation: null,
        evidence_role: "direct",
        structural_validation_status: "valid",
        semantic_support_verdict: "unreviewed",
      },
    }],
    ["/api/v1/projects/project-1/views/folder-summary", {
      view: {
        currentClaims: [{ id: "production-claim-1" }, { id: "risk-1" }],
      },
    }],
    ["/api/v1/projects/project-1/views/timeline", {
      view: [{ deltas: [{ id: "delta-1" }, { id: "delta-2" }] }],
    }],
    ["/api/v1/projects/project-1/views/decisions", { view: [] }],
    ["/api/v1/projects/project-1/views/preferences", { view: [] }],
    ["/api/v1/projects/project-1/views/open-questions", { view: [] }],
    ["/api/v1/projects/project-1/views/risks", { view: { claims: [], contradictions: [] } }],
    ["/api/v1/projects/project-1/gap-check", { gap_check: { applicable: false } }],
    ["/api/v1/projects/project-1/next-meeting-agenda", {
      agenda: [{ id: "agenda-1" }, { id: "agenda-2" }],
    }],
    ["/api/v1/projects/project-1/brief-card", {
      brief_card: {
        stateClaimId: "production-claim-1",
        deltaItemIds: ["delta-1", "delta-2"],
        agendaItemIds: ["agenda-1", "agenda-2"],
        riskClaimId: "risk-1",
        generated_at: "must-be-removed",
      },
    }],
  ]);
  return async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.accept, "application/json");
    const body = routes.get(url.pathname);
    if (!body) return response({ error: { code: "NOT_FOUND" } }, 404);
    return response(body);
  };
}

function twoRunFixtureFetch({ runOverrides = {}, debugOverrides = {} } = {}) {
  const baseFetch = fixtureFetch();
  const secondRun = {
    ...run,
    id: "run-2",
    ...runOverrides,
  };
  const secondDebug = {
    ...debug,
    ...secondRun,
    ...debugOverrides,
    validated_output: {
      ...debug.validated_output,
      event_id: secondRun.event_id,
      ...(debugOverrides.validated_output ?? {}),
    },
  };
  return async (url, options) => {
    if (url.pathname === "/api/v1/extraction-runs/run-2") {
      return response({ run: secondRun });
    }
    if (url.pathname === "/api/v1/extraction-runs/run-2/debug") {
      return response({ debug: secondDebug });
    }
    if (url.pathname === "/api/v1/extraction-runs/run-2/claims") {
      return response({ run: secondRun, claims: [], occurrence_candidates: [] });
    }
    if (url.pathname === "/api/v1/events/event-2") {
      return response({
        event: {
          id: "event-2",
          project_id: secondRun.project_id,
          event_type: "estimate",
          title: "Second estimate visit",
          occurred_at: "2026-08-10T09:00:00.000Z",
          sequence_no: 1,
        },
        assets: [],
      });
    }
    if (url.pathname === "/api/v1/projects/project-2") {
      return response({
        project: {
          id: "project-2",
          name: "Second fixture project",
          locale: "en-US",
          scenario: "contractor_estimate",
          scenario_status: "confirmed",
          scenario_version: 2,
          ledger_version: 4,
          context_version: secondDebug.context_version,
        },
      });
    }
    if (url.pathname.startsWith("/api/v1/projects/project-2/")) {
      const replacement = new URL(url);
      replacement.pathname = replacement.pathname.replace("/projects/project-2/", "/projects/project-1/");
      return baseFetch(replacement, options);
    }
    return baseFetch(url, options);
  };
}

test("API roots fail closed outside localhost unless the exact test host is allowed", () => {
  assert.equal(
    normalizeApiRoot({
      baseUrl: "http://localhost:3000",
      environment: "local",
      allowedTestHost: null,
    }).href,
    "http://localhost:3000/api/v1/",
  );
  assert.throws(
    () => normalizeApiRoot({
      baseUrl: "https://api.notique.example",
      environment: "local",
      allowedTestHost: null,
    }),
    /require --environment test/,
  );
  assert.throws(
    () => normalizeApiRoot({
      baseUrl: "https://api-test.notique.example",
      environment: "test",
      allowedTestHost: "another-test.notique.example",
    }),
    /exact host and port/,
  );
  assert.throws(
    () => normalizeApiRoot({
      baseUrl: "http://api-test.notique.example",
      environment: "test",
      allowedTestHost: "api-test.notique.example",
    }),
    /require HTTPS/,
  );
  assert.equal(
    normalizeApiRoot({
      baseUrl: "https://api-test.notique.example/api/v1",
      environment: "test",
      allowedTestHost: "api-test.notique.example",
    }).href,
    "https://api-test.notique.example/api/v1/",
  );
  assert.throws(
    () => normalizeApiRoot({
      baseUrl: "http://user:secret@localhost:3000",
      environment: "local",
      allowedTestHost: null,
    }),
    /Credentials/,
  );
});

test("production Run export is deterministic and preserves unadjudicated fields", async () => {
  const options = {
    baseUrl: "http://localhost:3000",
    environment: "local",
    allowedTestHost: null,
    projectId: "project-1",
    runIds: ["run-1"],
    commitSha: "abc123",
    fetchImpl: fixtureFetch(),
  };
  const first = await buildPredictionPackage(options);
  const second = await buildPredictionPackage({ ...options, fetchImpl: fixtureFetch() });
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.schemaVersion, "notique-eval-predictions.v1");
  assert.equal(first.metadata.model, "gpt-test-fixed");
  assert.equal(first.metadata.prompt, "prompt-v1");
  assert.deepEqual(first.metadata.parameters, {
    max_output_tokens: 1_000,
    reasoning_effort: "max",
  });
  const exported = first.runs[0];
  assert.equal(exported.usage.inputTokens, 120);
  assert.equal(exported.usage.outputTokens, 40);
  assert.equal(exported.usage.latencyMs, 2_500);
  assert.equal(exported.usage.costUsd, null);
  assert.equal(exported.claims[0].matchedGroundTruthId, null);
  assert.equal(exported.claims[0].citationSupport, "unreviewed");
  assert.equal(exported.claims[0].unsupportedVisualClaim, null);
  assert.equal(exported.claims[0].evidence[0].id, "evidence-1");
  assert.equal(exported.claims[0].evidence[0].idValid, true);
  assert.equal(exported.claims[0].evidence[0].quoteExact, true);
  assert.equal(exported.viewLeakageCount, null);
  assert.equal(exported.brief.slots.length, 6);
  assert.equal(exported.brief.slots.every((slot) => slot.sourceValid), true);
  assert.equal("generated_at" in exported.views.briefCard, false);
  assert.equal(stableStringify(first).includes("secret"), false);
});

test("production Run export does not treat a nonempty missing Brief source as valid", async () => {
  const baseFetch = fixtureFetch();
  const fetchImpl = async (url, options) => {
    if (url.pathname === "/api/v1/projects/project-1/brief-card") {
      return response({
        brief_card: {
          stateClaimId: "missing-claim",
          deltaItemIds: ["missing-delta", "delta-2"],
          agendaItemIds: ["missing-agenda", "agenda-2"],
          riskClaimId: "risk-1",
        },
      });
    }
    return baseFetch(url, options);
  };
  const exported = await buildPredictionPackage({
    baseUrl: "http://localhost:3000",
    environment: "local",
    allowedTestHost: null,
    projectId: "project-1",
    runIds: ["run-1"],
    fetchImpl,
  });
  assert.deepEqual(
    exported.runs[0].brief.slots.map((slot) => slot.sourceValid),
    [false, false, true, false, true, true],
  );
});

test("project assertion and comparable frozen configurations are enforced", async () => {
  await assert.rejects(
    buildPredictionPackage({
      baseUrl: "http://localhost:3000",
      environment: "local",
      allowedTestHost: null,
      projectId: "wrong-project",
      runIds: ["run-1"],
      fetchImpl: fixtureFetch(),
    }),
    /does not belong to project/,
  );
});

test("multiple Runs must use the exact same Event, input snapshot, and context snapshot", async () => {
  const cases = [
    {
      label: "projectId",
      runOverrides: { project_id: "project-2", event_id: "event-2" },
      expected: /projectId, eventId must match exactly/,
    },
    {
      label: "eventId",
      runOverrides: { event_id: "event-2" },
    },
    {
      label: "inputSnapshotHash",
      debugOverrides: { input_snapshot_hash: "different-input-snapshot" },
    },
    {
      label: "inputManifest",
      debugOverrides: {
        input_manifest: [
          { asset_version_id: "asset-version-2", kind: "transcript", sha256: "different-hash" },
        ],
      },
    },
    {
      label: "contextSnapshotHash",
      debugOverrides: { context_snapshot_hash: "different-context-snapshot" },
    },
    {
      label: "contextVersion",
      debugOverrides: { context_version: 4 },
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      buildPredictionPackage({
        baseUrl: "http://localhost:3000",
        environment: "local",
        allowedTestHost: null,
        runIds: ["run-1", "run-2"],
        fetchImpl: twoRunFixtureFetch(fixture),
      }),
      fixture.expected ?? new RegExp(`${fixture.label} must match exactly`),
      fixture.label,
    );
  }

  const combined = await buildPredictionPackage({
    baseUrl: "http://localhost:3000",
    environment: "local",
    allowedTestHost: null,
    runIds: ["run-1", "run-2"],
    fetchImpl: twoRunFixtureFetch(),
  });
  assert.deepEqual(combined.runs.map((item) => item.id), ["run-1", "run-2"]);
});

test("CLI parser requires explicit Run IDs and validates environment", () => {
  assert.throws(() => parseArgs([]), /At least one --run-id/);
  assert.throws(
    () => parseArgs(["--run-id", "run-1", "--environment", "production"]),
    /local or test/,
  );
  assert.deepEqual(
    parseArgs(["--run-id", "run-1", "--run-id", "run-2", "--project-id", "project-1"])
      .runIds,
    ["run-1", "run-2"],
  );
});
