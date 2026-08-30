import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { declarationSource, uiSource } from "./helpers/ui-source.mjs";
import { projectOverviewSections } from "../lib/domain/project-overview.ts";
import { summarySectionLabel, typeLabel } from "../lib/domain/labels.ts";

const page = uiSource;
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("AI draft is a chronological, evidence-linked view of existing Agent B claims", () => {
  assert.match(page, /buildAiDraftSummary\(runClaims\)/);
  assert.match(page, /left\.timestampStart - right\.timestampStart/);
  assert.match(page, /onOpenClaim\(item\.claimId\)/);
  assert.match(page, /item\.quote/);
  assert.match(page, /void openClaim\(id, "draft"\)/);
});

test("evidence cards use the scoped context endpoint and exact quote highlighting", () => {
  const evidenceCard = declarationSource("EvidenceCard");
  assert.match(evidenceCard, /useQuery\(evidenceContextQuery\(evidence\.id\)\)/);
  assert.doesNotMatch(evidenceCard, /listEventTranscriptSegments/);
  assert.match(evidenceCard, /context\.before/);
  assert.match(evidenceCard, /context\.target/);
  assert.match(evidenceCard, /context\.after/);
  assert.match(evidenceCard, /highlightExactPhrase\(text, quote\)/);
  assert.match(page, /function HandwrittenEvidencePreview/);
  assert.match(page, /context\?\.target\.bbox/);
  assert.match(styles, /\.handwriting-bbox/);
  // The evidence quote is the largest reading size in the app, and stays a
  // scale step rather than a hand-picked pixel value.
  assert.match(styles, /\.evidence-card blockquote\.evidence-target-quote[^}]*font-size: var\(--text-xl\)/);
  assert.match(styles, /--text-xl: 22px;/);
});

test("verified results render typed timeline moments and preference history", () => {
  assert.match(page, /recordArray\(group\.moments\)/);
  assert.match(page, /timelineMomentLabels/);
  assert.match(page, /beforeStatement && afterStatement/);
  assert.match(page, /visibleSource\.slice\(0, 3\)/);
  assert.doesNotMatch(page, /index === 0 && moments\.length > 3/);
  assert.match(page, /decisionPeople/);
  assert.match(page, /firstSeen/);
  assert.match(page, /lastSeen/);
  assert.match(page, /recordArray\(item\.history\)/);
});

test("results use four general project entrances and move specialist reports behind more", () => {
  const primary = declarationSource("primaryResultTabs");
  assert.match(primary, /项目概览/);
  assert.match(primary, /时间线/);
  assert.match(primary, /下一步/);
  assert.match(primary, /会前准备/);
  assert.equal((primary.match(/\{ key: "/g) ?? []).length, 4);
  assert.match(page, /className="result-nav-more"/);
  assert.match(page, /更多报告/);
  // The first character of a label is not an icon; the label carries itself.
  assert.doesNotMatch(page, /item\.short\.slice\(0, 1\)/, "report entries must not fake an icon from a truncated label");
  // Internal measurements are not product copy.
  assert.doesNotMatch(page, /报告读取|report-load-timing/, "the view load timing must not be shown to readers");
  assert.match(page, /projectOverviewSections/);
  const overviewLabels = projectOverviewSections.map((section) => section.label);
  assert.deepEqual(overviewLabels, [
    "关键事实",
    "需求与约束",
    "偏好与条件",
    "相关人员与职责",
    "关键对象与反馈",
    "未决问题与风险",
    "下一步行动",
  ]);
  for (const section of projectOverviewSections) {
    assert.ok(section.empty.trim(), `${section.key} must offer empty-state copy`);
  }
});

test("action and timeline empty states offer useful next steps", () => {
  assert.match(page, /查看 AI 建议/);
  assert.match(page, /从原文补充行动/);
  assert.match(page, /setMissingClaimDefaultType\("next_action"\)/);
  assert.match(page, /const timelineFilters/);
  assert.match(page, /金额.*要求与偏好.*对象.*行动.*发生变化/s);
  assert.match(page, /timelineMomentMatches/);
  assert.match(page, /filter === "all" \? "核对并确认内容后，变化会出现在这里。" : "切换到“全部”可查看其他已经确认的时间线节点。"/);
  assert.match(styles, /\.timeline-filter/);
});

test("meeting rail and selected header share the workflow snapshot status", () => {
  const rail = page.slice(page.indexOf('<div className="simple-meeting-list">'), page.indexOf('</aside>', page.indexOf('<div className="simple-meeting-list">')));
  assert.match(rail, /eventWorkflowSummaries\[item\.id\]/);
  assert.match(rail, /statusSummary\.materialCount/);
  assert.match(rail, /statusSummary\.pendingCount/);
  assert.doesNotMatch(rail, /displayItem\.assets|item\.assets|deriveGuidedDisplayStatus/);
  assert.match(page, /currentEventSummary\s*\? workflowEventDisplayStatus\(currentEventSummary\)/);
});

test("public uploads require a per-session safety acknowledgement", () => {
  assert.match(page, /公开共享演示空间/);
  assert.match(page, /只能使用公开、合成或已脱敏材料/);
  assert.match(page, /notique\.ui\.public-workspace-acknowledged/);
  assert.match(page, /requirePublicWorkspaceAcknowledgement/);
  assert.match(styles, /\.public-workspace-notice/);
});

test("completed analysis opens the summary and restores it after reading evidence", () => {
  assert.match(page, /setTranscriptFocusRequest\(\{ id: Date\.now\(\), eventId: targetEventId, tab: "summary" \}\)/);
  assert.match(page, /openClaimFromTranscriptSummary/);
  assert.match(page, /summaryReturnContext\.current/);
  assert.match(page, /restoreScrollY: context\.scrollY/);
  assert.match(page, /hasReadable \? "readable" : hasSummary \? "summary" : "raw"/);
  assert.match(page, /summaryRun\?\.status === "queued"/);
  assert.match(page, /readableRun\?\.status === "processing"/);
});

test("summary sources stay available in the action rail and artifact polling does not refetch raw transcript", () => {
  assert.match(page, /setSourceDrawer\(\{ sourceIds, summaryText, supportQuote, returnFocusId \}\)/);
  assert.match(page, /className="reader-action-rail"/);
  assert.match(page, /selectedSourceGroups/);
  assert.match(page, /className="source-drawer"/);
  assert.match(page, /在完整原稿中打开/);
  assert.match(page, /highlightExactPhrase\(group\.text, sourceDrawer\.supportQuote\)/);
  assert.match(page, /if \(quiet\)[\s\S]{0,500}eventArtifactsQuery/);
  assert.doesNotMatch(
    page.slice(page.indexOf("if (quiet)"), page.indexOf("let nextArtifactCount")),
    /eventTranscriptSegmentsQuery/,
  );
  assert.match(styles, /\.source-drawer \{/);
});

test("the continuous workspace preserves its local view and fails visibly at partial boundaries", () => {
  assert.match(page, /requestedWorkspaceView\.current = next/);
  assert.match(page, /localWorkspaceView \?\? "points"/);
  assert.match(page, /asset\.transform\?\.source_audio_asset_id/);
  assert.match(page, /audioAssetIdForVersion\(group\.assetVersionId\)/);
  assert.match(page, /const partialFailure = artifactResult\.status === "rejected"/);
  assert.match(page, /className="reader-partial-error"/);
  assert.match(page, /transcriptState === "error"/);
  assert.match(page, /if \(stayInWorkspace\) setEventIssue\(issue\)/);
});

test("the workspace nav is flat and a project-scope entry opens the record in one click", () => {
  assert.match(page, /aria-label="Transcript · 本次重点"/);
  assert.match(page, /aria-label="待核对"/);
  assert.match(page, /aria-label="结果"/);
  assert.doesNotMatch(page, /meeting-more-menu|meeting-more-trigger/, "the workspace nav must not hide entries behind a dropdown");
  assert.doesNotMatch(styles, /\.meeting-more-menu|\.meeting-more-trigger/);
  assert.match(page, /className="meeting-tabs-scope"/, "event scope and project scope stay visually separated");
  assert.match(styles, /\.meeting-tabs-project/);
  // The project entry navigates straight to the record; it must not render an
  // interstitial whose only content is another button.
  assert.match(page, /if \(next === "results" && !needsScenario && analysisDone\) \{ onResult\("client-progress"\); return; \}/);
  assert.match(page, /if \(next === "review" && workflowReviewReady\) \{ onReview\(\); return; \}/);
  assert.doesNotMatch(page, />打开项目概览</, "the dead interstitial button is replaced by direct navigation");
  assert.match(page, /className="reader-action-rail"/);
  assert.match(page, /连续核对 \{pendingReviewCount\} 条/);
  assert.match(styles, /\.reader-action-rail/);
  assert.match(page, /workspaceView === "points" && rawSegments\.length > 0 && <div className="summary-detail-entry"/);
  assert.match(page, /tab === "summary" && \(summaryArtifact \? <div className="summary-card-content"/);
  assert.match(page, /reviewReady && pendingReviewCount > 0/);
  assert.match(page, /reviewBlocked=\{false\}/);
});

test("a transcript without a Run explains auto-start and keeps one recovery action", () => {
  assert.match(page, /analysisRunning \? <div className="summary-card-loading"/);
  assert.match(page, /analysisComplete \? <div className="summary-card-message"/);
  assert.match(page, /系统通常会自动生成重点；如果本次没有启动，可以直接重新尝试/);
  assert.match(page, /重新启动分析/);
  assert.doesNotMatch(page, /开始分析并生成/);
  assert.match(page, /onStartAnalysis=\{onStartAnalysis\}/);
  assert.match(page, /analysisRunning=\{analysisRunning\}/);
  assert.match(page, /analysisComplete=\{analysisComplete\}/);
  assert.match(page, /details\.reason === "analysis_required"/);
});

test("failed reading artifacts fall back safely without exposing provider error codes", () => {
  assert.match(page, /AI 摘要未通过安全检查/);
  assert.match(page, /易读逐字稿未通过完整性检查/);
  assert.match(page, /事实识别和原始逐字稿都已保留/);
  const fallback = declarationSource("ArtifactFallback");
  assert.doesNotMatch(fallback, /run\.error_code/);
});

test("review empty states and completed workflow cards avoid duplicate primary actions", () => {
  assert.match(page, /workflowReviewReady && <button className="button primary"/);
  assert.match(page, /compactWorkflowCard/);
  assert.match(styles, /\.project-workflow-card\.compact/);
});

test("summary sections are named in the reader's language, not by model enum", () => {
  // The model returns a machine kind next to an English title; printing the
  // kind verbatim rendered "OVERVIEW" directly above "Overview".
  assert.doesNotMatch(page, /firstString\(section, \["kind"\]\)\?\.replaceAll/);
  assert.match(page, /summarySectionLabel\(firstString\(section, \["kind"\]\)\)/);
  for (const [kind, label] of [
    ["overview", "整体情况"],
    ["key_fact", "关键事实"],
    ["open_question", "待确认问题"],
    ["next_step", "下一步"],
  ]) {
    assert.equal(summarySectionLabel(kind), label);
  }
  assert.equal(summarySectionLabel("unknown_kind"), "", "an unmapped kind shows nothing rather than a raw enum");
});

test("evidence copy stays clear in both review and read-only modes", () => {
  assert.doesNotMatch(page, /\$\{typeLabel\(evidence\.role\)\}证据/);
  assert.match(page, /下面保留这条已确认记录的原句、前后文和来源/);
  assert.equal(typeLabel("other"), "其他重要信息");
  assert.equal(typeLabel("direct"), "直接证据");
});
