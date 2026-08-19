import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const outputDir = mkdtempSync(join(tmpdir(), "notique-readable-diff-"));
execFileSync("npx", [
  "tsc",
  "app/readable-transcript-diff.ts",
  "--target", "ES2022",
  "--module", "commonjs",
  "--moduleResolution", "node",
  "--esModuleInterop",
  "--skipLibCheck",
  "--outDir", outputDir,
], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
const compiled = readFileSync(join(outputDir, "readable-transcript-diff.js"), "utf8");
const readableDiffModule = { exports: {} };
new Function("module", "exports", "require", compiled)(
  readableDiffModule,
  readableDiffModule.exports,
  createRequire(import.meta.url),
);
const {
  READABLE_PARAGRAPH_DIFF_LIMITS,
  buildReadableWordDiff,
  mappedRawParagraph,
  risksForReadableChange,
} = readableDiffModule.exports;

const helperSource = await readFile(new URL("../app/readable-transcript-diff.ts", import.meta.url), "utf8");
const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

test("combines only explicitly mapped raw Segments in the readable paragraph order", () => {
  const mapped = mappedRawParagraph(["raw-2", "raw-1", "missing"], [
    { id: "raw-1", ordinal: 1, text: "First raw sentence." },
    { id: "raw-2", ordinal: 2, text: "Second raw sentence." },
    { id: "unrelated", ordinal: 3, text: "Must not enter this paragraph." },
  ]);

  assert.equal(mapped.text, "Second raw sentence.\nFirst raw sentence.");
  assert.deepEqual(mapped.missingIds, ["missing"]);
  assert.doesNotMatch(mapped.text, /Must not enter/);
});

test("word diff exposes the complete paragraph change and flags protected semantics", async () => {
  const result = await buildReadableWordDiff(
    "John is not the approver for $500 on September 8.",
    "Mary is the owner for $600 on September 9.",
  );

  assert.equal(result.status, "ready");
  assert.ok(result.parts.some((part) => part.removed && /not/.test(part.value)));
  assert.ok(result.parts.some((part) => part.added && /owner/.test(part.value)));
  assert.ok(result.parts.some((part) => part.added && /600|9/.test(part.value)));
  assert.deepEqual(new Set(result.risks), new Set(["amount_or_date", "negation", "responsibility"]));
});

test("sensitive-change hints cover Chinese responsibility and negation language", () => {
  assert.deepEqual(risksForReadableChange("不需要经纪人负责"), ["negation", "responsibility"]);
  assert.deepEqual(risksForReadableChange("预算五十万，9月8日确认"), ["amount_or_date"]);
});

test("large paragraphs fail closed before running an unbounded browser diff", async () => {
  const result = await buildReadableWordDiff(
    "a".repeat(READABLE_PARAGRAPH_DIFF_LIMITS.maxTextCharacters + 1),
    "short",
  );
  assert.deepEqual(result, { status: "fallback", reason: "too_long" });
});

test("UI lazy-loads jsdiff only after expansion and falls back to model edit records", () => {
  assert.match(helperSource, /const \{ diffWords \} = await import\(["']diff["']\)/);
  assert.match(helperSource, /maxEditLength:\s*READABLE_PARAGRAPH_DIFF_LIMITS\.maxEditLength/);
  assert.match(helperSource, /timeout:\s*READABLE_PARAGRAPH_DIFF_LIMITS\.timeoutMs/);
  assert.match(pageSource, /mappedRawParagraph\(sourceIds, rawSegments\)/);
  assert.match(pageSource, /toggleReadableDiff\(diffKey, group\.sourceIds, group\.text\)/);
  assert.match(pageSource, /<summary aria-label=["']查看整理详情["']>•••<\/summary>/);
  assert.match(pageSource, /state\.status === ["']fallback["'][\s\S]*?readable-edit-list/);
  assert.doesNotMatch(pageSource, /edits\.length\s*>\s*0\s*&&\s*<button[^>]*>[^<]*(?:查看差异|对比原稿)/);
});
