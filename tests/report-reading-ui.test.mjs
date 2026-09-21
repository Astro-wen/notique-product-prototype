import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { declarationSource, uiSource } from "./helpers/ui-source.mjs";
import { projectOverviewSections } from "../lib/domain/project-overview.ts";
import { summarySectionLabel, typeLabel } from "../lib/domain/labels.ts";

const page = uiSource;
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("the AI draft is read in the workspace, not on a page of its own", () => {
  // The draft page duplicated the summary and the rail's pending list; its
  // route now lands on the workspace with the same communication selected.
  assert.doesNotMatch(page, /AiDraftScreen/);
  assert.doesNotMatch(page, /screen === "draft"/);
  assert.match(page, /setTranscriptFocusRequest\(\{ id: Date\.now\(\), eventId: current\.event\.id, tab: "summary" \}\)/);
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

test("results use four general project entrances and keep other views accessible", () => {
  const primary = declarationSource("primaryResultTabs");
  assert.match(primary, /项目概览/);
  assert.match(primary, /时间线/);
  assert.match(primary, /下一步/);
  assert.match(primary, /下次准备/);
  assert.equal((primary.match(/\{ key: "/g) ?? []).length, 4);
  assert.match(page, /className="result-nav-secondary"/);
  assert.match(page, /更多视图/);
  assert.doesNotMatch(page, /result-nav-more|更多报告/);
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
    "行动相关记录",
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
  assert.match(page, /filter === "all" \? "核对并确认内容后，变化会出现在这里。" : "切到「全部」看其他已确认的节点"/);
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
  assert.match(page, /演示工作区/);
  assert.match(page, /请勿上传客户隐私/);
  assert.match(page, /只能使用公开、合成或已脱敏材料/);
  assert.match(page, /notique\.ui\.public-workspace-acknowledged/);
  assert.match(page, /requirePublicWorkspaceAcknowledgement/);
  assert.match(styles, /\.public-workspace-notice/);
});

test("the original transcript opens while explicit Summary evidence returns remain restorable", () => {
  assert.match(page, /setTranscriptFocusRequest\(\{ id: Date\.now\(\), eventId: targetEventId, tab: "summary" \}\)/);
  assert.match(page, /openClaimFromTranscriptSummary/);
  assert.match(page, /summaryReturnContext\.current/);
  assert.match(page, /restoreScrollY: context\.scrollY/);
  assert.match(page, /useState<TranscriptArtifactTab>\("raw"\)/);
  assert.match(page, /const fallbackTab: TranscriptArtifactTab = availableRawSegments.length > 0 \? "raw"/);
  assert.match(page, /summaryFirstNavigationKey\(project\.id, event\.id, "raw-ready"\)/);
  assert.match(page, /if \(readingTab \|\| transcriptFocusRequest\?\.eventId === event\.id\) return/);
  assert.match(page, /canonicalRawSegmentIds = new Set\(rawSegments\.map/);
  assert.match(page, /immediateRawSegments\.filter\(\(segment\) => !canonicalRawSegmentIds\.has\(segment\.id\)\)/);
  // Auto-opening the reader records a destination only when that destination
  // is the readable transcript. Recording raw — the only thing to show before
  // the readable pass lands — pinned the source text in the route for good,
  // so every later visit to that URL reopened the unpunctuated transcript.
  assert.match(page, /if \(readingAid === "readable"\) onFocusTranscriptArtifact\(event\.id, "readable"\);/);
  assert.doesNotMatch(page, /onFocusTranscriptArtifact\(event\.id, "raw"\)/);
  assert.doesNotMatch(page, /onFocusTranscriptArtifact\(event\.id, "summary"\)/);
});

test("summary sources stay available in the action rail and artifact polling does not refetch raw transcript", () => {
  assert.match(page, /className="reader-action-rail"/);
  assert.match(page, /selectedSourceGroups/);
  assert.match(page, /function selectTranscriptGroup/);
  assert.match(page, /className=\{`transcript-copy-button/);
  assert.match(page, /setWorkspaceView\("transcript"\)/);
  assert.match(page, /在逐字稿中定位/);
  assert.doesNotMatch(page, /setSourceDrawer|className="source-drawer"/);
  assert.match(page, /if \(quiet\)[\s\S]{0,500}eventArtifactsQuery/);
  assert.doesNotMatch(
    page.slice(page.indexOf("if (quiet)"), page.indexOf("let nextArtifactCount")),
    /eventTranscriptSegmentsQuery/,
  );
  assert.match(styles, /\.transcript-copy-button \{/);
});

test("the continuous workspace preserves its local view and fails visibly at partial boundaries", () => {
  assert.match(page, /requestedWorkspaceView\.current = null/);
  assert.match(page, /localWorkspaceView \?\? "chapters"/);
  assert.match(page, /const insightView:[\s\S]{0,120}workspaceView === "transcript" \? "chapters" : workspaceView/);
  assert.ok(
    page.indexOf('className="reader-intelligence-heading"') < page.indexOf('id="transcript-document"'),
    "the intelligent overview must precede the transcript in the same reading document",
  );
  assert.match(page, /asset\.transform\?\.source_audio_asset_id/);
  assert.match(page, /audioAssetIdForVersion\(group\.assetVersionId\)/);
  assert.match(page, /const partialFailure = artifactResult\.status === "rejected"/);
  assert.match(page, /className="reader-partial-error"/);
  assert.match(page, /transcriptState === "error"/);
  assert.match(page, /if \(stayInWorkspace\) setEventIssue\(issue\)/);
});

test("a new artifact or transcript revision invalidates stale rail actions and playback", () => {
  assert.match(page, /const sourceSelectionRevision = \[/);
  assert.match(page, /const summarySelectionRevision = \[/);
  assert.match(page, /const readableSelectionRevision = \[/);
  assert.match(page, /analysisRun\?\.id/);
  assert.match(page, /summaryArtifact\?\.id/);
  assert.match(page, /readableArtifact\?\.id/);
  assert.match(page, /selectedPointSelection && selectedPointSelection\.revision === revisionForPoint/);
  assert.match(page, /sourceSelection\?\.revision === sourceSelectionRevision/);
  assert.match(page, /setSelectedPointSelection\(null\)/);
  assert.match(page, /setSourceSelection\(null\)/);
  assert.match(page, /pendingPlaybackTarget\.current = null/);
  assert.match(page, /actionComposerRevision === selectedPointRevision/);
});

test("the workspace nav is flat and a project-scope entry opens the record in one click", () => {
  assert.match(page, /aria-label="本次重点"/);
  assert.match(page, /aria-label="材料"/);
  assert.match(page, /aria-label="整个项目"/);
  // 待确认 lives only in the action rail. The old top-bar entry opened the
  // same reading page and merely pre-selected the rail's own sub-tab.
  assert.doesNotMatch(page, /aria-label="待确认"/);
  assert.doesNotMatch(page, /meeting-more-menu|meeting-more-trigger/, "the workspace nav must not hide entries behind a dropdown");
  assert.doesNotMatch(styles, /\.meeting-more-menu|\.meeting-more-trigger/);
  assert.match(page, /className="meeting-tabs-scope"/, "event scope and project scope stay visually separated");
  assert.match(styles, /\.meeting-tabs-project/);
  // The project entry navigates straight to the record; it must not render an
  // interstitial whose only content is another button.
  assert.match(page, /if \(next === "results" && !needsScenario && analysisDone\) \{ onResult\("client-progress"\); return; \}/);
  assert.match(page, /if \(\(next === "transcript" \|\| next === "review"\) && event\)/);
  assert.doesNotMatch(page, />打开项目概览</, "the dead interstitial button is replaced by direct navigation");
  assert.match(page, /className="reader-action-rail"/);
  assert.match(page, /reviewMode=\{activeTab === "review"\}/);
  assert.match(page, /setActionView\("pending"\)/);
  assert.match(page, /从第一条开始确认/);
  assert.match(styles, /\.reader-action-rail/);
  assert.match(page, /className="reader-intelligence-heading"/);
  assert.match(page, /insightView === "points" && <section className="tingwu-keypoints"/);
  assert.match(page, /<header className="transcript-document-toolbar" id="transcript-document">/);
  assert.doesNotMatch(page, /summary-detail-entry/, "the summary must sit above the transcript instead of opening a second framed detail view");
  assert.match(page, /reviewReady && visiblePendingReviewCount > 0/);
  assert.match(page, /pendingOccurrences\.map/);
  assert.doesNotMatch(page, /pendingClaims\.slice\(0, 10\)/, "the rail must not silently hide review items");
  assert.match(page, /reviewBlocked=\{false\}/);
});

test("missing reading summaries offer generation while raw remains readable", () => {
  assert.match(page, /生成阅读总结/);
  assert.match(page, /className="artifact-panel raw-artifact"/);
  assert.match(page, /summaryRun\?\.status === "processing"/);
  assert.match(page, /details\.reason === "analysis_required"/);
});

test("review empty states and completed workflow cards avoid duplicate primary actions", () => {
  assert.match(page, /reviewReady && visiblePendingReviewCount > 0 && <button className="button primary full"/);
  assert.match(page, /compactWorkflowCard/);
  assert.match(styles, /\.project-workflow-card\.compact/);
});

test("summary sections are named in the reader's language, not by model enum", () => {
  // The model returns a machine kind next to an English title; printing the
  // kind verbatim rendered "OVERVIEW" directly above "Overview".
  assert.doesNotMatch(page, /firstString\(section, \["kind"\]\)\?\.replaceAll/);
  for (const [kind, label] of [
    ["overview", "全文概要"],
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
  assert.equal(typeLabel("measurement"), "尺寸与数量");
  assert.equal(typeLabel("unknown_model_enum"), "其他信息");
});
