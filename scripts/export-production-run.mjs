#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  buildPredictionPackage,
  stableStringify,
} from "./lib/export-production-run.mjs";

function usage() {
  return `Usage:
  node scripts/export-production-run.mjs --run-id <id> [--run-id <id>] [options]

Options:
  --base-url <url>          Site root or /api/v1 (default: http://localhost:3000)
  --project-id <id>         Optional project ownership assertion
  --output <path>           Write JSON to this path (default: stdout)
  --commit-sha <sha>        Commit recorded in metadata (default: unknown)
  --environment local|test  Export environment (default: local)
  --allow-test-host <host>  Exact host:port required for a non-local test URL
  --help                    Show this help

The command is read-only. It never calls a model and never reads Ground Truth.`;
}

function takeValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    baseUrl: "http://localhost:3000",
    environment: "local",
    allowedTestHost: null,
    projectId: null,
    runIds: [],
    commitSha: "unknown",
    output: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--base-url") options.baseUrl = takeValue(argv, index++, arg);
    else if (arg === "--environment") options.environment = takeValue(argv, index++, arg);
    else if (arg === "--allow-test-host") options.allowedTestHost = takeValue(argv, index++, arg);
    else if (arg === "--project-id") options.projectId = takeValue(argv, index++, arg);
    else if (arg === "--run-id") options.runIds.push(takeValue(argv, index++, arg));
    else if (arg === "--commit-sha") options.commitSha = takeValue(argv, index++, arg);
    else if (arg === "--output") options.output = takeValue(argv, index++, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.help) {
    if (options.environment !== "local" && options.environment !== "test") {
      throw new Error("--environment must be local or test.");
    }
    if (!options.runIds.length) throw new Error("At least one --run-id is required.");
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const predictionPackage = await buildPredictionPackage(options);
    const serialized = stableStringify(predictionPackage);
    if (options.output) {
      const outputPath = resolve(options.output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
      process.stdout.write(`Wrote ${outputPath}\n`);
    } else {
      process.stdout.write(serialized);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Export failed."}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
