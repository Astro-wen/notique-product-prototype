import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { declarationSource, effectContaining } from "./helpers/ui-source.mjs";
import { uiSource } from "./helpers/ui-source.mjs";

const moduleUrl = pathToFileURL(path.resolve("lib/domain/guided-workflow.ts")).href;
const {
  chooseRememberedSelection,
  deriveGuidedDisplayStatus,
  nextPendingClaimId,
} = await import(moduleUrl);

test("guided status exposes exactly one actionable phase", () => {
  const base = { assetCount: 1, analyzableAssetCount: 1, pendingCount: 0 };
  assert.equal(deriveGuidedDisplayStatus(base).label, "可以分析");
  assert.equal(deriveGuidedDisplayStatus({ ...base, runStatus: "queued" }).label, "正在启动分析");
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
  assert.match(uiSource, /recentProjectStorageKey = "notique\.ui\.recent-project-id"/);
  assert.match(uiSource, /storeId\(recentEventStorageKey\(projectId\), nextEvent\.id\)/);
  assert.match(uiSource, /key=\{project\?\.id \?\? "none"\}/);
  assert.match(uiSource, /onResult=\{\(tab = "brief-card"\) => void loadView\(tab\)\}/);
  assert.match(uiSource, /projectWorkflow\.phase === "complete" \? \(\) => onResult\("brief-card"\)/);
  assert.match(uiSource, /onResult\("client-progress"\); return; \}/, "the project record opens directly from the workspace nav");
  assert.match(uiSource, /await openClaim\(nextId, "review", undefined, "replace"\)/);
  assert.match(uiSource, /await finishGuidedReview\(\)/);
  const finishGuidedReview = declarationSource("finishGuidedReview");
  assert.match(finishGuidedReview, /loadView\("brief-card", projectId, "replace"\)/);
  assert.match(finishGuidedReview, /loadSimpleProject\(projectId, snapshot\.plan\.currentEventId, "replace"\)/);
  assert.match(finishGuidedReview, /if \(!isCurrentRequestOwner\(owner\)\) return/);
  assert.doesNotMatch(finishGuidedReview, /setScreen\("review-summary"\)/);
  assert.match(uiSource, /const claimRouteReadonly = isReadonlyClaimRoute\(route, selectedClaim\?\.reviewStatus\)/);
  assert.match(uiSource, /reviewClaims=\{claimRouteReadonly \? \[\] : claims\}/);
  assert.match(uiSource, /pendingOccurrenceCount=\{claimRouteReadonly \? 0 :/);
  assert.match(uiSource, /relationsReviewed/);
  assert.equal((uiSource.match(/api\.completeReviewSession/g) ?? []).length, 1, "review completion has one mutation path");
  assert.doesNotMatch(uiSource, /<em>\{itemDisplayStatus\.label\}<\/em>/);
  assert.match(uiSource, /const itemSummary = eventWorkflowSummaries\[item\.id\]/);
  assert.match(uiSource, /const itemDisplayStatus = workflowEventDisplayStatus\(itemSummary\)/);
  assert.match(uiSource, /const materialCount = itemSummary\?\.statusSummary\.materialCount/);
  assert.doesNotMatch(uiSource, /Luna Max|旧的 max/);
});

test("mobile keeps one event selector and resets the tab when switching events", () => {
  const styles = fs.readFileSync("app/globals.css", "utf8");
  assert.match(uiSource, /function selectEvent\(nextEventId: string\)[\s\S]*?setActiveTab\("materials"\);[\s\S]*?onUseEvent\(nextEventId\)/);
  assert.match(uiSource, /onChange=\{\(change\) => selectEvent\(change\.target\.value\)\}/);
  assert.match(styles, /@media \(max-width: 800px\)[\s\S]*?\.simple-meeting-rail \{ display: none; \}/);
  assert.match(styles, /\.simple-new-event-mobile \{ display: inline-flex;/);
});

test("terminal transcription refreshes the Event and workflow before publishing success", () => {
  const effect = effectContaining("const activeTranscriptionRunId = transcriptionRun?.id");
  const terminalBranch = effect.slice(effect.indexOf('if (latest.status === "succeeded")'));

  assert.match(terminalBranch, /Promise\.all\(\[\s*api\.getEvent\(eventId\),\s*inspectProjectWorkflow\(projectId, loadFreshWorkflowSnapshot\)/);
  assert.ok(
    terminalBranch.indexOf("api.getEvent(eventId)") < terminalBranch.indexOf("setTranscriptionRun(latest)"),
    "the terminal Run must not tear down polling before the ready Event is loaded",
  );
  assert.match(terminalBranch, /setEventWorkflowSummaries\(workflowSnapshot\.eventSummaries\)/);
  assert.match(effect, /isCurrentRequestOwner\(owner\)/);
});

test("starting analysis rechecks a stale Event once before reporting not ready", () => {
  const action = declarationSource("startExtractionForEvent");

  assert.match(action, /if \(extractionAssetVersionIds\(extractionTarget\)\.length === 0\) \{[\s\S]*?api\.getEvent\(targetEvent\.id\)/);
  assert.match(action, /extractionTarget = refreshed/);
  assert.match(action, /requestExtractionForEvent\(extractionTarget\)/);
  assert.ok(
    action.indexOf("api.getEvent(targetEvent.id)") < action.indexOf('code: "EVENT_NOT_READY"'),
    "the browser must consult server truth before rejecting a just-finished transcript",
  );
});

test("new material auto-starts one idempotent analysis only after its final transcript is ready", () => {
  const effect = effectContaining("const intent = readAutoAnalysisIntent(event.id)");

  assert.match(uiSource, /sessionStorage\.setItem\(autoAnalysisIntentKey\(intent\.eventId\), JSON\.stringify\(intent\)\)/);
  assert.match(uiSource, /armedAt: Date\.now\(\),\s*idempotencyKey: crypto\.randomUUID\(\)/);
  assert.match(uiSource, /armAutoAnalysis\(\s*targetEvent\.id,\s*kind === "audio" \? init\.assetId : undefined/);
  assert.match(uiSource, /created\.forEach\(\(item\) => armAutoAnalysis\(item\.id, undefined, item\.latestRun\?\.id \|\| item\.latestRunId\)\)/);
  assert.match(effect, /autoAnalysisDecision\(\{/);
  assert.match(effect, /baseRunId: intent\.baseRunId/);
  assert.match(effect, /latestRunLoaded: !latestRunId \|\| Boolean\(loadedLatestRun\)/);
  assert.match(effect, /if \(decision === "clear"\)/);
  assert.match(effect, /audioRun\?\.status !== "succeeded" \|\| !audioRun\.derivedTranscriptAssetId/);
  assert.match(effect, /asset\.id === audioRun\.derivedTranscriptAssetId && assetIsAnalyzable\(asset\)/);
  assert.match(effect, /currentEventTranscriptionRunning,\s*hasAnalyzableAssets: analyzableVersionIds\.length > 0/);
  assert.match(effect, /intent\.extractionFingerprint === fingerprint[\s\S]*?storeAutoAnalysisIntent\(\{ \.\.\.intent, extractionFingerprint: fingerprint, idempotencyKey \}\)/);
  assert.match(effect, /extractionKeys\.current\.set\(fingerprint, idempotencyKey\)/);
  assert.match(effect, /autoAnalysisAttempts\.current\.has\(fingerprint\)/);
  assert.match(effect, /startExtractionForEvent\(event, true\)/);
  // The intent belongs to an Event: transcription can finish while the reader
  // is in the project record or the review queue, and the Run must still start.
  assert.doesNotMatch(effect, /screen !== "simple"/, "auto-start must not depend on which screen is open");
  assert.match(effect, /routeRef\.current\.eventId !== event\.id\) return;/, "a stale Event must still be refused");
  // A browser that refuses session storage can never arm the intent, so the
  // message must offer the manual path instead of promising an automatic one.
  assert.match(uiSource, /const armed = armAutoAnalysis\(/);
  assert.match(uiSource, /armed \? "材料已加入，正在准备自动分析" : /);
  assert.match(uiSource, /这个浏览器不允许保存会话状态，请点击“重新启动分析”。/);
});
