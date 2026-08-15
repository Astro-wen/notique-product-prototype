import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const realtor = JSON.parse(await readFile(new URL("../eval/cases/synthetic-realtor-v1/ground-truth.json", import.meta.url), "utf8"));
const oak = JSON.parse(await readFile(new URL("../eval/cases/synthetic-contractor-v1/ground-truth.json", import.meta.url), "utf8"));

function executablePageFunction(name, nextName, dependencies) {
  const start = page.indexOf(`function ${name}`);
  const end = page.indexOf(`\n}\n\nfunction ${nextName}`, start);
  assert.ok(start >= 0 && end >= 0, `${name} must have a stable function boundary`);
  const javascript = ts.transpileModule(page.slice(start, end + 2), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const names = Object.keys(dependencies);
  return new Function(...names, `${javascript}\nreturn ${name};`)(...names.map((key) => dependencies[key]));
}

function claim(data, id) {
  const match = data.claims.find((item) => item.id === id);
  assert.ok(match, `fixture claim ${id} must exist`);
  return match;
}

test("buyer overview executes the production classifier against Morgan and Oak claims", () => {
  const firstString = (object, keys) => {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  };
  const classify = executablePageFunction("buyerOverviewSectionFor", "BuyerOverviewGrid", { firstString });

  assert.equal(classify(claim(realtor, "gt-r1-joint-offer-approval")), "people");
  assert.equal(classify(claim(oak, "gt-e1-cabinets-stay")), "preferences", "a decision is not automatically a decision-maker");
  assert.equal(classify(claim(realtor, "gt-r1-bedrooms-three")), "requirements");
  assert.equal(classify(claim(oak, "gt-e3-moisture-recheck")), "requirements", "a hard requirement wins over action-like wording");
  assert.equal(classify(claim(realtor, "gt-r1-older-character-home")), "preferences", "generic home wording is not a specific property");
  assert.equal(classify(claim(realtor, "gt-r2-redwood-rejected")), "properties");
  assert.equal(classify(claim(oak, "gt-e3-tile-purchase")), "actions", "a concrete future action is not buried in preferences");
});

test("duplicate project names get stable option labels without renaming projects", () => {
  const labelFor = executablePageFunction("projectSelectionLabel", "formatReviewDuration", { formatDate: (value) => value });
  const projects = [
    { id: "prj_alpha111", name: "Morgan Family", eventCount: 4, updatedAt: "2026-08-15T08:30:00.000Z" },
    { id: "prj_beta222", name: "Morgan Family", eventCount: 4, updatedAt: "2026-08-15T08:30:00.000Z" },
    { id: "prj_oak333", name: "Oak Street", eventCount: 3, updatedAt: "2026-08-14T07:00:00.000Z" },
  ];

  const first = labelFor(projects[0], projects);
  const second = labelFor(projects[1], projects);
  assert.match(first, /^Morgan Family · 4 次沟通 · 更新 2026-08-15T08:30:00\.000Z/);
  assert.notEqual(first, second);
  assert.match(first, /pha111$/);
  assert.match(second, /eta222$/);
  assert.equal(labelFor(projects[2], projects), "Oak Street");
  assert.equal(projects[0].name, "Morgan Family");
  assert.match(page, /projectSelectionLabel\(item, sortedProjects\)/);
});
