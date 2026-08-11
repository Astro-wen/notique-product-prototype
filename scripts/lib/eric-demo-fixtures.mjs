import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");

const FIXTURE_RELATIVE_PATHS = Object.freeze({
  contractor: "eval/cases/synthetic-contractor-v1/manifest.json",
  realtor: "eval/cases/synthetic-realtor-v1/manifest.json",
  insurance: "eval/cases/synthetic-insurance-v1/manifest.json",
});

export const ERIC_DEMO_FIXTURE_KEYS = Object.freeze(Object.keys(FIXTURE_RELATIVE_PATHS));

function fixtureError(value) {
  return new Error(
    `--fixture must be one of: ${ERIC_DEMO_FIXTURE_KEYS.join(", ")}. Received: ${value || "(empty)"}.`,
  );
}

export function resolveEricDemoFixture(value = "contractor") {
  if (typeof value !== "string" || !Object.hasOwn(FIXTURE_RELATIVE_PATHS, value)) {
    throw fixtureError(value);
  }
  const relativePath = FIXTURE_RELATIVE_PATHS[value];
  return Object.freeze({
    key: value,
    manifestPath: path.resolve(REPOSITORY_ROOT, relativePath),
    relativePath,
  });
}

export function identifyEricDemoFixture(manifestPath) {
  const resolved = path.resolve(manifestPath);
  for (const key of ERIC_DEMO_FIXTURE_KEYS) {
    const fixture = resolveEricDemoFixture(key);
    if (fixture.manifestPath === resolved) return fixture;
  }
  throw new Error(
    `Eric demo only accepts repository fixture manifests: ${ERIC_DEMO_FIXTURE_KEYS.join(", ")}.`,
  );
}
