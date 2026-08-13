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
const { buildAiDraftSummary, groupAiDraftClaims, sortClaimsForReview } = compiledModule.exports;

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

test("AI draft summary reuses validated claims and exact evidence without inventing prose", () => {
  const summary = buildAiDraftSummary([
    {
      id: "later-decision",
      type: "decision",
      statement: "The client approved option B.",
      reviewStatus: "pending",
      evidenceRefs: [{ id: "ev-2", quote: "Let's use option B", speaker: "Client", timestampStart: 65_000 }],
    },
    {
      id: "earlier-decision",
      type: "decision",
      statement: "The client rejected option A.",
      reviewStatus: "pending",
      evidenceRefs: [{ id: "ev-1", quote: "I do not want option A", speaker: "Client", timestampStart: "00:42" }],
    },
    {
      id: "budget",
      type: "budget",
      statement: "The budget is $10,000.",
      reviewStatus: "verified",
      evidenceRefs: [],
    },
  ]);

  assert.deepEqual(Array.from(summary, (item) => item.claimId), ["earlier-decision", "later-decision", "budget"]);
  assert.equal(summary[0].statement, "The client rejected option A.");
  assert.equal(summary[0].quote, "I do not want option A");
  assert.equal(summary[0].timestampStart, 42_000);
  assert.equal(summary[2].quote, null);
});
