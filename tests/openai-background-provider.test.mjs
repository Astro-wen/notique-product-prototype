import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAiBackgroundPending,
  OpenAiBackgroundRequestFailed,
  OpenAiBackgroundStalled,
  requestOpenAiBackgroundResponse,
} from "../lib/server/ai/openai-background.ts";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("an OpenAI background stage resumes with GET and never repeats POST", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const persisted = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    if (init.method === "POST") {
      return jsonResponse({ id: "resp_inventory_1", status: "queued" });
    }
    return jsonResponse({
      id: "resp_inventory_1",
      status: "completed",
      output_text: JSON.stringify({
        schema_version: "claim-inventory.v1",
        event_id: "event-1",
        candidates: [],
      }),
      usage: {
        input_tokens: 120,
        output_tokens: 24,
        input_tokens_details: { cached_tokens: 80 },
      },
    });
  };

  try {
    await assert.rejects(
      requestOpenAiBackgroundResponse({
        apiKey: "test-key",
        baseUrl: "https://api.openai.test/v1",
        requestBody: { model: "gpt-5.6-luna", reasoning: { effort: "xhigh" } },
        idempotencyKey: "notique:run-1:inventory:1",
        fetcher: globalThis.fetch,
        onResponse: async (response) => persisted.push(response),
      }),
      (error) => {
        assert.ok(error instanceof OpenAiBackgroundPending);
        assert.equal(error.responseId, "resp_inventory_1");
        return true;
      },
    );
    assert.deepEqual(persisted, [{ id: "resp_inventory_1", status: "queued" }]);

    const completed = await requestOpenAiBackgroundResponse({
      apiKey: "test-key",
      baseUrl: "https://api.openai.test/v1",
      requestBody: { model: "gpt-5.6-luna", reasoning: { effort: "xhigh" } },
      idempotencyKey: "notique:run-1:inventory:1",
      resumeResponseId: "resp_inventory_1",
      fetcher: globalThis.fetch,
      onResponse: async (response) => persisted.push(response),
    });

    assert.equal(completed.body.id, "resp_inventory_1");
    assert.deepEqual(requests.map((request) => request.method), ["POST", "GET"]);
    assert.equal(requests[0].url, "https://api.openai.test/v1/responses");
    assert.equal(requests[1].url, "https://api.openai.test/v1/responses/resp_inventory_1");
    assert.equal(requests[0].headers["idempotency-key"], "notique:run-1:inventory:1");
    assert.equal(requests[1].body, undefined);
    const firstBody = JSON.parse(requests[0].body);
    assert.equal(firstBody.background, true);
    assert.equal(firstBody.reasoning.effort, "xhigh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a terminal background failure is handled without issuing a replacement POST", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  const statuses = [];
  globalThis.fetch = async (_url, init = {}) => {
    methods.push(init.method);
    return jsonResponse({
      id: "resp_failed_1",
      status: "failed",
      error: { code: "server_error" },
    });
  };

  try {
    await assert.rejects(
      requestOpenAiBackgroundResponse({
        apiKey: "test-key",
        baseUrl: "https://api.openai.test/v1",
        requestBody: { model: "gpt-5.6-luna", reasoning: { effort: "xhigh" } },
        idempotencyKey: "notique:run-2:inventory:1",
        resumeResponseId: "resp_failed_1",
        fetcher: globalThis.fetch,
        onResponse: async (response) => statuses.push(response.status),
      }),
      (error) => {
        assert.ok(error instanceof OpenAiBackgroundRequestFailed);
        assert.equal(error.httpStatus, 422);
        return true;
      },
    );
    assert.deepEqual(methods, ["GET"]);
    assert.deepEqual(statuses, ["failed"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persistence or transport retry can replay the same POST idempotency key", async () => {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method, headers: init.headers });
    return jsonResponse({ id: "resp_replayed_1", status: "queued" });
  };
  const call = () => requestOpenAiBackgroundResponse({
    apiKey: "test-key",
    baseUrl: "https://api.openai.test/v1",
    requestBody: { model: "gpt-5.6-luna", reasoning: { effort: "xhigh" } },
    idempotencyKey: "notique:run-3:inventory:1",
    fetcher,
    onResponse: async () => {
      throw new Error("temporary database failure");
    },
  });

  await assert.rejects(call(), OpenAiBackgroundRequestFailed);
  await assert.rejects(call(), OpenAiBackgroundRequestFailed);
  assert.deepEqual(requests.map((request) => request.method), ["POST", "POST"]);
  assert.deepEqual(
    requests.map((request) => request.headers["idempotency-key"]),
    ["notique:run-3:inventory:1", "notique:run-3:inventory:1"],
  );
});

test("processor persists a Response ID before yielding and reuses the same stage attempt", async () => {
  const processor = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8"));
  const repository = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../lib/server/db/extraction-stage-repository.ts", import.meta.url), "utf8"));
  const provider = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../lib/server/ai/model-provider.ts", import.meta.url), "utf8"));

  assert.match(provider, /requestOpenAiBackgroundResponse/);
  assert.match(processor, /canResumeExisting[\s\S]*resumeProviderResponseId:\s*existing\.provider_request_id/);
  assert.match(processor, /onProviderResponse[\s\S]*upsertExtractionModelStage[\s\S]*providerRequestId:\s*response\.id/);
  assert.match(processor, /ModelBackgroundPendingError[\s\S]*Keep[\s\S]*GET \/responses\/:id/);
  assert.match(processor, /isTransientModelError\(error\)[\s\S]*same Idempotency-Key[\s\S]*persisted Response ID/);
  assert.match(repository, /provider_request_id\s*=\s*COALESCE\([\s\S]*excluded\.provider_request_id/);
  assert.match(processor, /last_error_code\s*=\s*'BACKGROUND_RESPONSE_PENDING'/);
  assert.match(processor, /attempt\s*=\s*CASE WHEN attempt > 0 THEN attempt - 1/);
  assert.match(
    processor,
    /Release the Run and requeue its durable outbox message atomically[\s\S]*UPDATE queue_outbox/,
  );
});


test("恢复时后台响应超过预算仍无进展：取消并要求重发；预算内照旧等待", async () => {
  const requests = [];
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  const fetcher = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).endsWith("/cancel")) return jsonResponse({ id: "resp_stuck", status: "cancelled" });
    return jsonResponse({ id: "resp_stuck", status: "in_progress", created_at: tenMinutesAgo });
  };
  // 线上见过：同批三块一分钟完，一块 in_progress 十二分钟没吐一个字。
  await assert.rejects(
    requestOpenAiBackgroundResponse({
      apiKey: "k", baseUrl: "https://api.example.test/v1", requestBody: {},
      resumeResponseId: "resp_stuck", stallBudgetMs: 5 * 60_000, fetcher,
    }),
    (error) => error instanceof OpenAiBackgroundStalled && error.responseId === "resp_stuck" && error.ageMs > 5 * 60_000,
  );
  assert.deepEqual(requests.map((r) => r.method + " " + r.url.split("/v1")[1]), [
    "GET /responses/resp_stuck",
    "POST /responses/resp_stuck/cancel",
  ]);

  const justNow = Math.floor(Date.now() / 1000) - 30;
  await assert.rejects(
    requestOpenAiBackgroundResponse({
      apiKey: "k", baseUrl: "https://api.example.test/v1", requestBody: {},
      resumeResponseId: "resp_fresh", stallBudgetMs: 5 * 60_000,
      fetcher: async () => jsonResponse({ id: "resp_fresh", status: "in_progress", created_at: justNow }),
    }),
    OpenAiBackgroundPending,
  );

  // 不传预算：永远不取消，行为和以前一样。
  await assert.rejects(
    requestOpenAiBackgroundResponse({
      apiKey: "k", baseUrl: "https://api.example.test/v1", requestBody: {},
      resumeResponseId: "resp_stuck",
      fetcher: async () => jsonResponse({ id: "resp_stuck", status: "in_progress", created_at: tenMinutesAgo }),
    }),
    OpenAiBackgroundPending,
  );
});
