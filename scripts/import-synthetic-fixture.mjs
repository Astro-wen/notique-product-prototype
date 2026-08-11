#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const FIXTURE_SCHEMA_VERSION = "notique-synthetic-case.v1";
const RESULT_SCHEMA_VERSION = "notique-synthetic-import-result.v1";
const EVENT_TYPES = new Set(["meeting", "showing", "estimate", "walkthrough"]);
const EVENT_TYPE_ALIASES = new Map([
  ["estimate_visit", "estimate"],
  ["scope_followup", "meeting"],
  ["preconstruction_walkthrough", "walkthrough"],
]);
const ASSET_KINDS = new Set(["transcript", "photo", "pdf", "text"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, field) {
  invariant(typeof value === "string" && value.trim(), `${field} must be a non-empty string.`);
  return value.trim();
}

function unique(values, field) {
  invariant(new Set(values).size === values.length, `${field} must be unique.`);
}

function safeIsoDate(value, field) {
  const text = nonEmptyString(value, field);
  invariant(Number.isFinite(Date.parse(text)), `${field} must be an ISO date.`);
  return new Date(text).toISOString();
}

function inferTranscriptMime(transcript) {
  if (transcript.mimeType) return transcript.mimeType;
  const format = transcript.format?.toLowerCase();
  const extension = transcript.path.toLowerCase().split(".").at(-1);
  if (format === "vtt" || extension === "vtt") return "text/vtt";
  if (format === "srt" || extension === "srt") return "application/x-subrip";
  if (format === "json" || extension === "json") return "application/json";
  return "text/plain";
}

function transcriptFilename(transcript) {
  return transcript.filename?.trim() || path.basename(transcript.path);
}

function apiEventType(value) {
  return EVENT_TYPE_ALIASES.get(value) ?? value;
}

function fixtureRelativePath(fixtureDirectory, relativePath, field) {
  const value = nonEmptyString(relativePath, field);
  const resolved = path.resolve(fixtureDirectory, value);
  const root = `${path.resolve(fixtureDirectory)}${path.sep}`;
  invariant(resolved.startsWith(root), `${field} must remain inside the fixture directory.`);
  return resolved;
}

export function validateSyntheticManifest(manifest) {
  invariant(manifest && typeof manifest === "object" && !Array.isArray(manifest), "Fixture manifest must be an object.");
  invariant(manifest.schemaVersion === FIXTURE_SCHEMA_VERSION, `Unsupported fixture schemaVersion. Expected ${FIXTURE_SCHEMA_VERSION}.`);
  nonEmptyString(manifest.id, "id");
  invariant(manifest.project && typeof manifest.project === "object", "project is required.");
  nonEmptyString(manifest.project.name, "project.name");
  if (manifest.project.locale != null) nonEmptyString(manifest.project.locale, "project.locale");
  invariant(Array.isArray(manifest.events) && manifest.events.length >= 1, "events must contain at least one event.");
  invariant(manifest.events.length <= 10, "One fixture may contain at most 10 transcript events.");

  const eventKeys = [];
  const transcriptPaths = [];
  const assetKeys = [];
  for (const [eventIndex, event] of manifest.events.entries()) {
    const prefix = `events[${eventIndex}]`;
    eventKeys.push(nonEmptyString(event.key, `${prefix}.key`));
    invariant(EVENT_TYPES.has(apiEventType(event.type)), `${prefix}.type is unsupported.`);
    nonEmptyString(event.title, `${prefix}.title`);
    safeIsoDate(event.occurredAt, `${prefix}.occurredAt`);
    invariant(event.transcript && typeof event.transcript === "object", `${prefix}.transcript is required.`);
    transcriptPaths.push(nonEmptyString(event.transcript.path, `${prefix}.transcript.path`));
    inferTranscriptMime(event.transcript);
    const assets = event.assets ?? [];
    invariant(Array.isArray(assets), `${prefix}.assets must be an array.`);
    for (const [assetIndex, asset] of assets.entries()) {
      const assetPrefix = `${prefix}.assets[${assetIndex}]`;
      assetKeys.push(nonEmptyString(asset.key, `${assetPrefix}.key`));
      invariant(ASSET_KINDS.has(asset.kind), `${assetPrefix}.kind is unsupported.`);
      invariant(asset.kind !== "transcript", `${assetPrefix}.kind must not duplicate the event transcript.`);
      nonEmptyString(asset.path, `${assetPrefix}.path`);
      nonEmptyString(asset.mimeType, `${assetPrefix}.mimeType`);
      if (asset.capturedAt != null) safeIsoDate(asset.capturedAt, `${assetPrefix}.capturedAt`);
      if (asset.metadata != null) {
        invariant(
          typeof asset.metadata === "object" && !Array.isArray(asset.metadata),
          `${assetPrefix}.metadata must be an object.`,
        );
      }
    }
  }
  unique(eventKeys, "event keys");
  unique(transcriptPaths, "transcript paths");
  unique(assetKeys, "asset keys");
  return manifest;
}

export function assertLoopbackBaseUrl(value) {
  const url = new URL(value);
  invariant(["http:", "https:"].includes(url.protocol), "base URL must use HTTP or HTTPS.");
  invariant(LOOPBACK_HOSTS.has(url.hostname), "Synthetic fixture import is restricted to localhost.");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

class ApiRequestError extends Error {
  constructor(method, pathname, status, body) {
    const code = body?.error?.code ?? "HTTP_ERROR";
    const message = body?.error?.message ?? `HTTP ${status}`;
    super(`${method} ${pathname} failed with ${code}: ${message}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function writeHeaders(baseUrl, headers = {}) {
  return {
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
    ...headers,
  };
}

async function apiJson(fetchImpl, baseUrl, method, pathname, options = {}) {
  const headers = writeHeaders(baseUrl, options.headers);
  let body;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.bytes !== undefined) {
    headers["content-type"] = options.mimeType;
    headers["content-length"] = String(options.bytes.byteLength);
    body = options.bytes;
  }
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const response = await fetchImpl(`${baseUrl}${pathname}`, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${pathname} returned non-JSON content.`);
    }
  }
  if (!response.ok) throw new ApiRequestError(method, pathname, response.status, parsed);
  invariant(parsed?.data !== undefined, `${method} ${pathname} returned no data envelope.`);
  return parsed.data;
}

async function apiBytes(fetchImpl, baseUrl, pathname) {
  const response = await fetchImpl(`${baseUrl}${pathname}`, {
    method: "GET",
    headers: writeHeaders(baseUrl),
  });
  if (!response.ok) {
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // The status and route are enough for a binary endpoint failure.
    }
    throw new ApiRequestError("GET", pathname, response.status, parsed);
  }
  return Buffer.from(await response.arrayBuffer());
}

function idempotencyKey(runId, suffix) {
  return `synthetic:${runId}:${suffix}`.slice(0, 200);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPersistedBytesMatch({ label, expectedBytes, persistedSha256, persistedSizeBytes }) {
  invariant(
    persistedSha256 === sha256Hex(expectedBytes) &&
      Number(persistedSizeBytes) === expectedBytes.byteLength,
    `${label} was already uploaded with different content. Use a new run ID for changed fixture bytes.`,
  );
}

async function readFixtureFiles(manifest, manifestPath) {
  const fixtureDirectory = path.dirname(manifestPath);
  const events = [];
  for (const [eventIndex, event] of manifest.events.entries()) {
    const transcriptPath = fixtureRelativePath(
      fixtureDirectory,
      event.transcript.path,
      `events[${eventIndex}].transcript.path`,
    );
    const transcriptBytes = await readFile(transcriptPath);
    invariant(transcriptBytes.byteLength > 0, `${event.transcript.path} is empty.`);
    const assets = [];
    for (const [assetIndex, asset] of (event.assets ?? []).entries()) {
      const assetPath = fixtureRelativePath(
        fixtureDirectory,
        asset.path,
        `events[${eventIndex}].assets[${assetIndex}].path`,
      );
      const bytes = await readFile(assetPath);
      invariant(bytes.byteLength > 0, `${asset.path} is empty.`);
      assets.push({ manifest: asset, path: assetPath, bytes });
    }
    events.push({ manifest: event, transcriptPath, transcriptBytes, assets });
  }
  return events;
}

function oneByFilename(items, filename) {
  const matches = items.filter((item) => item.filename === filename);
  invariant(matches.length === 1, `API did not return exactly one transcript item for ${filename}.`);
  return matches[0];
}

export async function importSyntheticFixture({
  manifestPath,
  baseUrl = "http://localhost:3000",
  fetchImpl = fetch,
  runId = randomUUID(),
  probeUnconfiguredProvider = false,
  eventKey = null,
}) {
  const safeBaseUrl = assertLoopbackBaseUrl(baseUrl);
  const absoluteManifestPath = path.resolve(manifestPath);
  const completeManifest = validateSyntheticManifest(
    JSON.parse(await readFile(absoluteManifestPath, "utf8")),
  );
  const manifest = eventKey
    ? {
        ...completeManifest,
        events: completeManifest.events.filter((event) => event.key === eventKey),
      }
    : completeManifest;
  invariant(
    !eventKey || manifest.events.length === 1,
    `Fixture event key was not found: ${eventKey}`,
  );
  const fixtureEvents = await readFixtureFiles(manifest, absoluteManifestPath);
  const projectData = await apiJson(fetchImpl, safeBaseUrl, "POST", "/api/v1/projects", {
    idempotencyKey: idempotencyKey(runId, "project"),
    json: {
      name: `[SYNTHETIC] ${manifest.project.name}`,
      locale: manifest.project.locale ?? "en-US",
    },
  });
  const project = projectData.project;

  const transcriptFiles = fixtureEvents.map(({ manifest: event, transcriptBytes }) => ({
    filename: transcriptFilename(event.transcript),
    mime_type: inferTranscriptMime(event.transcript),
    size_bytes: transcriptBytes.byteLength,
  }));
  const importData = await apiJson(
    fetchImpl,
    safeBaseUrl,
    "POST",
    `/api/v1/projects/${encodeURIComponent(project.id)}/transcript-imports`,
    {
      idempotencyKey: idempotencyKey(runId, "transcript-import"),
      json: { files: transcriptFiles },
    },
  );
  const transcriptImport = importData.transcript_import;

  const orderedItems = [];
  for (const [index, fixtureEvent] of fixtureEvents.entries()) {
    const filename = transcriptFilename(fixtureEvent.manifest.transcript);
    const item = oneByFilename(transcriptImport.items, filename);
    if (item.upload_status === "uploaded" || item.upload_status === "finalized") {
      assertPersistedBytesMatch({
        label: `Transcript ${filename}`,
        expectedBytes: fixtureEvent.transcriptBytes,
        persistedSha256: item.content_sha256,
        persistedSizeBytes: item.size_bytes,
      });
    } else {
      invariant(
        item.upload_status === "pending",
        `Transcript ${filename} cannot resume from upload status ${item.upload_status}.`,
      );
      await apiJson(
        fetchImpl,
        safeBaseUrl,
        "PUT",
        `/api/v1/transcript-imports/${encodeURIComponent(transcriptImport.id)}/items/${encodeURIComponent(item.id)}/content`,
        {
          bytes: fixtureEvent.transcriptBytes,
          mimeType: inferTranscriptMime(fixtureEvent.manifest.transcript),
        },
      );
    }
    orderedItems.push({
      item_id: item.id,
      occurred_at: safeIsoDate(fixtureEvent.manifest.occurredAt, `events[${index}].occurredAt`),
      title: fixtureEvent.manifest.title,
      event_type: apiEventType(fixtureEvent.manifest.type),
    });
  }

  const finalizedImport = await apiJson(
    fetchImpl,
    safeBaseUrl,
    "POST",
    `/api/v1/transcript-imports/${encodeURIComponent(transcriptImport.id)}/finalize`,
    { json: { ordered_items: orderedItems } },
  );
  invariant(
    finalizedImport.events.length === fixtureEvents.length,
    "Finalized transcript import returned the wrong number of events.",
  );

  const importedEvents = [];
  for (const [eventIndex, fixtureEvent] of fixtureEvents.entries()) {
    const event = finalizedImport.events[eventIndex];
    invariant(event.title === fixtureEvent.manifest.title, `Event ${fixtureEvent.manifest.key} title changed during import.`);
    const uploadedAssets = [];
    for (const [assetIndex, fixtureAsset] of fixtureEvent.assets.entries()) {
      const assetSpec = fixtureAsset.manifest;
      const initialized = await apiJson(
        fetchImpl,
        safeBaseUrl,
        "POST",
        `/api/v1/events/${encodeURIComponent(event.id)}/assets/init`,
        {
          idempotencyKey: idempotencyKey(runId, `asset:${eventIndex}:${assetIndex}`),
          json: {
            kind: assetSpec.kind,
            filename: path.basename(assetSpec.path),
            mime_type: assetSpec.mimeType,
            size_bytes: fixtureAsset.bytes.byteLength,
            ...(assetSpec.capturedAt ? { captured_at: safeIsoDate(assetSpec.capturedAt, `asset ${assetSpec.key} capturedAt`) } : {}),
            metadata: {
              ...(assetSpec.metadata ?? {}),
              synthetic_fixture_id: manifest.id,
              synthetic_event_key: fixtureEvent.manifest.key,
              synthetic_asset_key: assetSpec.key,
              ...(assetSpec.description ? { description: assetSpec.description } : {}),
            },
          },
        },
      );
      const initializedAsset = initialized.asset;
      const assetId = initializedAsset.id;
      let finalizedAsset;
      if (initializedAsset.current_version_id) {
        assertPersistedBytesMatch({
          label: `Asset ${assetSpec.key}`,
          expectedBytes: fixtureAsset.bytes,
          persistedSha256: initializedAsset.version?.content_sha256,
          persistedSizeBytes: initializedAsset.version?.size_bytes,
        });
        finalizedAsset = initializedAsset;
      } else {
        await apiJson(fetchImpl, safeBaseUrl, "PUT", `/api/v1/assets/${encodeURIComponent(assetId)}/content`, {
          bytes: fixtureAsset.bytes,
          mimeType: assetSpec.mimeType,
        });
        const finalized = await apiJson(
          fetchImpl,
          safeBaseUrl,
          "POST",
          `/api/v1/assets/${encodeURIComponent(assetId)}/finalize`,
          { json: {} },
        );
        finalizedAsset = finalized.asset;
      }
      uploadedAssets.push({
        key: assetSpec.key,
        asset: finalizedAsset,
        expectedBytes: fixtureAsset.bytes,
      });
    }
    importedEvents.push({ key: fixtureEvent.manifest.key, event, uploadedAssets, fixtureEvent });
  }

  const persistedProject = (await apiJson(
    fetchImpl,
    safeBaseUrl,
    "GET",
    `/api/v1/projects/${encodeURIComponent(project.id)}`,
  )).project;
  const persistedEvents = (await apiJson(
    fetchImpl,
    safeBaseUrl,
    "GET",
    `/api/v1/projects/${encodeURIComponent(project.id)}/events`,
  )).events;
  invariant(persistedProject.id === project.id, "Project round-trip returned a different project.");
  invariant(persistedEvents.length === manifest.events.length, "Project event count changed after persistence.");

  let verifiedObjectCount = 0;
  const resultEvents = [];
  for (const importedEvent of importedEvents) {
    const detail = await apiJson(
      fetchImpl,
      safeBaseUrl,
      "GET",
      `/api/v1/events/${encodeURIComponent(importedEvent.event.id)}`,
    );
    const expectedAssetCount = 1 + importedEvent.uploadedAssets.length;
    invariant(detail.assets.length === expectedAssetCount, `Event ${importedEvent.key} has the wrong asset count.`);
    invariant(detail.assets.every((asset) => asset.processing_status === "ready"), `Event ${importedEvent.key} has an unready asset.`);

    const transcriptAsset = oneByFilename(
      detail.assets,
      transcriptFilename(importedEvent.fixtureEvent.manifest.transcript),
    );
    const transcriptRoundTrip = await apiBytes(
      fetchImpl,
      safeBaseUrl,
      `/api/v1/assets/${encodeURIComponent(transcriptAsset.id)}/evidence-view`,
    );
    invariant(
      transcriptRoundTrip.equals(importedEvent.fixtureEvent.transcriptBytes),
      `Transcript content changed for event ${importedEvent.key}.`,
    );
    verifiedObjectCount += 1;

    for (const uploaded of importedEvent.uploadedAssets) {
      const roundTrip = await apiBytes(
        fetchImpl,
        safeBaseUrl,
        `/api/v1/assets/${encodeURIComponent(uploaded.asset.id)}/evidence-view`,
      );
      invariant(roundTrip.equals(uploaded.expectedBytes), `Asset content changed for ${uploaded.key}.`);
      verifiedObjectCount += 1;
    }

    resultEvents.push({
      key: importedEvent.key,
      id: importedEvent.event.id,
      title: importedEvent.event.title,
      asset_count: detail.assets.length,
      asset_version_ids: detail.assets.map((asset) => asset.version?.id).filter(Boolean),
    });
  }

  let providerProbe = { performed: false };
  if (probeUnconfiguredProvider) {
    const first = resultEvents[0];
    try {
      await apiJson(
        fetchImpl,
        safeBaseUrl,
        "POST",
        `/api/v1/events/${encodeURIComponent(first.id)}/extraction-runs`,
        {
          idempotencyKey: idempotencyKey(runId, "provider-probe"),
          json: { asset_version_ids: first.asset_version_ids },
        },
      );
      throw new Error("Provider probe created an extraction run; the local environment is configured and this was not a no-provider test.");
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "MODEL_PROVIDER_NOT_CONFIGURED") throw error;
      providerProbe = { performed: true, status: "passed", error_code: error.code };
    }
  }

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    fixture_id: manifest.id,
    selected_event_key: eventKey,
    run_id: runId,
    base_url: safeBaseUrl,
    project: { id: project.id, name: persistedProject.name },
    events: resultEvents,
    checks: {
      api_only_import: true,
      persisted_project: true,
      persisted_event_count: persistedEvents.length,
      ready_event_count: persistedEvents.filter((event) => event.material_status === "ready").length,
      verified_object_count: verifiedObjectCount,
    },
    provider_probe: providerProbe,
    note: "Synthetic data is for local regression only and is not concept-validation evidence.",
  };
}

function parseArgs(argv) {
  const options = {
    manifestPath: null,
    baseUrl: process.env.NOTIQUE_BASE_URL ?? "http://localhost:3000",
    outputPath: null,
    runId: randomUUID(),
    probeUnconfiguredProvider: false,
    eventKey: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--output=")) options.outputPath = arg.slice("--output=".length);
    else if (arg.startsWith("--run-id=")) options.runId = arg.slice("--run-id=".length);
    else if (arg.startsWith("--event-key=")) options.eventKey = arg.slice("--event-key=".length);
    else if (arg === "--probe-unconfigured-provider") options.probeUnconfiguredProvider = true;
    else if (!arg.startsWith("-") && options.manifestPath === null) options.manifestPath = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  invariant(options.manifestPath, "A fixture manifest path is required.");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await importSyntheticFixture(options);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

if (process.argv?.[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
