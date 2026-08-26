import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { projectOverviewSectionFor } from "../lib/domain/project-overview.ts";
import { projectSelectionLabel } from "../lib/domain/project-label.ts";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const realtor = JSON.parse(await readFile(new URL("../eval/cases/synthetic-realtor-v1/ground-truth.json", import.meta.url), "utf8"));
const oak = JSON.parse(await readFile(new URL("../eval/cases/synthetic-contractor-v1/ground-truth.json", import.meta.url), "utf8"));

function claim(data, id) {
  const match = data.claims.find((item) => item.id === id);
  assert.ok(match, `fixture claim ${id} must exist`);
  return match;
}

test("project overview executes the production classifier across buyer and contractor claims", () => {
  const classify = projectOverviewSectionFor;

  assert.equal(classify(claim(realtor, "gt-r1-joint-offer-approval")), "people");
  assert.equal(classify({ type: "decision", statement: "Lena Morgan cannot commit on behalf of both buyers." }), "people");
  assert.equal(classify({ type: "decision", statement: "Lena Morgan and Evan Morgan must both approve any offer." }), "people");
  assert.equal(classify(claim(oak, "gt-e1-cabinets-stay")), "facts", "a decision is not automatically a person or preference");
  assert.equal(classify(claim(realtor, "gt-r1-bedrooms-three")), "requirements");
  assert.equal(classify(claim(oak, "gt-e3-moisture-recheck")), "requirements", "a hard requirement wins over action-like wording");
  assert.equal(classify(claim(realtor, "gt-r1-older-character-home")), "preferences", "generic home wording is not a specific property");
  assert.equal(classify(claim(realtor, "gt-r2-redwood-rejected")), "subjects");
  assert.equal(classify(claim(oak, "gt-e3-tile-purchase")), "actions", "a concrete future action is not buried in preferences");
  assert.equal(classify({ type: "risk", statement: "The repair could expose hidden damage." }), "questions");
  assert.equal(classify({ type: "other", statement: "The insurance claim includes water damage." }), "subjects");
});

test("the page renders the overview through the shared production classifier", () => {
  assert.match(page, /import \{ projectOverviewSectionFor, projectOverviewSections, type ProjectOverviewSection \} from "@\/lib\/domain\/project-overview"/);
  assert.doesNotMatch(page, /function projectOverviewSectionFor/, "the classifier must live in the domain layer, not in the page");
});

test("duplicate project names get stable option labels without renaming projects", () => {
  const labelFor = projectSelectionLabel;
  const projects = [
    { id: "prj_alpha111", name: "Morgan Family", eventCount: 4, updatedAt: "2026-08-15T08:30:00.000Z" },
    { id: "prj_beta222", name: "Morgan Family", eventCount: 4, updatedAt: "2026-08-15T08:30:00.000Z" },
    { id: "prj_oak333", name: "Oak Street", eventCount: 3, updatedAt: "2026-08-14T07:00:00.000Z" },
  ];

  const first = labelFor(projects[0], projects);
  const second = labelFor(projects[1], projects);
  assert.match(first, /^Morgan Family · 4 次沟通 · 更新 /);
  assert.notEqual(first, second);
  assert.match(first, /pha111$/);
  assert.match(second, /eta222$/);
  assert.equal(labelFor(projects[2], projects), "Oak Street");
  assert.equal(projects[0].name, "Morgan Family");
  assert.match(page, /projectSelectionLabel\(item, sortedProjects\)/);
});
