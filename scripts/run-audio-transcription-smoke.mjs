#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const transcriptionTerminal = new Set(["succeeded", "failed", "cancelled"]);
const extractionTerminal = new Set(["succeeded", "completed", "completed_with_warnings", "failed", "cancelled"]);
const audioMimeByExtension = new Map([
  ["wav", "audio/wav"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["mp4", "audio/mp4"],
  ["mpeg", "audio/mpeg"],
  ["mpga", "audio/mpeg"],
  ["webm", "audio/webm"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function loopbackBaseUrl(value) {
  const url = new URL(value);
  invariant(["localhost", "127.0.0.1", "::1"].includes(url.hostname), "Audio smoke test is restricted to localhost.");
  invariant(["http:", "https:"].includes(url.protocol), "Audio smoke test requires HTTP or HTTPS.");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function request(baseUrl, method, pathname, { json, bytes, mimeType, key } = {}) {
  const headers = { origin: baseUrl, "sec-fetch-site": "same-origin" };
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (bytes !== undefined) {
    headers["content-type"] = mimeType;
    headers["content-length"] = String(bytes.byteLength);
    body = bytes;
  }
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers, body });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* status below is sufficient */ }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed with ${parsed?.error?.code ?? response.status}: ${parsed?.error?.message ?? text}`);
  }
  invariant(parsed?.data !== undefined, `${method} ${pathname} returned no data envelope.`);
  return parsed.data;
}

async function main() {
  const args = process.argv.slice(2);
  const extract = args.includes("--extract");
  const positional = args.filter((value) => value !== "--extract");
  const [audioPath, rawBaseUrl = "http://localhost:3000"] = positional;
  invariant(audioPath, "usage: npm run audio:smoke -- AUDIO_FILE [BASE_URL]");
  const baseUrl = loopbackBaseUrl(rawBaseUrl);
  const absolutePath = path.resolve(audioPath);
  const filename = path.basename(absolutePath);
  const extension = filename.toLowerCase().split(".").at(-1) ?? "";
  const mimeType = audioMimeByExtension.get(extension);
  invariant(mimeType, "Audio file must be WAV, MP3, M4A, MP4, MPEG, MPGA, or WebM.");
  const bytes = await readFile(absolutePath);
  invariant(bytes.byteLength > 0 && bytes.byteLength <= 100 * 1024 * 1024, "Audio file must be between 1 byte and 100 MiB.");

  const runKey = randomUUID();
  const project = (await request(baseUrl, "POST", "/api/v1/projects", {
    key: `audio-smoke:${runKey}:project`,
    json: { name: `[AUDIO E2E] ${new Date().toISOString()}`, locale: "en-US" },
  })).project;
  const event = (await request(baseUrl, "POST", `/api/v1/projects/${encodeURIComponent(project.id)}/events`, {
    key: `audio-smoke:${runKey}:event`,
    json: { event_type: "meeting", title: extract ? "AMI ES2002a product design meeting" : "Audio transcription smoke", occurred_at: new Date().toISOString() },
  })).event;
  const initialized = await request(baseUrl, "POST", `/api/v1/events/${encodeURIComponent(event.id)}/assets/init`, {
    key: `audio-smoke:${runKey}:asset`,
    json: { kind: "audio", filename, mime_type: mimeType, size_bytes: bytes.byteLength },
  });
  const assetId = initialized.asset.id;
  await request(baseUrl, "PUT", initialized.content_url, { bytes, mimeType });
  const asset = (await request(baseUrl, "POST", `/api/v1/assets/${encodeURIComponent(assetId)}/finalize`, { json: {} })).asset;
  let transcriptionRun = (await request(baseUrl, "POST", `/api/v1/assets/${encodeURIComponent(assetId)}/transcription-runs`, {
    key: `audio-smoke:${runKey}:transcription`,
    json: {},
  })).transcription_run;

  const transcriptionStartedAt = Date.now();
  const deadline = transcriptionStartedAt + 10 * 60_000;
  await request(baseUrl, "POST", "/api/v1/jobs/dispatch", {
    json: { kind: "transcription", run_id: transcriptionRun.id },
  });
  let lastTranscriptionWakeAt = transcriptionStartedAt;
  while (!transcriptionTerminal.has(transcriptionRun.status) && Date.now() < deadline) {
    transcriptionRun = (await request(baseUrl, "GET", `/api/v1/transcription-runs/${encodeURIComponent(transcriptionRun.id)}`)).transcription_run;
    if (transcriptionRun.status === "queued" && Date.now() - lastTranscriptionWakeAt >= 15_000) {
      await request(baseUrl, "POST", "/api/v1/jobs/dispatch", {
        json: { kind: "transcription", run_id: transcriptionRun.id },
      });
      lastTranscriptionWakeAt = Date.now();
    }
    if (!transcriptionTerminal.has(transcriptionRun.status)) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  invariant(transcriptionTerminal.has(transcriptionRun.status), "Transcription did not reach a terminal state within ten minutes.");
  invariant(transcriptionRun.status === "succeeded", `Transcription failed with ${transcriptionRun.error_code ?? "unknown error"}.`);
  invariant(Array.isArray(transcriptionRun.segments) && transcriptionRun.segments.length > 0, "Transcription succeeded without speaker segments.");
  const persistedEvent = await request(baseUrl, "GET", `/api/v1/events/${encodeURIComponent(event.id)}`);
  invariant(persistedEvent.event?.id === event.id, "The Event readback did not match the created Event.");
  invariant(Array.isArray(persistedEvent.assets), "The Event readback did not include its Asset collection.");
  const derivedTranscript = persistedEvent.assets.find(
    (item) => item.kind === "transcript" && item.processing_status === "ready",
  );
  invariant(derivedTranscript, "The derived transcript Asset was not persisted on the Event.");

  let extraction = null;
  if (extract) {
    const transcriptVersionId = derivedTranscript.version?.id;
    invariant(transcriptVersionId, "The derived transcript is missing a finalized version.");
    let extractionRun = (await request(baseUrl, "POST", `/api/v1/events/${encodeURIComponent(event.id)}/extraction-runs`, {
      key: `audio-smoke:${runKey}:extraction`,
      json: { asset_version_ids: [transcriptVersionId] },
    })).run;
    const extractionStartedAt = Date.now();
    const extractionDeadline = extractionStartedAt + 30 * 60_000;
    await request(baseUrl, "POST", "/api/v1/jobs/dispatch", {
      json: { kind: "extraction", run_id: extractionRun.id },
    });
    let lastExtractionWakeAt = extractionStartedAt;
    while (!extractionTerminal.has(extractionRun.status) && Date.now() < extractionDeadline) {
      extractionRun = (await request(baseUrl, "GET", `/api/v1/extraction-runs/${encodeURIComponent(extractionRun.id)}`)).run;
      if (extractionRun.status === "queued" && Date.now() - lastExtractionWakeAt >= 15_000) {
        await request(baseUrl, "POST", "/api/v1/jobs/dispatch", {
          json: { kind: "extraction", run_id: extractionRun.id },
        });
        lastExtractionWakeAt = Date.now();
      }
      if (!extractionTerminal.has(extractionRun.status)) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    invariant(extractionTerminal.has(extractionRun.status), "Extraction did not reach a terminal state within thirty minutes.");
    invariant(
      ["succeeded", "completed", "completed_with_warnings"].includes(extractionRun.status),
      `Extraction failed with ${extractionRun.error_code ?? "unknown error"}.`,
    );
    const review = await request(baseUrl, "GET", `/api/v1/extraction-runs/${encodeURIComponent(extractionRun.id)}/claims`);
    const debug = await request(baseUrl, "GET", `/api/v1/extraction-runs/${encodeURIComponent(extractionRun.id)}/debug`);
    extraction = {
      run_id: extractionRun.id,
      status: extractionRun.status,
      elapsed_ms: Date.now() - extractionStartedAt,
      model: extractionRun.model,
      prompt_version: extractionRun.prompt_version,
      schema_version: extractionRun.schema_version,
      claims: review.claims ?? [],
      occurrence_candidates: review.occurrence_candidates ?? [],
      debug: debug.debug ?? null,
    };
  }

  process.stdout.write(`${JSON.stringify({
    schema_version: "notique-audio-smoke.v1",
    project_id: project.id,
    event_id: event.id,
    audio_asset_id: asset.id,
    audio_asset_version_id: asset.version?.id ?? null,
    transcription_run_id: transcriptionRun.id,
    transcription_status: transcriptionRun.status,
    model: transcriptionRun.model,
    duration_seconds: transcriptionRun.duration_seconds,
    transcription_elapsed_ms: Date.now() - transcriptionStartedAt,
    segment_count: transcriptionRun.segments.length,
    segments: transcriptionRun.segments.map((segment) => ({
      speaker: segment.speaker,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      text: segment.text,
    })),
    derived_transcript_asset_id: derivedTranscript.id,
    derived_transcript_asset_version_id: derivedTranscript.version?.id ?? null,
    extraction,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
