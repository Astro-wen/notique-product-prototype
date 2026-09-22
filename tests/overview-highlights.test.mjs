import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { figureDigits, splitOverviewFigures } from "../lib/domain/overview-highlights.ts";

const figures = (text, claims) => splitOverviewFigures(text, claims).filter((p) => p.kind === "figure").map((p) => p.text);

test("money, percentages, dates, durations, areas and room counts are picked out", () => {
  assert.deepEqual(
    figures("The buyer has about $10,000–$12,000 now, targets $220,000 and $1,600 a month, wants a 4-bedroom home on 0.17 acres by February, and expects a 6-month term at 3.5%."),
    ["$10,000", "$12,000", "$220,000", "$1,600 a month", "4-bedroom", "0.17 acres", "February", "6-month", "3.5%"],
  );
  assert.deepEqual(figures("预算上限是 120 万美元，2 月底前搬家，房子建成不超过 10 年。"), ["120 万美元", "2 月", "10 年"]);
  // 数字后面的逗号是标点，不属于数字。
  assert.deepEqual(figures("about $1,600, then more"), ["$1,600"]);
});

test("plain prose without figures is left as one piece, and pieces reassemble to the original", () => {
  const text = "Kyle met Curtis, who is moving with his family and wants an open floor plan.";
  assert.deepEqual(splitOverviewFigures(text), [{ kind: "text", text }]);
  const mixed = "Target price $220,000, lease ends in February.";
  assert.equal(splitOverviewFigures(mixed).map((p) => p.text).join(""), mixed);
});

test("a figure that appears in a conclusion links to that conclusion; others do not", () => {
  const claims = [
    { id: "clm_price", statement: "The parties adopted approximately $220,000 as the working purchase-price target." },
    { id: "clm_pay", statement: "Approximately $1,600 per month is comfortable." },
  ];
  const pieces = splitOverviewFigures("They agreed on $220,000 with about $1,600 a month and a move by February.", claims);
  const byText = Object.fromEntries(pieces.filter((p) => p.kind === "figure").map((p) => [p.text, p.claimId]));
  assert.equal(byText["$220,000"], "clm_price");
  assert.equal(byText["$1,600 a month"], "clm_pay");
  assert.equal(byText["February"], null);
  assert.equal(figureDigits("$1,600 a month"), "1600");
});

test("the overview renders per sentence with clickable figures", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /splitOverviewFigures\(/);
  assert.match(page, /className="overview-figure is-claim"/);
  assert.match(page, /className="overview-figure"/);
  assert.match(styles, /\.overview-figure\b/);
});
