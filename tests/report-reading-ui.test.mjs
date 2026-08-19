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
  assert.match(page, /visibleSource\.slice\(0, 3\)/);
  assert.doesNotMatch(page, /index === 0 && moments\.length > 3/);
  assert.match(page, /decisionPeople/);
  assert.match(page, /firstSeen/);
  assert.match(page, /lastSeen/);
  assert.match(page, /recordArray\(item\.history\)/);
});

test("results use four buyer-journey entrances and move specialist reports behind more", () => {
  const primary = page.slice(page.indexOf("const primaryResultTabs"), page.indexOf("const secondaryResultTabs"));
  assert.match(primary, /客户概览/);
  assert.match(primary, /时间线/);
  assert.match(primary, /下一步/);
  assert.match(primary, /会前准备/);
  assert.equal((primary.match(/\{ key: "/g) ?? []).length, 4);
  assert.match(page, /className="result-nav-more"/);
  assert.match(page, /更多报告/);
  assert.match(page, /buyerOverviewSections/);
  assert.match(page, /预算与融资/);
  assert.match(page, /已看房源与反馈/);
});

test("action and timeline empty states offer useful next steps", () => {
  assert.match(page, /查看 AI 建议/);
  assert.match(page, /从原文补充行动/);
  assert.match(page, /setMissingClaimDefaultType\("next_action"\)/);
  assert.match(page, /const timelineFilters/);
  assert.match(page, /预算.*偏好.*房源.*行动.*发生变化/s);
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
  assert.match(page, /公开共享测试空间/);
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

test("a transcript without an analysis offers one valid start action instead of broken artifact retries", () => {
  assert.match(page, /analysisRunning \? <div className="summary-card-loading"/);
  assert.match(page, /analysisComplete \? <div className="summary-card-message"/);
  assert.match(page, /开始本次分析后，AI 摘要、易读逐字稿和事实识别会一起生成/);
  assert.match(page, /开始分析并生成/);
  assert.match(page, /onStartAnalysis=\{onStartAnalysis\}/);
  assert.match(page, /analysisRunning=\{analysisRunning\}/);
  assert.match(page, /analysisComplete=\{analysisComplete\}/);
  assert.match(page, /details\.reason === "analysis_required"/);
});

test("failed reading artifacts fall back safely without exposing provider error codes", () => {
  assert.match(page, /AI 摘要未通过安全检查/);
  assert.match(page, /易读逐字稿未通过完整性检查/);
  assert.match(page, /事实识别和原始逐字稿都已保留/);
  const fallback = page.slice(page.indexOf("function ArtifactFallback"), page.indexOf("function AudioTranscriptionProgressPanel"));
  assert.doesNotMatch(fallback, /run\.error_code/);
});

test("review empty states and completed workflow cards avoid duplicate primary actions", () => {
  assert.match(page, /workflowReviewReady && <button className="button primary"/);
  assert.match(page, /compactWorkflowCard/);
  assert.match(styles, /\.project-workflow-card\.compact/);
});

test("evidence copy stays clear in both review and read-only modes", () => {
  assert.doesNotMatch(page, /\$\{typeLabel\(evidence\.role\)\}证据/);
  assert.match(page, /下面保留这条已确认记录的原句、前后文和来源/);
  assert.match(page, /other: "其他重要信息"/);
});
