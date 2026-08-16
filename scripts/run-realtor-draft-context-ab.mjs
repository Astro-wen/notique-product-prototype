#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPredictionPackage } from "./lib/export-production-run.mjs";
import { resolveEricDemoFixture } from "./lib/eric-demo-fixtures.mjs";
import { runEricDemo } from "./lib/run-eric-demo.mjs";
import { importSyntheticFixture } from "./import-synthetic-fixture.mjs";
import {
  REALTOR_AB_ARM_SCHEMA_VERSION,
  REALTOR_AB_CONTRACT,
  REALTOR_AB_SCHEMA_VERSION,
  buildAdjudicationTemplate,
  sha256Json,
  summarizeArm,
  validateComparableArms,
} from "./lib/realtor-draft-context-ab.mjs";
import {
  createGitSourceFreezeGuard,
  runSourceFrozenAb,
} from "./lib/git-source-freeze.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const FIXTURE = resolveEricDemoFixture("realtor");
const REALTOR_AB_PROJECT_PROFILE = "real_estate_buyer_journey";
const GROUND_TRUTH_PATH = path.resolve(
  REPOSITORY_ROOT,
  "eval/cases/synthetic-realtor-v1/ground-truth.json",
);
const ACTION_GROUND_TRUTH_PATH = path.resolve(
  REPOSITORY_ROOT,
  "eval/cases/synthetic-realtor-v1/action-ground-truth.json",
);

export function localServerConfiguration(port) {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Local A/B server port must be an integer from 1024 to 65535.");
  }
  const hostname = "127.0.0.1";
  return {
    baseUrl: `http://${hostname}:${port}`,
    commandArgs: [
      path.resolve(REPOSITORY_ROOT, "node_modules/vinext/dist/cli.js"),
      "dev",
      "--port",
      String(port),
      "--hostname",
      hostname,
    ],
  };
}

export function realtorAbFixtureImportOptions(options) {
  return { ...options, projectProfile: REALTOR_AB_PROJECT_PROFILE };
}

function usage() {
  return `Usage:
  node scripts/run-realtor-draft-context-ab.mjs [options]

Options:
  --allow-paid-model-calls   Required to run the two four-Event model arms
  --output=<path>            New output directory (default: outputs/realtor-draft-ab/<timestamp>-<id>)
  --port=<number>            Dedicated sequential local port (default: 3187)
  --poll-ms=<ms>             Extraction poll interval (default: 1000)
  --timeout-ms=<ms>          Timeout per Event extraction (default: 900000)
  --help                     Show this help

Without --allow-paid-model-calls this command only prints the frozen plan and exits.
It never connects to production. Each arm receives its own new local D1/R2 state directory.
Claims, Occurrences, Relations, and draft links remain unconfirmed.`;
}

function integer(value, label, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function safeOutput(value, invocationId) {
  if (value != null) {
    if (!value.trim()) throw new Error("--output requires a path.");
    return path.resolve(value);
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.resolve("outputs", "realtor-draft-ab", `${timestamp}-${invocationId.slice(0, 8)}`);
}

export function parseArgs(argv, invocationId = randomUUID()) {
  const options = {
    allowPaidModelCalls: false,
    outputPath: null,
    port: 3187,
    pollMs: 1_000,
    timeoutMs: 900_000,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help") options.help = true;
    else if (arg === "--allow-paid-model-calls") options.allowPaidModelCalls = true;
    else if (arg.startsWith("--output=")) options.outputPath = arg.slice("--output=".length);
    else if (arg.startsWith("--port=")) {
      options.port = integer(arg.slice("--port=".length), "--port", options.port, { minimum: 1024, maximum: 65535 });
    } else if (arg.startsWith("--poll-ms=")) {
      options.pollMs = integer(arg.slice("--poll-ms=".length), "--poll-ms", options.pollMs, { minimum: 100, maximum: 60_000 });
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = integer(arg.slice("--timeout-ms=".length), "--timeout-ms", options.timeoutMs, { minimum: 30_000, maximum: 3_600_000 });
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  options.outputPath = safeOutput(options.outputPath, invocationId);
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function spawnCapture(command, args, { env = process.env, cwd = REPOSITORY_ROOT, logPath }) {
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exitCode;
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await new Promise((resolve) => log.end(resolve));
  }
  if (exitCode.code !== 0) {
    throw new Error(`${path.basename(command)} exited with ${exitCode.code ?? exitCode.signal}; see ${logPath}.`);
  }
}

async function endpointAvailable(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer({ baseUrl, port, statePath, draftContextEnabled, logPath }) {
  const configuration = localServerConfiguration(port);
  if (baseUrl !== configuration.baseUrl) {
    throw new Error("Local A/B health URL must match the server's loopback listener.");
  }
  if (await endpointAvailable(baseUrl)) {
    throw new Error(`Port ${port} already serves an application; choose a dedicated --port.`);
  }
  const log = createWriteStream(logPath, { flags: "wx" });
  const child = spawn(
    process.execPath,
    configuration.commandArgs,
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        AI_DRAFT_CONTEXT: draftContextEnabled ? "1" : "0",
        NOTIQUE_LOCAL_STATE_PATH: statePath,
        MINIFLARE_REGISTRY_PATH: path.join(statePath, "registry"),
        WRANGLER_LOG_PATH: path.join(statePath, "wrangler.log"),
        WRANGLER_WRITE_LOGS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  const server = { child, log };
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (exit) {
      await stopServer(server);
      throw new Error(`Local server stopped before readiness (${exit.code ?? exit.signal}); see ${logPath}.`);
    }
    if (await endpointAvailable(baseUrl)) return server;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stopServer(server);
  throw new Error(`Local server was not ready within 120 seconds; see ${logPath}.`);
}

async function stopServer(server) {
  if (!server) return;
  if (server.child.exitCode == null && server.child.signalCode == null) {
    server.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (server.child.exitCode == null && server.child.signalCode == null) {
      server.child.kill("SIGKILL");
      await new Promise((resolve) => server.child.once("exit", resolve));
    }
  }
  await new Promise((resolve) => server.log.end(resolve));
}

async function getData(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed with ${body?.error?.code ?? response.status}.`);
  }
  return body.data;
}

function targetedDemoFetch(baseUrl) {
  let activeRunId = null;
  return async (input, options = {}) => {
    const url = new URL(input);
    const runMatch = url.pathname.match(/^\/api\/v1\/extraction-runs\/([^/]+)$/);
    if ((options.method ?? "GET") === "GET" && runMatch) {
      activeRunId = decodeURIComponent(runMatch[1]);
    }
    if ((options.method ?? "GET") === "POST" && url.pathname === "/api/v1/local/jobs/dispatch") {
      if (!activeRunId) throw new Error("Targeted A/B dispatch has no active extraction Run.");
      return fetch(`${baseUrl}/api/v1/jobs/dispatch`, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "extraction", run_id: activeRunId }),
      });
    }
    return fetch(input, options);
  };
}

async function dispatchArtifact(baseUrl, runId) {
  const response = await fetch(`${baseUrl}/api/v1/jobs/dispatch`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ kind: "artifact", run_id: runId }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(`Artifact dispatch failed with ${body?.error?.code ?? response.status}.`);
  }
}

async function waitForArtifacts(baseUrl, extractionRunId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const debug = await getData(
      baseUrl,
      `/api/v1/extraction-runs/${encodeURIComponent(extractionRunId)}/debug`,
    );
    const runs = debug.debug?.artifact_runs ?? [];
    const byKind = new Map(runs.map((run) => [run.kind, run]));
    const required = [byKind.get("summary"), byKind.get("readable_transcript")];
    if (required.every((run) => run?.status === "succeeded")) return debug.debug;
    const failed = required.find((run) => run && ["failed", "cancelled"].includes(run.status));
    if (failed) {
      throw new Error(`${failed.kind} artifact ${failed.id} failed with ${failed.error_code ?? "unknown error"}.`);
    }
    for (const run of required.filter((candidate) => candidate?.status === "queued")) {
      await dispatchArtifact(baseUrl, run.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`AI artifacts for ${extractionRunId} did not finish within ${timeoutMs} ms.`);
}

function safeStage(stage) {
  return {
    stage: stage.stage,
    attempt: stage.attempt,
    provider: stage.provider,
    model: stage.model,
    reasoning_effort: stage.reasoning_effort,
    prompt_version: stage.prompt_version,
    schema_version: stage.schema_version,
    status: stage.status,
    input_tokens: stage.input_tokens,
    output_tokens: stage.output_tokens,
    cached_tokens: stage.cached_tokens,
    estimated_cost_usd: stage.estimated_cost_usd,
    error_code: stage.error_code,
    started_at: stage.started_at,
    finished_at: stage.finished_at,
    duration_ms: stage.duration_ms,
  };
}

async function collectArm({
  arm,
  enabled,
  armDirectory,
  baseUrl,
  port,
  fixtureManifest,
  fixtureBytes,
  groundTruthBytes,
  actionGroundTruthBytes,
  commitSha,
  options,
}) {
  await mkdir(armDirectory, { recursive: false });
  const statePath = path.join(armDirectory, "state");
  await mkdir(statePath, { recursive: false });
  await spawnCapture(
    process.execPath,
    [
      path.resolve(REPOSITORY_ROOT, "node_modules/wrangler/bin/wrangler.js"),
      "d1", "migrations", "apply", "DB", "--local",
      "--config", path.resolve(REPOSITORY_ROOT, "wrangler.local.jsonc"),
      "--persist-to", statePath,
    ],
    { logPath: path.join(armDirectory, "migration.log") },
  );

  let server = null;
  try {
    server = await startServer({
      baseUrl,
      port,
      statePath,
      draftContextEnabled: enabled,
      logPath: path.join(armDirectory, "server.log"),
    });
    const demo = await runEricDemo({
      manifestPath: FIXTURE.manifestPath,
      baseUrl,
      importFixture: (input) => importSyntheticFixture(realtorAbFixtureImportOptions(input)),
      correlationId: `realtor-draft-ab-${arm}-${randomUUID()}`,
      acceptFixtureScenario: true,
      confirmReviewedFixture: false,
      pollMs: options.pollMs,
      timeoutMs: options.timeoutMs,
      fetchImpl: targetedDemoFetch(baseUrl),
    });
    if (demo.status !== "awaiting_review") {
      throw new Error(`${arm} did not stop at awaiting_review.`);
    }
    if (demo.review_actions.length !== 0) {
      throw new Error(`${arm} unexpectedly created review actions.`);
    }
    await writeJson(path.join(armDirectory, "demo-trace.json"), demo);

    const runs = [];
    for (const [index, runReport] of demo.extraction_runs.entries()) {
      const completedDebug = await waitForArtifacts(baseUrl, runReport.run_id, options.timeoutMs);
      const predictionPackage = await buildPredictionPackage({
        baseUrl,
        environment: "local",
        projectId: demo.project.id,
        runIds: [runReport.run_id],
        commitSha,
      });
      const prediction = predictionPackage.runs[0];
      await writeJson(
        path.join(armDirectory, `event-${String(index + 1).padStart(2, "0")}-predictions.json`),
        predictionPackage,
      );
      runs.push({
        runId: runReport.run_id,
        eventId: runReport.event_id,
        eventKey: fixtureManifest.events[index].key,
        eventTitle: runReport.event_title,
        status: runReport.status,
        prediction,
        stages: (completedDebug.stages ?? []).map(safeStage),
        artifactRuns: (completedDebug.artifact_runs ?? []).map((artifactRun) => ({
          id: artifactRun.id,
          kind: artifactRun.kind,
          status: artifactRun.status,
          model: artifactRun.model,
          reasoning_effort: artifactRun.reasoning_effort,
          prompt_version: artifactRun.prompt_version,
          schema_version: artifactRun.schema_version,
          input_tokens: artifactRun.input_tokens,
          output_tokens: artifactRun.output_tokens,
          cached_tokens: artifactRun.cached_tokens,
          estimated_cost_usd: artifactRun.estimated_cost_usd,
          duration_ms: artifactRun.duration_ms,
          error_code: artifactRun.error_code,
        })),
      });
    }
    const [draftMemoryData, actionsData] = await Promise.all([
      getData(baseUrl, `/api/v1/projects/${encodeURIComponent(demo.project.id)}/draft-memory`),
      getData(baseUrl, `/api/v1/projects/${encodeURIComponent(demo.project.id)}/actions`),
    ]);
    const armSnapshot = {
      schemaVersion: REALTOR_AB_ARM_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      arm,
      draftContextEnabled: enabled,
      fixtureId: fixtureManifest.id,
      fixtureSha256: sha256(fixtureBytes),
      groundTruthSha256: sha256(groundTruthBytes),
      actionGroundTruthSha256: sha256(actionGroundTruthBytes),
      commitSha,
      contextSchema: REALTOR_AB_CONTRACT.contextSchema,
      localIsolation: {
        productionAccessed: false,
        statePath: path.relative(REPOSITORY_ROOT, statePath),
        baseUrl,
      },
      projectId: demo.project.id,
      runs,
      draftMemory: draftMemoryData.draft_memory,
      actions: actionsData.actions,
      reviewActions: demo.review_actions,
      limitations: [
        "Claims and Occurrences are pending; no Claim/Occurrence/Relation was automatically confirmed.",
        "The synthetic project was created with the fixed real-estate buyer journey Scenario so Events 2-4 can run without AI Scenario guessing.",
        "Semantic matching and Evidence support require human adjudication before scoring.",
      ],
    };
    armSnapshot.snapshotSha256 = sha256Json(armSnapshot);
    await writeJson(path.join(armDirectory, "arm.json"), armSnapshot);
    return armSnapshot;
  } finally {
    await stopServer(server);
  }
}

async function gitValue(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: REPOSITORY_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `git exited ${code}`));
    });
  });
}

async function readGitSourceState() {
  const headBefore = await gitValue(["rev-parse", "HEAD"]);
  const status = await gitValue(["status", "--porcelain", "--untracked-files=all"]);
  const headAfter = await gitValue(["rev-parse", "HEAD"]);
  return { headBefore, status, headAfter };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.allowPaidModelCalls) {
    process.stdout.write([
      "DRY PLAN — no model was called.",
      `Fixture: ${FIXTURE.relativePath}`,
      `Control: AI_DRAFT_CONTEXT=0, new isolated local D1/R2`,
      `Treatment: AI_DRAFT_CONTEXT=1, new isolated local D1/R2`,
      `Contract: ${REALTOR_AB_CONTRACT.runPrompt}, ${REALTOR_AB_CONTRACT.contextSchema}, ${REALTOR_AB_CONTRACT.verifySchema}`,
      "Claims/Occurrences/Relations remain pending; only the fixed synthetic Scenario is accepted.",
      "Rerun with --allow-paid-model-calls after the release commit is clean.",
      "",
    ].join("\n"));
    return;
  }

  const sourceGuard = createGitSourceFreezeGuard({ readState: readGitSourceState });
  const commitSha = await sourceGuard.freeze("startup");
  const [fixtureBytes, groundTruthBytes, actionGroundTruthBytes] = await Promise.all([
    readFile(FIXTURE.manifestPath),
    readFile(GROUND_TRUTH_PATH),
    readFile(ACTION_GROUND_TRUTH_PATH),
  ]);
  const fixtureManifest = JSON.parse(fixtureBytes.toString("utf8"));
  const groundTruth = JSON.parse(groundTruthBytes.toString("utf8"));
  const actionGroundTruth = JSON.parse(actionGroundTruthBytes.toString("utf8"));
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await mkdir(options.outputPath, { recursive: false });
  const baseUrl = localServerConfiguration(options.port).baseUrl;

  const manifest = await runSourceFrozenAb({
    sourceGuard,
    runArm: (arm) => collectArm({
      arm,
      enabled: arm === "treatment",
      armDirectory: path.join(options.outputPath, arm),
      baseUrl,
      port: options.port,
      fixtureManifest,
      fixtureBytes,
      groundTruthBytes,
      actionGroundTruthBytes,
      commitSha,
      options,
    }),
    prepareFinal: async ({ control, treatment }) => {
      const comparable = validateComparableArms(control, treatment);
      const controlAdjudication = buildAdjudicationTemplate(control, groundTruth, actionGroundTruth);
      const treatmentAdjudication = buildAdjudicationTemplate(treatment, groundTruth, actionGroundTruth);
      await Promise.all([
        writeJson(path.join(options.outputPath, "control-adjudication.json"), controlAdjudication),
        writeJson(path.join(options.outputPath, "treatment-adjudication.json"), treatmentAdjudication),
      ]);
      return {
        schemaVersion: REALTOR_AB_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        commitSha,
        fixture: {
          id: fixtureManifest.id,
          path: path.relative(REPOSITORY_ROOT, FIXTURE.manifestPath),
          sha256: sha256(fixtureBytes),
          groundTruthPath: path.relative(REPOSITORY_ROOT, GROUND_TRUTH_PATH),
          groundTruthSha256: sha256(groundTruthBytes),
          actionGroundTruthPath: path.relative(REPOSITORY_ROOT, ACTION_GROUND_TRUTH_PATH),
          actionGroundTruthSha256: sha256(actionGroundTruthBytes),
        },
        contract: REALTOR_AB_CONTRACT,
        comparable,
        arms: {
          control: { path: "control/arm.json", summary: summarizeArm(control) },
          treatment: { path: "treatment/arm.json", summary: summarizeArm(treatment) },
        },
        adjudication: {
          control: "control-adjudication.json",
          treatment: "treatment-adjudication.json",
          scoreCommand:
            `node scripts/score-realtor-draft-context-ab.mjs --run-dir=${options.outputPath}`,
        },
        paidCalls: {
          expectedFactCalls: 16,
          expectedArtifactCalls: 16,
          expectedTotalCalls: 32,
          explanation: "2 arms × 4 Events × (2 fact stages + Summary + Readable Transcript); escalation can add calls.",
        },
      };
    },
    writeFinal: async ({ prepared }) => {
      const finalManifest = {
        ...prepared,
        sourceFreeze: sourceGuard.snapshot(),
      };
      await writeJson(path.join(options.outputPath, "manifest.json"), finalManifest);
      return finalManifest;
    },
  });
  process.stdout.write([
    "Realtor Draft Context A/B completed without confirming Claims or Relations.",
    `Output: ${options.outputPath}`,
    `Control Claims: ${manifest.arms.control.summary.claimCount}`,
    `Treatment Claims: ${manifest.arms.treatment.summary.claimCount}`,
    "Human adjudication is required before any accuracy percentage is valid.",
    `Score after review: ${manifest.adjudication.scoreCommand}`,
    "",
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
