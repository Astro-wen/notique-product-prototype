import assert from "node:assert/strict";
import test from "node:test";
import {
  declarationFile,
  declarationSource,
  declaredSymbols,
  effectContaining,
  statementContaining,
  uiSourceFiles,
} from "./helpers/ui-source.mjs";

test("the helper indexes every UI source file, not just the page", () => {
  const files = uiSourceFiles();
  assert.ok(files.includes("app/page.tsx"));
  assert.ok(files.length > 1, "the index must span the whole app directory");
  assert.ok(declaredSymbols().length > 100);
});

test("a declaration is returned whole, with balanced braces", () => {
  for (const name of ["Home", "SimpleTestScreen", "TranscriptViewer", "primaryResultTabs"]) {
    const body = declarationSource(name);
    assert.equal(
      (body.match(/\{/g) ?? []).length,
      (body.match(/\}/g) ?? []).length,
      `${name} must be extracted as a complete declaration`,
    );
  }
});

test("regex literals and template braces do not unbalance extraction", () => {
  // projectOverviewSectionFor-style quantifiers such as {0,40} once broke a
  // hand-written brace scanner; the TypeScript AST is immune to them.
  const body = declarationSource("timelineMomentMatches");
  assert.match(body, /^function timelineMomentMatches/);
  assert.match(body, /\}$/);
});

test("a missing or ambiguous name fails loudly instead of asserting on an empty slice", () => {
  assert.throws(() => declarationSource("thisNameDoesNotExist"), /was not found/);
  assert.throws(() => statementContaining("this text is nowhere in the app"), /no statement/);
  assert.throws(() => effectContaining("this text is nowhere in the app"), /no useEffect/);
});

test("statement and effect anchors resolve to complete blocks", () => {
  const effect = effectContaining("const intent = readAutoAnalysisIntent(event.id)");
  assert.match(effect, /^useEffect\(/);
  assert.match(effect, /autoAnalysisDecision\(\{/);
  const statement = statementContaining("[queuedExtractionRunId, queuedExtractionRunStatus]");
  assert.match(statement, /^useEffect\(/);
});

test("declarationFile reports where code lives so moves stay visible", () => {
  assert.equal(declarationFile("Home"), "app/page.tsx");
});
