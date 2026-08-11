#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  formatEricDemoReport,
  runEricDemo,
} from "./lib/run-eric-demo.mjs";
import {
  ERIC_DEMO_FIXTURE_KEYS,
  resolveEricDemoFixture,
} from "./lib/eric-demo-fixtures.mjs";

function usage() {
  return `Usage:
  npm run demo:eric -- [options]

Options:
  --base-url=<url>                 Local full-stack URL (default: http://localhost:3000)
  --fixture=<name>                 Fixed case: contractor, realtor, or insurance (default: contractor)
  --correlation-id=<id>            Reuse one stable demo identity to resume safely
  --accept-fixture-scenario        Confirm the fixed synthetic Scenario after Run 1
  --confirm-reviewed-fixture      Attest and confirm synthetic Claims/Occurrences after each Run
  --poll-ms=<ms>                   Poll interval (default: 1000)
  --timeout-ms=<ms>                Timeout per extraction Run (default: 600000)
  --output=<path>                  JSON trace path (default: outputs/eric-demo/<fixture>-<id>-<invocation>.json)
  --help                           Show this help

The script imports one repository-approved synthetic fixture through the real local API and
uses the configured model. It never reads or prints model secrets. It does not run during
tests or builds. The two confirmation flags are explicit because they create real Verdicts.
Synthetic confirmations are regression aids, not evidence of human review or concept validation.`;
}

function integerOption(text, name, fallback) {
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function correlationOption(value) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error("--correlation-id must be 1-100 safe characters: letters, digits, dot, underscore, colon, or hyphen.");
  }
  return normalized;
}

export function parseArgs(argv, defaultCorrelationId = randomUUID(), invocationId = randomUUID()) {
  let fixture = resolveEricDemoFixture("contractor");
  const options = {
    baseUrl: "http://localhost:3000",
    acceptFixtureScenario: false,
    confirmReviewedFixture: false,
    pollMs: 1_000,
    timeoutMs: 600_000,
    correlationId: defaultCorrelationId,
    fixtureKey: fixture.key,
    manifestPath: fixture.manifestPath,
    fixturePath: fixture.relativePath,
    outputPath: null,
    help: false,
  };
  let explicitOutput = null;
  let explicitCorrelationId = null;
  let explicitFixture = null;
  for (const arg of argv) {
    if (arg === "--help") options.help = true;
    else if (arg === "--accept-fixture-scenario") options.acceptFixtureScenario = true;
    else if (arg === "--confirm-reviewed-fixture") options.confirmReviewedFixture = true;
    else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice("--base-url=".length);
    else if (arg.startsWith("--fixture=")) {
      if (explicitFixture !== null) throw new Error("--fixture may only be supplied once.");
      explicitFixture = arg.slice("--fixture=".length);
    }
    else if (arg.startsWith("--correlation-id=")) explicitCorrelationId = correlationOption(arg.slice("--correlation-id=".length));
    else if (arg.startsWith("--poll-ms=")) options.pollMs = integerOption(arg.slice("--poll-ms=".length), "--poll-ms", options.pollMs);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = integerOption(arg.slice("--timeout-ms=".length), "--timeout-ms", options.timeoutMs);
    else if (arg.startsWith("--output=")) explicitOutput = arg.slice("--output=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (explicitFixture !== null) fixture = resolveEricDemoFixture(explicitFixture);
  options.fixtureKey = fixture.key;
  options.manifestPath = fixture.manifestPath;
  options.fixturePath = fixture.relativePath;
  if (explicitCorrelationId !== null) options.correlationId = explicitCorrelationId;
  if (explicitOutput !== null) {
    if (!explicitOutput.trim()) throw new Error("--output requires a path.");
    options.outputPath = path.resolve(explicitOutput);
  } else {
    options.outputPath = path.resolve(
      "outputs",
      "eric-demo",
      `${options.fixtureKey}-${options.correlationId}-${invocationId}.json`,
    );
  }
  if (options.confirmReviewedFixture && !options.acceptFixtureScenario) {
    throw new Error("--confirm-reviewed-fixture requires --accept-fixture-scenario for the multi-Event fixture.");
  }
  return options;
}

export { ERIC_DEMO_FIXTURE_KEYS };

async function reserveReport(outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  return open(outputPath, "wx");
}

async function writeReport(file, report) {
  await file.truncate(0);
  await file.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  await file.sync();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let reportFile;
  try {
    reportFile = await reserveReport(options.outputPath);
    const report = await runEricDemo(options);
    await writeReport(reportFile, report);
    process.stdout.write(formatEricDemoReport(report));
    process.stdout.write(`\nFull JSON trace: ${options.outputPath}\n`);
  } catch (error) {
    const report = error?.demoReport;
    if (report && reportFile) {
      await writeReport(reportFile, report).catch((writeError) => {
        process.stderr.write(`Could not write failure trace: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`);
      });
      process.stderr.write(formatEricDemoReport(report));
      process.stderr.write(`\nFailure JSON trace: ${options.outputPath}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  } finally {
    await reportFile?.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
