import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const outputDir = mkdtempSync(join(tmpdir(), "notique-highlight-"));
execFileSync("npx", ["tsc", "lib/domain/text-highlight.ts", "--target", "ES2022", "--module", "commonjs", "--outDir", outputDir], { stdio: "pipe" });
const compiled = readFileSync(join(outputDir, "text-highlight.js"), "utf8");
const textHighlightModule = { exports: {} };
new Function("module", "exports", compiled)(
  textHighlightModule,
  textHighlightModule.exports,
);
const { highlightExactPhrase } = textHighlightModule.exports;

test("highlights the exact evidence phrase without changing transcript text", () => {
  assert.deepEqual(
    highlightExactPhrase("Before our brand is accepted abroad after", "our brand is accepted abroad"),
    [
      { text: "Before ", highlighted: false },
      { text: "our brand is accepted abroad", highlighted: true },
      { text: " after", highlighted: false },
    ],
  );
});

test("uses case-insensitive matching while preserving original characters", () => {
  assert.deepEqual(highlightExactPhrase("The Price Is 25 Euro.", "the price is 25 euro"), [
    { text: "The Price Is 25 Euro", highlighted: true },
    { text: ".", highlighted: false },
  ]);
});

test("does not invent a highlight when the quote is not in the segment", () => {
  assert.deepEqual(highlightExactPhrase("Different transcript text", "missing quote"), [
    { text: "Different transcript text", highlighted: false },
  ]);
});
