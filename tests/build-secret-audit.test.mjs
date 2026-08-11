import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditBuildPackage,
  cleanForbiddenPackagePaths,
  isForbiddenPackagePath,
} from "../scripts/lib/build-secret-audit.mjs";

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return false;
    throw error;
  }
}

test("build package path policy rejects local environment and key files", () => {
  for (const path of [
    "server/.dev.vars",
    "server/.dev.vars.preview",
    "client/.env",
    "client/.env.production",
    "server/secrets.json",
    "server/credentials.json",
    "server/.npmrc",
    "server/signing.pem",
  ]) {
    assert.equal(isForbiddenPackagePath(path), true, path);
  }
  assert.equal(isForbiddenPackagePath("server/index.js"), false);
  assert.equal(isForbiddenPackagePath("client/assets/page.js"), false);
});

test("clean mode removes forbidden files and audit reports no secret material", async (t) => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "notique-package-audit-"));
  t.after(() => rm(packageDirectory, { force: true, recursive: true }));

  await mkdir(join(packageDirectory, "server"), { recursive: true });
  await mkdir(join(packageDirectory, "server", "secrets"), { recursive: true });
  await writeFile(join(packageDirectory, "server", "index.js"), "export default {};\n");
  await writeFile(join(packageDirectory, "server", "secrets", "local.txt"), "placeholder\n");
  await writeFile(
    join(packageDirectory, "server", ".dev.vars"),
    "AI_API_KEY=test-only-placeholder\n",
  );

  const removed = await cleanForbiddenPackagePaths(packageDirectory);
  assert.deepEqual(removed, ["server/.dev.vars", "server/secrets"]);
  assert.equal(await exists(join(packageDirectory, "server", ".dev.vars")), false);
  assert.equal(await exists(join(packageDirectory, "server", "secrets")), false);
  assert.deepEqual(await auditBuildPackage(packageDirectory), {
    forbiddenPaths: [],
    contentFindings: [],
  });
});

test("audit reports token-like content without returning the matched value", async (t) => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "notique-package-audit-"));
  t.after(() => rm(packageDirectory, { force: true, recursive: true }));

  await mkdir(join(packageDirectory, "client"), { recursive: true });
  const dummyToken = ["sk", "testonly", "a".repeat(32)].join("-");
  await writeFile(
    join(packageDirectory, "client", "unsafe.js"),
    `const token = '${dummyToken}';\n`,
  );

  const result = await auditBuildPackage(packageDirectory);
  assert.deepEqual(result.forbiddenPaths, []);
  assert.deepEqual(result.contentFindings, [
    { path: "client/unsafe.js", rule: "generic-sk-key" },
  ]);
  assert.equal(JSON.stringify(result).includes(dummyToken), false);
});

test("the generated dist package is free of forbidden files and token-like content", async () => {
  const packageDirectory = fileURLToPath(new URL("../dist", import.meta.url));
  assert.deepEqual(await auditBuildPackage(packageDirectory), {
    forbiddenPaths: [],
    contentFindings: [],
  });
});
