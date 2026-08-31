#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

const transcriptionTerminal = new Set(["succeeded", "failed", "cancelled"]);
const extractionTerminal = new Set([
  "succeeded",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
]);
const artifactTerminal = new Set(["succeeded", "failed", "cancelled"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function loopbackBaseUrl(value) {
  const url = new URL(value);
  invariant(url.origin === "http://localhost:3000", "UI audio performance smoke is restricted to http://localhost:3000.");
  invariant(!url.username && !url.password, "UI audio performance smoke does not accept URL credentials.");
  invariant(url.pathname === "/" && !url.search && !url.hash, "UI audio performance smoke requires the localhost root URL.");
  return url.origin;
}

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function emit(startedAt, phase, details = {}) {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    elapsed_ms: elapsed(startedAt),
    phase,
    ...details,
  })}\n`);
}

async function api(page, baseUrl, method, pathname, { json, key } = {}) {
  const headers = {
    origin: baseUrl,
    "sec-fetch-site": "same-origin",
  };
  let data;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    data = json;
  }
  if (key) headers["idempotency-key"] = key;
  const response = await page.request.fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
    timeout: 30_000,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // The status and response body below are enough to diagnose the request.
  }
  if (!response.ok()) {
    throw new Error(`${method} ${pathname} failed with ${parsed?.error?.code ?? response.status()}: ${parsed?.error?.message ?? text}`);
  }
  invariant(parsed?.data !== undefined, `${method} ${pathname} returned no data envelope.`);
  return parsed.data;
}

function metadataValue(asset, key) {
  const metadata = asset?.metadata;
  return metadata && typeof metadata === "object" ? metadata[key] : undefined;
}

async function safeText(locator) {
  try {
    return (await locator.first().innerText({ timeout: 800 })).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function observedUploadPhase(method, pathname) {
  if (method === "POST" && /^\/api\/v1\/events\/[^/]+\/assets\/init$/.test(pathname)) return "asset_upload_initialized_http";
  if (method === "PUT" && /^\/api\/v1\/assets\/[^/]+\/content$/.test(pathname)) return "asset_content_uploaded_http";
  if (method === "POST" && /^\/api\/v1\/assets\/[^/]+\/finalize$/.test(pathname)) return "asset_finalized_http";
  return null;
}

function assertSelectedRoute(page, projectId, eventId) {
  const current = new URL(page.url());
  invariant(current.searchParams.get("project") === projectId, `UI switched away from target project ${projectId}.`);
  invariant(current.searchParams.get("event") === eventId, `UI switched away from target event ${eventId}.`);
}

async function main() {
  const [consentFlag, audioPath, rawBaseUrl = "http://localhost:3000"] = process.argv.slice(2);
  invariant(
    consentFlag === "--allow-external-ai",
    "This smoke may send the selected audio to configured external AI providers and incur usage. Re-run only with explicit user consent: --allow-external-ai AUDIO_FILE [BASE_URL]",
  );
  invariant(audioPath, "usage: node scripts/run-audio-ui-performance-smoke.mjs --allow-external-ai AUDIO_FILE [BASE_URL]");
  const baseUrl = loopbackBaseUrl(rawBaseUrl);
  const absolutePath = path.resolve(audioPath);
  const fileStat = await stat(absolutePath);
  invariant(fileStat.isFile(), "Audio path must point to a file.");
  invariant(fileStat.size > 0 && fileStat.size <= 100 * 1024 * 1024, "Audio file must be between 1 byte and 100 MiB.");

  const startedAt = Date.now();
  const runKey = randomUUID();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.sessionStorage.setItem("notique.ui.public-workspace-acknowledged", "1");
  });
  const page = await context.newPage();
  const browserErrors = [];
  const networkFailures = [];
  const uploadRequests = [];
  const requestStartedAt = new WeakMap();
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (request.url().startsWith(`${baseUrl}/`)) requestStartedAt.set(request, Date.now());
  });
  page.on("requestfailed", (request) => {
    if (!request.url().startsWith(`${baseUrl}/`)) return;
    const pathname = new URL(request.url()).pathname;
    const error = request.failure()?.errorText ?? "request failed";
    if (!pathname.startsWith("/api/v1/") || error.includes("ERR_ABORTED")) return;
    networkFailures.push({
      method: request.method(),
      pathname,
      error,
    });
  });
  page.on("response", (response) => {
    const request = response.request();
    if (!request.url().startsWith(`${baseUrl}/`)) return;
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/v1/") && response.status() >= 400) {
      networkFailures.push({ method: request.method(), pathname, status: response.status() });
    }
    const phase = observedUploadPhase(request.method(), pathname);
    if (!phase) return;
    const started = requestStartedAt.get(request) ?? Date.now();
    const item = {
      sequence: uploadRequests.length + 1,
      method: request.method(),
      pathname,
      status: response.status(),
      duration_ms: Date.now() - started,
      content_length: request.headers()["content-length"] ?? null,
    };
    uploadRequests.push(item);
    emit(startedAt, phase, item);
  });

  try {
    const project = (await api(page, baseUrl, "POST", "/api/v1/projects", {
      key: `audio-ui-perf:${runKey}:project`,
      json: { name: `[AUDIO UI PERF] ${new Date().toISOString()}`, locale: "en-US" },
    })).project;
    const event = (await api(page, baseUrl, "POST", `/api/v1/projects/${encodeURIComponent(project.id)}/events`, {
      key: `audio-ui-perf:${runKey}:event`,
      json: {
        event_type: "meeting",
        title: `UI performance · ${path.basename(absolutePath)}`,
        occurred_at: new Date().toISOString(),
      },
    })).event;
    emit(startedAt, "test_project_ready", { project_id: project.id, event_id: event.id });

    await page.goto(
      `${baseUrl}/?project=${encodeURIComponent(project.id)}&event=${encodeURIComponent(event.id)}&view=simple`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(({ eventId, eventTitle }) => {
      const select = document.querySelector('select[aria-label="选择当前沟通"]');
      if (!(select instanceof HTMLSelectElement) || select.value !== eventId) return false;
      const selected = select.selectedOptions.item(0);
      return selected?.textContent?.trim() === eventTitle;
    }, { eventId: event.id, eventTitle: event.title }, { timeout: 15_000 });
    assertSelectedRoute(page, project.id, event.id);
    const targetAssetInit = page.waitForResponse((response) => {
      const request = response.request();
      return request.method() === "POST"
        && new URL(request.url()).pathname === `/api/v1/events/${event.id}/assets/init`;
    }, { timeout: 30_000 });
    await page.locator('input[type="file"][aria-label="选择已有录音文件"]').setInputFiles(absolutePath);
    const initResponse = await targetAssetInit;
    invariant(initResponse.ok(), `Target audio Asset init failed with HTTP ${initResponse.status()}.`);
    assertSelectedRoute(page, project.id, event.id);
    emit(startedAt, "file_selected", { filename: path.basename(absolutePath), size_bytes: fileStat.size });

    const assetRegistrationDeadline = Date.now() + 30_000;
    let registeredAudioAsset = null;
    while (Date.now() < assetRegistrationDeadline && !registeredAudioAsset) {
      const targetEvent = await api(page, baseUrl, "GET", `/api/v1/events/${encodeURIComponent(event.id)}`);
      registeredAudioAsset = targetEvent.assets?.find(
        (asset) => asset.kind === "audio" && asset.filename === path.basename(absolutePath),
      ) ?? null;
      if (!registeredAudioAsset) await page.waitForTimeout(250);
    }
    invariant(registeredAudioAsset, "Uploaded audio did not register on the target Event within 30 seconds.");
    assertSelectedRoute(page, project.id, event.id);

    const seen = new Map();
    const markOnce = (key, phase, details = {}) => {
      if (seen.has(key)) return;
      seen.set(key, Date.now());
      emit(startedAt, phase, details);
    };
    let lastUiStatus = "";
    let lastTranscriptionStatus = "";
    let lastChunkStatus = "";
    let lastExtractionStatus = "";
    let lastSummaryStatus = "";
    let lastReadableStatus = "";
    let lastAudioStatus = "";
    let lastWakeAt = 0;
    let transcriptionRunId = null;
    let terminalReport = null;
    let lastSnapshot = null;
    const deadline = startedAt + 45 * 60_000;

    while (Date.now() < deadline) {
      const [eventData, workflowData, artifactData] = await Promise.all([
        api(page, baseUrl, "GET", `/api/v1/events/${encodeURIComponent(event.id)}`),
        api(page, baseUrl, "GET", `/api/v1/projects/${encodeURIComponent(project.id)}/workflow-snapshot`),
        api(page, baseUrl, "GET", `/api/v1/events/${encodeURIComponent(event.id)}/ai-artifacts`),
      ]);
      const currentEvent = workflowData.workflow_snapshot?.events?.find((item) => item.id === event.id) ?? null;
      const audioAsset = eventData.assets?.find((asset) => asset.kind === "audio" && asset.filename === path.basename(absolutePath));
      if (audioAsset) {
        markOnce("audio-asset-created", "audio_asset_created", {
          asset_id: audioAsset.id,
          processing_status: audioAsset.processing_status,
        });
        if (audioAsset.processing_status !== lastAudioStatus) {
          lastAudioStatus = audioAsset.processing_status;
          emit(startedAt, "original_audio_status", {
            asset_id: audioAsset.id,
            processing_status: audioAsset.processing_status,
          });
        }
        if (audioAsset.processing_status === "ready" && audioAsset.current_version_id) {
          markOnce("audio-ready", "original_audio_ready", {
            asset_id: audioAsset.id,
            asset_version_id: audioAsset.current_version_id,
          });
        }
        const storedRunId = metadataValue(audioAsset, "transcription_run_id");
        if (typeof storedRunId === "string" && storedRunId) transcriptionRunId = storedRunId;
      }

      let transcriptionRun = null;
      if (transcriptionRunId) {
        transcriptionRun = (await api(
          page,
          baseUrl,
          "GET",
          `/api/v1/transcription-runs/${encodeURIComponent(transcriptionRunId)}`,
        )).transcription_run;
        if (transcriptionRun.status !== lastTranscriptionStatus) {
          lastTranscriptionStatus = transcriptionRun.status;
          emit(startedAt, "transcription_status", {
            run_id: transcriptionRun.id,
            status: transcriptionRun.status,
            orchestration_mode: transcriptionRun.orchestration_mode,
            chunk_count: transcriptionRun.chunk_count,
            queued_at: transcriptionRun.queued_at,
            started_at: transcriptionRun.started_at,
            finished_at: transcriptionRun.finished_at,
          });
        }
        const chunkStatus = Array.isArray(transcriptionRun.chunks)
          ? transcriptionRun.chunks.map((chunk) => `${chunk.index}:${chunk.status}`).join(",")
          : "";
        if (chunkStatus && chunkStatus !== lastChunkStatus) {
          lastChunkStatus = chunkStatus;
          emit(startedAt, "transcription_chunks", { chunks: chunkStatus });
        }
      }

      const transcriptData = await api(page, baseUrl, "GET", `/api/v1/events/${encodeURIComponent(event.id)}/transcript-segments`);
      const segmentCount = transcriptData.segments?.length ?? 0;
      if (segmentCount > 0) {
        markOnce("raw-ready", "raw_transcript_ready", { segment_count: segmentCount });
      }

      const summaryRun = artifactData.runs?.find((run) => run.kind === "summary") ?? null;
      const readableRun = artifactData.runs?.find((run) => run.kind === "readable_transcript") ?? null;
      if (summaryRun?.status && summaryRun.status !== lastSummaryStatus) {
        lastSummaryStatus = summaryRun.status;
        emit(startedAt, "summary_status", { run_id: summaryRun.id, status: summaryRun.status });
      }
      if (readableRun?.status && readableRun.status !== lastReadableStatus) {
        lastReadableStatus = readableRun.status;
        emit(startedAt, "readable_status", { run_id: readableRun.id, status: readableRun.status });
      }
      const readableArtifact = artifactData.artifacts?.find((artifact) => artifact.kind === "readable_transcript") ?? null;
      const summaryArtifact = artifactData.artifacts?.find((artifact) => artifact.kind === "summary") ?? null;
      if (readableArtifact) {
        markOnce("readable-ready", "readable_transcript_ready", { artifact_id: readableArtifact.id });
      }
      if (summaryArtifact) {
        markOnce("summary-ready", "summary_ready", { artifact_id: summaryArtifact.id });
      }

      const extraction = currentEvent?.extraction ?? null;
      if (extraction?.status && extraction.status !== lastExtractionStatus) {
        lastExtractionStatus = extraction.status;
        emit(startedAt, "extraction_status", { status: extraction.status, stage: extraction.stage });
      }

      const uiStatus = [
        await safeText(page.locator(".asset-upload-progress:visible")),
        await safeText(page.locator(".transcription-journey:visible")),
        await safeText(page.locator(".workflow-reading-banner:visible")),
        await safeText(page.locator(".project-workflow-progress:visible")),
      ].filter(Boolean).join(" | ");
      if (uiStatus && uiStatus !== lastUiStatus) {
        lastUiStatus = uiStatus;
        emit(startedAt, "visible_ui_status", { text: uiStatus.slice(0, 1_000) });
      }
      const visibleTranscriptTurns = await page.locator('[data-testid="transcript-turn"]:visible').count();
      if (visibleTranscriptTurns > 0) {
        markOnce("raw-visible", "transcript_visible_in_ui", {
          visible_turns: visibleTranscriptTurns,
          url: page.url(),
        });
      }

      if (Date.now() - lastWakeAt >= 10_000) {
        const wakeups = [];
        if (transcriptionRun && !transcriptionTerminal.has(transcriptionRun.status)) {
          wakeups.push({ kind: "transcription", run_id: transcriptionRun.id });
        }
        if (extraction && !extractionTerminal.has(extraction.status)) {
          wakeups.push({ kind: "extraction", run_id: extraction.run_id });
        }
        for (const artifactRun of artifactData.runs ?? []) {
          if (!artifactTerminal.has(artifactRun.status)) {
            wakeups.push({ kind: "artifact", run_id: artifactRun.id });
          }
        }
        await Promise.all(wakeups.map((input) => api(page, baseUrl, "POST", "/api/v1/jobs/dispatch", { json: input })));
        lastWakeAt = Date.now();
      }

      let reviewData = null;
      if (extraction?.run_id && extractionTerminal.has(extraction.status)) {
        reviewData = await api(
          page,
          baseUrl,
          "GET",
          `/api/v1/extraction-runs/${encodeURIComponent(extraction.run_id)}/claims`,
        );
      }
      const claims = reviewData?.claims ?? [];
      const occurrenceCandidates = reviewData?.occurrence_candidates ?? [];
      const claimTypeCounts = claims.reduce((counts, claim) => {
        const type = typeof claim.type === "string" ? claim.type : "unknown";
        counts[type] = (counts[type] ?? 0) + 1;
        return counts;
      }, {});
      const originalAudioReady = audioAsset?.processing_status === "ready" && Boolean(audioAsset.current_version_id);
      const transcriptionDone = transcriptionRun && transcriptionTerminal.has(transcriptionRun.status);
      const artifactsDone = summaryRun && readableRun
        && artifactTerminal.has(summaryRun.status)
        && artifactTerminal.has(readableRun.status);
      const extractionDone = extraction && extractionTerminal.has(extraction.status);
      lastSnapshot = {
        audio_status: audioAsset?.processing_status ?? null,
        transcription_status: transcriptionRun?.status ?? null,
        segment_count: segmentCount,
        readable_status: readableRun?.status ?? null,
        summary_status: summaryRun?.status ?? null,
        extraction_status: extraction?.status ?? null,
        claim_count: claims.length,
        occurrence_count: occurrenceCandidates.length,
        ui_status: lastUiStatus,
      };
      if (originalAudioReady && transcriptionDone && artifactsDone && extractionDone) {
        const summaryCard = page.locator(".summary-overview-card.ready:visible").first();
        if (summaryRun.status === "succeeded") {
          await summaryCard.waitFor({ state: "visible", timeout: 15_000 });
        }
        const summaryVisible = await page.locator(".summary-overview-card.ready:visible").count();
        const rawTab = page.locator(".transcript-subtabs").getByRole("button", { name: /^原文/ });
        const readableTab = page.locator(".transcript-subtabs").getByRole("button", { name: /^易读版/ });
        await rawTab.click();
        await page.locator('.raw-artifact [data-testid="transcript-turn"]:visible').first().waitFor({ state: "visible", timeout: 15_000 });
        const rawVisibleTurns = await page.locator('.raw-artifact [data-testid="transcript-turn"]:visible').count();
        await readableTab.click();
        if (readableRun.status === "succeeded") {
          await page.locator('.readable-artifact [data-testid="transcript-turn"]:visible').first().waitFor({ state: "visible", timeout: 15_000 });
        }
        const readableVisibleTurns = await page.locator('.readable-artifact [data-testid="transcript-turn"]:visible').count();
        await rawTab.click();
        terminalReport = {
          project_id: project.id,
          event_id: event.id,
          audio_asset_id: audioAsset.id,
          audio_asset_status: audioAsset.processing_status,
          transcription_run_id: transcriptionRun.id,
          transcription_status: transcriptionRun.status,
          chunk_count: transcriptionRun.chunk_count,
          chunk_statuses: (transcriptionRun.chunks ?? []).map((chunk) => ({ index: chunk.index, status: chunk.status })),
          segment_count: segmentCount,
          readable_run_id: readableRun.id,
          readable_status: readableRun.status,
          readable_artifact_id: readableArtifact?.id ?? null,
          summary_run_id: summaryRun.id,
          summary_status: summaryRun.status,
          summary_artifact_id: summaryArtifact?.id ?? null,
          extraction_run_id: extraction.run_id,
          extraction_status: extraction.status,
          claim_count: claims.length,
          claim_type_counts: claimTypeCounts,
          next_action_count: claimTypeCounts.next_action ?? 0,
          occurrence_count: occurrenceCandidates.length,
          visible_transcript_turns: rawVisibleTurns,
          visible_readable_turns: readableVisibleTurns,
          visible_summary_cards: summaryVisible,
          browser_errors: browserErrors,
          network_failures: networkFailures,
          upload_requests: uploadRequests,
          milestones_ms: Object.fromEntries([...seen.entries()].map(([key, value]) => [key, value - startedAt])),
        };
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    invariant(terminalReport, `UI audio performance smoke did not finish within 45 minutes. Last snapshot: ${JSON.stringify(lastSnapshot)}`);
    emit(startedAt, "complete", terminalReport);
    if (terminalReport.transcription_status !== "succeeded") {
      throw new Error(`Transcription ended with ${terminalReport.transcription_status}.`);
    }
    if (terminalReport.readable_status !== "succeeded") {
      throw new Error(`Readable transcript ended with ${terminalReport.readable_status}.`);
    }
    if (terminalReport.summary_status !== "succeeded") {
      throw new Error(`Summary ended with ${terminalReport.summary_status}.`);
    }
    if (!["succeeded", "completed", "completed_with_warnings"].includes(terminalReport.extraction_status)) {
      throw new Error(`Extraction ended with ${terminalReport.extraction_status}.`);
    }
    invariant(terminalReport.audio_asset_status === "ready", "Original audio did not reach ready state.");
    invariant(terminalReport.segment_count > 0, "Transcription finished without segments.");
    invariant(terminalReport.readable_artifact_id, "Readable transcript Run finished without an artifact.");
    invariant(terminalReport.summary_artifact_id, "Summary Run finished without an artifact.");
    invariant(terminalReport.visible_transcript_turns > 0, "Raw transcript was not visible in the UI.");
    invariant(terminalReport.visible_readable_turns > 0, "Readable transcript was not visible in the UI.");
    invariant(terminalReport.visible_summary_cards > 0, "Summary was not visible above the transcript.");
    invariant(terminalReport.browser_errors.length === 0, "Browser reported console errors.");
    invariant(terminalReport.network_failures.length === 0, "Local requests reported failures.");
  } catch (error) {
    emit(startedAt, "error", {
      message: error instanceof Error ? error.message : String(error),
      browser_errors: browserErrors,
      network_failures: networkFailures,
      upload_requests: uploadRequests,
    });
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
