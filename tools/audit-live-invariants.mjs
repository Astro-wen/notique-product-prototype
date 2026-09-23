/**
 * Walks a live workspace and checks the invariants a reader depends on.
 *
 * Bugs in this product kept surfacing one screen at a time, because a
 * walkthrough only reveals what is visible on the screen it is looking at, and
 * the E2E fixtures were more generous than the real API. This asks the running
 * server the same questions about every Project at once, so a whole class of
 * breakage arrives as one list instead of one bug per visit.
 *
 *   node tools/audit-live-invariants.mjs [base-url]
 *
 * It only reads. Every finding names the Event it came from so it can be
 * opened by hand.
 */

const base = (process.argv[2] || "https://notique-evidence-workspace.uclae2e12.chatgpt.site").replace(/\/$/, "");
const findings = [];
const TERMINAL_RUN = new Set(["succeeded", "failed", "cancelled", "completed_with_warnings"]);
const STALE_MS = 30 * 60_000;

function report(severity, invariant, where, detail) {
  findings.push({ severity, invariant, where, detail });
}

async function api(path) {
  const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  const body = await response.json();
  return body.data ?? body;
}

async function tryApi(path) {
  try {
    return await api(path);
  } catch {
    return null;
  }
}

const ageMs = (value) => (value ? Date.now() - Date.parse(String(value)) : 0);

async function auditEvent(project, event) {
  const where = `${project.name} / ${event.title || event.id}`;
  const detail = await tryApi(`/api/v1/events/${event.id}`);
  const assets = detail?.assets ?? [];
  const audio = assets.filter((asset) => asset.kind === "audio" && asset.metadata?.transcription_chunk !== true);
  const transcripts = assets.filter((asset) =>
    (asset.kind === "transcript" || asset.kind === "text") && asset.metadata?.transcription_chunk !== true);

  for (const asset of audio) {
    const status = asset.metadata?.transcription_status ?? null;
    const runId = asset.metadata?.transcription_run_id;
    if (!runId) {
      if (status && status !== "succeeded") {
        report("warn", "audio-without-run", where, `${asset.filename} is ${status} with no transcription Run`);
      }
      continue;
    }
    const run = (await tryApi(`/api/v1/transcription-runs/${runId}`))?.transcription_run;
    if (!run) {
      report("error", "run-missing", where, `${asset.filename} points at ${runId}, which does not resolve`);
      continue;
    }
    // A reader is told what the materials row says; it must not disagree with
    // the Run that produced it.
    if (status && run.status === "succeeded" && status !== "succeeded") {
      report("error", "asset-status-lags-run", where, `${asset.filename} shows ${status} for a succeeded Run`);
    }
    if (status && run.status === "failed" && status !== "failed") {
      report("error", "asset-status-lags-run", where, `${asset.filename} shows ${status} for a failed Run`);
    }
    // Nothing may sit in a non-terminal state forever: that is the shape every
    // stall in this product has taken.
    if (!TERMINAL_RUN.has(String(run.status)) && ageMs(run.updated_at) > STALE_MS) {
      report("error", "run-stalled", where, `transcription ${run.id} is ${run.status}, untouched for ${Math.round(ageMs(run.updated_at) / 60000)}m`);
    }
    const chunks = run.chunks ?? [];
    const stuckChunks = chunks.filter((chunk) => !TERMINAL_RUN.has(String(chunk.status)));
    if (String(run.status) === "succeeded" && stuckChunks.length) {
      report("error", "chunk-outlives-parent", where, `${stuckChunks.length} chunk(s) still ${stuckChunks[0].status} under a succeeded Run`);
    }
    if (String(run.status) === "succeeded" && !run.derived_transcript_asset_id) {
      report("error", "succeeded-without-transcript", where, `transcription ${run.id} succeeded but derived no transcript asset`);
    }
  }

  // A finished transcript with nothing reading it is the failure that left a
  // recording sitting at 等待自动整理 for two days.
  const artifacts = await tryApi(`/api/v1/events/${event.id}/ai-artifacts`);
  const runs = artifacts?.runs ?? [];
  const hasReadyTranscript = transcripts.some((asset) => asset.processing_status === "ready");
  if (hasReadyTranscript && !event.active_run_id && !runs.length) {
    report("error", "transcript-without-downstream", where, "a ready transcript has no extraction or artifact Run at all");
  }
  for (const run of runs) {
    if (!TERMINAL_RUN.has(String(run.status)) && ageMs(run.updated_at) > STALE_MS) {
      report("error", "artifact-stalled", where, `${run.kind} ${run.id} is ${run.status}, untouched for ${Math.round(ageMs(run.updated_at) / 60000)}m`);
    }
    if (String(run.status) === "failed") {
      report("warn", "artifact-failed", where, `${run.kind} failed with ${run.error_code ?? "no code"}`);
    }
  }

  // Every Claim must be able to reach the sentence it came from — the whole
  // promise of the product, and the thing that was quietly switched off.
  const runId = event.active_run_id;
  if (!runId) return;
  const claims = (await tryApi(`/api/v1/extraction-runs/${runId}/claims`))?.claims ?? [];
  const segmentIds = new Set();
  const segments = await tryApi(`/api/v1/events/${event.id}/transcript-segments`);
  for (const segment of segments?.segments ?? []) segmentIds.add(segment.id);
  for (const claim of claims) {
    const refIds = claim.evidence_ref_ids ?? [];
    if (!refIds.length) {
      report("error", "claim-without-evidence", where, `${claim.id} carries no evidence reference`);
      continue;
    }
    for (const refId of refIds) {
      const ref = (await tryApi(`/api/v1/evidence-refs/${refId}`))?.evidence_ref;
      if (!ref) {
        report("error", "evidence-unresolvable", where, `${claim.id} references ${refId}, which does not resolve`);
        continue;
      }
      const ids = ref.segment_ids ?? [];
      if (!ids.length) {
        report("error", "evidence-without-segments", where, `${refId} names no transcript segment`);
        continue;
      }
      if (segmentIds.size && ids.some((id) => !segmentIds.has(id))) {
        report("error", "evidence-points-outside-transcript", where, `${refId} cites a segment this Event's transcript does not contain`);
      }
    }
  }
}

const projects = (await api("/api/v1/projects")).projects ?? [];
for (const project of projects) {
  const events = (await tryApi(`/api/v1/projects/${project.id}/events`))?.events ?? [];
  for (const event of events) {
    try {
      await auditEvent(project, event);
    } catch (error) {
      report("warn", "audit-failed", `${project.name} / ${event.id}`, error instanceof Error ? error.message : String(error));
    }
  }
}

const bySeverity = { error: [], warn: [] };
for (const finding of findings) bySeverity[finding.severity].push(finding);
for (const severity of ["error", "warn"]) {
  const group = bySeverity[severity];
  if (!group.length) continue;
  console.log(`\n${severity.toUpperCase()} (${group.length})`);
  const byInvariant = new Map();
  for (const finding of group) {
    if (!byInvariant.has(finding.invariant)) byInvariant.set(finding.invariant, []);
    byInvariant.get(finding.invariant).push(finding);
  }
  for (const [invariant, items] of byInvariant) {
    console.log(`  ${invariant} (${items.length})`);
    for (const item of items.slice(0, 6)) console.log(`    - ${item.where}: ${item.detail}`);
    if (items.length > 6) console.log(`    … ${items.length - 6} more`);
  }
}
console.log(`\nchecked ${projects.length} projects; ${bySeverity.error.length} errors, ${bySeverity.warn.length} warnings`);
