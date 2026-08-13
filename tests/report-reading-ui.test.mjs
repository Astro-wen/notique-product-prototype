import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("AI draft is a chronological, evidence-linked view of existing Agent B claims", () => {
  assert.match(page, /buildAiDraftSummary\(runClaims\)/);
  assert.match(page, /left\.timestampStart - right\.timestampStart/);
  assert.match(page, /onOpenClaim\(item\.claimId\)/);
  assert.match(page, /item\.quote/);
  assert.match(page, /void openClaim\(id, "draft"\)/);
});

test("evidence cards use the scoped context endpoint and exact quote highlighting", () => {
  const evidenceCard = page.slice(page.indexOf("function EvidenceCard"), page.indexOf("function uncertaintyForEdit"));
  assert.match(evidenceCard, /api\.getEvidenceContext\(evidence\.id\)/);
  assert.doesNotMatch(evidenceCard, /listEventTranscriptSegments/);
  assert.match(evidenceCard, /context\.before/);
  assert.match(evidenceCard, /context\.target/);
  assert.match(evidenceCard, /context\.after/);
  assert.match(evidenceCard, /highlightExactPhrase\(text, quote\)/);
  assert.match(styles, /\.evidence-card blockquote\.evidence-target-quote[^}]*font-size: 22px/);
});

test("verified results render typed timeline moments and preference history", () => {
  assert.match(page, /recordArray\(group\.moments\)/);
  assert.match(page, /timelineMomentLabels/);
  assert.match(page, /beforeStatement && afterStatement/);
  assert.match(page, /moments\.slice\(0, 3\)/);
  assert.match(page, /decisionPeople/);
  assert.match(page, /firstSeen/);
  assert.match(page, /lastSeen/);
  assert.match(page, /recordArray\(item\.history\)/);
});
