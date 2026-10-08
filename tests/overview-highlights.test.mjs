import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { splitOverviewFigures } from "../lib/domain/overview-highlights.ts";

const figures = (text) => splitOverviewFigures(text).filter((p) => p.kind === "figure").map((p) => p.text);

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

test("highlights preserve ambiguous equal numbers without guessing a claim or unit", () => {
  const text = "Price $1,600, deposit $1,600, area 1600 sqft and date 1/6.";
  const pieces = splitOverviewFigures(text);
  assert.equal(pieces.map(piece => piece.text).join(""), text);
  assert.deepEqual(figures(text), ["$1,600", "$1,600", "1600 sqft", "1/6"]);
  assert.ok(pieces.every(piece => !("claimId" in piece)));
});

test("the overview renders per sentence with clickable figures", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /splitOverviewFigures\(/);
  assert.doesNotMatch(page, /splitOverviewFigures\(item.text, claims\)/);
  assert.match(page, /onClick=\{\(\) => locateRawSources\(item.sourceIds\)\}/);
  assert.match(page, /className="overview-figure"/);
  assert.match(styles, /\.overview-figure\b/);
});

test('month names do not highlight parts of participant names',()=>{
  assert.deepEqual(figures('Maya and Marchand discussed October 20, 2026.'),['October 20, 2026']);
  assert.deepEqual(figures('May, Jun. 2, and September.'),['May','Jun. 2','September']);
});
