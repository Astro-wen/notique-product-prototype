import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { uiSourceFiles } from "./helpers/ui-source.mjs";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

// Base rules start at column 0; rules inside a media query are indented.
const baseRuleHeads = css
  .split("\n")
  .filter((line) => /^\.[^{}]*\{/.test(line))
  .map((line) => line.slice(0, line.indexOf("{")).trim());

/**
 * Two unrelated rules once shared the name .project-overview-grid: one was the
 * project screen's two-column layout, the other the overview's section grid.
 * Editing "the" rule by name then hit the wrong one and silently removed 221
 * lines of unrelated layout, which no test covered. New duplicates are refused;
 * the legacy .simple-* ones are recorded so they cannot grow.
 */
const KNOWN_DUPLICATE_SELECTORS = [
  ".simple-header",
  ".simple-header h1",
  ".simple-header p",
  ".simple-import-action",
  ".simple-import-actions",
  ".simple-material-list",
  ".simple-material-list b",
  ".simple-page",
  ".simple-session",
  ".simple-session-copy",
];

test("no two unrelated base rules share a selector", () => {
  const tally = new Map();
  for (const head of baseRuleHeads) tally.set(head, (tally.get(head) ?? 0) + 1);
  const duplicates = [...tally].filter(([, count]) => count > 1).map(([head]) => head).sort();
  assert.deepEqual(
    duplicates,
    KNOWN_DUPLICATE_SELECTORS,
    "a duplicate selector makes rules impossible to edit by name; give the new rule its own name",
  );
});

test("the stylesheet keeps its load-bearing layout rules", () => {
  // A floor, not a target: it exists so that removing a large block of rules
  // fails here instead of only showing up as a broken screen in a browser.
  assert.ok(baseRuleHeads.length > 900, `only ${baseRuleHeads.length} base rules remain`);
  for (const selector of [
    ".app-shell",
    ".sidebar",
    ".claim-layout",
    ".result-layout",
    ".evidence-card",
    ".project-screen-grid",
    ".event-workspace",
    ".asset-list",
    ".view-card",
    ".modal",
  ]) {
    assert.ok(
      baseRuleHeads.some((head) => head === selector || head.startsWith(`${selector} `) || head.startsWith(`${selector}.`)),
      `${selector} must keep an explicit rule`,
    );
  }
});

test("every statically named class is declared in the stylesheet", async () => {
  const declared = new Set(css.match(/\.[a-z][a-z0-9-]*/g)?.map((name) => name.slice(1)) ?? []);
  const missing = new Set();
  for (const file of uiSourceFiles()) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    // Only fully static className literals; interpolated ones carry runtime values.
    for (const match of source.matchAll(/className="([a-z0-9 -]+)"/g)) {
      for (const name of match[1].split(/\s+/).filter(Boolean)) {
        if (!declared.has(name)) missing.add(name);
      }
    }
  }
  // Pre-existing dead class names, kept as a list so new ones fail here. Each
  // is a no-op modifier beside a class that does carry the styling.
  const KNOWN_UNSTYLED = [
    "claim-type",
    "debug-output",
    "event-panel",
    "form-note",
    "list-page",
    "neutral",
    "results-page",
    "source-panel",
    "summary-related-claims",
  ];
  assert.deepEqual(
    [...missing].sort(),
    KNOWN_UNSTYLED,
    "a class rendered by the UI has no rule in the stylesheet",
  );
});
