import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const moduleUrl = pathToFileURL(path.resolve("lib/domain/guided-workflow.ts")).href;
const {
  chooseRememberedSelection,
  deriveGuidedDisplayStatus,
  nextPendingClaimId,
} = await import(moduleUrl);

test("guided status exposes exactly one actionable phase", () => {
  const base = { assetCount: 1, analyzableAssetCount: 1, pendingCount: 0 };
  assert.equal(deriveGuidedDisplayStatus(base).label, "可以分析");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "processing", pipelineStage: "inventory" }).label, "正在识别事实");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "processing", pipelineStage: "verify" }).label, "正在查漏纠错");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "processing", pipelineStage: "verify_escalated" }).label, "需要加强复核");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "succeeded", needsScenarioConfirmation: true }).label, "等待场景确认");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "succeeded", pendingCount: 2 }).label, "等待人工核对");
  assert.equal(deriveGuidedDisplayStatus({ ...base, pendingCount: 2 }).label, "等待人工核对");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "succeeded" }).label, "已完成");
});

test("continuous review advances without a list round trip", () => {
  const claims = [
    { id: "a", reviewStatus: "pending" },
    { id: "b", reviewStatus: "verified" },
    { id: "c", reviewStatus: "pending" },
  ];
  assert.equal(nextPendingClaimId(claims, "a"), "c");
  assert.equal(nextPendingClaimId(claims, "c"), "a");
  assert.equal(nextPendingClaimId(claims.map((claim) => ({ ...claim, reviewStatus: "verified" })), "a"), null);
});

test("remembered selection falls back safely when an id is stale", () => {
  const items = [{ id: "one" }, { id: "two" }];
  assert.equal(chooseRememberedSelection(items, "two")?.id, "two");
  assert.equal(chooseRememberedSelection(items, "missing")?.id, "one");
  assert.equal(chooseRememberedSelection([], "missing"), null);
});

test("the page connects guided navigation without weakening review gates", () => {
  const source = fs.readFileSync("app/page.tsx", "utf8");
  assert.match(source, /recentProjectStorageKey = "notique\.ui\.recent-project-id"/);
  assert.match(source, /storeId\(recentEventStorageKey\(projectId\), nextEvent\.id\)/);
  assert.match(source, /key=\{project\?\.id \?\? "none"\}/);
  assert.match(source, /onResult=\{\(\) => void loadView\("brief-card"\)\}/);
  assert.match(source, /await openClaim\(nextId\)/);
  assert.match(source, /await finishGuidedReview\(\)/);
  assert.match(source, /reviewClaims=\{claims\}/);
  assert.match(source, /relationsReviewed/);
  assert.doesNotMatch(source, /<em>\{itemDisplayStatus\.label\}<\/em>/);
  assert.match(source, /item\.id === event\?\.id \? \(run \?\? displayItem\.latestRun\)/);
  assert.doesNotMatch(source, /Luna Max|旧的 max/);
});
