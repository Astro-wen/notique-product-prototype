import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertLoopbackBaseUrl,
  importSyntheticFixture,
  validateSyntheticManifest,
} from "../scripts/import-synthetic-fixture.mjs";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function data(value, status = 200) {
  return json({ data: value, request_id: "req-test" }, status);
}

function error(code, message, status) {
  return json({ error: { code, message }, request_id: "req-test" }, status);
}

function requestJson(options) {
  return JSON.parse(String(options.body));
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createApiDouble() {
  const requests = [];
  const transcriptItems = new Map();
  const events = [];
  const assets = new Map();
  const initializedAssets = new Map();
  let assetSequence = 0;
  let transcriptImportStatus = null;
  let transcriptImportRequest = null;

  const transcriptItemRecord = (item) => {
    const record = { ...item };
    delete record.bytes;
    return record;
  };
  const transcriptImportRecord = () => ({
    id: "import-test",
    status: transcriptImportStatus,
    items: [...transcriptItems.values()].map(transcriptItemRecord),
  });
  const assetRecord = (asset) => {
    const record = { ...asset };
    delete record.bytes;
    return record;
  };

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    const pathname = url.pathname;
    const headers = new Headers(options.headers);
    requests.push({ method, pathname, headers, body: options.body });

    if (method === "POST" && pathname === "/api/v1/projects") {
      const body = requestJson(options);
      return data({ project: { id: "prj-test", name: body.name } }, 201);
    }
    if (method === "POST" && pathname === "/api/v1/projects/prj-test/transcript-imports") {
      const body = requestJson(options);
      const request = JSON.stringify(body.files);
      if (transcriptImportRequest === null) {
        transcriptImportRequest = request;
        transcriptImportStatus = "open";
        const items = body.files.map((file, index) => ({
          id: `item-${index + 1}`,
          filename: file.filename,
          mime_type: file.mime_type,
          size_bytes: file.size_bytes,
          upload_status: "pending",
          content_sha256: null,
          error_code: null,
          bytes: null,
        }));
        for (const item of items) transcriptItems.set(item.id, item);
      } else if (transcriptImportRequest !== request) {
        return error("IDEMPOTENCY_CONFLICT", "Transcript import request changed.", 409);
      }
      return data({ transcript_import: transcriptImportRecord() }, 201);
    }
    const transcriptUpload = pathname.match(/^\/api\/v1\/transcript-imports\/import-test\/items\/([^/]+)\/content$/);
    if (method === "PUT" && transcriptUpload) {
      const item = transcriptItems.get(transcriptUpload[1]);
      const bytes = Buffer.from(options.body);
      const sha256 = sha256Hex(bytes);
      if (item.upload_status !== "pending") {
        if (item.content_sha256 === sha256 && item.size_bytes === bytes.byteLength) {
          return data({ transcript_import: transcriptImportRecord() });
        }
        return error("IDEMPOTENCY_CONFLICT", "Transcript content changed.", 409);
      }
      item.bytes = bytes;
      item.content_sha256 = sha256;
      item.upload_status = "uploaded";
      return data({ transcript_import: transcriptImportRecord() });
    }
    if (method === "POST" && pathname === "/api/v1/transcript-imports/import-test/finalize") {
      if (transcriptImportStatus !== "finalized") {
        const body = requestJson(options);
        for (const [index, ordered] of body.ordered_items.entries()) {
          const item = transcriptItems.get(ordered.item_id);
          const event = {
            id: `evt-${index + 1}`,
            title: ordered.title,
            event_type: ordered.event_type,
            material_status: "ready",
            sequence_no: index + 1,
          };
          events.push(event);
          const version = {
            id: `av-transcript-${index + 1}`,
            content_sha256: item.content_sha256,
            size_bytes: item.size_bytes,
            mime_type: item.mime_type,
          };
          const asset = {
            id: `ast-transcript-${index + 1}`,
            event_id: event.id,
            filename: item.filename,
            kind: "transcript",
            current_version_id: version.id,
            processing_status: "ready",
            version,
            bytes: item.bytes,
          };
          assets.set(asset.id, asset);
          item.upload_status = "finalized";
        }
        transcriptImportStatus = "finalized";
      }
      return data({
        transcript_import: transcriptImportRecord(),
        events,
      });
    }
    const initialize = pathname.match(/^\/api\/v1\/events\/([^/]+)\/assets\/init$/);
    if (method === "POST" && initialize) {
      const body = requestJson(options);
      const idempotency = headers.get("idempotency-key");
      const request = JSON.stringify(body);
      const replay = initializedAssets.get(idempotency);
      if (replay) {
        if (replay.request !== request) {
          return error("IDEMPOTENCY_CONFLICT", "Asset initialization changed.", 409);
        }
        const asset = assets.get(replay.assetId);
        return data({ asset: assetRecord(asset), content_url: `/api/v1/assets/${asset.id}/content` }, 201);
      }
      assetSequence += 1;
      const asset = {
        id: `ast-upload-${assetSequence}`,
        event_id: initialize[1],
        filename: body.filename,
        kind: body.kind,
        current_version_id: null,
        processing_status: "uploading",
        version: null,
        bytes: null,
      };
      assets.set(asset.id, asset);
      initializedAssets.set(idempotency, { assetId: asset.id, request });
      return data({ asset: assetRecord(asset), content_url: `/api/v1/assets/${asset.id}/content` }, 201);
    }
    const content = pathname.match(/^\/api\/v1\/assets\/([^/]+)\/content$/);
    if (method === "PUT" && content) {
      const asset = assets.get(content[1]);
      if (asset.current_version_id) {
        return error("BAD_REQUEST", "Finalized asset content is immutable.", 409);
      }
      asset.bytes = Buffer.from(options.body);
      asset.processing_status = "parsing";
      return data({ asset: assetRecord(asset) });
    }
    const finalize = pathname.match(/^\/api\/v1\/assets\/([^/]+)\/finalize$/);
    if (method === "POST" && finalize) {
      const asset = assets.get(finalize[1]);
      if (!asset.current_version_id) {
        asset.processing_status = "ready";
        asset.version = {
          id: `av-${asset.id}`,
          content_sha256: sha256Hex(asset.bytes),
          size_bytes: asset.bytes.byteLength,
          mime_type: "image/png",
        };
        asset.current_version_id = asset.version.id;
      }
      return data({ asset: assetRecord(asset) });
    }
    if (method === "GET" && pathname === "/api/v1/projects/prj-test") {
      return data({ project: { id: "prj-test", name: "[SYNTHETIC] Contractor regression" } });
    }
    if (method === "GET" && pathname === "/api/v1/projects/prj-test/events") {
      return data({ events });
    }
    const eventDetail = pathname.match(/^\/api\/v1\/events\/([^/]+)$/);
    if (method === "GET" && eventDetail) {
      const event = events.find((value) => value.id === eventDetail[1]);
      return data({
        event,
        assets: [...assets.values()]
          .filter((asset) => asset.event_id === event.id)
          .map(assetRecord),
      });
    }
    const evidence = pathname.match(/^\/api\/v1\/assets\/([^/]+)\/evidence-view$/);
    if (method === "GET" && evidence) {
      return new Response(assets.get(evidence[1]).bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    if (method === "POST" && /^\/api\/v1\/events\/[^/]+\/extraction-runs$/.test(pathname)) {
      return error("MODEL_PROVIDER_NOT_CONFIGURED", "No extraction run was created.", 503);
    }
    return error("NOT_FOUND", `${method} ${pathname}`, 404);
  };

  return { fetchImpl, requests };
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "notique-fixture-"));
  await mkdir(path.join(root, "transcripts"));
  await mkdir(path.join(root, "images"));
  await writeFile(path.join(root, "transcripts", "visit-1.txt"), "[00:01] Owner: Remove the short wall.\n");
  await writeFile(path.join(root, "transcripts", "visit-2.txt"), "[00:02] Owner: Keep the existing outlet.\n");
  await writeFile(path.join(root, "images", "wall.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const manifest = {
    schemaVersion: "notique-synthetic-case.v1",
    id: "contractor-regression",
    project: { name: "Contractor regression", locale: "en-US" },
    events: [
      {
        key: "estimate",
        type: "estimate_visit",
        title: "Estimate visit",
        occurredAt: "2026-08-01T10:00:00.000Z",
        transcript: { path: "transcripts/visit-1.txt", format: "txt" },
        assets: [
          {
            key: "wall-before",
            kind: "photo",
            path: "images/wall.png",
            mimeType: "image/png",
            description: "Synthetic wall photo",
          },
        ],
      },
      {
        key: "follow-up",
        type: "meeting",
        title: "Scope follow-up",
        occurredAt: "2026-08-02T10:00:00.000Z",
        transcript: { path: "transcripts/visit-2.txt", format: "txt" },
        assets: [],
      },
    ],
  };
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { manifest, manifestPath };
}

test("synthetic fixture importer uses only the public API and verifies persisted bytes", async () => {
  const { manifestPath } = await createFixture();
  const api = createApiDouble();
  const result = await importSyntheticFixture({
    manifestPath,
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: api.fetchImpl,
    runId: "unit-run",
    probeUnconfiguredProvider: true,
  });

  assert.equal(result.fixture_id, "contractor-regression");
  assert.equal(result.project.name, "[SYNTHETIC] Contractor regression");
  assert.equal(result.events.length, 2);
  assert.equal(eventsFromRequests(api.requests)[0].event_type, "estimate");
  assert.equal(result.checks.persisted_event_count, 2);
  assert.equal(result.checks.verified_object_count, 3);
  assert.deepEqual(result.provider_probe, {
    performed: true,
    status: "passed",
    error_code: "MODEL_PROVIDER_NOT_CONFIGURED",
  });

  const writes = api.requests.filter((request) => request.method === "POST" || request.method === "PUT");
  assert.ok(writes.every((request) => request.pathname.startsWith("/api/v1/")));
  const resourceCreates = writes.filter((request) =>
    request.method === "POST" &&
    (request.pathname === "/api/v1/projects" ||
      request.pathname.endsWith("/transcript-imports") ||
      request.pathname.endsWith("/assets/init")),
  );
  assert.ok(resourceCreates.every((request) => request.headers.has("idempotency-key")));
  assert.ok(writes.every((request) => request.headers.get("sec-fetch-site") === "same-origin"));
});

test("synthetic fixture importer can isolate one named Event for a paid smoke test", async () => {
  const { manifestPath } = await createFixture();
  const api = createApiDouble();
  const result = await importSyntheticFixture({
    manifestPath,
    fetchImpl: api.fetchImpl,
    runId: "one-event-smoke",
    eventKey: "follow-up",
  });

  assert.equal(result.selected_event_key, "follow-up");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].key, "follow-up");
  assert.equal(result.checks.persisted_event_count, 1);
});

test("same run ID resumes a finalized fixture without uploading content again", async () => {
  const { manifestPath } = await createFixture();
  const api = createApiDouble();
  const options = {
    manifestPath,
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: api.fetchImpl,
    runId: "resume-finalized-run",
  };
  const first = await importSyntheticFixture(options);
  const resumeRequestStart = api.requests.length;
  const resumed = await importSyntheticFixture(options);
  const resumeRequests = api.requests.slice(resumeRequestStart);

  assert.deepEqual(
    resumed.events.map((event) => event.id),
    first.events.map((event) => event.id),
  );
  assert.equal(resumed.checks.verified_object_count, first.checks.verified_object_count);
  assert.equal(
    resumeRequests.filter((request) => request.method === "PUT").length,
    0,
    "finalized transcript and asset bytes must not be uploaded again",
  );
  assert.equal(
    resumeRequests.filter(
      (request) => request.method === "POST" && /^\/api\/v1\/assets\/[^/]+\/finalize$/.test(request.pathname),
    ).length,
    0,
    "a finalized asset must not be finalized again",
  );
});

test("same run ID rejects changed finalized transcript bytes before upload", async () => {
  const { manifestPath } = await createFixture();
  const api = createApiDouble();
  const options = {
    manifestPath,
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: api.fetchImpl,
    runId: "changed-transcript-run",
  };
  await importSyntheticFixture(options);
  const changedTranscript = "[00:01] Owner: Retain the short wall.\n";
  assert.equal(
    Buffer.byteLength(changedTranscript),
    Buffer.byteLength("[00:01] Owner: Remove the short wall.\n"),
    "the regression must exercise a same-size byte change",
  );
  await writeFile(
    path.join(path.dirname(manifestPath), "transcripts", "visit-1.txt"),
    changedTranscript,
  );
  const resumeRequestStart = api.requests.length;

  await assert.rejects(
    importSyntheticFixture(options),
    /Transcript visit-1\.txt was already uploaded with different content/,
  );
  assert.equal(
    api.requests.slice(resumeRequestStart).filter((request) => request.method === "PUT").length,
    0,
  );
});

test("same run ID rejects changed finalized asset bytes before upload", async () => {
  const { manifestPath } = await createFixture();
  const api = createApiDouble();
  const options = {
    manifestPath,
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: api.fetchImpl,
    runId: "changed-asset-run",
  };
  await importSyntheticFixture(options);
  await writeFile(
    path.join(path.dirname(manifestPath), "images", "wall.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 4]),
  );
  const resumeRequestStart = api.requests.length;

  await assert.rejects(
    importSyntheticFixture(options),
    /Asset wall-before was already uploaded with different content/,
  );
  assert.equal(
    api.requests.slice(resumeRequestStart).filter((request) => request.method === "PUT").length,
    0,
  );
});

function eventsFromRequests(requests) {
  const finalize = requests.find(
    (request) =>
      request.method === "POST" &&
      request.pathname === "/api/v1/transcript-imports/import-test/finalize",
  );
  return JSON.parse(String(finalize.body)).ordered_items;
}

test("synthetic fixture tooling refuses production and external URLs", () => {
  assert.equal(assertLoopbackBaseUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(assertLoopbackBaseUrl("http://127.0.0.1:8788/"), "http://127.0.0.1:8788");
  assert.throws(() => assertLoopbackBaseUrl("https://notique.example.com"), /restricted to localhost/);
});

test("synthetic fixture manifest rejects duplicate identities and path escapes", async () => {
  const { manifest, manifestPath } = await createFixture();
  const duplicate = structuredClone(manifest);
  duplicate.events[1].key = duplicate.events[0].key;
  assert.throws(() => validateSyntheticManifest(duplicate), /event keys must be unique/);

  const escaped = structuredClone(manifest);
  escaped.events[0].transcript.path = "../outside.txt";
  await writeFile(manifestPath, JSON.stringify(escaped));
  const api = createApiDouble();
  await assert.rejects(
    importSyntheticFixture({ manifestPath, fetchImpl: api.fetchImpl }),
    /must remain inside the fixture directory/,
  );
  assert.equal(api.requests.length, 0, "invalid fixtures must fail before any API write");
});
