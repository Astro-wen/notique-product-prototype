#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  auditBuildPackage,
  cleanForbiddenPackagePaths,
  sanitizeGeneratedWranglerConfig,
} from "./lib/build-secret-audit.mjs";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = resolve(root, "dist");
const clean = process.argv.includes("--clean");

try {
  await stat(packageDirectory);
} catch (error) {
  if (error && typeof error === "object" && error.code === "ENOENT") {
    console.error("Build package audit failed: dist/ does not exist.");
    process.exit(1);
  }
  throw error;
}

if (clean) {
  const removed = await cleanForbiddenPackagePaths(packageDirectory);
  if (removed.length > 0) {
    console.log(`Removed ${removed.length} forbidden file(s) from the build package.`);
  }
  const removedWranglerFields = await sanitizeGeneratedWranglerConfig(packageDirectory);
  if (removedWranglerFields.length > 0) {
    console.log(
      `Removed generated Wrangler build metadata: ${removedWranglerFields.join(", ")}.`,
    );
  }
}

const result = await auditBuildPackage(packageDirectory);
if (result.forbiddenPaths.length > 0 || result.contentFindings.length > 0) {
  console.error("Build package secret audit failed.");
  for (const path of result.forbiddenPaths) {
    console.error(`Forbidden package path: ${path}`);
  }
  for (const finding of result.contentFindings) {
    console.error(`Potential secret content: ${finding.path} (${finding.rule})`);
  }
  process.exit(1);
}

console.log("Build package secret audit passed.");
