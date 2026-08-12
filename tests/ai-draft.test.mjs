import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../lib/domain/ai-draft.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
vm.runInNewContext(compiled, { module: compiledModule, exports: compiledModule.exports, Set });
const { groupAiDraftClaims, sortClaimsForReview } = compiledModule.exports;

test("review queue prioritizes human additions, critical facts, relations, then ordinary facts", () => {
  const sorted = sortClaimsForReview([
    { id: "ordinary", type: "property_fact", statement: "ordinary", reviewStatus: "pending" },
    { id: "relation", type: "property_fact", statement: "relation", reviewStatus: "pending", relationsForReview: [{ status: "proposed" }] },
    { id: "critical", type: "budget", statement: "critical", reviewStatus: "pending" },
    { id: "human", type: "other", statement: "human", reviewStatus: "pending", source: "human" },
  ]);
  assert.deepEqual(Array.from(sorted, (claim) => claim.id), ["human", "critical", "relation", "ordinary"]);
});

test("AI draft groups readable meeting topics without changing content", () => {
  const grouped = groupAiDraftClaims([
    { id: "d", type: "decision", statement: "approved", reviewStatus: "pending" },
    { id: "b", type: "budget", statement: "$10", reviewStatus: "pending" },
    { id: "p", type: "preference", statement: "blue", reviewStatus: "pending" },
    { id: "q", type: "open_question", statement: "who pays", reviewStatus: "pending" },
    { id: "r", type: "property_fact", statement: "needs proof", reviewStatus: "pending", needsAdditionalEvidence: true },
  ]);
  assert.equal(grouped.decisions[0].statement, "approved");
  assert.equal(grouped.money_dates_owners[0].statement, "$10");
  assert.equal(grouped.preferences[0].statement, "blue");
  assert.equal(grouped.open_questions[0].statement, "who pays");
  assert.equal(grouped.risks[0].statement, "needs proof");
});
