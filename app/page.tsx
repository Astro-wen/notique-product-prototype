"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DropdownMenu } from "radix-ui";
import {
  isHeifLike,
  MAX_IMAGE_BYTES,
  MODEL_IMAGE_FILE_ACCEPT,
  MODEL_IMAGE_MIME_TYPES,
  modelImageMimeFor,
  normalizeMimeType,
} from "@/lib/domain/asset-policy";
import {
  AUDIO_FILE_ACCEPT,
  MAX_AUDIO_BYTES,
  audioMimeFor,
} from "@/lib/domain/audio-transcription";
import { shouldChunkAudio } from "@/lib/domain/audio-chunking";
import { mapWithConcurrency } from "@/lib/domain/bounded-parallel";
import {
  audioChunkPlan,
  inspectAudioDurationMs,
  prepareAudioChunk,
} from "@/app/audio-chunking";
import { resolveSimpleImportTarget } from "@/lib/domain/simple-import-target";
import {
  type ProjectWorkflowPlan,
} from "@/lib/domain/project-workflow";
import {
  chooseRememberedSelection,
  deriveGuidedDisplayStatus,
  nextPendingClaimId,
} from "@/lib/domain/guided-workflow";
import { ACTIVE_BACKGROUND_WAKE_MS, buildRunTimingItems, runNeedsRecovery, runPollDelayMs, runTotalDurationMs } from "@/lib/domain/run-timing";
import { buildAnalysisProgress, type AnalysisProgress } from "@/lib/domain/analysis-progress";
import {
  factsReadyForReview,
  factsStillRunning,
  matchingSummarySourceIndexes,
  preferredReadingAid,
  shouldAutoFocusSummary,
  type ReadingAidTarget,
} from "@/lib/domain/summary-first-workflow";
import { buildAiDraftSummary, sortClaimsForReview } from "@/lib/domain/ai-draft";
import { highlightExactPhrase } from "@/lib/domain/text-highlight";
import { displaySpeakerLabel } from "@/lib/domain/speaker-label";
import { buildChunkProgress } from "@/lib/domain/transcription-progress";
import { autoAnalysisDecision } from "@/lib/domain/auto-analysis";
import { formatTimestamp } from "@/lib/domain/display-format";
import { typeLabel } from "@/lib/domain/labels";
import { ViewItem } from "@/app/components/view-item";
import { ProjectOverviewList } from "@/app/components/project-overview-list";
import { Modal } from "@/app/components/modal";
import { TranscriptViewer } from "@/app/components/transcript-viewer";
import { firstString, isRecord, stringValue } from "@/lib/domain/claim-fields";
import { formatDate, projectSelectionLabel } from "@/lib/domain/project-label";
import {
  backLabelForRoute,
  fallbackBackRoute,
  isCoreWorkflowRoute,
  isReadonlyClaimRoute,
  normalizeAppRoute,
  parseAppRoute,
  requestOwnerIsCurrent,
  routeForView,
  serializeAppRoute,
  type AppReadingTab,
  type AppRoute,
  type AppRouteOrigin,
  type AppView,
  type RequestOwner,
} from "@/lib/domain/app-navigation";
import {
  ApiClientError,
  AiDraftAssessment,
  ApiIssue,
  Claim,
  ClaimEditSubmission,
  Event,
  EventAiArtifact,
  EventAiArtifactRun,
  EvidenceContext,
  EvidenceRef,
  ExtractionRun,
  GlossaryEntry,
  GlossaryEntryCategory,
  ImportSession,
  OccurrenceCandidate,
  OccurrenceNewClaim,
  Project,
  ProjectDeletePreview,
  ProjectViewName,
  RelationTarget,
  RelationType,
  ReviewSession,
  RunDebug,
  TranscriptionRun,
  TranscriptSegment,
  WorkflowEventSummary,
  WorkflowSnapshot,
  api,
  normalizeClaim,
  toIssue,
} from "./api-client";
import { DirectRecorder } from "./direct-recorder";
import {
  claimHistoryQuery,
  draftMemoryQuery,
  evidenceContextQuery,
  evidenceQuery,
  eventArtifactsQuery,
  eventTranscriptSegmentsQuery,
  notiqueQueryKeys,
  projectActionsQuery,
  verifiedViewQuery,
  workflowSnapshotQuery,
} from "./notique-queries";
import {
  buildReadableWordDiff,
  mappedRawParagraph,
  type ReadableDiffRisk,
  type ReadableWordDiffResult,
} from "./readable-transcript-diff";
import { selectTranscriptArtifactPair } from "./transcript-artifact-selection";
import { activeTranscriptGroupKeyAt, groupConsecutiveSpeakerSegments, groupReadableTranscriptSegments } from "./transcript-display";

type Screen = AppView;
type AsyncState = "idle" | "loading" | "ready" | "empty" | "error";
type ResultTab = ProjectViewName;

type AudioPreparationProgress = {
  audioAssetId: string;
  eventId: string;
  filename: string;
  stage: "inspecting" | "preparing" | "starting";
  total: number;
  completed: number;
  chunks: Array<{
    index: number;
    status: "queued" | "processing" | "succeeded" | "failed";
    fraction: number;
  }>;
};

type ContradictionResolutionInput = {
  relationId: string;
  sourceClaimVersionId: string;
  targetClaimVersionId: string;
  winningClaimVersionId: string;
  explanation: string;
};

type ManualRelationSubmission = {
  type: RelationType;
  target: RelationTarget;
  reason: string;
};

type BriefDisplayData = Record<string, unknown> & {
  stateItem?: Record<string, unknown>;
  deltaItems?: Record<string, unknown>[];
  agendaItems?: Record<string, unknown>[];
  riskItem?: Record<string, unknown>;
};

type ImportRow = {
  key: string;
  file: File;
  title: string;
  occurredAt: string;
  eventType: "meeting" | "showing" | "estimate" | "walkthrough";
};

type ProjectWorkflowState = Omit<ProjectWorkflowPlan, "phase"> & {
  phase: ProjectWorkflowPlan["phase"] | "idle" | "loading" | "error";
  issue?: ApiIssue;
};

type ProjectWorkflowSnapshot = {
  project: Project;
  events: Event[];
  eventSummaries: Record<string, WorkflowEventSummary>;
  details: Array<{ event: Event; run: ExtractionRun | null; candidateCount?: number }>;
  plan: ProjectWorkflowPlan;
};

type ReviewQueueSnapshot = {
  project: Project;
  claims: Claim[];
  occurrenceCandidates: OccurrenceCandidate[];
};

type ReviewSummaryDestination = {
  complete: boolean;
  nextEventId?: string;
};

type TranscriptArtifactTab = AppReadingTab;

type TranscriptFocusRequest = {
  id: number;
  eventId: string;
  tab: TranscriptArtifactTab;
  restoreScrollY?: number;
};

type SummarySourceDrawerState = {
  sourceIds: string[];
  summaryText: string;
  supportQuote: string;
  returnFocusId: string;
};

type ReadableDiffViewState =
  | { status: "loading" }
  | ReadableWordDiffResult
  | { status: "fallback"; reason: "mapping_incomplete" };

const primaryResultTabs: Array<{ key: ResultTab; label: string; short: string }> = [
  { key: "client-progress", label: "项目概览", short: "概览" },
  { key: "timeline", label: "时间线", short: "时间线" },
  { key: "actions", label: "下一步", short: "行动" },
  { key: "brief-card", label: "会前准备", short: "会前" },
];

const secondaryResultTabs: Array<{ key: ResultTab; label: string; short: string }> = [
  { key: "folder-summary", label: "事项概况", short: "概况" },
  { key: "decisions", label: "决定", short: "决定" },
  { key: "preferences", label: "偏好", short: "偏好" },
  { key: "open-questions", label: "待确认问题", short: "问题" },
  { key: "risks", label: "风险与矛盾", short: "风险" },
  { key: "gap-check", label: "资料缺口", short: "缺口" },
  { key: "next-meeting-agenda", label: "下次沟通清单", short: "清单" },
];

const resultTabs = [...primaryResultTabs, ...secondaryResultTabs];

const runInProgress = new Set(["queued", "processing", "extracting"]);
const runComplete = new Set(["succeeded", "completed", "completed_with_warnings"]);
const acceptedTranscriptTypes = [".txt", ".vtt", ".srt", ".json"];
const recentProjectStorageKey = "notique.ui.recent-project-id";
const workflowIntentStorageKey = "notique.ui.workflow-intent-project-id";
const sidebarCollapsedStorageKey = "notique.ui.sidebar-collapsed";
const publicWorkspaceAcknowledgementKey = "notique.ui.public-workspace-acknowledged";

type AutoAnalysisIntent = {
  eventId: string;
  waitForAudioAssetIds: string[];
  armedAt: number;
  idempotencyKey: string;
  extractionFingerprint?: string;
  baseRunId?: string;
};

function autoAnalysisIntentKey(eventId: string): string {
  return `notique.ui.auto-analysis:${eventId}`;
}

function readAutoAnalysisIntent(eventId: string): AutoAnalysisIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(autoAnalysisIntentKey(eventId)) || "null") as unknown;
    if (
      !isRecord(value)
      || value.eventId !== eventId
      || !Array.isArray(value.waitForAudioAssetIds)
      || typeof value.idempotencyKey !== "string"
      || !value.idempotencyKey
    ) return null;
    return {
      eventId,
      waitForAudioAssetIds: value.waitForAudioAssetIds.filter((id): id is string => typeof id === "string" && Boolean(id)),
      armedAt: typeof value.armedAt === "number" ? value.armedAt : Date.now(),
      idempotencyKey: value.idempotencyKey,
      ...(typeof value.extractionFingerprint === "string"
        ? { extractionFingerprint: value.extractionFingerprint }
        : {}),
      ...(typeof value.baseRunId === "string" ? { baseRunId: value.baseRunId } : {}),
    };
  } catch {
    return null;
  }
}

function storeAutoAnalysisIntent(intent: AutoAnalysisIntent): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(autoAnalysisIntentKey(intent.eventId), JSON.stringify(intent));
    return true;
  } catch {
    // Same-tab automation is an enhancement. Server Runs and their
    // idempotency/concurrency guards remain authoritative. The caller is told
    // so it can promise manual recovery instead of an automatic start that a
    // browser with storage disabled will never perform.
    return false;
  }
}

function clearStoredAutoAnalysisIntent(eventId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(autoAnalysisIntentKey(eventId));
  } catch {
    // A blocked storage API must not affect the analysis Run itself.
  }
}

function recentEventStorageKey(projectId: string): string {
  return `notique.ui.recent-event-id:${projectId}`;
}

function readStoredId(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeId(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Navigation preferences are optional. Server data remains authoritative.
  }
}

function publicWorkspaceAcknowledged(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(publicWorkspaceAcknowledgementKey) === "1";
  } catch {
    return false;
  }
}

function rememberPublicWorkspaceAcknowledgement(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(publicWorkspaceAcknowledgementKey, "1");
  } catch {
    // A blocked storage API should not hide the warning. The current page can
    // still continue after the user explicitly confirms the modal.
  }
}

function summaryFirstNavigationKey(projectId: string, eventId: string, runId: string): string {
  return `notique.ui.summary-first:${projectId}:${eventId}:${runId}`;
}

function readSummaryFirstNavigationMark(key: string): "auto" | "user" | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(key);
    return value === "auto" || value === "user" ? value : null;
  } catch {
    return null;
  }
}

function storeSummaryFirstNavigationMark(key: string, value: "auto" | "user"): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // This is only a same-tab navigation guard. Server workflow state remains
    // authoritative if storage is unavailable.
  }
}

function formatReviewDuration(value: number): string {
  if (value > 0 && value < 1000) return `${Math.max(1, Math.round(value))} 毫秒`;
  const totalSeconds = Math.max(0, Math.floor(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds.toString().padStart(2, "0")} 秒` : `${seconds} 秒`;
}

function formatBytes(value?: number): string {
  if (value == null) return "大小未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function photoUploadIssue(
  filename: string,
  mimeType: string,
  sizeBytes: number,
): ApiIssue | null {
  const normalizedMime = normalizeMimeType(mimeType);
  const imageMime = modelImageMimeFor(filename, normalizedMime);
  const looksLikePhoto =
    normalizedMime.startsWith("image/") ||
    /\.(?:jpe?g|png|webp|heic|heif|hif)$/i.test(filename);
  if (!looksLikePhoto) return null;
  if (isHeifLike(filename, normalizedMime) || !imageMime) {
    return {
      code: "ASSET_UNSUPPORTED_FORMAT",
      message: "照片只支持 JPG、PNG 或 WebP。当前测试版不会转换 HEIC/HEIF。",
      status: 415,
      details: {
        kind: "photo",
        filename,
        mime_type: normalizedMime,
        accepted_mime_types: [...MODEL_IMAGE_MIME_TYPES],
      },
    };
  }
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return {
      code: "ASSET_TOO_LARGE",
      message: "单张照片超过 15 MB，尚未上传。",
      status: 413,
      details: {
        kind: "photo",
        filename,
        max_size_bytes: MAX_IMAGE_BYTES,
        size_bytes: sizeBytes,
      },
    };
  }
  return null;
}

function audioUploadIssue(filename: string, mimeType: string, sizeBytes: number): ApiIssue | null {
  const normalizedMime = normalizeMimeType(mimeType);
  const looksLikeAudio = normalizedMime.startsWith("audio/") || normalizedMime === "video/mp4" ||
    /\.(?:mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(filename);
  if (!looksLikeAudio) return null;
  const acceptedMime = audioMimeFor(filename, normalizedMime);
  if (!acceptedMime) {
    return {
      code: "ASSET_UNSUPPORTED_FORMAT",
      message: "录音支持 MP3、M4A、WAV、WebM、MP4、MPEG 或 MPGA。",
      status: 415,
      details: { kind: "audio", filename, mime_type: normalizedMime },
    };
  }
  if (sizeBytes > MAX_AUDIO_BYTES) {
    return {
      code: "ASSET_TOO_LARGE",
      message: "录音超过 100 MB，尚未上传。",
      status: 413,
      details: { kind: "audio", filename, size_bytes: sizeBytes, max_size_bytes: MAX_AUDIO_BYTES },
    };
  }
  return null;
}

function transcriptionRunIdsFromEvent(value: Event): Array<{ audioAssetId: string; runId: string }> {
  const runs: Array<{ audioAssetId: string; runId: string }> = [];
  for (const asset of value.assets) {
    if (asset.kind !== "audio") continue;
    if (asset.metadata.transcription_chunk === true) continue;
    const runId = stringValue(asset.metadata.transcription_run_id);
    if (runId) runs.push({ audioAssetId: asset.id, runId });
  }
  return runs;
}

function assetIsAnalyzable(asset: Event["assets"][number]): boolean {
  return asset.status === "ready" &&
    Boolean(asset.versionId) &&
    asset.kind !== "audio" &&
    asset.metadata.analysis_source !== false &&
    asset.metadata.artifact_kind !== "readable_transcript";
}

function assetIsGeneratedAiArtifact(asset: Event["assets"][number]): boolean {
  return asset.metadata.artifact_kind === "readable_transcript"
    || asset.metadata.analysis_source === false
    || asset.metadata.transcription_chunk === true;
}

const idleProjectWorkflow: ProjectWorkflowState = {
  phase: "idle",
  total: 0,
  completed: 0,
  currentPosition: 0,
  ignoredEmptyCount: 0,
  pendingTotal: 0,
  trustState: "trusted",
};

function workflowEventDisplayStatus(summary?: WorkflowEventSummary): {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "active";
} {
  if (!summary) return { label: "正在读取状态", tone: "neutral" };
  const labels: Record<WorkflowEventSummary["display_status"], string> = {
    waiting_material: "等待材料",
    transcribing: "正在转写",
    ready: "可以分析",
    queued: "正在启动分析",
    inventory: "正在识别事实",
    verify: "正在查漏纠错",
    verify_escalated: "需要加强复核",
    waiting_scenario: "等待场景确认",
    waiting_review: "等待人工核对",
    complete: "已完成",
    needs_attention: "需要处理",
  };
  const tones: Record<WorkflowEventSummary["display_status"], "neutral" | "success" | "warning" | "danger" | "active"> = {
    waiting_material: "neutral",
    transcribing: "active",
    ready: "success",
    queued: "neutral",
    inventory: "active",
    verify: "active",
    verify_escalated: "warning",
    waiting_scenario: "warning",
    waiting_review: "warning",
    complete: "success",
    needs_attention: "danger",
  };
  return { label: labels[summary.display_status], tone: tones[summary.display_status] };
}

async function inspectProjectWorkflow(
  projectId: string,
  loadWorkflowSnapshot: (id: string) => Promise<WorkflowSnapshot> = (id) => api.getWorkflowSnapshot(id),
): Promise<ProjectWorkflowSnapshot> {
  const [snapshot, latestEvents] = await Promise.all([
    loadWorkflowSnapshot(projectId),
    api.listEvents(projectId),
  ]);
  const workflow = snapshot.workflow;
  const summary = workflow.current_event_id
    ? snapshot.events.find((item) => item.id === workflow.current_event_id)
    : undefined;
  const currentEvent = workflow.current_event_id
    ? await api.getEvent(workflow.current_event_id)
    : null;
  const currentRun: ExtractionRun | null = summary?.extraction
    ? {
        id: summary.extraction.run_id,
        eventId: summary.id,
        status: summary.extraction.status,
        pipelineStage: summary.extraction.stage ?? undefined,
        errorCode: summary.extraction.error_code ?? undefined,
        processingAttemptNo: summary.extraction.processing_attempt_no,
        dispatchAttemptNo: summary.extraction.dispatch_attempt_no,
        createdAt: summary.extraction.created_at,
        queuedAt: summary.extraction.queued_at ?? undefined,
        firstQueuedAt: summary.extraction.first_queued_at ?? undefined,
        currentQueuedAt: summary.extraction.current_queued_at ?? undefined,
        startedAt: summary.extraction.started_at ?? undefined,
        firstStartedAt: summary.extraction.first_started_at ?? undefined,
        currentStartedAt: summary.extraction.current_started_at ?? undefined,
        finishedAt: summary.extraction.finished_at ?? undefined,
        updatedAt: summary.extraction.updated_at,
        stages: [],
      }
    : null;
  const details = currentEvent
    ? [{ event: currentEvent, run: currentRun, candidateCount: summary?.candidate_count }]
    : [];
  const eventSummaries = Object.fromEntries(
    snapshot.events.map((item) => [item.id, item]),
  );
  const plan: ProjectWorkflowPlan = {
    phase: workflow.phase,
    total: workflow.total,
    completed: workflow.completed,
    currentPosition: workflow.current_position,
    ...(workflow.current_event_id ? { currentEventId: workflow.current_event_id } : {}),
    ...(currentEvent?.title ? { currentEventTitle: currentEvent.title } : {}),
    ...(workflow.current_run_id ? { currentRunId: workflow.current_run_id } : {}),
    ignoredEmptyCount: Math.max(0, latestEvents.length - workflow.total),
    pendingTotal: workflow.pending_total,
    trustState: workflow.trust_state,
  };
  return { project: snapshot.project, events: latestEvents, eventSummaries, details, plan };
}

function confidenceText(value?: number): string {
  if (value == null) return "AI 未提供置信度";
  const normalized = value <= 1 ? value * 100 : value;
  return `AI 置信度 ${Math.round(normalized)}%`;
}

function isCompleteEvidenceSet(
  expectedIds: string[],
  evidenceRefs: EvidenceRef[],
  everyFetchSucceeded: boolean,
): boolean {
  if (!everyFetchSucceeded || expectedIds.length === 0 || evidenceRefs.length !== expectedIds.length) {
    return false;
  }
  const expected = new Set(expectedIds);
  const received = new Set(evidenceRefs.map((item) => item.id));
  return expected.size === expectedIds.length &&
    received.size === evidenceRefs.length &&
    expectedIds.every((id) => received.has(id));
}

function uncertaintyParts(value: unknown): {
  reason?: string;
  alternatives: string[];
  question?: string;
} | null {
  if (typeof value === "string" && value.trim()) {
    return { reason: value.trim(), alternatives: [] };
  }
  if (!isRecord(value)) return null;
  const reason = stringValue(value.reason);
  const question = stringValue(value.question);
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.flatMap((item) => {
        const text = stringValue(item);
        return text ? [text] : [];
      })
    : [];
  if (!reason && !question && !alternatives.length) return null;
  return { reason, alternatives, question };
}

function UncertaintyNotice({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const details = uncertaintyParts(value);
  if (!details) return null;
  if (compact) {
    const summary = details.question || details.reason || details.alternatives.join(" / ");
    return <p className="uncertainty">需要留意：{summary}</p>;
  }
  return <div className="uncertainty">
    <strong>这条记录还需要确认</strong>
    {details.reason && <p>{details.reason}</p>}
    {details.alternatives.length > 0 && <p>目前有两种可能：{details.alternatives.join(" / ")}</p>}
    {details.question && <p><b>建议追问：</b>{details.question}</p>}
  </div>;
}

function EvidenceRequirementNotice({ claim, compact = false }: { claim: Claim; compact?: boolean }) {
  if (!claim.needsAdditionalEvidence || uncertaintyForEdit(claim.uncertainty)) return null;
  return <p className="uncertainty">{compact ? "仍需补充证据" : "这条记录仍需补充证据，确认前请检查现有材料是否足够。"}</p>;
}

function statusLabel(value?: string): string {
  const labels: Record<string, string> = {
    draft: "等待材料",
    ready: "材料已就绪",
    uploading: "正在上传",
    parsing: "正在读取",
    queued: "正在启动分析",
    processing: "正在提取",
    extracting: "正在提取",
    succeeded: "处理完成",
    completed: "处理完成",
    completed_with_warnings: "完成，有部分提醒",
    failed: "处理失败",
    cancelled: "已取消",
    pending: "待审核",
    verified: "已确认",
    rejected: "未采纳",
    active: "当前有效",
    withdrawn: "已撤回",
    superseded: "已被更新",
    resolved: "已解决",
    ai_suggested: "AI 建议",
    not_adopted: "不采纳",
    unassessed: "等待判断使用场景",
    assessing: "正在判断使用场景",
    pending_confirmation: "等待确认使用场景",
    confirmed: "使用场景已确认",
  };
  return labels[(value ?? "").toLowerCase()] ?? value ?? "状态未知";
}

function extractionProgressLabel(run?: ExtractionRun | null): string {
  if (!run || !runInProgress.has(run.status)) return statusLabel(run?.status);
  if (run.status === "queued") return "正在启动分析";
  if (run.pipelineStage === "inventory") return "正在识别事实";
  if (run.pipelineStage === "verify") return "正在查漏纠错";
  if (run.pipelineStage === "verify_escalated") return "正在加强复核";
  return "正在准备分析";
}

function extractionProgressBody(run?: ExtractionRun | null): string {
  if (run?.status === "queued") return "同一个任务正在等待后台领取；页面会继续检查，不会重复创建或重复收费。";
  if (run?.pipelineStage === "inventory") return "第一轮正在逐条盘点原子事实和证据，不会直接写入正式结果。";
  if (run?.pipelineStage === "verify") return "第二轮正在检查遗漏、重复、原子性和跨沟通关系。";
  if (run?.pipelineStage === "verify_escalated") return "确定性质量门发现风险，正在用更强推理重新复核。";
  return "任务已经进入后台，页面会继续读取真实状态，不会重复提交。";
}

function issueTitle(issue: ApiIssue): string {
  if (issue.code === "EXTRACTION_POLL_TIMEOUT" || issue.code === "TRANSCRIPTION_POLL_TIMEOUT") return "仍在后台运行";
  if (issue.code === "MODEL_PROVIDER_NOT_CONFIGURED") return "模型服务尚未配置";
  if (issue.code === "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED") return "录音转写服务尚未配置";
  if (issue.code === "TRANSCRIPTION_TIMEOUT") return "录音转写超时";
  if (issue.code === "TRANSCRIPTION_OUTPUT_INVALID") return "转写结果无法使用";
  if (issue.code === "QUEUE_NOT_CONFIGURED") return "处理队列尚未配置";
  if (issue.code === "DATABASE_UNAVAILABLE") return "数据库暂时不可用";
  if (issue.code === "SCENARIO_CONFIRMATION_REQUIRED") return "请先确认使用场景";
  if (issue.status === 404) return "没有找到这项数据";
  if (issue.status === 503 || issue.status === 0) return "暂时无法连接服务";
  if (issue.status >= 500) return "服务器暂时无法完成请求";
  return "这一步没有完成";
}

function issueMessage(issue: ApiIssue): string {
  if (issue.code === "EXTRACTION_POLL_TIMEOUT") return "页面暂时停止等待，但原来的事实识别任务仍由服务器保存。重新检查只会读取同一个任务，不会重复付费。";
  if (issue.code === "TRANSCRIPTION_POLL_TIMEOUT") return "页面暂时停止等待，但录音和原来的转写任务仍然保留。重新检查不会重复上传录音。";
  if (issue.code === "RUN_BUDGET_EXCEEDED") {
    return "这次材料超过当前单次分析上限。本次分析没有启动，请减少材料后重试。";
  }
  if (issue.code === "MODEL_PROVIDER_NOT_CONFIGURED") return "服务端还没有配置模型 Provider 和 API Key。本次没有生成任何候选记录，配置完成后可以安全重试。";
  if (issue.code === "TRANSCRIPTION_PROVIDER_NOT_CONFIGURED") return "录音已经安全保存，但服务端还没有配置 OpenAI 转写模型。本次没有生成逐字稿，配置完成后可以重新提交。";
  if (issue.code === "TRANSCRIPTION_TIMEOUT") return "录音已经保存，但本次转写在时限内没有完成。可以安全重试，不需要重新上传。";
  if (issue.code === "TRANSCRIPTION_OUTPUT_INVALID") return "模型返回的逐字稿缺少可核对的说话人或时间点，系统没有把它写进正式材料。";
  if (issue.code === "REVIEW_SESSION_CONFLICT") return "审核内容发生了变化，系统没有写入错误的计时结果。请刷新审核区后继续。";
  if (issue.code === "AUDIO_TRANSCRIPTION_FAILED") return "录音已经保存，但转写没有完成。请保留 Request ID，稍后重新提交转写。";
  if (issue.code === "QUEUE_NOT_CONFIGURED") return "后台处理队列还没有配置。本次任务没有开始，也没有写入半成品。";
  if (issue.code === "DATABASE_UNAVAILABLE") return "当前无法读取数据库中的真实记录，请稍后重试。";
  if (issue.code === "SCENARIO_CONFIRMATION_REQUIRED") return "第一份材料的使用场景还没有确认。确认后，后续沟通才会开始提取。";
  if (issue.code === "CLAIM_VERSION_CONFLICT" || issue.code === "SCENARIO_VERSION_CONFLICT") return "这项内容已经被其他操作更新。重新读取最新版本后再继续。";
  if (issue.code === "ASSET_TOO_LARGE") {
    const details = isRecord(issue.details) ? issue.details : {};
    const total = typeof details.total_image_bytes === "number" ? details.total_image_bytes : undefined;
    const maxTotal = typeof details.max_total_image_bytes === "number" ? details.max_total_image_bytes : undefined;
    const size = typeof details.size_bytes === "number" ? details.size_bytes : undefined;
    const max = typeof details.max_size_bytes === "number" ? details.max_size_bytes : undefined;
    if (maxTotal !== undefined) {
      return `本次分析的图片合计 ${formatBytes(total)}，超过 ${formatBytes(maxTotal)} 的上限。请减少图片或压缩后重试。`;
    }
    if (max !== undefined) {
      return `这份文件为 ${formatBytes(size)}，超过 ${formatBytes(max)} 的单文件上限，尚未上传。`;
    }
    return "文件超过当前允许的大小。页面没有上传或保存这份文件。";
  }
  if (issue.code === "ASSET_UNSUPPORTED_FORMAT") {
    const details = isRecord(issue.details) ? issue.details : {};
    if (details.kind === "audio") {
      return "录音支持 MP3、M4A、WAV、WebM、MP4、MPEG 或 MPGA。页面没有上传这份不支持的文件。";
    }
    if (details.kind === "photo") {
      return "照片只支持 JPG、PNG 或 WebP。当前测试版不会转换 HEIC/HEIF，请先在手机或电脑上转成支持的格式。";
    }
    return "当前文件格式暂不支持。页面没有上传或保存这份文件。";
  }
  if (issue.code === "EVENT_NOT_READY") {
    const details = isRecord(issue.details) ? issue.details : {};
    if (details.reason === "analysis_required") {
      return "原始逐字稿已经准备好。系统通常会自动生成 AI 摘要、易读逐字稿和事实清单；如果没有启动，可以直接重新尝试。";
    }
    return "这次沟通还没有准备好可处理的材料。请等文件状态变为“材料已就绪”。";
  }
  if (issue.code === "NOT_FOUND" || issue.status === 404) return "请求的内容不存在。后端接口可能尚未完成，或这条数据已经被删除。";
  if (issue.code === "NETWORK_ERROR" || issue.status === 0) return "无法连接后端服务，请确认本地服务正在运行。";
  if (issue.status >= 500) return "服务端没有完成这次请求。本次没有写入假数据或半成品，请保留 Request ID 供排查。";
  return issue.message;
}

function ErrorNotice({ issue, onRetry, compact = false }: { issue: ApiIssue; onRetry?: () => void; compact?: boolean }) {
  const retryLabel = issue.code === "EXTRACTION_POLL_TIMEOUT" || issue.code === "TRANSCRIPTION_POLL_TIMEOUT"
    ? "检查状态"
    : issue.code.includes("EMPTY_OUTPUT")
      ? "检查材料"
      : "重试";
  return (
    <section className={`notice notice-error ${compact ? "notice-compact" : ""}`} role="alert">
      <span className="notice-mark">!</span>
      <div>
        <strong>{issueTitle(issue)}</strong>
        <p>{issueMessage(issue)}</p>
        {issue.requestId && <small>Request ID: {issue.requestId}</small>}
      </div>
      {onRetry && <button className="button secondary" onClick={onRetry}>{retryLabel}</button>}
    </section>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-symbol">○</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

function LoadingBlock({ label = "正在读取…" }: { label?: string }) {
  return <div className="loading-block" role="status"><span /><span /><span /><small>{label}</small></div>;
}

function MaterialSyncingCard({ detail = "文件已上传，正在更新这次沟通。" }: { detail?: string }) {
  return <div className="material-syncing-card" role="status" aria-live="polite" aria-busy="true">
    <span className="material-syncing-spinner" aria-hidden="true" />
    <div><strong>正在同步材料…</strong><p>{detail}</p></div>
  </div>;
}

function StatusBadge({ value }: { value?: string }) {
  const tone = ["failed", "rejected", "withdrawn"].includes(value ?? "")
    ? "danger"
    : ["pending", "queued", "processing", "extracting", "pending_confirmation", "completed_with_warnings"].includes(value ?? "")
      ? "warning"
      : ["verified", "succeeded", "completed", "ready", "confirmed", "active"].includes(value ?? "")
        ? "success"
        : "neutral";
  return <span className={`status-badge ${tone}`}>{statusLabel(value)}</span>;
}

function PublicWorkspaceConfirmationModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <Modal
    title="上传前先确认材料安全"
    description="这是公开共享的测试空间，不适合保存真实客户的敏感资料。"
    onClose={onCancel}
  >
    <div className="public-workspace-confirmation">
      <div className="public-workspace-warning">
        <strong>只能使用公开、合成或已脱敏材料</strong>
        <ul>
          <li>不要包含真实客户姓名、电话、邮箱或精确住址。</li>
          <li>不要包含贷款、银行、身份证件或其他财务与身份信息。</li>
          <li>录音前请确认所有参与者知情，并避免谈论敏感资料。</li>
        </ul>
      </div>
      <label className="public-workspace-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我确认这次材料不含真实客户敏感信息。</span></label>
      <div className="modal-actions"><button className="button secondary" onClick={onCancel}>取消</button><button className="button primary" disabled={!confirmed} onClick={onConfirm}>确认并继续</button></div>
    </div>
  </Modal>;
}

function ProjectDeleteModal({ preview, busy, onClose, onConfirm }: {
  preview: ProjectDeletePreview;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return <Modal title="把项目移到回收站？" description="项目不会立即永久消失，可以随时从回收站恢复。" onClose={onClose} dismissible={!busy} returnFocusSelector=".project-menu-trigger">
    <div className="delete-preview">
      <strong>{preview.project_name}</strong>
      <dl><div><dt>沟通</dt><dd>{preview.event_count} 次</dd></div><div><dt>材料</dt><dd>{preview.material_count} 份</dd></div><div><dt>待核对</dt><dd>{preview.pending_count} 条</dd></div></dl>
      {!preview.can_delete && <p className="danger-note">还有 {preview.active_job_count} 个转写、分析或 AI 阅读任务正在运行。完成前不能删除。</p>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button danger" disabled={busy || !preview.can_delete} onClick={() => void onConfirm()}>{busy ? "正在移动…" : "移到回收站"}</button></div>
    </div>
  </Modal>;
}

function ProjectTrashModal({ projects, state, issue, busy, onClose, onRetry, onRestore, onPermanentDelete }: {
  projects: Project[];
  state: AsyncState;
  issue: ApiIssue | null;
  busy: string | null;
  onClose: () => void;
  onRetry: () => Promise<void>;
  onRestore: (project: Project, openAfterRestore?: boolean) => Promise<void>;
  onPermanentDelete: (project: Project, confirmation: string) => Promise<void>;
}) {
  const [permanentTarget, setPermanentTarget] = useState<Project | null>(null);
  const [confirmation, setConfirmation] = useState("");
  return <Modal title="回收站" description="恢复会带回项目的全部材料、核对记录、Evidence 和报告。这里不会自动按天清理。" onClose={onClose} dismissible={!Boolean(busy)} returnFocusSelector=".project-menu-trigger" wide>
    <div className="trash-list">
      {state === "loading" && <LoadingBlock label="正在读取回收站…" />}
      {state === "error" && issue && <ErrorNotice issue={issue} onRetry={() => void onRetry()} />}
      {state === "empty" && <EmptyState title="回收站是空的" body="移入回收站的项目会显示在这里。" />}
      {projects.map((item) => <article key={item.id}><span><strong>{item.name}</strong><small>{item.eventCount ?? 0} 次沟通 · 删除于 {formatDate(item.deletedAt, true)}</small></span><div><button className="button secondary" disabled={Boolean(busy)} onClick={() => void onRestore(item, true)}>恢复并打开</button><button className="text-button danger" disabled={Boolean(busy)} onClick={() => { setPermanentTarget(item); setConfirmation(""); }}>永久删除</button></div></article>)}
    </div>
    {permanentTarget && <div className="permanent-confirm">
      <h3>永久删除“{permanentTarget.name}”</h3>
      <p>系统会先删除该项目在文件存储中的录音、照片、逐字稿与暂存结果，再删除数据库记录。这个动作无法撤销。</p>
      <label className="field"><span>输入完整项目名称确认</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoFocus /></label>
      <div className="modal-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => setPermanentTarget(null)}>取消</button><button className="button danger" disabled={Boolean(busy) || confirmation !== permanentTarget.name} onClick={() => void onPermanentDelete(permanentTarget, confirmation).then(() => { setPermanentTarget(null); setConfirmation(""); })}>{busy === `permanent:${permanentTarget.id}` ? "正在清理文件…" : "永久删除"}</button></div>
    </div>}
  </Modal>;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
}

function objectItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  return recordArray(value.items ?? value.events);
}

function redactDebugValue(value: unknown, key = ""): unknown {
  if (/(api.?key|secret|password|authorization|cookie|credential|idempotency_key|r2_.*_key)/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactDebugValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactDebugValue(childValue, childKey)]));
}

function claimViewItem(value: Record<string, unknown>): Record<string, unknown> {
  const version = isRecord(value.version) ? value.version : {};
  return {
    ...value,
    claim_id: firstString(value, ["claimId", "claim_id"]) || (Object.keys(version).length ? firstString(value, ["id"]) : undefined),
    claim_version_id: firstString(value, ["claimVersionId", "claim_version_id"]) || firstString(version, ["id"]),
    statement: firstString(value, ["statement"]) || firstString(version, ["statement"]),
    evidence_ref_ids: Array.isArray(value.evidenceRefIds) ? value.evidenceRefIds : Array.isArray(version.evidenceRefIds) ? version.evidenceRefIds : [],
    lifecycle_status: firstString(value, ["lifecycleStatus", "lifecycle_status"]),
    updated_at: firstString(value, ["updatedAt", "updated_at"]),
  };
}

function findItemById(
  items: Record<string, unknown>[],
  id: string,
  keys: string[],
): Record<string, unknown> | undefined {
  return items.find((item) => firstString(item, keys) === id);
}

async function loadBriefDisplayData(
  projectId: string,
  loadVerifiedView: (projectId: string, view: ProjectViewName) => Promise<unknown> = (id, view) => api.getView(id, view),
): Promise<BriefDisplayData> {
  const [briefValue, summaryValue, agendaValue] = await Promise.all([
    loadVerifiedView(projectId, "brief-card"),
    loadVerifiedView(projectId, "folder-summary"),
    loadVerifiedView(projectId, "next-meeting-agenda"),
  ]);
  if (!isRecord(briefValue)) return {};

  const summary = isRecord(summaryValue) ? summaryValue : {};
  const currentClaims = recordArray(summary.currentClaims ?? summary.current_claims).map(claimViewItem);
  const recentDeltas = recordArray(summary.recentDeltas ?? summary.recent_deltas);
  const agendaItems = objectItems(agendaValue);
  const stateClaimId = firstString(briefValue, ["stateClaimId", "state_claim_id"]);
  const riskClaimId = firstString(briefValue, ["riskClaimId", "risk_claim_id"]);
  const deltaItemIds = stringValues(briefValue.deltaItemIds ?? briefValue.delta_item_ids);
  const agendaItemIds = stringValues(briefValue.agendaItemIds ?? briefValue.agenda_item_ids);

  return {
    ...briefValue,
    stateItem: stateClaimId
      ? findItemById(currentClaims, stateClaimId, ["claim_id", "claimId", "id"])
        ?? { claim_id: stateClaimId, source_missing: true }
      : undefined,
    deltaItems: deltaItemIds
      .map((id) => findItemById(recentDeltas, id, ["id", "delta_item_id", "deltaItemId"])
        ?? { id, source_missing: true }),
    agendaItems: agendaItemIds
      .map((id) => findItemById(agendaItems, id, ["id", "agenda_item_id", "agendaItemId"])
        ?? { id, source_missing: true }),
    riskItem: riskClaimId
      ? findItemById(currentClaims, riskClaimId, ["claim_id", "claimId", "id"])
        ?? { claim_id: riskClaimId, source_missing: true }
      : undefined,
  };
}

function claimsFromVerifiedView(value: unknown): Claim[] {
  const raw: Record<string, unknown>[] = [];
  if (Array.isArray(value)) {
    for (const group of recordArray(value)) raw.push(...recordArray(group.claims));
  } else if (isRecord(value)) {
    raw.push(...recordArray(value.currentClaims ?? value.current_claims), ...recordArray(value.claims));
  }
  return raw.map(normalizeClaim).filter((claim) => Boolean(claim.id && claim.versionId));
}

function viewEmptyReason(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value.empty_reason) : undefined;
}


function ContradictionCard({
  item,
  onOpenClaim,
  onResolve,
  busy,
}: {
  item: Record<string, unknown>;
  onOpenClaim: (id: string) => void;
  onResolve: (input: ContradictionResolutionInput) => void;
  busy: boolean;
}) {
  const relationId = firstString(item, ["relationId", "relation_id"]) ?? "";
  const sourceClaimId = firstString(item, ["sourceClaimId", "source_claim_id"]);
  const targetClaimId = firstString(item, ["targetClaimId", "target_claim_id"]);
  const sourceVersionId = firstString(item, ["sourceClaimVersionId", "source_claim_version_id"]) ?? "";
  const targetVersionId = firstString(item, ["targetClaimVersionId", "target_claim_version_id"]) ?? "";
  const sourceStatement = firstString(item, ["sourceStatement", "source_statement"]) ?? "服务器没有返回这条记录的原文";
  const targetStatement = firstString(item, ["targetStatement", "target_statement"]) ?? "服务器没有返回这条记录的原文";
  const sourceEvidenceIds = stringValues(item.sourceEvidenceRefIds ?? item.source_evidence_ref_ids);
  const targetEvidenceIds = stringValues(item.targetEvidenceRefIds ?? item.target_evidence_ref_ids);
  const [winner, setWinner] = useState("");
  const [explanation, setExplanation] = useState("");
  const contractReady = Boolean(relationId && sourceVersionId && targetVersionId);
  return (
    <article className="contradiction-card">
      <header>
        <span className="eyebrow">尚未解决的矛盾</span>
        <h3>选择目前仍然有效的一条记录</h3>
        <p>另一条会退出当前结果，但仍保留在历史记录中。</p>
      </header>
      <div className="contradiction-options">
        {[
          { key: "source", claimId: sourceClaimId, versionId: sourceVersionId, statement: sourceStatement, evidenceIds: sourceEvidenceIds },
          { key: "target", claimId: targetClaimId, versionId: targetVersionId, statement: targetStatement, evidenceIds: targetEvidenceIds },
        ].map((option, index) => (
          <label className={winner === option.versionId ? "selected" : ""} key={option.key}>
            <input type="radio" name={`winner-${relationId}`} checked={winner === option.versionId} onChange={() => setWinner(option.versionId)} />
            <span className="contradiction-option-body">
              <small>记录 {index + 1}</small>
              <strong>{option.statement}</strong>
              <span className="evidence-id-list"><b>Evidence IDs</b>{option.evidenceIds.length ? option.evidenceIds.map((id) => <code key={id}>{id}</code>) : <em>服务器没有返回 Evidence ID</em>}</span>
              {option.claimId && <button type="button" className="text-button" onClick={(event) => { event.preventDefault(); onOpenClaim(option.claimId!); }}>查看这条记录和原始证据</button>}
            </span>
          </label>
        ))}
      </div>
      <label className="field contradiction-reason"><span>为什么保留这一条</span><textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} placeholder="写下判断依据，方便以后回看。" /></label>
      {!contractReady && <p className="uncertainty">服务器返回的矛盾记录缺少 Relation 或 Version ID，目前不能提交。</p>}
      <button
        className="button primary"
        disabled={!contractReady || !winner || !explanation.trim() || busy}
        onClick={() => onResolve({ relationId, sourceClaimVersionId: sourceVersionId, targetClaimVersionId: targetVersionId, winningClaimVersionId: winner, explanation: explanation.trim() })}
      >{busy ? "正在保存…" : "保留所选记录并解决矛盾"}</button>
    </article>
  );
}

const timelineMomentLabels: Record<string, string> = {
  new: "新增",
  updated: "修改或取代",
  resolved: "已解决",
  contradicted: "出现矛盾",
  reaffirmed: "再次确认",
  withdrawn: "已撤回",
};

function TimelineMoment({ moment, onOpenClaim }: { moment: Record<string, unknown>; onOpenClaim: (id: string) => void }) {
  const kind = firstString(moment, ["kind"]) || "new";
  const before = isRecord(moment.before) ? moment.before : null;
  const after = isRecord(moment.after) ? moment.after : null;
  const primaryEvidence = recordArray(moment.evidence)[0];
  const claimId = (after && firstString(after, ["claimId", "claim_id"]))
    || (before && firstString(before, ["claimId", "claim_id"]));
  const startMs = typeof moment.transcriptStartMs === "number"
    ? moment.transcriptStartMs
    : typeof moment.transcript_start_ms === "number"
      ? moment.transcript_start_ms
      : typeof primaryEvidence?.startMs === "number"
        ? primaryEvidence.startMs
        : typeof primaryEvidence?.start_ms === "number"
          ? primaryEvidence.start_ms
          : null;
  const speaker = primaryEvidence ? firstString(primaryEvidence, ["speaker"]) : undefined;
  const quote = primaryEvidence ? firstString(primaryEvidence, ["quoteRaw", "quote_raw"]) : undefined;
  const beforeStatement = before ? firstString(before, ["statement"]) : undefined;
  const afterStatement = after ? firstString(after, ["statement"]) : undefined;
  return (
    <li className={`timeline-moment ${kind}`}>
      <span className="timeline-dot" aria-hidden="true" />
      <article>
        <header>
          <span className={`timeline-kind ${kind}`}>{timelineMomentLabels[kind] || kind}</span>
          {(speaker || startMs !== null) && <small>{speaker || "说话人未标注"}{startMs !== null ? ` · ${formatTimestamp(startMs / 1000)}` : ""}</small>}
        </header>
        <h4>{firstString(moment, ["displayText", "display_text"]) || afterStatement || beforeStatement || "这次沟通留下了一条已确认变化"}</h4>
        {beforeStatement && afterStatement && beforeStatement !== afterStatement && <div className="timeline-change"><p><span>之前</span>{beforeStatement}</p><p><span>现在</span>{afterStatement}</p></div>}
        {quote && <blockquote>“{quote}”</blockquote>}
        {claimId && <button className="text-button" onClick={() => onOpenClaim(claimId)}>查看记录与原始证据</button>}
      </article>
    </li>
  );
}

function TimelineEventGroup({ group, index, moments, eventRecord, onOpenClaim }: { group: Record<string, unknown>; index: number; moments?: Record<string, unknown>[]; eventRecord?: Event; onOpenClaim: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const event = isRecord(group.event) ? group.event : {};
  const visibleSource = moments ?? recordArray(group.moments);
  const pendingReviewCount = (eventRecord?.pendingClaimCount ?? 0) + (eventRecord?.pendingOccurrenceCount ?? 0);
  const collapsed = visibleSource.length > 3 && !expanded;
  const visibleMoments = collapsed ? visibleSource.slice(0, 3) : visibleSource;
  return (
    <section className="timeline-group">
      <header>
        <div><span className="section-kicker">第 {index + 1} 次沟通</span><h3>{firstString(event, ["title"]) || "未命名沟通"}</h3></div>
        <time>{formatDate(firstString(event, ["occurredAt", "occurred_at"]))}</time>
      </header>
      {pendingReviewCount > 0 && <p className="pending-review-note compact">还有 {pendingReviewCount} 条待核对，尚未进入本页结果。</p>}
      {firstString(group, ["summary"]) && <p>{firstString(group, ["summary"])}</p>}
      <ol className="timeline-track">
        {visibleMoments.map((moment, momentIndex) => <TimelineMoment key={firstString(moment, ["id"]) || momentIndex} moment={moment} onOpenClaim={onOpenClaim} />)}
      </ol>
      {visibleSource.length > 3 && <button className="button secondary timeline-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起次要节点" : `展开其余 ${visibleSource.length - 3} 个节点`}</button>}
    </section>
  );
}

type TimelineFilter = "all" | "budget" | "preference" | "property" | "action" | "change";

const timelineFilters: Array<{ key: TimelineFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "budget", label: "金额" },
  { key: "preference", label: "要求与偏好" },
  { key: "property", label: "对象" },
  { key: "action", label: "行动" },
  { key: "change", label: "发生变化" },
];

function timelineMomentMatches(moment: Record<string, unknown>, filter: TimelineFilter): boolean {
  if (filter === "all") return true;
  const before = isRecord(moment.before) ? moment.before : {};
  const after = isRecord(moment.after) ? moment.after : {};
  const kind = firstString(moment, ["kind"]) || "new";
  const type = firstString(after, ["type", "claim_type"])
    || firstString(before, ["type", "claim_type"])
    || firstString(moment, ["type", "claim_type"])
    || "";
  const text = [
    firstString(moment, ["displayText", "display_text"]),
    firstString(before, ["statement"]),
    firstString(after, ["statement"]),
  ].filter(Boolean).join(" ");
  if (filter === "change") return kind !== "new";
  if (filter === "budget") return type === "budget" || /budget|financ|mortgage|price|loan|amount|cost|quote|预算|融资|贷款|按揭|价格|金额|费用|报价|赔付/i.test(text);
  if (filter === "preference") return type === "preference" || type === "requirement" || /prefer|must.?have|deal.?breaker|偏好|要求|必须|不能接受/i.test(text);
  if (filter === "property") return type === "property_fact" || /property|listing|house|home|condo|apartment|claim|damage|repair|estimate|contract|document|asset|房源|房子|住宅|公寓|看房|索赔|损坏|维修|报价|合同|文件|材料/i.test(text);
  return type === "next_action" || /next step|follow.?up|action|下一步|跟进|负责人|期限/i.test(text);
}

function TimelineView({ data, events, onOpenClaim }: { data: unknown; events: Event[]; onOpenClaim: (id: string) => void }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const groups = recordArray(data);
  const counts = Object.fromEntries(timelineFilters.map(({ key }) => [
    key,
    groups.reduce((total, group) => total + recordArray(group.moments).filter((moment) => timelineMomentMatches(moment, key)).length, 0),
  ])) as Record<TimelineFilter, number>;
  const visibleGroups = groups.flatMap((group, index) => {
    const moments = recordArray(group.moments).filter((moment) => timelineMomentMatches(moment, filter));
    return moments.length ? [{ group, moments, index }] : [];
  });
  return <div className="timeline-view">
    <div className="timeline-filter" role="group" aria-label="筛选时间线">
      {timelineFilters.map((item) => <button className={filter === item.key ? "active" : ""} key={item.key} onClick={() => setFilter(item.key)}>{item.label}<span>{counts[item.key]}</span></button>)}
    </div>
    {visibleGroups.length > 0 ? <div className="timeline-groups">{visibleGroups.map(({ group, moments, index }) => {
      const event = isRecord(group.event) ? group.event : {};
      const eventId = firstString(event, ["id"]);
      return <TimelineEventGroup key={eventId || index} group={group} index={index} moments={moments} eventRecord={events.find((item) => item.id === eventId)} onOpenClaim={onOpenClaim} />;
    })}</div> : <EmptyState
      title={filter === "all" ? "时间线还没有内容" : "这个筛选下还没有变化"}
      body={filter === "all" ? "核对并确认内容后，变化会出现在这里。" : "切换到“全部”可查看其他已经确认的时间线节点。"}
    />}
  </div>;
}

const preferenceHistoryLabels: Record<string, string> = {
  stated: "首次提出",
  updated: "发生变化",
  reaffirmed: "再次确认",
  withdrawn: "已撤回",
};

function PreferenceCard({ item, onOpenClaim }: { item: Record<string, unknown>; onOpenClaim: (id: string) => void }) {
  const claimId = firstString(item, ["claimId", "claim_id"]);
  const currentValue = isRecord(item.currentValue) ? item.currentValue : isRecord(item.current_value) ? item.current_value : null;
  const conditions = Array.isArray(item.conditions) ? item.conditions.map(stringValue).filter((value): value is string => Boolean(value)) : [];
  const decisionPeople = stringValues(item.decisionPeople ?? item.decision_people);
  const firstSeen = isRecord(item.firstSeen) ? item.firstSeen : isRecord(item.first_seen) ? item.first_seen : null;
  const lastSeen = isRecord(item.lastSeen) ? item.lastSeen : isRecord(item.last_seen) ? item.last_seen : null;
  const history = recordArray(item.history);
  const valueEntries = currentValue
    ? Object.entries(currentValue).filter(([, value]) => value !== null && value !== undefined && stringValue(value))
    : [];
  return (
    <article className="preference-card">
      <header><div><span className="eyebrow">当前偏好</span><h3>{firstString(item, ["statement"]) || "偏好内容未显示"}</h3></div>{item.isCurrent !== false && item.is_current !== false && <span className="status-badge success">当前有效</span>}</header>
      {valueEntries.length > 0 && <dl className="preference-values">{valueEntries.map(([key, value]) => <div key={key}><dt>{typeLabel(key)}</dt><dd>{stringValue(value)}</dd></div>)}</dl>}
      {(conditions.length > 0 || decisionPeople.length > 0) && <div className="preference-context">{conditions.length > 0 && <p><strong>适用条件</strong>{conditions.join("、")}</p>}{decisionPeople.length > 0 && <p><strong>参与决定</strong>{decisionPeople.join("、")}</p>}</div>}
      <div className="preference-seen"><span>首次出现<strong>{formatDate(firstSeen ? firstString(firstSeen, ["eventOccurredAt", "event_occurred_at"]) : undefined)}</strong></span><span>最近确认<strong>{formatDate(lastSeen ? firstString(lastSeen, ["eventOccurredAt", "event_occurred_at"]) : undefined)}</strong></span></div>
      {history.length > 0 && <ol className="preference-history">{history.map((entry, index) => {
        const entryClaimId = firstString(entry, ["claimId", "claim_id"]);
        const kind = firstString(entry, ["kind"]) || "stated";
        return <li key={firstString(entry, ["id"]) || index}><span aria-hidden="true" /><div><small>{preferenceHistoryLabels[kind] || kind} · {formatDate(firstString(entry, ["eventOccurredAt", "event_occurred_at"]))}</small><p>{firstString(entry, ["statement"]) || "内容未显示"}</p>{entryClaimId && <button className="text-button" onClick={() => onOpenClaim(entryClaimId)}>查看当时证据</button>}</div></li>;
      })}</ol>}
      {claimId && <button className="button secondary preference-open" onClick={() => onOpenClaim(claimId)}>查看当前记录与证据</button>}
    </article>
  );
}

const draftLinkLabels: Record<string, string> = {
  same: "可能是同一件事",
  changed: "可能发生变化",
  conflicting: "可能前后冲突",
  possibly_answered: "可能回答了旧问题",
};


function ResultContent({ tab, data, events, onOpenClaim, onSelect, onResolveContradiction, onCompleteAction, onDecideDraftLink, onOpenAiSuggestions, onAddAction, busyAction }: { tab: ResultTab; data: unknown; events: Event[]; onOpenClaim: (id: string) => void; onSelect: (tab: ResultTab) => void; onResolveContradiction: (input: ContradictionResolutionInput) => void; onCompleteAction: (claimId: string) => void; onDecideDraftLink: (linkId: string, action: "accept" | "reject") => void; onOpenAiSuggestions: () => void; onAddAction: () => void; busyAction: string | null }) {
  const emptyReason = viewEmptyReason(data);
  if (tab === "client-progress" && isRecord(data)) {
    const draftMemory = isRecord(data.draft_memory) ? data.draft_memory : {};
    const drafts = recordArray(draftMemory.claims);
    const draftLinks = recordArray(draftMemory.links);
    const verified = isRecord(data.verified) ? data.verified : {};
    const trusted = recordArray(verified.currentClaims ?? verified.current_claims).map(claimViewItem);
    return <div className="summary-view client-progress-view">
      <section className="memory-layer"><header><span className="eyebrow">项目记录</span><h3>已确认内容可信，AI 草稿仅供参考</h3><p>每条记录都标明状态。时间线、会前准备和正式报告只读取已确认内容。</p></header><ProjectOverviewList drafts={drafts} trusted={trusted} onOpenClaim={onOpenClaim} /></section>
      {draftLinks.length > 0 && <section className="memory-layer draft-link-layer"><header><span className="eyebrow">可能的跨沟通联系</span><h3>先作为提示，不会自动改变可信记忆</h3><p>只有两边都经过人工确认后，接受按钮才会开放；接受后才创建正式关系。</p></header><div className="draft-link-list">{draftLinks.map((link, index) => {
        const linkId = firstString(link, ["id"]);
        const sourceId = firstString(link, ["source_claim_id"]);
        const targetId = firstString(link, ["target_draft_claim_id"]);
        const linkType = firstString(link, ["type"]) || "same";
        const bothVerified = firstString(link, ["source_review_status"]) === "verified" && firstString(link, ["target_review_status"]) === "verified";
        const busy = Boolean(linkId && (busyAction === `draft-link:${linkId}:accept` || busyAction === `draft-link:${linkId}:reject`));
        return <article className="draft-link-card" key={linkId || index}><div className="view-card-top"><span className="status-badge warning">{draftLinkLabels[linkType] || linkType}</span><small>{Math.round(Number(link.confidence ?? 0) * 100)}% 置信</small></div><div className="draft-link-comparison"><p><span>这次草稿</span>{firstString(link, ["source_statement"]) || "内容未显示"}</p><p><span>旧草稿</span>{firstString(link, ["target_statement"]) || "内容未显示"}</p></div>{firstString(link, ["reason"]) && <p className="muted">AI 判断理由：{firstString(link, ["reason"])}</p>}<div className="action-card-buttons">{sourceId && <button className="text-button" onClick={() => onOpenClaim(sourceId)}>查看这次记录</button>}{targetId && <button className="text-button" onClick={() => onOpenClaim(targetId)}>查看旧记录</button>}{linkId && <button className="button primary small" disabled={!bothVerified || busy} title={bothVerified ? "建立正式关系" : "请先分别确认两条记录"} onClick={() => onDecideDraftLink(linkId, "accept")}>{busy ? "正在保存…" : bothVerified ? "接受为正式关系" : "两边确认后可接受"}</button>}{linkId && <button className="button quiet small" disabled={busy} onClick={() => onDecideDraftLink(linkId, "reject")}>不采纳关联</button>}</div></article>;
      })}</div></section>}
    </div>;
  }
  if (tab === "actions") {
    const actions = objectItems(data);
    if (!actions.length) return <div className="action-empty-state"><EmptyState title="目前没有下一步行动" body="AI 建议会先留在草稿层；确认后才能进入站内行动清单。" /><div><button className="button primary" onClick={onOpenAiSuggestions}>查看 AI 建议</button><button className="button secondary" onClick={onAddAction}>从原文补充行动</button></div><p>从原文补充的行动会先进入待核对队列，不会直接写入可信记忆。</p></div>;
    return <div className="action-list">{actions.map((item, index) => {
      const claimId = firstString(item, ["claim_id"]);
      const status = firstString(item, ["status"]) || "ai_suggested";
      return <article className={`view-card action-card ${status}`} key={claimId || index}><div className="view-card-top"><div><span className="eyebrow">{status === "ai_suggested" ? "AI 建议" : status === "confirmed" ? "已确认" : status === "completed" ? "已完成" : "不采纳"}</span><h3>{firstString(item, ["statement"]) || "未命名行动"}</h3></div><StatusBadge value={status} /></div>{firstString(item, ["owner"]) && <p><b>负责人：</b>{firstString(item, ["owner"])}</p>}{firstString(item, ["due_at"]) && <p><b>期限：</b>{formatDate(firstString(item, ["due_at"]), true)}</p>}<p className="muted">来源：{firstString(item, ["event_title"]) || "一次沟通"}</p><div className="action-card-buttons">{claimId && <button className="text-button" onClick={() => onOpenClaim(claimId)}>查看记录与 Evidence</button>}{claimId && status === "confirmed" && <button className="button primary small" disabled={busyAction === `complete-action:${claimId}`} onClick={() => onCompleteAction(claimId)}>{busyAction === `complete-action:${claimId}` ? "正在完成…" : "标记完成"}</button>}</div></article>;
    })}</div>;
  }
  if (tab === "folder-summary" && isRecord(data)) {
    const scenario = firstString(data, ["scenario", "scenario_label"]);
    const claims = recordArray(data.currentClaims ?? data.current_claims).map(claimViewItem);
    const deltas = recordArray(data.recentDeltas ?? data.recent_deltas);
    if (!scenario && !claims.length && !deltas.length) return <EmptyState title="还没有事项概况" body={emptyReason || firstString(data, ["emptyReason"]) || "先完成材料处理并确认有用的记录。待审核内容不会出现在这里。"} />;
    return (
      <div className="summary-view">
        {scenario && <span className="scenario-chip">使用场景：{scenario.replaceAll("_", " ")}</span>}
        <ResultSection title="当前情况" empty="还没有已确认且仍有效的记录。" hasContent={claims.length > 0}><div className="view-grid">{claims.map((item, index) => <ViewItem key={firstString(item, ["claim_id"]) || index} item={item} onOpenClaim={onOpenClaim} />)}</div></ResultSection>
        <ResultSection title="最近变化" empty="还没有已确认的变化。" hasContent={deltas.length > 0}><div className="view-grid">{deltas.map((item, index) => <ViewItem key={firstString(item, ["id"]) || index} item={item} onOpenClaim={onOpenClaim} />)}</div></ResultSection>
      </div>
    );
  }
  if (tab === "timeline") {
    const groups = recordArray(data);
    if (!groups.length) return <EmptyState title="时间线还没有内容" body={emptyReason || "确认第一批记录后，这里会按每次沟通显示新增、变化和解决的事项。"} />;
    return <TimelineView data={data} events={events} onOpenClaim={onOpenClaim} />;
  }
  if (tab === "preferences") {
    const preferences = objectItems(data);
    if (!preferences.length) return <EmptyState title="目前没有已确认的偏好" body={emptyReason || "确认偏好后，这里会保留当前内容、条件、决策人和变化过程。"} />;
    return <div className="preferences-view">{preferences.map((item, index) => <PreferenceCard key={firstString(item, ["claimId", "claim_id"]) || index} item={item} onOpenClaim={onOpenClaim} />)}</div>;
  }
  if (tab === "risks" && isRecord(data)) {
    const claims = recordArray(data.claims).map(claimViewItem);
    const contradictions = recordArray(data.contradictions);
    if (!claims.length && !contradictions.length) return <EmptyState title="目前没有已确认的风险或未解决矛盾" body="这不代表没有风险，只代表现有已确认记录中没有。" />;
    return <div className="summary-view"><ResultSection title="风险记录" empty="目前没有单独标记的风险。" hasContent={claims.length > 0}><div className="view-grid">{claims.map((item, index) => <ViewItem key={firstString(item, ["claim_id"]) || index} item={item} onOpenClaim={onOpenClaim} />)}</div></ResultSection><ResultSection title="尚未解决的矛盾" empty="目前没有尚未解决的矛盾。" hasContent={contradictions.length > 0}><div className="contradiction-list">{contradictions.map((item, index) => { const relationId = firstString(item, ["relationId", "relation_id"]) || String(index); return <ContradictionCard key={relationId} item={item} onOpenClaim={onOpenClaim} onResolve={onResolveContradiction} busy={busyAction === `relation:${relationId}`} />; })}</div></ResultSection></div>;
  }
  if (tab === "gap-check" && isRecord(data)) {
    const applicable = data.applicable === true;
    const missing = stringValues(data.missingSlots ?? data.missing_slots);
    const satisfied = isRecord(data.satisfied) ? data.satisfied : {};
    if (!applicable) return <EmptyState title="当前场景没有配置资料缺口检查" body={`已确认场景：${firstString(data, ["scenario"]) || "未确认"}。目前只有已配置检查规则的场景会生成缺口。`} />;
    return <div className="summary-view"><ResultSection title="还需要补齐" empty="当前检查规则要求的资料已经齐全。" hasContent={missing.length > 0}><div className="slot-grid">{missing.map((slot) => <article className="view-card" key={slot}><span className="eyebrow">缺少资料</span><h3>{slotLabel(slot)}</h3></article>)}</div></ResultSection><ResultSection title="已有依据" empty="还没有满足任何检查项。" hasContent={Object.keys(satisfied).length > 0}><div className="slot-grid">{Object.entries(satisfied).map(([slot, ids]) => <article className="view-card" key={slot}><span className="eyebrow">已有资料</span><h3>{slotLabel(slot)}</h3>{Array.isArray(ids) && ids.map((id) => stringValue(id)).filter(Boolean).map((id) => <button className="text-button" key={id} onClick={() => onOpenClaim(id!)}>查看对应记录</button>)}</article>)}</div></ResultSection></div>;
  }
  if (tab === "next-meeting-agenda") {
    const rows = objectItems(data);
    if (!rows.length) return <EmptyState title="目前没有下次必须确认的内容" body="资料缺口、开放问题和未解决矛盾会汇总到这里。" />;
    return <div className="agenda-list">{rows.map((item, index) => {
      const sourceKind = firstString(item, ["sourceKind", "source_kind"]);
      if (sourceKind === "contradiction") {
        const relationId = firstString(item, ["relationId", "relation_id"]) || String(index);
        return <ContradictionCard key={relationId} item={item} onOpenClaim={onOpenClaim} onResolve={onResolveContradiction} busy={busyAction === `relation:${relationId}`} />;
      }
      const adapted = sourceKind === "gap" ? { ...item, title: `补齐：${slotLabel(firstString(item, ["slot"]) || "资料")}`, type: "资料缺口" } : { ...item, type: "待确认问题", claim_version_id: firstString(item, ["claimVersionId"]) };
      return <ViewItem key={firstString(item, ["id"]) || index} item={adapted} onOpenClaim={onOpenClaim} />;
    })}</div>;
  }
  if (tab === "brief-card" && isRecord(data)) {
    const stateItem = isRecord(data.stateItem) ? data.stateItem : undefined;
    const riskItem = isRecord(data.riskItem) ? data.riskItem : undefined;
    const deltaItems = recordArray(data.deltaItems);
    const agendaItems = recordArray(data.agendaItems);
    const missing = Number(data.missingSlotCount ?? data.missing_slot_count ?? 0);
    if (!stateItem && !riskItem && !deltaItems.length && !agendaItems.length) return <EmptyState title="会前速览的信息还不够" body="系统不会为了填满内容而编造记录。" />;
    return <div className="brief-grid"><div className="brief-overview-action"><div><span className="section-kicker">下一步</span><strong>需要更多细节？</strong><p>完整报告会展开事项概况、时间线、决定、偏好、问题、风险和下次沟通清单。</p></div><button className="button secondary" onClick={() => onSelect("folder-summary")}>查看完整报告</button></div>
      <BriefGroup title="当前最重要的情况" items={stateItem ? [stateItem] : []} kind="state" empty="还没有可用记录" onOpenClaim={onOpenClaim} onSelect={onSelect} />
      <BriefGroup title="最近变化" items={deltaItems} kind="delta" empty="还没有变化" onOpenClaim={onOpenClaim} onSelect={onSelect} />
      <BriefGroup title="下次要问" items={agendaItems} kind="agenda" empty="还没有待确认事项" onOpenClaim={onOpenClaim} onSelect={onSelect} />
      <BriefGroup title="需要留意的风险" items={riskItem ? [riskItem] : []} kind="risk" empty="还没有风险记录" onOpenClaim={onOpenClaim} onSelect={onSelect} warning />
      {missing > 0 && <article className="view-card brief-warning"><span className="eyebrow">信息完整度</span><h3>还有 {missing} 个位置没有足够依据</h3><p>这些位置保持空白，没有用推测补齐。</p></article>}
    </div>;
  }
  const rows = objectItems(data).map((item) => tab === "decisions" || tab === "open-questions" ? claimViewItem(item) : item);
  if (!rows.length) {
    const copy: Record<ResultTab, [string, string]> = {
      "client-progress": ["还没有项目进展", "处理第一场沟通后，AI 草稿和可信记忆会分层显示。"],
      actions: ["目前没有下一步行动", "确认 AI 建议后，它会进入站内行动清单。"],
      "folder-summary": ["还没有事项概况", "先完成材料处理并确认有用的记录。"],
      timeline: ["时间线还没有内容", "确认第一批记录后，这里会按每次沟通显示新增、变化和解决的事项。"],
      decisions: ["目前没有已确认的决定", "待审核的决定不会提前出现在这里。"],
      preferences: ["目前没有已确认的偏好", "确认偏好后，这里会保留当前内容和变化过程。"],
      "open-questions": ["目前没有待确认问题", "新问题经过审核后会显示首次出现、重提次数和开放天数。"],
      risks: ["目前没有已确认的风险或未解决矛盾", "这不代表没有风险，只代表现有已确认记录中没有。"],
      "gap-check": ["还不能运行资料缺口检查", "先确认使用场景。只有已配置检查规则的场景才会生成缺口。"],
      "next-meeting-agenda": ["目前没有下次必须确认的内容", "资料缺口、开放问题和未解决矛盾会汇总到这里。"],
      "brief-card": ["会前速览的信息还不够", "系统不会为了填满六项而编造内容。"],
    };
    return <EmptyState title={copy[tab][0]} body={emptyReason || copy[tab][1]} />;
  }
  return <div className={tab === "brief-card" ? "brief-grid" : "view-grid"}>{rows.map((item, index) => <ViewItem key={firstString(item, ["id", "claim_id", "delta_item_id", "agenda_item_id"]) || index} item={item} onOpenClaim={onOpenClaim} />)}</div>;
}

function ResultSection({ title, empty, hasContent = true, children }: { title: string; empty?: string; hasContent?: boolean; children: ReactNode }) {
  return <section className="result-section"><h2>{title}</h2>{hasContent ? children : empty ? <p className="muted">{empty}</p> : null}</section>;
}

function slotLabel(value: string): string {
  const labels: Record<string, string> = {
    budget: "预算",
    financing: "资金或贷款",
    target_areas: "目标区域",
    timeline: "购买时间线",
    decision_makers: "谁参与决定",
    must_haves: "房屋硬性要求",
    preferences: "偏好与条件",
    dealbreakers: "明确不能接受的事项",
    property_feedback: "已看房源与反馈",
    next_actions: "下一步行动",
  };
  return labels[value] || value.replaceAll("_", " ");
}

type BriefItemKind = "state" | "delta" | "agenda" | "risk";

function briefItemText(item: Record<string, unknown>, kind: BriefItemKind): string {
  if (item.source_missing === true) return "这条内容刚刚发生变化，请打开来源页查看最新记录。";
  if (kind === "delta") return firstString(item, ["displayText", "display_text"]) || "变化内容暂时无法显示。";
  if (kind === "agenda") {
    const sourceKind = firstString(item, ["sourceKind", "source_kind"]);
    if (sourceKind === "gap") return `还需要补齐：${slotLabel(firstString(item, ["slot"]) || "资料")}`;
    if (sourceKind === "evidence_gap") return firstString(item, ["statement"]) || "这条记录仍需补充证据";
    if (sourceKind === "contradiction") {
      const source = firstString(item, ["sourceStatement", "source_statement"]) || "第一条记录";
      const target = firstString(item, ["targetStatement", "target_statement"]) || "第二条记录";
      return `需要确认哪条记录仍然有效：“${source}”与“${target}”`;
    }
  }
  return firstString(item, ["statement", "displayText", "display_text", "title", "question"]) || "内容暂时无法显示。";
}

function briefSourceId(item: Record<string, unknown>, kind: BriefItemKind): string | undefined {
  if (kind === "state" || kind === "risk") return firstString(item, ["claim_id", "claimId", "id"]);
  if (kind === "delta") return firstString(item, ["afterClaimVersionId", "after_claim_version_id", "claimVersionId", "claim_version_id"]);
  const sourceKind = firstString(item, ["sourceKind", "source_kind"]);
  if (sourceKind === "gap" || sourceKind === "contradiction") return undefined;
  return firstString(item, ["claimVersionId", "claim_version_id"]);
}

function BriefGroup({ title, items, kind, empty, onOpenClaim, onSelect, warning = false }: { title: string; items: Record<string, unknown>[]; kind: BriefItemKind; empty: string; onOpenClaim: (id: string) => void; onSelect: (tab: ResultTab) => void; warning?: boolean }) {
  return <article className={`view-card brief-group ${warning ? "brief-warning" : ""}`}>
    <span className="eyebrow">会前速览</span>
    <h3>{title}</h3>
    {items.length ? <ol className="brief-item-list">{items.map((item, index) => {
      const sourceKind = firstString(item, ["sourceKind", "source_kind"]);
      const sourceId = briefSourceId(item, kind);
      const sourceTab: ResultTab = kind === "delta"
        ? "timeline"
        : sourceKind === "gap"
          ? "gap-check"
          : kind === "agenda"
            ? "next-meeting-agenda"
            : kind === "risk"
              ? "risks"
              : "folder-summary";
      const sourceLabel = sourceId
        ? "查看记录与原始证据"
        : sourceKind === "gap"
          ? "查看资料缺口"
          : sourceKind === "contradiction"
            ? "查看矛盾与双方来源"
            : "查看来源";
      return <li key={firstString(item, ["id", "claim_id", "claimId", "claimVersionId", "claim_version_id"]) || `${kind}-${index}`}>
        {items.length > 1 && <small>{index + 1}</small>}
        <strong>{briefItemText(item, kind)}</strong>
        <button className="text-button" onClick={() => sourceId ? onOpenClaim(sourceId) : onSelect(sourceTab)}>{sourceLabel}</button>
      </li>;
    })}</ol> : <p>{empty}</p>}
  </article>;
}

export default function Home() {
  const queryClient = useQueryClient();
  const loadWorkflowSnapshot = useCallback((projectId: string, fresh = false) => queryClient.fetchQuery({
    ...workflowSnapshotQuery(projectId),
    staleTime: fresh ? 0 : 2_000,
  }), [queryClient]);
  const loadFreshWorkflowSnapshot = useCallback((projectId: string) =>
    loadWorkflowSnapshot(projectId, true), [loadWorkflowSnapshot]);
  const invalidateProjectReadModels = useCallback((projectId: string) =>
    queryClient.invalidateQueries({ queryKey: ["notique", "project", projectId] }), [queryClient]);
  // Keep the first client render identical to SSR. The URL is restored in the
  // mount effect below, after hydration has finished.
  const [route, setRouteState] = useState<AppRoute>({ view: "simple" });
  const screen = route.view;
  const routeRef = useRef(route);
  const routeRestoreAction = useRef<(nextRoute: AppRoute) => void>(() => undefined);
  const requestEpochs = useRef({ projects: 0, project: 0, event: 0, claims: 0, view: 0, claim: 0, debug: 0 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsState, setProjectsState] = useState<AsyncState>("loading");
  const [projectsIssue, setProjectsIssue] = useState<ApiIssue | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventWorkflowSummaries, setEventWorkflowSummaries] = useState<Record<string, WorkflowEventSummary>>({});
  const [projectState, setProjectState] = useState<AsyncState>("idle");
  const [projectIssue, setProjectIssue] = useState<ApiIssue | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [eventState, setEventState] = useState<AsyncState>("idle");
  const [eventIssue, setEventIssue] = useState<ApiIssue | null>(null);
  const [run, setRun] = useState<ExtractionRun | null>(null);
  const [transcriptionRun, setTranscriptionRun] = useState<TranscriptionRun | null>(null);
  const [transcriptionRunsByAssetId, setTranscriptionRunsByAssetId] = useState<Record<string, TranscriptionRun>>({});
  const [audioPreparationProgressByAssetId, setAudioPreparationProgressByAssetId] = useState<Record<string, AudioPreparationProgress>>({});
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);
  const [draftAssessment, setDraftAssessment] = useState<AiDraftAssessment | null>(null);
  const [showMissingClaim, setShowMissingClaim] = useState(false);
  const [missingClaimDefaultType, setMissingClaimDefaultType] = useState<OccurrenceNewClaim["type"]>("other");
  const [reviewSummaryDestination, setReviewSummaryDestination] = useState<ReviewSummaryDestination | null>(null);
  const [reviewClockNow, setReviewClockNow] = useState(() => Date.now());
  const [claims, setClaims] = useState<Claim[]>([]);
  const [occurrenceCandidates, setOccurrenceCandidates] = useState<OccurrenceCandidate[]>([]);
  const [claimsState, setClaimsState] = useState<AsyncState>("idle");
  const [claimsIssue, setClaimsIssue] = useState<ApiIssue | null>(null);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRef[]>([]);
  const [evidenceState, setEvidenceState] = useState<AsyncState>("idle");
  const [viewTab, setViewTab] = useState<ResultTab>("folder-summary");
  const [viewData, setViewData] = useState<unknown>(null);
  const [viewState, setViewState] = useState<AsyncState>("idle");
  const [viewIssue, setViewIssue] = useState<ApiIssue | null>(null);
  const [viewLoadDurationMs, setViewLoadDurationMs] = useState<number | null>(null);
  const [runDebug, setRunDebug] = useState<RunDebug | null>(null);
  const [runDebugState, setRunDebugState] = useState<AsyncState>("idle");
  const [runDebugIssue, setRunDebugIssue] = useState<ApiIssue | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewEvent, setShowNewEvent] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showPublicWorkspaceConfirmation, setShowPublicWorkspaceConfirmation] = useState(false);
  const [transcriptFocusRequest, setTranscriptFocusRequest] = useState<TranscriptFocusRequest | null>(null);
  const [deletePreview, setDeletePreview] = useState<ProjectDeletePreview | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [trashProjects, setTrashProjects] = useState<Project[]>([]);
  const [trashState, setTrashState] = useState<AsyncState>("idle");
  const [trashIssue, setTrashIssue] = useState<ApiIssue | null>(null);
  const [undoDeletedProject, setUndoDeletedProject] = useState<Project | null>(null);
  const [simpleFlow, setSimpleFlow] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [projectWorkflow, setProjectWorkflow] = useState<ProjectWorkflowState>(idleProjectWorkflow);
  const [workflowIntentProjectId, setWorkflowIntentProjectId] = useState<string | null>(() =>
    readStoredId(workflowIntentStorageKey),
  );
  const [runPollCycle, setRunPollCycle] = useState(0);
  const [transcriptionPollCycle, setTranscriptionPollCycle] = useState(0);
  const pollAttempts = useRef(0);
  const transcriptionPollAttempts = useRef(0);
  const pollingRunKey = useRef("");
  const transcriptionPollingRunKey = useRef("");
  const extractionKeys = useRef(new Map<string, string>());
  const transcriptionKeys = useRef(new Map<string, string>());
  const mutationKeys = useRef(new Map<string, string>());
  const localDispatchRuns = useRef(new Set<string>());
  const staleRecoveryRuns = useRef(new Set<string>());
  const localDispatchTranscriptionRuns = useRef(new Set<string>());
  const activeTranscriptionDispatches = useRef(new Set<string>());
  const autoAnalysisAttempts = useRef(new Set<string>());
  const completingReviewSessions = useRef(new Set<string>());
  const reviewRefreshEpoch = useRef(0);
  const projectWorkflowRefreshToken = useRef(0);
  const guidedTransitionKey = useRef("");
  const guidedTransitionAction = useRef<(phase: "waiting_scenario" | "waiting_review" | "draft_ready" | "partially_reviewed" | "complete") => void>(() => undefined);
  const pendingPublicWorkspaceAction = useRef<(() => void) | null>(null);
  const summaryReturnContext = useRef<{ eventId: string; scrollY: number } | null>(null);
  const [autoAnalysisIntentRevision, setAutoAnalysisIntentRevision] = useState(0);

  function armAutoAnalysis(eventId: string, audioAssetId?: string, baseRunId?: string): boolean {
    const current = readAutoAnalysisIntent(eventId);
    const waitForAudioAssetIds = Array.from(new Set([
      ...(current?.waitForAudioAssetIds ?? []),
      ...(audioAssetId ? [audioAssetId] : []),
    ]));
    const armed = storeAutoAnalysisIntent({
      eventId,
      waitForAudioAssetIds,
      armedAt: Date.now(),
      idempotencyKey: crypto.randomUUID(),
      ...(baseRunId ? { baseRunId } : {}),
    });
    for (const key of autoAnalysisAttempts.current) {
      if (key === eventId || key.startsWith(`${eventId}:`)) autoAnalysisAttempts.current.delete(key);
    }
    setAutoAnalysisIntentRevision((value) => value + 1);
    return armed;
  }

  function clearAutoAnalysisIntent(eventId: string): void {
    clearStoredAutoAnalysisIntent(eventId);
    for (const key of autoAnalysisAttempts.current) {
      if (key === eventId || key.startsWith(`${eventId}:`)) autoAnalysisAttempts.current.delete(key);
    }
    setAutoAnalysisIntentRevision((value) => value + 1);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const frame = window.requestAnimationFrame(() => {
      setSidebarCollapsed(readStoredId(sidebarCollapsedStorageKey) === "1");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      storeId(sidebarCollapsedStorageKey, next ? "1" : null);
      return next;
    });
  }, []);

  const navigateRoute = useCallback((nextRoute: AppRoute, mode: "push" | "replace" | "none" = "push") => {
    const normalized = normalizeAppRoute(nextRoute);
    routeRef.current = normalized;
    setRouteState(normalized);
    if (mode === "none" || typeof window === "undefined") return;
    const currentState = isRecord(window.history.state) ? window.history.state : {};
    const currentDepth = typeof currentState.notiqueDepth === "number" ? currentState.notiqueDepth : 0;
    const nextState = {
      ...currentState,
      notiqueRoute: true,
      notiqueDepth: mode === "push" ? currentDepth + 1 : currentDepth,
    };
    const url = `${window.location.pathname}${serializeAppRoute(normalized)}${window.location.hash}`;
    if (mode === "replace") window.history.replaceState(nextState, "", url);
    else window.history.pushState(nextState, "", url);
  }, []);

  const setScreen = useCallback((nextScreen: Screen, mode: "push" | "replace" | "none" = "push") => {
    navigateRoute(routeForView(routeRef.current, nextScreen), mode);
  }, [navigateRoute]);

  const invalidateNavigationRequests = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: ["notique"] });
    requestEpochs.current.projects += 1;
    requestEpochs.current.project += 1;
    requestEpochs.current.event += 1;
    requestEpochs.current.claims += 1;
    requestEpochs.current.view += 1;
    requestEpochs.current.claim += 1;
    requestEpochs.current.debug += 1;
  }, [queryClient]);

  const invalidateProjectSelectionRequests = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: ["notique"] });
    // Selecting a project owns every piece of project/event-derived UI. A
    // response from the previous selection must not be able to repopulate it.
    projectWorkflowRefreshToken.current += 1;
    requestEpochs.current.event += 1;
    requestEpochs.current.claims += 1;
    requestEpochs.current.view += 1;
    requestEpochs.current.claim += 1;
    requestEpochs.current.debug += 1;
  }, [queryClient]);

  const invalidateEventSelectionRequests = useCallback(() => {
    void queryClient.cancelQueries({ queryKey: ["notique"] });
    // Event switches keep the project selection, but invalidate every panel
    // whose contents may have been derived from the previous event.
    requestEpochs.current.claims += 1;
    requestEpochs.current.view += 1;
    requestEpochs.current.claim += 1;
    requestEpochs.current.debug += 1;
  }, [queryClient]);

  const isCurrentRequestOwner = useCallback((owner: RequestOwner) => requestOwnerIsCurrent(owner, {
    projectId: routeRef.current.projectId,
    projectEpoch: requestEpochs.current.project,
    eventId: routeRef.current.eventId,
    eventEpoch: requestEpochs.current.event,
  }), []);

  const navigateBack = useCallback(() => {
    if (typeof window !== "undefined") {
      const state = isRecord(window.history.state) ? window.history.state : {};
      if (state.notiqueRoute === true && typeof state.notiqueDepth === "number" && state.notiqueDepth > 0) {
        window.history.back();
        return;
      }
    }
    const destination = fallbackBackRoute(routeRef.current);
    invalidateNavigationRequests();
    navigateRoute(destination, "replace");
    routeRestoreAction.current(destination);
  }, [invalidateNavigationRequests, navigateRoute]);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  const requirePublicWorkspaceAcknowledgement = useCallback((action: () => void) => {
    if (publicWorkspaceAcknowledged()) {
      action();
      return;
    }
    pendingPublicWorkspaceAction.current = action;
    setShowPublicWorkspaceConfirmation(true);
  }, []);

  const confirmPublicWorkspaceAcknowledgement = useCallback(() => {
    rememberPublicWorkspaceAcknowledgement();
    setShowPublicWorkspaceConfirmation(false);
    const action = pendingPublicWorkspaceAction.current;
    pendingPublicWorkspaceAction.current = null;
    action?.();
  }, []);

  const cancelPublicWorkspaceAcknowledgement = useCallback(() => {
    pendingPublicWorkspaceAction.current = null;
    setShowPublicWorkspaceConfirmation(false);
  }, []);

  useEffect(() => {
    if (reviewSession?.status !== "active") return;
    const timer = window.setInterval(() => setReviewClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [reviewSession?.id, reviewSession?.status]);

  useEffect(() => {
    const projectId = project?.id;
    const eventId = event?.id;
    if (!projectId || !eventId) return;
    if (eventWorkflowSummaries[eventId]?.statusSummary.summaryStatus !== "succeeded") return;
    // The user commonly moves from the newly available Summary to the buyer
    // overview. Warm those read-only layers without blocking Summary or
    // starting any model/ledger mutation.
    void Promise.allSettled([
      queryClient.prefetchQuery(draftMemoryQuery(projectId)),
      queryClient.prefetchQuery(verifiedViewQuery(projectId, "folder-summary")),
    ]);
  }, [event?.id, eventWorkflowSummaries, project?.id, queryClient]);

  const loadProjects = useCallback(async () => {
    const token = requestEpochs.current.projects + 1;
    requestEpochs.current.projects = token;
    setProjectsState("loading");
    setProjectsIssue(null);
    try {
      const result = await api.listProjects();
      if (requestEpochs.current.projects !== token) return;
      setProjects(result);
      setProjectsState(result.length ? "ready" : "empty");
    } catch (error) {
      if (requestEpochs.current.projects !== token) return;
      setProjectsIssue(toIssue(error));
      setProjectsState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProjects]);

  useEffect(() => {
    const rememberedIntent = readStoredId(workflowIntentStorageKey);
    if (!rememberedIntent) return;
    const timer = window.setTimeout(() => setWorkflowIntentProjectId(rememberedIntent), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const loadProject = useCallback(async (
    projectId: string,
    nextScreen: Screen = "project",
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    invalidateProjectSelectionRequests();
    const token = requestEpochs.current.project + 1;
    requestEpochs.current.project = token;
    setProjectState("loading");
    setProjectIssue(null);
    setEventWorkflowSummaries({});
    navigateRoute({
      view: nextScreen,
      projectId,
      ...(nextScreen === "project" ? { origin: "projects" as const } : {}),
    }, historyMode);
    try {
      const [nextProject, nextEvents] = await Promise.all([api.getProject(projectId), api.listEvents(projectId)]);
      if (requestEpochs.current.project !== token) return;
      setProject(nextProject);
      setEvents(nextEvents);
      setProjectState("ready");
    } catch (error) {
      if (requestEpochs.current.project !== token) return;
      const issue = toIssue(error);
      setProjectIssue(issue);
      setProjectState("error");
      if (issue.status === 404) setProject(null);
    }
  }, [invalidateProjectSelectionRequests, navigateRoute]);

  const loadClaimsForRun = useCallback(async (runId: string) => {
    const token = requestEpochs.current.claims + 1;
    requestEpochs.current.claims = token;
    const ownerProjectId = routeRef.current.projectId || project?.id;
    const owner: RequestOwner | null = ownerProjectId
      ? {
          projectId: ownerProjectId,
          projectEpoch: requestEpochs.current.project,
          ...(routeRef.current.eventId || event?.id
            ? {
                eventId: routeRef.current.eventId || event?.id,
                eventEpoch: requestEpochs.current.event,
              }
            : {}),
        }
      : null;
    const requestIsCurrent = () => requestEpochs.current.claims === token
      && (!owner || isCurrentRequestOwner(owner));
    setClaimsState("loading");
    setClaimsIssue(null);
    try {
      const result = await api.getRunClaims(runId);
      if (!requestIsCurrent()) return;
      setClaims(result);
      setClaimsState(result.length ? "ready" : "empty");
    } catch (error) {
      if (!requestIsCurrent()) return;
      setClaimsIssue(toIssue(error));
      setClaimsState("error");
    }
  }, [event?.id, isCurrentRequestOwner, project?.id]);

  const loadTranscriptionForEvent = useCallback(async (nextEvent: Event, expectedEventEpoch?: number) => {
    const transcriptionRunRefs = transcriptionRunIdsFromEvent(nextEvent);
    if (transcriptionRunRefs.length === 0) {
      if (expectedEventEpoch != null && requestEpochs.current.event !== expectedEventEpoch) return;
      setTranscriptionRun(null);
      setTranscriptionRunsByAssetId({});
      return;
    }
    try {
      const settled = await Promise.allSettled(transcriptionRunRefs.map(async ({ audioAssetId, runId }) => ({
        audioAssetId,
        run: await api.getTranscriptionRun(runId),
      })));
      if (expectedEventEpoch != null && requestEpochs.current.event !== expectedEventEpoch) return;
      const loaded = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const hardFailure = settled.find((result) => result.status === "rejected" && toIssue(result.reason).status !== 404);
      if (hardFailure?.status === "rejected") throw hardFailure.reason;
      const byAssetId = Object.fromEntries(loaded.map(({ audioAssetId, run }) => [audioAssetId, run]));
      setTranscriptionRunsByAssetId(byAssetId);
      setTranscriptionRun(loaded.at(-1)?.run ?? null);
    } catch (error) {
      if (expectedEventEpoch != null && requestEpochs.current.event !== expectedEventEpoch) return;
      const issue = toIssue(error);
      if (issue.status === 404) {
        setTranscriptionRun(null);
        setTranscriptionRunsByAssetId({});
        return;
      }
      throw error;
    }
  }, []);

  const refreshProjectWorkflow = useCallback(async (
    projectId: string,
  ): Promise<ProjectWorkflowSnapshot | null> => {
    const owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
    };
    if (!isCurrentRequestOwner(owner)) return null;
    const token = projectWorkflowRefreshToken.current + 1;
    projectWorkflowRefreshToken.current = token;
    setProjectWorkflow((current) => current.phase === "running"
      ? current
      : { ...current, phase: "loading", issue: undefined });
    try {
      const snapshot = await inspectProjectWorkflow(projectId, loadFreshWorkflowSnapshot);
      if (projectWorkflowRefreshToken.current !== token || !isCurrentRequestOwner(owner)) return null;
      setProject(snapshot.project);
      setProjectWorkflow(snapshot.plan);
      setEventWorkflowSummaries(snapshot.eventSummaries);
      return snapshot;
    } catch (error) {
      if (projectWorkflowRefreshToken.current !== token || !isCurrentRequestOwner(owner)) return null;
      setProjectWorkflow({
        ...idleProjectWorkflow,
        phase: "error",
        issue: toIssue(error),
      });
      return null;
    }
  }, [isCurrentRequestOwner, loadFreshWorkflowSnapshot]);

  const loadSimpleProject = useCallback(async (
    projectId: string,
    preferredEventId?: string,
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    invalidateProjectSelectionRequests();
    const projectToken = requestEpochs.current.project + 1;
    const eventToken = requestEpochs.current.event + 1;
    requestEpochs.current.project = projectToken;
    requestEpochs.current.event = eventToken;
    navigateRoute({
      view: "simple",
      projectId,
      ...(preferredEventId ? { eventId: preferredEventId } : {}),
    }, historyMode);
    setProjectState("loading");
    setProjectIssue(null);
    setEvent(null);
    setEventState("idle");
    setEventIssue(null);
    setRun(null);
    setTranscriptionRun(null);
    setTranscriptionRunsByAssetId({});
    setClaims([]);
    setClaimsState("idle");
    try {
      const [nextProject, nextEvents] = await Promise.all([api.getProject(projectId), api.listEvents(projectId)]);
      if (requestEpochs.current.project !== projectToken || requestEpochs.current.event !== eventToken) return;
      setProject(nextProject);
      setEvents(nextEvents);
      setProjectState("ready");
      storeId(recentProjectStorageKey, nextProject.id);
      const rememberedEventId = preferredEventId ?? readStoredId(recentEventStorageKey(projectId));
      const target = chooseRememberedSelection(nextEvents, rememberedEventId);
      if (rememberedEventId && !nextEvents.some((item) => item.id === rememberedEventId)) {
        storeId(recentEventStorageKey(projectId), null);
      }
      if (!target) {
        setEvent(null);
        setRun(null);
        setClaims([]);
        setClaimsState("idle");
        return;
      }
      setEventState("loading");
      const nextEvent = await api.getEvent(target.id);
      if (requestEpochs.current.project !== projectToken || requestEpochs.current.event !== eventToken) return;
      setEvent(nextEvent);
      storeId(recentEventStorageKey(projectId), nextEvent.id);
      navigateRoute({ view: "simple", projectId, eventId: nextEvent.id }, historyMode === "none" ? "none" : "replace");
      setEventState("ready");
      await loadTranscriptionForEvent(nextEvent, eventToken);
      if (requestEpochs.current.project !== projectToken || requestEpochs.current.event !== eventToken) return;
      const runId = nextEvent.latestRun?.id || nextEvent.latestRunId;
      if (!runId) {
        setRun(null);
        setClaims([]);
        setClaimsState("idle");
        return;
      }
      const nextRun = await api.getRun(runId);
      if (requestEpochs.current.project !== projectToken || requestEpochs.current.event !== eventToken) return;
      setRun(nextRun);
      if (runComplete.has(nextRun.status)) await loadClaimsForRun(nextRun.id);
    } catch (error) {
      if (requestEpochs.current.project !== projectToken || requestEpochs.current.event !== eventToken) return;
      const issue = toIssue(error);
      if (issue.status === 404 || issue.status === 403) {
        storeId(recentProjectStorageKey, null);
        storeId(recentEventStorageKey(projectId), null);
        if (readStoredId(workflowIntentStorageKey) === projectId) {
          storeId(workflowIntentStorageKey, null);
          setWorkflowIntentProjectId(null);
        }
      }
      setProjectIssue(issue);
      setProjectState("error");
      setEventIssue(issue);
      setEventState("error");
    }
  }, [invalidateProjectSelectionRequests, loadClaimsForRun, loadTranscriptionForEvent, navigateRoute]);

  useEffect(() => {
    if (screen !== "simple" || project || projectsState !== "ready" || routeRef.current.projectId) return;
    const rememberedProjectId = readStoredId(recentProjectStorageKey);
    const selection = chooseRememberedSelection(projects, rememberedProjectId);
    if (!selection) return;
    if (rememberedProjectId && selection.id !== rememberedProjectId) {
      storeId(recentProjectStorageKey, null);
    }
    const timer = window.setTimeout(() => void loadSimpleProject(selection.id), 0);
    return () => window.clearTimeout(timer);
  }, [loadSimpleProject, project, projects, projectsState, screen]);

  useEffect(() => {
    if (!project?.id) {
      projectWorkflowRefreshToken.current += 1;
      return;
    }
    if (screen !== "simple") return;
    const projectId = project.id;
    const timer = window.setTimeout(() => {
      void refreshProjectWorkflow(projectId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    event?.pendingClaimCount,
    event?.pendingOccurrenceCount,
    events,
    project?.contextVersion,
    project?.id,
    project?.pendingClaimCount,
    project?.pendingOccurrenceCount,
    project?.scenarioVersion,
    refreshProjectWorkflow,
    run?.id,
    run?.status,
    screen,
  ]);

  useEffect(() => {
    if (
      screen !== "simple"
      || !project?.id
      || projectWorkflow.phase !== "running"
      || !projectWorkflow.currentRunId
    ) return;
    const projectId = project.id;
    const runId = projectWorkflow.currentRunId;
    if (run?.id === runId && runInProgress.has(run.status)) return;
    void api.kickDispatcher({ kind: "extraction", runId }).catch(() => undefined);
    let attempts = 0;
    const timer = window.setInterval(async () => {
      if (attempts >= 360) {
        window.clearInterval(timer);
        const issue: ApiIssue = {
          code: "EXTRACTION_POLL_TIMEOUT",
          message: "页面等待时间已到，但同一个任务仍在后台运行。材料和任务都已保留；点击“重新检查”不会创建新的付费任务。",
          status: 408,
        };
        setEventIssue(issue);
        setProjectWorkflow((current) => current.currentRunId === runId ? { ...current, issue } : current);
        return;
      }
      attempts += 1;
      try {
        const latestRun = await api.getRun(runId);
        if (!runInProgress.has(latestRun.status)) {
          window.clearInterval(timer);
          await refreshProjectWorkflow(projectId);
        }
      } catch (error) {
        const issue = toIssue(error);
        if (issue.status >= 500 || issue.status === 0) return;
        window.clearInterval(timer);
        setProjectWorkflow((current) => current.currentRunId === runId
          ? { ...current, phase: "error", issue }
          : current);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [
    project?.id,
    projectWorkflow.currentRunId,
    projectWorkflow.phase,
    refreshProjectWorkflow,
    run?.id,
    run?.status,
    screen,
  ]);

  const loadEvent = useCallback(async (
    eventId: string,
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    invalidateEventSelectionRequests();
    const token = requestEpochs.current.event + 1;
    requestEpochs.current.event = token;
    setEventState("loading");
    setEventIssue(null);
    setClaims([]);
    setOccurrenceCandidates([]);
    setClaimsState("idle");
    navigateRoute({
      view: "event",
      ...(project?.id || routeRef.current.projectId ? { projectId: project?.id || routeRef.current.projectId } : {}),
      eventId,
      origin: "project",
    }, historyMode);
    try {
      const nextEvent = await api.getEvent(eventId);
      if (requestEpochs.current.event !== token) return;
      setEvent(nextEvent);
      setEventState("ready");
      await loadTranscriptionForEvent(nextEvent, token);
      if (requestEpochs.current.event !== token) return;
      const runId = nextEvent.latestRun?.id || nextEvent.latestRunId;
      if (runId) {
        const nextRun = await api.getRun(runId);
        if (requestEpochs.current.event !== token) return;
        setRun(nextRun);
        if (runComplete.has(nextRun.status)) await loadClaimsForRun(nextRun.id);
      } else {
        setRun(null);
        setClaims([]);
        setClaimsState("idle");
      }
    } catch (error) {
      if (requestEpochs.current.event !== token) return;
      setEventIssue(toIssue(error));
      setEventState("error");
    }
  }, [invalidateEventSelectionRequests, loadClaimsForRun, loadTranscriptionForEvent, navigateRoute, project?.id]);

  const queuedExtractionRunId = run?.id;
  const queuedExtractionRunStatus = run?.status;

  useEffect(() => {
    if (!queuedExtractionRunId) return;
    if (!runInProgress.has(queuedExtractionRunStatus ?? "")) {
      localDispatchRuns.current.delete(queuedExtractionRunId);
      return;
    }
    if (queuedExtractionRunStatus === "queued" && !localDispatchRuns.current.has(queuedExtractionRunId)) {
      localDispatchRuns.current.add(queuedExtractionRunId);
      void api.kickDispatcher({ kind: "extraction", runId: queuedExtractionRunId }).catch(() => {
      // The durable Run remains queued when an explicit dispatch request fails,
      // so polling and the scheduled sweeper can recover without duplicating it.
      });
    }
    const runId = queuedExtractionRunId;
    let stopped = false;
    let wakeTimer: number | null = null;
    const scheduleWake = () => {
      wakeTimer = window.setTimeout(() => {
        void api.getRun(runId).then(async (latest) => {
          if (stopped || !runInProgress.has(latest.status)) return;
          // A queued Run needs starting; a processing Run may hold a durable
          // OpenAI background Response that needs a cheap GET-based resume.
          await api.kickDispatcher({ kind: "extraction", runId }).catch(() => undefined);
          if (!stopped) scheduleWake();
        }).catch(() => {
          if (!stopped) scheduleWake();
        });
      }, ACTIVE_BACKGROUND_WAKE_MS);
    };
    scheduleWake();
    return () => {
      stopped = true;
      if (wakeTimer !== null) window.clearTimeout(wakeTimer);
    };
  }, [queuedExtractionRunId, queuedExtractionRunStatus]);

  const queuedTranscriptionRunId = transcriptionRun?.id;
  const queuedTranscriptionRunStatus = transcriptionRun?.status;

  useEffect(() => {
    if (!queuedTranscriptionRunId) return;
    if (queuedTranscriptionRunStatus !== "queued") {
      localDispatchTranscriptionRuns.current.delete(queuedTranscriptionRunId);
      return;
    }
    if (!localDispatchTranscriptionRuns.current.has(queuedTranscriptionRunId)) {
      localDispatchTranscriptionRuns.current.add(queuedTranscriptionRunId);
      void api.kickDispatcher({ kind: "transcription", runId: queuedTranscriptionRunId }).catch(() => {
      // The durable transcription Run remains recoverable by the same endpoint
      // or the scheduled sweeper.
      });
    }
    const runId = queuedTranscriptionRunId;
    const wakeTimer = window.setTimeout(() => {
      void api.getTranscriptionRun(runId).then((latest) => {
        if (latest.status !== "queued") return;
        return api.kickDispatcher({ kind: "transcription", runId });
      }).catch(() => undefined);
    }, 15_000);
    return () => window.clearTimeout(wakeTimer);
  }, [queuedTranscriptionRunId, queuedTranscriptionRunStatus]);

  const activeTranscriptionRunId = transcriptionRun?.id;
  const activeTranscriptionRunStatus = transcriptionRun?.status;
  const activeTranscriptionRunChunkCount = transcriptionRun?.chunkCount;

  useEffect(() => {
    if (!activeTranscriptionRunId || !runInProgress.has(activeTranscriptionRunStatus ?? "")) return;
    const runId = activeTranscriptionRunId;
    const projectId = routeRef.current.projectId || project?.id;
    const eventId = routeRef.current.eventId || event?.id;
    if (!projectId || !eventId) return;
    const owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
      eventId,
      eventEpoch: requestEpochs.current.event,
    };
    const pollKey = `${runId}:${transcriptionPollCycle}`;
    if (transcriptionPollingRunKey.current !== pollKey) {
      transcriptionPollingRunKey.current = pollKey;
      transcriptionPollAttempts.current = 0;
    }
    const pollStartedAt = Date.now();
    let cancelled = false;
    let timer: number | undefined;
    const requestIsCurrent = () => !cancelled && isCurrentRequestOwner(owner);
    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => void poll(), runPollDelayMs(Date.now() - pollStartedAt));
    };
    const poll = async () => {
      if (cancelled) return;
      const pollTimeoutMs = activeTranscriptionRunChunkCount && activeTranscriptionRunChunkCount > 1
        ? 30 * 60_000
        : 10 * 60_000;
      if (Date.now() - pollStartedAt >= pollTimeoutMs) {
        setEventIssue({
          code: "TRANSCRIPTION_POLL_TIMEOUT",
          message: "等待逐字稿的时间过长。录音已经保存，可以重新检查后台状态；如果服务器已经标记失败，也可以重新转写。",
          status: 408,
        });
        return;
      }
      transcriptionPollAttempts.current += 1;
      try {
        const latest = await api.getTranscriptionRun(runId);
        if (!requestIsCurrent()) return;
        if (!runInProgress.has(latest.status)) {
          if (latest.status === "succeeded") {
            // Do not publish the terminal Run before its parent Event and
            // workflow summary have been reloaded. Publishing it first tears
            // down this polling effect and used to cancel the ready-state
            // refresh, leaving a completed transcript labelled "transcribing".
            const [refreshed, workflowSnapshot] = await Promise.all([
              api.getEvent(eventId),
              inspectProjectWorkflow(projectId, loadFreshWorkflowSnapshot),
            ]);
            if (!requestIsCurrent()) return;
            setTranscriptionRun(latest);
            setTranscriptionRunsByAssetId((current) => ({ ...current, [latest.audioAssetId]: latest }));
            setEvent(refreshed);
            setProject(workflowSnapshot.project);
            setEvents(workflowSnapshot.events);
            setProjectWorkflow(workflowSnapshot.plan);
            setEventWorkflowSummaries(workflowSnapshot.eventSummaries);
            setEventIssue(null);
            flash(`逐字稿已生成，包含 ${latest.segmentCount ?? latest.segments.length} 个带时间点的片段`);
          } else if (latest.status === "failed") {
            setTranscriptionRun(latest);
            setTranscriptionRunsByAssetId((current) => ({ ...current, [latest.audioAssetId]: latest }));
            setEventIssue({
              code: latest.errorCode || "TRANSCRIPTION_FAILED",
              message: "录音仍然保留在这次沟通中。请检查错误后点击“重新转写”。",
              status: 502,
            });
          }
          return;
        }
        setTranscriptionRun(latest);
        setTranscriptionRunsByAssetId((current) => ({ ...current, [latest.audioAssetId]: latest }));
        if (latest.orchestrationMode === "chunked" && latest.status === "processing") {
          wakeChunkedTranscription(latest.id);
        }
      } catch (error) {
        if (!requestIsCurrent()) return;
        const issue = toIssue(error);
        if (issue.status >= 500 || issue.status === 0) {
          schedule();
          return;
        }
        setEventIssue(issue);
        return;
      }
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeTranscriptionRunChunkCount, activeTranscriptionRunId, activeTranscriptionRunStatus, event?.id, flash, isCurrentRequestOwner, loadFreshWorkflowSnapshot, project?.id, transcriptionPollCycle]);

  const secondaryTranscriptionRuns = Object.values(transcriptionRunsByAssetId)
    .filter((item) => item.id !== activeTranscriptionRunId && runInProgress.has(item.status));
  const secondaryTranscriptionRunKey = secondaryTranscriptionRuns
    .map((item) => `${item.id}:${item.status}:${item.completedChunkCount}`)
    .sort()
    .join("|");

  useEffect(() => {
    if (!secondaryTranscriptionRunKey) return;
    const projectId = routeRef.current.projectId || project?.id;
    const eventId = routeRef.current.eventId || event?.id;
    if (!projectId || !eventId) return;
    const owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
      eventId,
      eventEpoch: requestEpochs.current.event,
    };
    const runsToPoll = secondaryTranscriptionRuns.map((item) => ({
      id: item.id,
      eventId: item.eventId,
    }));
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const settled = await Promise.allSettled(runsToPoll.map(async ({ id }) => {
        const latest = await api.getTranscriptionRun(id);
        if (runInProgress.has(latest.status)) {
          if (latest.status === "queued" || latest.orchestrationMode === "chunked") {
            wakeChunkedTranscription(latest.id);
          }
        }
        return latest;
      }));
      if (cancelled || !isCurrentRequestOwner(owner)) return;
      const latestRuns = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const completedCurrentEvent = latestRuns.some((item) => item.eventId === eventId && item.status === "succeeded");
      let refreshed: Event | null = null;
      let workflowSnapshot: ProjectWorkflowSnapshot | null = null;
      if (completedCurrentEvent) {
        [refreshed, workflowSnapshot] = await Promise.all([
          api.getEvent(eventId).catch(() => null),
          inspectProjectWorkflow(projectId, loadFreshWorkflowSnapshot).catch(() => null),
        ]);
      }
      if (cancelled || !isCurrentRequestOwner(owner)) return;
      if (latestRuns.length > 0) {
        setTranscriptionRunsByAssetId((current) => ({
          ...current,
          ...Object.fromEntries(latestRuns.map((item) => [item.audioAssetId, item])),
        }));
      }
      if (refreshed) setEvent(refreshed);
      if (workflowSnapshot) {
        setProject(workflowSnapshot.project);
        setEvents(workflowSnapshot.events);
        setProjectWorkflow(workflowSnapshot.plan);
        setEventWorkflowSummaries(workflowSnapshot.eventSummaries);
      }
      if (!cancelled && latestRuns.some((item) => runInProgress.has(item.status))) {
        timer = window.setTimeout(() => void poll(), 2_000);
      }
    };
    for (const item of secondaryTranscriptionRuns) {
      if (item.status === "queued" || item.orchestrationMode === "chunked") wakeChunkedTranscription(item.id);
    }
    timer = window.setTimeout(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // The stable key intentionally owns the polling lifetime; the captured
    // list is refreshed whenever any secondary Run changes state or progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondaryTranscriptionRunKey, event?.id, isCurrentRequestOwner, loadFreshWorkflowSnapshot, project?.id]);

  const activeExtractionRunId = run?.id;
  const activeExtractionRunStatus = run?.status;

  useEffect(() => {
    if (!activeExtractionRunId || !runInProgress.has(activeExtractionRunStatus ?? "")) return;
    const runId = activeExtractionRunId;
    const projectId = routeRef.current.projectId || project?.id;
    const eventId = routeRef.current.eventId || event?.id;
    if (!projectId || !eventId) return;
    const owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
      eventId,
      eventEpoch: requestEpochs.current.event,
    };
    const pollKey = `${runId}:${runPollCycle}`;
    if (pollingRunKey.current !== pollKey) {
      pollingRunKey.current = pollKey;
      pollAttempts.current = 0;
    }
    const pollStartedAt = Date.now();
    let cancelled = false;
    let timer: number | undefined;
    const pollIsCurrent = () => !cancelled && isCurrentRequestOwner(owner);
    const schedule = () => {
      if (!pollIsCurrent()) return;
      timer = window.setTimeout(() => void poll(), runPollDelayMs(Date.now() - pollStartedAt));
    };
    const poll = async () => {
      if (!pollIsCurrent()) return;
      // The frozen two-stage Run can legitimately include two long reasoning
      // calls plus one escalation. Stop foreground waiting after 30 minutes,
      // but keep the durable server Run untouched and recoverable.
      if (Date.now() - pollStartedAt >= 30 * 60_000) {
        const issue: ApiIssue = {
          code: "EXTRACTION_POLL_TIMEOUT",
          message: "页面等待时间已到，但同一个任务仍在后台运行。材料和任务都已保留；点击“重新检查”不会创建新的付费任务。",
          status: 408,
        };
        if (pollIsCurrent()) {
          setEventIssue(issue);
          setProjectWorkflow((current) => current.currentRunId === runId ? { ...current, issue } : current);
        }
        return;
      }
      pollAttempts.current += 1;
      try {
        const [latest, workflowSnapshot] = await Promise.all([
          api.getRun(runId),
          // Summary and readable transcript finish independently from the fact
          // pipeline. Reuse the server-owned snapshot while this Run is
          // already being polled so the UI can surface them without starting
          // another job or inventing a second source of workflow state.
          loadWorkflowSnapshot(projectId, true).catch(() => null),
        ]);
        if (!pollIsCurrent()) return;
        if (workflowSnapshot) {
          setEventWorkflowSummaries(Object.fromEntries(
            workflowSnapshot.events.map((item) => [item.id, item]),
          ));
        }
        const latestStillRunning = runInProgress.has(latest.status);
        if (latestStillRunning) setRun(latest);
        if (runNeedsRecovery({
          status: latest.status,
          createdAt: latest.createdAt,
          queuedAt: latest.queuedAt,
          startedAt: latest.startedAt,
          finishedAt: latest.finishedAt,
          stages: latest.stages,
        }) && !staleRecoveryRuns.current.has(runId)) {
          staleRecoveryRuns.current.add(runId);
          flash("检测到事实识别长时间没有更新，正在检查并恢复同一个后台任务");
          void api.kickDispatcher({ kind: "extraction", runId }).finally(() => {
            if (pollIsCurrent()) setRunPollCycle((value) => value + 1);
          });
          return;
        }
        if (!latestStillRunning) {
          if (runComplete.has(latest.status)) {
            setEventIssue(null);
            await loadClaimsForRun(latest.id);
            if (!pollIsCurrent()) return;
            // Fetch both terminal refreshes without mutating React state. If
            // Project committed first it changed this effect's `project`
            // dependency, cancelled the effect, and permanently dropped a
            // slower Event refresh plus the terminal Run commit.
            const [refreshedProject, refreshedEvent] = await Promise.all([
              api.getProject(projectId),
              api.getEvent(eventId),
            ]);
            if (pollIsCurrent()) {
              // Commit one coherent terminal snapshot. No partial Project or
              // Event state can trigger cleanup before all three values land.
              setProject(refreshedProject);
              setEvent(refreshedEvent);
              setRun(latest);
              guidedTransitionAction.current(
                refreshedProject?.scenarioStatus === "confirmed"
                  ? "draft_ready"
                  : "waiting_scenario",
              );
            }
          } else if (latest.status === "failed") {
            if (pollIsCurrent()) {
              setRun(latest);
              setEventIssue({
                code: latest.errorCode || "EXTRACTION_FAILED",
                message: latest.errorMessage || "这次分析没有完成。材料仍然保留，可以直接重新分析。",
                status: 502,
              });
            }
          }
          return;
        }
      } catch (error) {
        if (!pollIsCurrent()) return;
        const issue = toIssue(error);
        if (issue.status >= 500 || issue.status === 0) {
          schedule();
          return;
        }
        setClaimsIssue(issue);
        setProjectWorkflow((current) => current.currentRunId === runId
          ? { ...current, phase: "error", issue }
          : current);
        return;
      }
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeExtractionRunId, activeExtractionRunStatus, event?.id, flash, isCurrentRequestOwner, loadClaimsForRun, loadWorkflowSnapshot, project, runPollCycle]);

  const syncReviewTiming = useCallback(async (
    latestProject: Project,
    requestIsCurrent: () => boolean = () => true,
  ) => {
    const pendingTotal = latestProject.pendingClaimCount + latestProject.pendingOccurrenceCount;
    if (pendingTotal > 0) {
      const fingerprint = `review-start:${latestProject.id}`;
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      try {
        const started = await api.startReviewSession(latestProject.id, idempotencyKey);
        if (requestIsCurrent()) setReviewSession(started);
      } catch (error) {
        const issue = toIssue(error);
        if (issue.code !== "REVIEW_SESSION_CONFLICT") throw error;
        const existing = await api.getReviewSession(latestProject.id);
        if (requestIsCurrent()) setReviewSession(existing);
      }
      return;
    }
    let latest = await api.getReviewSession(latestProject.id);
    if (latest?.status === "active" && !completingReviewSessions.current.has(latest.id)) {
      completingReviewSessions.current.add(latest.id);
      const fingerprint = `review-complete:${latest.id}`;
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      try {
        latest = await api.completeReviewSession(latest.id, idempotencyKey);
        mutationKeys.current.delete(fingerprint);
        if (requestIsCurrent()) flash(`本次审核完成，用时 ${formatReviewDuration(latest.durationMs ?? 0)}`);
      } finally {
        completingReviewSessions.current.delete(latest.id);
      }
    }
    if (requestIsCurrent()) setReviewSession(latest);
    if (latest?.status === "completed") mutationKeys.current.delete(`review-start:${latestProject.id}`);
  }, [flash]);

  const refreshReviewSnapshotInBackground = useCallback((targetProjectId: string) => {
    const token = reviewRefreshEpoch.current + 1;
    reviewRefreshEpoch.current = token;
    const requestIsCurrent = () => reviewRefreshEpoch.current === token
      && routeRef.current.projectId === targetProjectId;
    void (async () => {
      try {
        await invalidateProjectReadModels(targetProjectId);
        const [latestProject, latestEvents] = await Promise.all([
          api.getProject(targetProjectId),
          api.listEvents(targetProjectId),
        ]);
        if (!requestIsCurrent()) return;
        setProject(latestProject);
        setEvents(latestEvents);
        await syncReviewTiming(latestProject, requestIsCurrent);
      } catch {
        // The verdict is already durable. Counts and the server-owned review
        // timer will reconcile on the next queue/workflow refresh.
      }
    })();
  }, [invalidateProjectReadModels, syncReviewTiming]);

  const loadReviewQueue = useCallback(async (
    destination: "review" | "draft" = "review",
    projectIdOverride?: string,
    historyMode: "push" | "replace" | "none" = "push",
  ): Promise<ReviewQueueSnapshot | null> => {
    const targetProjectId = projectIdOverride || project?.id || routeRef.current.projectId;
    if (!targetProjectId) return null;
    const token = requestEpochs.current.claims + 1;
    requestEpochs.current.claims = token;
    const owner: RequestOwner = {
      projectId: targetProjectId,
      projectEpoch: requestEpochs.current.project,
    };
    const requestIsCurrent = () => requestEpochs.current.claims === token
      && isCurrentRequestOwner(owner);
    navigateRoute({
      view: destination,
      projectId: targetProjectId,
      ...(event?.id || routeRef.current.eventId ? { eventId: event?.id || routeRef.current.eventId } : {}),
      origin: destination === "draft" ? "simple" : "draft",
    }, historyMode);
    setClaimsState("loading");
    setClaimsIssue(null);
    try {
      const [latestProject, latestEvents] = await Promise.all([
        api.getProject(targetProjectId),
        api.listEvents(targetProjectId),
      ]);
      if (!requestIsCurrent()) return null;
      setProject(latestProject);
      setEvents(latestEvents);
      const runIds = [...new Set(latestEvents.map((item) => item.latestRun?.id || item.latestRunId).filter((value): value is string => Boolean(value)))];
      if (!runIds.length) {
        setClaims([]);
        setOccurrenceCandidates([]);
        setClaimsState("empty");
        await syncReviewTiming(latestProject, requestIsCurrent);
        if (!requestIsCurrent()) return null;
        return { project: latestProject, claims: [], occurrenceCandidates: [] };
      }
      const results = await Promise.allSettled(runIds.map((runId) => api.getRunReview(runId)));
      if (!requestIsCurrent()) return null;
      const failed = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
      const foundClaims = results.flatMap((item) => item.status === "fulfilled" ? item.value.claims : []);
      const foundOccurrences = results.flatMap((item) => item.status === "fulfilled" ? item.value.occurrenceCandidates : []);
      if (failed && !foundClaims.length && !foundOccurrences.length) throw failed.reason;
      const uniqueClaims = sortClaimsForReview(
        [...new Map(foundClaims.map((item) => [item.id, item])).values()],
      );
      const uniqueOccurrences = [...new Map(foundOccurrences.map((item) => [item.id, item])).values()];
      setClaims(uniqueClaims);
      setOccurrenceCandidates(uniqueOccurrences);
      setClaimsState(uniqueClaims.length || uniqueOccurrences.length ? "ready" : "empty");
      if (!requestIsCurrent()) return null;
      await syncReviewTiming(latestProject, requestIsCurrent);
      if (!requestIsCurrent()) return null;
      return {
        project: latestProject,
        claims: uniqueClaims,
        occurrenceCandidates: uniqueOccurrences,
      };
    } catch (error) {
      if (!requestIsCurrent()) return null;
      setClaimsIssue(toIssue(error));
      setClaimsState("error");
      return null;
    }
  }, [event?.id, isCurrentRequestOwner, navigateRoute, project?.id, syncReviewTiming]);

  const loadView = useCallback(async (
    tab: ResultTab,
    projectIdOverride?: string,
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    const targetProjectId = projectIdOverride || project?.id || routeRef.current.projectId;
    if (!targetProjectId) return;
    const token = requestEpochs.current.view + 1;
    requestEpochs.current.view = token;
    const loadStartedAt = performance.now();
    setViewTab(tab);
    const currentOrigin = routeRef.current.view === "results"
      ? routeRef.current.origin
      : routeRef.current.view === "simple"
        ? "simple"
        : "project";
    navigateRoute({
      view: "results",
      projectId: targetProjectId,
      ...(event?.id || routeRef.current.eventId ? { eventId: event?.id || routeRef.current.eventId } : {}),
      tab,
      origin: currentOrigin,
    }, historyMode);
    setViewState("loading");
    setViewIssue(null);
    setViewLoadDurationMs(null);
    try {
      const loadVerifiedView = (projectId: string, view: ProjectViewName) =>
        queryClient.fetchQuery(verifiedViewQuery(projectId, view));
      const keepCurrentProjectContext = project?.id === targetProjectId;
      const [result, nextProject, nextEvents] = await Promise.all([
        tab === "client-progress"
          ? Promise.all([
              queryClient.fetchQuery(draftMemoryQuery(targetProjectId)),
              loadVerifiedView(targetProjectId, "folder-summary"),
            ]).then(([draftMemory, verified]) => ({ draft_memory: draftMemory, verified }))
          : tab === "actions"
            ? queryClient.fetchQuery(projectActionsQuery(targetProjectId)).then((items) => ({ items }))
          : tab === "brief-card"
          ? loadBriefDisplayData(targetProjectId, loadVerifiedView)
          : loadVerifiedView(targetProjectId, tab),
        keepCurrentProjectContext && project ? Promise.resolve(project) : api.getProject(targetProjectId),
        keepCurrentProjectContext ? Promise.resolve(events) : api.listEvents(targetProjectId),
      ]);
      if (requestEpochs.current.view !== token) return;
      setProject(nextProject);
      setEvents(nextEvents);
      setViewData(result);
      const briefReady = tab === "brief-card" && isRecord(result) && Boolean(
        result.stateItem ||
        result.riskItem ||
        recordArray(result.deltaItems).length ||
        recordArray(result.agendaItems).length,
      );
      setViewState(
        objectItems(result).length ||
        (isRecord(result) && (result.summary || result.folder_summary)) ||
        briefReady
          ? "ready"
          : "empty",
      );
    } catch (error) {
      if (requestEpochs.current.view !== token) return;
      const issue = toIssue(error);
      setViewIssue(issue);
      setViewState(issue.status === 404 ? "empty" : "error");
      setViewData(null);
    } finally {
      if (requestEpochs.current.view !== token) return;
      setViewLoadDurationMs(Math.max(0, Math.round(performance.now() - loadStartedAt)));
    }
  }, [event?.id, events, navigateRoute, project, queryClient]);

  const openRunDebug = useCallback(async (
    runId: string,
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    const token = requestEpochs.current.debug + 1;
    requestEpochs.current.debug = token;
    navigateRoute({
      view: "run-debug",
      ...(project?.id || routeRef.current.projectId ? { projectId: project?.id || routeRef.current.projectId } : {}),
      ...(event?.id || routeRef.current.eventId ? { eventId: event?.id || routeRef.current.eventId } : {}),
      runId,
      origin: "event",
    }, historyMode);
    setRunDebugState("loading");
    setRunDebugIssue(null);
    setRunDebug(null);
    try {
      const result = await api.getRunDebug(runId);
      if (requestEpochs.current.debug !== token) return;
      setRunDebug(result);
      setRunDebugState("ready");
    } catch (error) {
      if (requestEpochs.current.debug !== token) return;
      setRunDebugIssue(toIssue(error));
      setRunDebugState("error");
    }
  }, [event?.id, navigateRoute, project?.id]);

  async function openClaim(
    claimOrVersionId: string,
    origin?: AppRouteOrigin,
    projectIdOverride?: string,
    historyMode: "push" | "replace" | "none" = "push",
    originReadingTab?: AppReadingTab,
  ) {
    const token = requestEpochs.current.claim + 1;
    requestEpochs.current.claim = token;
    let listClaim = claims.find((item) => item.id === claimOrVersionId || item.versionId === claimOrVersionId) ?? null;
    let nextClaim: Claim | null = null;
    setBusyAction("open-claim");
    try {
      let lookupId = listClaim?.id ?? claimOrVersionId;
      let history: unknown;
      try {
        history = await queryClient.fetchQuery(claimHistoryQuery(lookupId, listClaim?.versionId));
      } catch (error) {
        const issue = toIssue(error);
        const targetProjectId = projectIdOverride || project?.id || routeRef.current.projectId;
        if (!targetProjectId || issue.status !== 404) throw error;
        const [summaryView, timelineView] = await Promise.all([
          queryClient.fetchQuery(verifiedViewQuery(targetProjectId, "folder-summary")),
          queryClient.fetchQuery(verifiedViewQuery(targetProjectId, "timeline")),
        ]);
        if (requestEpochs.current.claim !== token) return;
        listClaim = [...claimsFromVerifiedView(summaryView), ...claimsFromVerifiedView(timelineView)]
          .find((item) => item.id === claimOrVersionId || item.versionId === claimOrVersionId) ?? null;
        if (!listClaim) throw error;
        lookupId = listClaim.id;
        history = await queryClient.fetchQuery(claimHistoryQuery(lookupId, listClaim.versionId));
      }
      if (isRecord(history)) {
        const detailed = normalizeClaim(history.current_claim ?? history.claim ?? history);
        nextClaim = {
          ...detailed,
          eventTitle: detailed.eventTitle ?? listClaim?.eventTitle,
          evidenceRefs: detailed.evidenceRefs.length ? detailed.evidenceRefs : listClaim?.evidenceRefs ?? [],
        };
      }
    } catch (error) {
      if (requestEpochs.current.claim !== token) return;
      setClaimsIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
    if (!nextClaim?.id || requestEpochs.current.claim !== token) return;
    const resolvedOrigin = origin
      ?? (routeRef.current.view === "draft"
        ? "draft"
        : routeRef.current.view === "results"
          ? "results"
          : routeRef.current.view === "event"
            ? "event"
            : "review");
    setSelectedClaim(nextClaim);
    navigateRoute({
      view: "claim",
      ...(projectIdOverride || project?.id || routeRef.current.projectId ? { projectId: projectIdOverride || project?.id || routeRef.current.projectId } : {}),
      ...(nextClaim.eventId || event?.id || routeRef.current.eventId ? { eventId: nextClaim.eventId || event?.id || routeRef.current.eventId } : {}),
      claimId: nextClaim.id,
      origin: resolvedOrigin,
      ...(resolvedOrigin === "results" ? { originTab: viewTab } : {}),
      ...(resolvedOrigin === "simple" && originReadingTab ? { originReadingTab } : {}),
    }, historyMode);
    setEvidence([]);
    setEvidenceState("loading");
    try {
      const embedded = nextClaim.evidenceRefs;
      const missingIds = nextClaim.evidenceRefIds.filter((id) => !embedded.some((item) => item.id === id));
      const fetched = await Promise.allSettled(
        missingIds.map((id) => queryClient.fetchQuery(evidenceQuery(id))),
      );
      if (requestEpochs.current.claim !== token) return;
      const refs = [...embedded, ...fetched.flatMap((item) => item.status === "fulfilled" ? [item.value] : [])];
      setEvidence(refs);
      const everyFetchSucceeded = fetched.every((item) => item.status === "fulfilled");
      setEvidenceState(
        isCompleteEvidenceSet(nextClaim.evidenceRefIds, refs, everyFetchSucceeded)
          ? "ready"
          : nextClaim.evidenceRefIds.length === 0
            ? "empty"
            : "error",
      );
      refs.forEach((ref) => {
        void queryClient.prefetchQuery(evidenceContextQuery(ref.id));
      });
      const followingClaimId = nextPendingClaimId(claims, nextClaim.id);
      const followingClaim = claims.find((item) => item.id === followingClaimId);
      if (followingClaim) {
        void queryClient.prefetchQuery(claimHistoryQuery(followingClaim.id, followingClaim.versionId));
        followingClaim.evidenceRefIds.forEach((id) => {
          void queryClient.prefetchQuery(evidenceQuery(id));
          void queryClient.prefetchQuery(evidenceContextQuery(id));
        });
      }
    } catch {
      if (requestEpochs.current.claim !== token) return;
      setEvidenceState("error");
    }
  }

  async function openClaimFromTranscriptSummary(claimId: string) {
    const sourceEventId = event?.id || routeRef.current.eventId;
    if (sourceEventId && typeof window !== "undefined") {
      summaryReturnContext.current = {
        eventId: sourceEventId,
        scrollY: window.scrollY,
      };
      // Persist the reading surface in the current history entry before the
      // Claim entry is pushed. Browser Back can then restore Summary even
      // after the Claim page itself has been reloaded.
      navigateRoute({
        ...routeRef.current,
        view: "simple",
        eventId: sourceEventId,
        readingTab: "summary",
      }, "replace");
    }
    await openClaim(claimId, "simple", undefined, "push", "summary");
  }

  async function finishGuidedReview() {
    if (!project) return;
    const projectId = project.id;
    const owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
      eventId: routeRef.current.eventId,
      eventEpoch: requestEpochs.current.event,
    };
    const [snapshot, latestReviewSession] = await Promise.all([
      inspectProjectWorkflow(projectId, loadFreshWorkflowSnapshot),
      api.getReviewSession(projectId),
    ]);
    if (!isCurrentRequestOwner(owner)) return;
    setProject(snapshot.project);
    setEvents(snapshot.events);
    setProjectWorkflow(snapshot.plan);
    setEventWorkflowSummaries(snapshot.eventSummaries);
    if (latestReviewSession) setReviewSession(latestReviewSession);
    setReviewSummaryDestination(null);
    if (snapshot.plan.phase === "complete") {
      storeId(workflowIntentStorageKey, null);
      setWorkflowIntentProjectId(null);
      flash("整组沟通已经核对完成，正在打开会前速览");
      await loadView("brief-card", projectId, "replace");
      return;
    }
    if (snapshot.plan.currentEventId) {
      const nextEvent = snapshot.events.find((item) => item.id === snapshot.plan.currentEventId);
      armAutoAnalysis(snapshot.plan.currentEventId, undefined, nextEvent?.latestRun?.id || nextEvent?.latestRunId);
      await loadSimpleProject(projectId, snapshot.plan.currentEventId, "replace");
      flash("下一次沟通已准备好，正在自动开始分析");
      return;
    }
    await loadSimpleProject(projectId, event?.id, "replace");
  }

  async function continueAfterReviewSummary() {
    if (!project || !reviewSummaryDestination) return;
    if (reviewSummaryDestination.complete) {
      storeId(workflowIntentStorageKey, null);
      setWorkflowIntentProjectId(null);
      flash("整组沟通已经核对完成，正在打开会前速览");
      await loadView("brief-card");
    } else if (reviewSummaryDestination.nextEventId) {
      const nextEvent = events.find((item) => item.id === reviewSummaryDestination.nextEventId);
      armAutoAnalysis(reviewSummaryDestination.nextEventId, undefined, nextEvent?.latestRun?.id || nextEvent?.latestRunId);
      await loadSimpleProject(project.id, reviewSummaryDestination.nextEventId);
      flash("下一次沟通已准备好，正在自动开始分析");
    } else {
      await loadSimpleProject(project.id, event?.id);
    }
    setReviewSummaryDestination(null);
  }

  async function enterAiDraft() {
    const snapshot = await loadReviewQueue("draft");
    if (!snapshot) return;
    const owner: RequestOwner = {
      projectId: snapshot.project.id,
      projectEpoch: requestEpochs.current.project,
    };
    const currentRunId = projectWorkflow.currentRunId
      || event?.latestRun?.id
      || event?.latestRunId
      || run?.id;
    if (currentRunId) {
      try {
        const assessment = await api.getAiDraftAssessment(currentRunId);
        if (isCurrentRequestOwner(owner)) setDraftAssessment(assessment);
      } catch (error) {
        if (isCurrentRequestOwner(owner)) setClaimsIssue(toIssue(error));
      }
    } else if (isCurrentRequestOwner(owner)) {
      setDraftAssessment(null);
    }
  }

  async function enterContinuousReview() {
    const snapshot = await loadReviewQueue("review");
    if (!snapshot) return;
    const firstPending = snapshot.claims.find((item) => item.reviewStatus === "pending");
    if (firstPending) {
      await openClaim(firstPending.id, "review");
      return;
    }
    if (snapshot.occurrenceCandidates.some((item) => item.status === "pending")) {
      setScreen("review", "replace");
      return;
    }
    await finishGuidedReview();
  }

  async function continueFromDraftWithoutReview() {
    if (!project) return;
    const projectId = project.id;
    const owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
      eventId: routeRef.current.eventId,
      eventEpoch: requestEpochs.current.event,
    };
    const snapshot = await inspectProjectWorkflow(projectId, loadFreshWorkflowSnapshot);
    if (!isCurrentRequestOwner(owner)) return;
    setProject(snapshot.project);
    setEvents(snapshot.events);
    setProjectWorkflow(snapshot.plan);
    setEventWorkflowSummaries(snapshot.eventSummaries);
    if (snapshot.plan.phase === "ready" && snapshot.plan.currentEventId) {
      const nextEvent = snapshot.events.find((item) => item.id === snapshot.plan.currentEventId);
      armAutoAnalysis(snapshot.plan.currentEventId, undefined, nextEvent?.latestRun?.id || nextEvent?.latestRunId);
      await loadSimpleProject(projectId, snapshot.plan.currentEventId, "replace");
      flash("下一次沟通已准备好，正在自动开始分析");
      return;
    }
    if (snapshot.plan.phase === "draft_ready" || snapshot.plan.phase === "partially_reviewed") {
      await loadView("client-progress", projectId, "replace");
      return;
    }
    await loadSimpleProject(projectId, event?.id, "replace");
  }

  guidedTransitionAction.current = (phase) => {
    if (!isCoreWorkflowRoute(routeRef.current)) return;
    if (phase === "waiting_scenario") {
      document.querySelector(".simple-scenario-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (phase === "waiting_review" || phase === "draft_ready" || phase === "partially_reviewed") {
      // Summary-first navigation is owned by the current workspace surface.
      // When facts finish, keep the user's reading position and only announce
      // that review is available.
      flash("事实识别已经完成；你可以继续阅读，重要内容现在可以核对");
      return;
    }
    const targetEventId = event?.id || routeRef.current.eventId;
    const targetSummary = targetEventId ? eventWorkflowSummaries[targetEventId] : undefined;
    if (
      targetSummary?.statusSummary.summaryStatus === "succeeded"
      || targetSummary?.statusSummary.readableTranscriptStatus === "succeeded"
    ) {
      flash("整组处理已经完成；当前阅读位置已保留，可随时打开会前速览");
      return;
    }
    storeId(workflowIntentStorageKey, null);
    setWorkflowIntentProjectId(null);
    void loadView("brief-card");
  };

  useEffect(() => {
    if (!project?.id || workflowIntentProjectId !== project.id || !isCoreWorkflowRoute(routeRef.current)) return;
    const phase = projectWorkflow.phase;
    if (phase !== "waiting_scenario" && phase !== "waiting_review" && phase !== "draft_ready" && phase !== "partially_reviewed" && phase !== "complete") return;
    const transitionKey = `${project.id}:${projectWorkflow.currentRunId || "none"}:${phase}`;
    if (guidedTransitionKey.current === transitionKey) return;
    guidedTransitionKey.current = transitionKey;
    const timer = window.setTimeout(() => {
      guidedTransitionAction.current(phase);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    project?.id,
    projectWorkflow.currentRunId,
    projectWorkflow.phase,
    screen,
    workflowIntentProjectId,
  ]);

  async function runVerdict(
    action: "confirm" | "reject" | "edit",
    reason?: string,
    edit?: ClaimEditSubmission,
    retainRelationIds?: string[],
  ) {
    if (!selectedClaim) return;
    const reviewedClaimId = selectedClaim.id;
    const wasPending = selectedClaim.reviewStatus === "pending";
    if ((action === "confirm" || action === "edit") && evidenceState !== "ready") {
      flash("证据尚未完整加载，暂时不能确认或修改这条记录");
      return;
    }
    setBusyAction(action);
    try {
      const fingerprint = [
        "verdict",
        selectedClaim.id,
        selectedClaim.versionId,
        action,
        reason || "",
        retainRelationIds ? [...retainRelationIds].sort().join(",") : "",
        edit ? JSON.stringify({
          ...edit,
          evidenceRefIds: [...edit.evidenceRefIds].sort(),
          retainRelationIds: [...edit.retainRelationIds].sort(),
        }) : "",
      ].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const updated = await api.saveVerdict(selectedClaim, action, {
        idempotencyKey,
        reason,
        retainRelationIds,
        edit,
      });
      mutationKeys.current.delete(fingerprint);
      queryClient.removeQueries({
        queryKey: ["notique", "claim", reviewedClaimId, "history"],
      });
      setSelectedClaim(updated);
      const updatedClaims = claims.map((item) => item.id === reviewedClaimId ? updated : item);
      setClaims(updatedClaims);
      flash(action === "reject" ? "已记录为不采纳" : action === "edit" ? "修改已保存并确认" : "记录已确认");
      const nextId = wasPending ? nextPendingClaimId(updatedClaims, reviewedClaimId) : null;
      if (nextId) {
        if (project) refreshReviewSnapshotInBackground(project.id);
        await openClaim(nextId, "review", undefined, "replace");
        return;
      }
      if (!wasPending) {
        if (project) refreshReviewSnapshotInBackground(project.id);
        if (action === "edit") await openClaim(updated.id, routeRef.current.origin, undefined, "replace");
        return;
      }
      const reviewSnapshot = await loadReviewQueue("review", undefined, "replace");
      if (!reviewSnapshot) return;
      const remainingClaim = reviewSnapshot.claims.find((item) => item.reviewStatus === "pending");
      if (remainingClaim) {
        await openClaim(remainingClaim.id, "review", undefined, "replace");
        return;
      }
      if (!reviewSnapshot.occurrenceCandidates.some((item) => item.status === "pending")) {
        await finishGuidedReview();
      }
    } catch (error) {
      const issue = toIssue(error);
      setClaimsIssue(issue);
      if (issue.code === "CLAIM_VERSION_CONFLICT") flash("这条记录已被其他操作修改，请刷新后再决定");
    } finally {
      setBusyAction(null);
    }
  }

  async function withdrawClaim(reason: string) {
    if (!selectedClaim) return;
    setBusyAction("withdraw");
    try {
      const fingerprint = ["withdraw", selectedClaim.id, selectedClaim.versionId, reason].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const updated = await api.withdrawClaim(selectedClaim, idempotencyKey, reason);
      mutationKeys.current.delete(fingerprint);
      if (project) await invalidateProjectReadModels(project.id);
      setSelectedClaim(updated);
      setClaims((items) => items.map((item) => item.id === selectedClaim.id ? updated : item));
      flash("这条记录已撤回，仍会保留在历史时间线中");
    } catch (error) {
      setClaimsIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function runOccurrenceVerdict(candidate: OccurrenceCandidate, action: "confirm" | "reject") {
    setBusyAction(`occurrence:${candidate.id}`);
    setClaimsIssue(null);
    try {
      const fingerprint = ["occurrence", candidate.id, candidate.base_version_id, action].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      await api.saveOccurrenceVerdict(candidate, action, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      if (project) await invalidateProjectReadModels(project.id);
      flash(action === "confirm" ? "已确认这次再次出现，并保存新的原始证据" : "这次再次出现未被采纳");
      const reviewSnapshot = await loadReviewQueue("review", undefined, "replace");
      const remainingClaim = reviewSnapshot?.claims.find((item) => item.reviewStatus === "pending");
      if (remainingClaim) await openClaim(remainingClaim.id, "review", undefined, "replace");
      else if (reviewSnapshot && !reviewSnapshot.occurrenceCandidates.some((item) => item.status === "pending")) {
        await finishGuidedReview();
      }
    } catch (error) {
      const issue = toIssue(error);
      setClaimsIssue(issue);
      if (issue.code === "CLAIM_VERSION_CONFLICT") flash("原记录已经变化，请刷新审核区后重新决定");
    } finally {
      setBusyAction(null);
    }
  }

  async function runOccurrenceConversion(
    candidate: OccurrenceCandidate,
    newClaims: OccurrenceNewClaim[],
  ) {
    setBusyAction(`occurrence:${candidate.id}`);
    setClaimsIssue(null);
    try {
      const fingerprint = [
        "occurrence",
        candidate.id,
        candidate.base_version_id,
        "convert_to_new_claim",
        JSON.stringify(newClaims),
      ].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const converted = await api.convertOccurrenceToClaims(candidate, newClaims, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      if (project) await invalidateProjectReadModels(project.id);
      flash(`已生成 ${converted.length} 条待审核记录，原记录没有改动`);
      const reviewSnapshot = await loadReviewQueue("review", undefined, "replace");
      const firstConverted = reviewSnapshot?.claims.find((item) => converted.some((created) => created.id === item.id));
      const remainingClaim = firstConverted ?? reviewSnapshot?.claims.find((item) => item.reviewStatus === "pending");
      if (remainingClaim) await openClaim(remainingClaim.id, "review", undefined, "replace");
    } catch (error) {
      const issue = toIssue(error);
      setClaimsIssue(issue);
      if (issue.code === "CLAIM_VERSION_CONFLICT") flash("原记录已经变化，请刷新审核区后重新决定");
    } finally {
      setBusyAction(null);
    }
  }

  async function runContradictionResolution(input: {
    relationId: string;
    sourceClaimVersionId: string;
    targetClaimVersionId: string;
    winningClaimVersionId: string;
    explanation: string;
  }) {
    setBusyAction(`relation:${input.relationId}`);
    setViewIssue(null);
    try {
      const fingerprint = [
        "relation",
        input.relationId,
        input.sourceClaimVersionId,
        input.targetClaimVersionId,
        input.winningClaimVersionId,
        input.explanation,
      ].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      await api.resolveContradiction(input, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      if (project) await invalidateProjectReadModels(project.id);
      flash("矛盾已解决，正式结果已按服务器记录刷新");
      await loadView(viewTab);
    } catch (error) {
      const issue = toIssue(error);
      setViewIssue(issue);
      if (issue.code === "CLAIM_VERSION_CONFLICT") flash("这组矛盾已经变化，请刷新后重新选择");
    } finally {
      setBusyAction(null);
    }
  }

  async function runManualRelation(input: ManualRelationSubmission) {
    if (!project || !selectedClaim) return;
    setBusyAction("manual-relation");
    setClaimsIssue(null);
    const fingerprint = [
      "manual-relation",
      project.id,
      project.contextVersion,
      selectedClaim.id,
      selectedClaim.versionId,
      input.target.claim_id,
      input.target.claim_version_id,
      input.type,
      input.reason,
    ].join(":");
    try {
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      await api.createManualRelation(
        {
          project_id: project.id,
          base_context_version: project.contextVersion,
          source_claim_id: selectedClaim.id,
          source_claim_version_id: selectedClaim.versionId,
          target_claim_id: input.target.claim_id,
          target_claim_version_id: input.target.claim_version_id,
          type: input.type,
          reason: input.reason,
        },
        idempotencyKey,
      );
      mutationKeys.current.delete(fingerprint);
      await invalidateProjectReadModels(project.id);
      const [latestProject, latestEvents] = await Promise.all([
        api.getProject(project.id),
        api.listEvents(project.id),
      ]);
      setProject(latestProject);
      setEvents(latestEvents);
      flash("记录关系已保存，当前结果已经重新计算");
      await openClaim(selectedClaim.id, routeRef.current.origin, undefined, "replace");
    } catch (error) {
      const issue = toIssue(error);
      setClaimsIssue(issue);
      if (issue.code === "CLAIM_VERSION_CONFLICT") {
        flash("记录或 Project 已经变化，请刷新后重新关联");
      }
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function launchTranscription(
    audioAssetId: string,
    targetEventId: string,
    retryOfRunId = "initial",
    chunks: Array<{ assetId: string; index: number; startMs: number; endMs: number }> = [],
  ): Promise<TranscriptionRun> {
    const fingerprint = ["transcription", audioAssetId, retryOfRunId].join(":");
    const key = transcriptionKeys.current.get(fingerprint) || crypto.randomUUID();
    transcriptionKeys.current.set(fingerprint, key);
    const next = await api.startTranscription(audioAssetId, key, chunks);
    transcriptionKeys.current.delete(fingerprint);
    setTranscriptionRun(next);
    setTranscriptionRunsByAssetId((current) => ({ ...current, [next.audioAssetId]: next }));
    setTranscriptionPollCycle((current) => current + 1);
    if (next.orchestrationMode === "chunked") {
      wakeChunkedTranscription(next.id);
    }
    const refreshed = await api.getEvent(targetEventId);
    if (routeRef.current.eventId === targetEventId || event?.id === targetEventId) setEvent(refreshed);
    return next;
  }

  function wakeChunkedTranscription(runId: string): void {
    if (activeTranscriptionDispatches.current.has(runId)) return;
    activeTranscriptionDispatches.current.add(runId);
    void api.kickDispatcher({ kind: "transcription", runId })
      .catch(() => undefined)
      .finally(() => activeTranscriptionDispatches.current.delete(runId));
  }

  async function prepareLongAudioTranscription(
    source: Blob,
    filename: string,
    originalAudioAssetId: string,
    targetEventId: string,
  ): Promise<TranscriptionRun> {
    const setPreparation = (
      next: AudioPreparationProgress | null | ((current: AudioPreparationProgress | undefined) => AudioPreparationProgress | null | undefined),
    ) => {
      setAudioPreparationProgressByAssetId((current) => {
        const resolved = typeof next === "function" ? next(current[originalAudioAssetId]) : next;
        if (!resolved) {
          if (!current[originalAudioAssetId]) return current;
          const copy = { ...current };
          delete copy[originalAudioAssetId];
          return copy;
        }
        return { ...current, [originalAudioAssetId]: resolved };
      });
    };
    setPreparation({
      audioAssetId: originalAudioAssetId,
      eventId: targetEventId,
      filename,
      stage: "inspecting",
      total: 0,
      completed: 0,
      chunks: [],
    });
    try {
      const durationMs = await inspectAudioDurationMs(source);
      if (!shouldChunkAudio({ durationMs, sizeBytes: source.size })) {
        setPreparation(null);
        return await launchTranscription(originalAudioAssetId, targetEventId);
      }
      const plan = audioChunkPlan(durationMs);
      setPreparation({
        audioAssetId: originalAudioAssetId,
        eventId: targetEventId,
        filename,
        stage: "preparing",
        total: plan.length,
        completed: 0,
        chunks: plan.map((item) => ({ index: item.index, status: "queued", fraction: 0 })),
      });
      const uploadedChunks = await mapWithConcurrency<typeof plan[number], {
        assetId: string;
        index: number;
        startMs: number;
        endMs: number;
      }>(plan, 4, async (item) => {
        const updateChunk = (status: AudioPreparationProgress["chunks"][number]["status"], fraction: number) => {
          setPreparation((current) => {
            if (!current) return current;
            const chunks = current.chunks.map((chunk) => chunk.index === item.index
              ? { ...chunk, status, fraction }
              : chunk);
            return {
              ...current,
              completed: chunks.filter((chunk) => chunk.status === "succeeded").length,
              chunks,
            };
          });
        };
        updateChunk("processing", 0);
        const prepared = await prepareAudioChunk(source, item, filename, (progress) => {
          const currentFraction = Math.min(0.8, Math.max(0, progress) * 0.8);
          setPreparation((current) => {
            if (!current) return current;
            const existing = current.chunks.find((chunk) => chunk.index === item.index);
            if (!existing || Math.abs(existing.fraction - currentFraction) < 0.02) return current;
            return {
              ...current,
              chunks: current.chunks.map((chunk) => chunk.index === item.index
                ? { ...chunk, status: "processing", fraction: currentFraction }
                : chunk),
            };
          });
        });
        updateChunk("processing", 0.82);
        const fingerprint = [
          "transcription-chunk",
          originalAudioAssetId,
          item.index,
          item.startMs,
          item.endMs,
          prepared.blob.size,
        ].join(":");
        const key = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
        mutationKeys.current.set(fingerprint, key);
        const initialized = await api.initAsset(targetEventId, {
          kind: "audio",
          filename: prepared.filename,
          content_type: prepared.mimeType,
          size_bytes: prepared.blob.size,
          metadata: {
            analysis_source: false,
            transcription_chunk: true,
            source_audio_asset_id: originalAudioAssetId,
            chunk_index: item.index,
            chunk_start_ms: item.startMs,
            chunk_end_ms: item.endMs,
          },
        }, key);
        updateChunk("processing", 0.88);
        await api.uploadAsset(
          initialized.assetId,
          initialized.uploadUrl,
          prepared.blob,
          prepared.mimeType,
        );
        updateChunk("processing", 0.96);
        await api.finalizeAsset(initialized.assetId);
        mutationKeys.current.delete(fingerprint);
        updateChunk("succeeded", 0);
        return { assetId: initialized.assetId, ...item };
      });
      setPreparation((current) => current ? {
        ...current,
        eventId: targetEventId,
        stage: "starting",
        total: plan.length,
        completed: plan.length,
        chunks: current.chunks.map((chunk) => ({ ...chunk, status: "succeeded", fraction: 0 })),
      } : current);
      flash(`长录音已分成 ${plan.length} 段，正在并行转写`);
      return await launchTranscription(
        originalAudioAssetId,
        targetEventId,
        "chunked",
        uploadedChunks.sort((left, right) => left.index - right.index),
      );
    } catch (error) {
      setPreparation((current) => current ? {
        ...current,
        chunks: current.chunks.map((chunk) => chunk.status === "processing"
          ? { ...chunk, status: "failed", fraction: 0 }
          : chunk),
      } : current);
      throw error;
    } finally {
      setPreparation(null);
    }
  }

  async function retryAudioTranscription(audioAssetId: string) {
    if (!event) return;
    setBusyAction("transcription");
    setEventIssue(null);
    try {
      let current = transcriptionRunsByAssetId[audioAssetId]
        ?? (transcriptionRun?.audioAssetId === audioAssetId ? transcriptionRun : null);
      if (!current) {
        const refreshedEvent = await api.getEvent(event.id);
        setEvent(refreshedEvent);
        const persistedAudio = refreshedEvent.assets.find((asset) => asset.id === audioAssetId);
        const persistedRunId = persistedAudio
          ? stringValue(persistedAudio.metadata.transcription_run_id)
          : undefined;
        if (persistedRunId) {
          const persistedRun = await api.getTranscriptionRun(persistedRunId);
          if (persistedRun.audioAssetId === audioAssetId) {
            current = persistedRun;
            setTranscriptionRun(persistedRun);
            setTranscriptionRunsByAssetId((runs) => ({ ...runs, [persistedRun.audioAssetId]: persistedRun }));
          }
        }
      }
      if (current && runInProgress.has(current.status)) {
        const failedChunks = current.chunks.filter((chunk) => chunk.status === "failed");
        if (current.orchestrationMode === "chunked" && failedChunks.length > 0) {
          const retryFingerprint = `transcription-chunks-retry:${current.id}:${failedChunks.map((chunk) => chunk.index).join(",")}`;
          const retryKey = mutationKeys.current.get(retryFingerprint) || crypto.randomUUID();
          mutationKeys.current.set(retryFingerprint, retryKey);
          current = await api.retryFailedTranscriptionChunks(current.id, retryKey);
          mutationKeys.current.delete(retryFingerprint);
          setTranscriptionRun(current);
          setTranscriptionRunsByAssetId((runs) => ({ ...runs, [current!.audioAssetId]: current! }));
          wakeChunkedTranscription(current.id);
          setTranscriptionPollCycle((value) => value + 1);
          flash(`只重试失败的 ${failedChunks.length} 个录音片段，已完成片段不会重复收费`);
          return;
        }
        const largeAudioAsset = event.assets.find((asset) =>
          asset.id === audioAssetId &&
          current?.orchestrationMode === "single" &&
          shouldChunkAudio({ durationMs: 0, sizeBytes: asset.sizeBytes ?? 0 }));
        if (largeAudioAsset) {
          const source = await api.downloadAsset(audioAssetId);
          const next = await prepareLongAudioTranscription(
            source,
            largeAudioAsset.filename,
            audioAssetId,
            event.id,
          );
          flash(`旧的整段任务已换成 ${next.chunkCount ?? next.chunks.length} 段并行转写`);
          return;
        }
        await api.kickDispatcher({ kind: "transcription", runId: current.id }).catch(() => undefined);
        const latest = await api.getTranscriptionRun(current.id);
        if (runInProgress.has(latest.status)) {
          setTranscriptionRun(latest);
          setTranscriptionRunsByAssetId((runs) => ({ ...runs, [latest.audioAssetId]: latest }));
          setTranscriptionPollCycle((value) => value + 1);
          flash("已重新检查后台任务，会继续等待转写结果");
          return;
        }
        if (latest.status === "succeeded") {
          setTranscriptionRun(latest);
          setTranscriptionRunsByAssetId((runs) => ({ ...runs, [latest.audioAssetId]: latest }));
          setEvent(await api.getEvent(event.id));
          flash("逐字稿已经生成");
          return;
        }
      }
      const audioAsset = event.assets.find((asset) => asset.id === audioAssetId);
      if (current?.status === "failed" && audioAsset) {
        const source = await api.downloadAsset(audioAssetId);
        const next = await prepareLongAudioTranscription(
          source,
          audioAsset.filename,
          audioAssetId,
          event.id,
        );
        flash(next.orchestrationMode === "chunked"
          ? `已改用 ${next.chunkCount ?? next.chunks.length} 段并行转写，不需要重新上传录音`
          : "已重新开始转写，录音不会重复上传");
        return;
      }
      await launchTranscription(audioAssetId, event.id, current?.id || "retry-without-run");
      flash("已重新开始转写，录音不会重复上传");
    } catch (error) {
      setEventIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function retryEventAiArtifact(
    eventId: string,
    kind: EventAiArtifactRun["kind"],
  ): Promise<void> {
    const action = `artifact:${kind}`;
    setBusyAction(action);
    try {
      const fingerprint = `${action}:${eventId}`;
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const artifactRun = await api.retryEventAiArtifact(eventId, kind, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      await queryClient.invalidateQueries({ queryKey: notiqueQueryKeys.artifacts(eventId), exact: true });
      await api.kickDispatcher({ kind: "artifact", runId: artifactRun.id }).catch(() => undefined);
      flash(kind === "summary" ? "AI 摘要已重新提交" : "易读逐字稿已重新提交");
    } catch (error) {
      setEventIssue(toIssue(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function openProjectDeletePreview(): Promise<void> {
    if (!project) return;
    setBusyAction("project-delete-preview");
    try {
      setDeletePreview(await api.getProjectDeletePreview(project.id));
    } catch (error) {
      setProjectIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  function clearCurrentProjectSelection(projectId: string): void {
    queryClient.removeQueries({ queryKey: ["notique", "project", projectId] });
    invalidateNavigationRequests();
    projectWorkflowRefreshToken.current += 1;
    storeId(recentProjectStorageKey, null);
    storeId(recentEventStorageKey(projectId), null);
    if (readStoredId(workflowIntentStorageKey) === projectId) {
      storeId(workflowIntentStorageKey, null);
      setWorkflowIntentProjectId(null);
    }
    setProject(null);
    setEvents([]);
    setEventWorkflowSummaries({});
    setEvent(null);
    setRun(null);
    setTranscriptionRun(null);
    setTranscriptionRunsByAssetId({});
    setAudioPreparationProgressByAssetId({});
    setClaims([]);
    setOccurrenceCandidates([]);
    setProjectWorkflow(idleProjectWorkflow);
  }

  async function moveCurrentProjectToTrash(): Promise<void> {
    if (!project || !deletePreview) return;
    const deleting = project;
    setBusyAction("project-delete");
    try {
      const deleted = await api.moveProjectToTrash(deleting.id, crypto.randomUUID());
      const remaining = projects.filter((item) => item.id !== deleting.id);
      setProjects(remaining);
      setDeletePreview(null);
      setUndoDeletedProject(deleted);
      clearCurrentProjectSelection(deleting.id);
      flash("项目已移到回收站");
      if (remaining[0]) await loadSimpleProject(remaining[0].id, undefined, "replace");
      else navigateRoute({ view: "simple" }, "replace");
    } catch (error) {
      setProjectIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  const loadTrash = useCallback(async () => {
    setTrashState("loading");
    setTrashIssue(null);
    try {
      const deleted = await api.listDeletedProjects();
      setTrashProjects(deleted);
      setTrashState(deleted.length ? "ready" : "empty");
    } catch (error) {
      setTrashIssue(toIssue(error));
      setTrashState("error");
    }
  }, []);

  async function restoreDeletedProject(target: Project, openAfterRestore = false): Promise<void> {
    setBusyAction(`restore:${target.id}`);
    try {
      const restored = await api.restoreProject(target.id, crypto.randomUUID());
      await invalidateProjectReadModels(target.id);
      setUndoDeletedProject((current) => current?.id === target.id ? null : current);
      await Promise.all([loadProjects(), loadTrash()]);
      flash(`“${restored.name}”已恢复`);
      if (openAfterRestore) {
        setShowTrash(false);
        await loadSimpleProject(restored.id, undefined, "replace");
      }
    } catch (error) {
      setTrashIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function permanentlyDeleteProject(target: Project, confirmation: string): Promise<void> {
    setBusyAction(`permanent:${target.id}`);
    try {
      await api.permanentlyDeleteProject(target.id, confirmation, crypto.randomUUID());
      queryClient.removeQueries({ queryKey: ["notique", "project", target.id] });
      setTrashProjects((current) => current.filter((item) => item.id !== target.id));
      flash(`“${target.name}”已永久删除`);
    } catch (error) {
      setTrashIssue(toIssue(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function retryRunStatus() {
    if (!run || !event) return;
    setBusyAction("run-status");
    setEventIssue(null);
    try {
      await api.kickDispatcher({ kind: "extraction", runId: run.id }).catch(() => undefined);
      const latest = await api.getRun(run.id);
      setRun(latest);
      if (runInProgress.has(latest.status)) {
        setRunPollCycle((value) => value + 1);
        flash("已重新检查后台任务，会继续等待分析结果");
      } else if (runComplete.has(latest.status)) {
        await loadClaimsForRun(latest.id);
        flash("分析已经完成");
      } else {
        await startExtractionForEvent(event);
      }
    } catch (error) {
      setEventIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  function extractionAssetVersionIds(targetEvent: Event): string[] {
    return targetEvent.assets
      .filter(assetIsAnalyzable)
      .map((asset) => asset.versionId)
      .filter((id): id is string => Boolean(id));
  }

  async function requestExtractionForEvent(targetEvent: Event): Promise<ExtractionRun> {
    const ids = extractionAssetVersionIds(targetEvent);
    if (!ids.length) {
      throw new ApiClientError({
        code: "EVENT_NOT_READY",
        message: "当前材料还没有可用于分析的已完成版本。",
        status: 409,
      });
    }
    const fingerprint = `${targetEvent.id}:${[...ids].sort().join(",")}`;
    let key = extractionKeys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      extractionKeys.current.set(fingerprint, key);
    }
    const nextRun = await api.startExtraction(targetEvent.id, ids, key);
    extractionKeys.current.delete(fingerprint);
    return nextRun;
  }

  async function startExtractionForEvent(targetEvent: Event, automatic = false): Promise<boolean> {
    setBusyAction("extraction");
    setEventIssue(null);
    try {
      let extractionTarget = targetEvent;
      if (extractionAssetVersionIds(extractionTarget).length === 0) {
        // The transcription may have completed between the last render and
        // this explicit click. Re-read the Event once instead of rejecting a
        // valid canonical transcript because the browser held stale assets.
        const refreshed = await api.getEvent(targetEvent.id);
        if ((routeRef.current.eventId || event?.id) !== targetEvent.id) return false;
        extractionTarget = refreshed;
        setEvent(refreshed);
      }
      if (extractionAssetVersionIds(extractionTarget).length === 0) {
        setEventIssue({ code: "EVENT_NOT_READY", message: "当前材料还没有可用于分析的已完成版本。", status: 409 });
        return false;
      }
      const nextRun = await requestExtractionForEvent(extractionTarget);
      clearAutoAnalysisIntent(targetEvent.id);
      setRun(nextRun);
      setRunPollCycle((value) => value + 1);
      setClaims([]);
      setClaimsState("idle");
      flash(automatic
        ? "材料已就绪，正在自动整理重点；你可以先看逐字稿"
        : "分析已经开始，可以稍后回来查看");
      return true;
    } catch (error) {
      setEventIssue(toIssue(error));
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  useEffect(() => {
    if (!event || busyAction) return;
    // The intent belongs to an Event, not to a screen. Material can finish
    // transcribing while the reader is in the project record or the review
    // queue, and the paid Run must still start exactly once rather than wait
    // for them to navigate back.
    if (routeRef.current.eventId && routeRef.current.eventId !== event.id) return;
    const intent = readAutoAnalysisIntent(event.id);
    if (!intent) return;
    const waitingForAudio = intent.waitForAudioAssetIds.some((audioAssetId) => {
      const audioRun = transcriptionRunsByAssetId[audioAssetId];
      if (audioRun?.status !== "succeeded" || !audioRun.derivedTranscriptAssetId) return true;
      return !event.assets.some((asset) =>
        asset.id === audioRun.derivedTranscriptAssetId && assetIsAnalyzable(asset));
    });
    const currentEventTranscriptionRunning = Object.values(transcriptionRunsByAssetId)
      .some((item) => item.eventId === event.id && runInProgress.has(item.status));
    const analyzableVersionIds = extractionAssetVersionIds(event);
    const fingerprint = `${event.id}:${analyzableVersionIds.sort().join(",")}`;
    const latestRunId = event.latestRun?.id || event.latestRunId;
    const loadedLatestRun = event.latestRun
      || (run && (run.eventId === event.id || (latestRunId && run.id === latestRunId)) ? run : null);
    const decision = autoAnalysisDecision({
      baseRunId: intent.baseRunId,
      extractionFingerprint: intent.extractionFingerprint,
      currentFingerprint: fingerprint,
      latestRunId,
      latestRunLoaded: !latestRunId || Boolean(loadedLatestRun),
      latestRunInProgress: Boolean(loadedLatestRun && runInProgress.has(loadedLatestRun.status)),
      waitingForAudio,
      currentEventTranscriptionRunning,
      hasAnalyzableAssets: analyzableVersionIds.length > 0,
    });
    if (decision === "wait") return;
    if (decision === "clear") {
      clearStoredAutoAnalysisIntent(event.id);
      return;
    }
    if (autoAnalysisAttempts.current.has(fingerprint)) return;
    autoAnalysisAttempts.current.add(fingerprint);
    const idempotencyKey = intent.extractionFingerprint === fingerprint
      ? intent.idempotencyKey
      : crypto.randomUUID();
    if (intent.extractionFingerprint !== fingerprint) {
      storeAutoAnalysisIntent({ ...intent, extractionFingerprint: fingerprint, idempotencyKey });
    }
    extractionKeys.current.set(fingerprint, idempotencyKey);
    void startExtractionForEvent(event, true).then((started) => {
      if (!started) clearAutoAnalysisIntent(event.id);
    });
    // startExtractionForEvent deliberately owns the mutation. The primitive
    // dependencies below are the complete readiness signal for this intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoAnalysisIntentRevision,
    busyAction,
    event,
    run,
    transcriptionRunsByAssetId,
  ]);

  async function advanceProjectWorkflow() {
    if (!project) return;
    const projectId = project.id;
    let owner: RequestOwner = {
      projectId,
      projectEpoch: requestEpochs.current.project,
      eventId: routeRef.current.eventId,
      eventEpoch: requestEpochs.current.event,
    };
    storeId(workflowIntentStorageKey, projectId);
    setWorkflowIntentProjectId(projectId);
    setBusyAction("project-workflow");
    setEventIssue(null);
    try {
      projectWorkflowRefreshToken.current += 1;
      const snapshot = await inspectProjectWorkflow(projectId, loadFreshWorkflowSnapshot);
      if (!isCurrentRequestOwner(owner)) return;
      setProject(snapshot.project);
      setEvents(snapshot.events);
      setProjectWorkflow(snapshot.plan);
      setEventWorkflowSummaries(snapshot.eventSummaries);
      const current = snapshot.plan.currentEventId
        ? snapshot.details.find((item) => item.event.id === snapshot.plan.currentEventId)
        : undefined;

      if (snapshot.plan.phase === "waiting_review") {
        if (current) {
          setEvent(current.event);
          setEventState("ready");
          setRun(current.run);
        }
        await enterContinuousReview();
        return;
      }
      if (snapshot.plan.phase === "draft_ready" || snapshot.plan.phase === "partially_reviewed") {
        await enterAiDraft();
        return;
      }
      if (snapshot.plan.phase === "waiting_scenario") {
        if (current) await loadSimpleProject(projectId, current.event.id);
        flash("先确认使用场景，再核对这次结果");
        return;
      }
      if (snapshot.plan.phase === "waiting_material") {
        if (current) await loadSimpleProject(projectId, current.event.id);
        flash("前一次沟通的材料还没有准备好，暂时不会越过它处理后面的内容");
        return;
      }
      if (snapshot.plan.phase === "complete") {
        storeId(workflowIntentStorageKey, null);
        setWorkflowIntentProjectId(null);
        flash("全部沟通都已处理并核对完成，正在打开会前速览");
        await loadView("brief-card");
        return;
      }
      if (snapshot.plan.phase === "empty" || !current) {
        flash("当前 Project 还没有可处理的材料");
        return;
      }

      invalidateEventSelectionRequests();
      const eventEpoch = requestEpochs.current.event + 1;
      requestEpochs.current.event = eventEpoch;
      owner = {
        projectId,
        projectEpoch: requestEpochs.current.project,
        eventId: current.event.id,
        eventEpoch,
      };
      navigateRoute({ view: "simple", projectId: snapshot.project.id, eventId: current.event.id }, "replace");
      setEvent(current.event);
      setEventState("ready");
      setEventIssue(null);
      setRun(current.run);
      setClaims([]);
      setClaimsState("idle");
      await loadTranscriptionForEvent(current.event, eventEpoch);
      if (!isCurrentRequestOwner(owner)) return;

      if (snapshot.plan.phase === "running" && current.run) {
        await api.kickDispatcher({ kind: "extraction", runId: current.run.id }).catch(() => undefined);
        if (!isCurrentRequestOwner(owner)) return;
        setRunPollCycle((value) => value + 1);
        flash(`继续等待第 ${snapshot.plan.currentPosition}/${snapshot.plan.total} 次沟通的处理结果`);
        return;
      }

      const nextRun = await requestExtractionForEvent(current.event);
      if (!isCurrentRequestOwner(owner)) return;
      setRun(nextRun);
      setRunPollCycle((value) => value + 1);
      setProjectWorkflow({
        ...snapshot.plan,
        phase: "running",
        currentRunId: nextRun.id,
      });
      flash(`正在处理第 ${snapshot.plan.currentPosition}/${snapshot.plan.total} 次沟通`);
    } catch (error) {
      if (!isCurrentRequestOwner(owner)) return;
      const issue = toIssue(error);
      setEventIssue(issue);
      setProjectWorkflow((current) => ({ ...current, phase: "error", issue }));
    } finally {
      setBusyAction(null);
    }
  }

  async function completeAction(claimId: string) {
    if (!project) return;
    const fingerprint = `complete-action:${claimId}`;
    const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
    mutationKeys.current.set(fingerprint, idempotencyKey);
    setBusyAction(fingerprint);
    setViewIssue(null);
    try {
      await api.completeProjectAction(claimId, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      await invalidateProjectReadModels(project.id);
      flash("行动已完成，并已保留为一条人工确认的项目进展记录");
      await loadView("actions", project.id, "replace");
    } catch (error) {
      setViewIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function decideDraftLink(linkId: string, action: "accept" | "reject") {
    if (!project) return;
    const fingerprint = `draft-link:${linkId}:${action}`;
    const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
    mutationKeys.current.set(fingerprint, idempotencyKey);
    setBusyAction(fingerprint);
    setViewIssue(null);
    try {
      await api.decideDraftLink(linkId, action, project.contextVersion, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      await invalidateProjectReadModels(project.id);
      setProject(await api.getProject(project.id));
      flash(action === "accept"
        ? "这条草稿关联已转为人工确认的正式关系"
        : "这条草稿关联已不采纳；它不会影响可信记忆");
      await loadView("client-progress", project.id, "replace");
    } catch (error) {
      setViewIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function beginSimpleTest(
    openTranscriptAfterCreate = false,
  ): Promise<{ project: Project; event: Event | null } | null> {
    setSimpleFlow(true);
    setBusyAction("simple-start");
    setProjectsIssue(null);
    try {
      const now = new Date();
      const name = `新项目 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(now)}`;
      const fingerprint = `simple-project:${name}`;
      const key = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, key);
      const created = await api.createProject({ name }, key);
      mutationKeys.current.delete(fingerprint);
      setProject(created);
      setEvents([]);
      setEvent(null);
      setRun(null);
      setClaims([]);
      setProjectState("ready");
      await loadProjects();
      await loadSimpleProject(created.id);
      if (openTranscriptAfterCreate) setShowImport(true);
      flash("新项目已经建立。Transcript 会成为第一条沟通，录音或照片会自动建立第一条沟通。");
      return { project: created, event: null };
    } catch (error) {
      setProjectsIssue(toIssue(error));
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function attachSimpleFile(file: File): Promise<boolean> {
    const localIssue = photoUploadIssue(file.name, file.type, file.size)
      ?? audioUploadIssue(file.name, file.type, file.size);
    if (localIssue) {
      setEventIssue(localIssue);
      return false;
    }
    let targetProject = project;
    let targetEvent = event;
    try {
      const target = await resolveSimpleImportTarget({
        project: targetProject,
        event: targetEvent,
        createTest: () => beginSimpleTest(false),
        createEvent: async (currentProject) => {
          const fingerprint = `simple-event:${currentProject.id}`;
          const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
          mutationKeys.current.set(fingerprint, idempotencyKey);
          const createdEvent = await api.createEvent(
            currentProject.id,
            { title: "第一次沟通", event_type: "meeting", occurred_at: new Date().toISOString() },
            idempotencyKey,
          );
          mutationKeys.current.delete(fingerprint);
          return createdEvent;
        },
      });
      if (!target) return false;
      targetProject = target.project;
      targetEvent = target.event;
      setProject(targetProject);
      setEvent(targetEvent);
      setEvents((current) => current.some((item) => item.id === targetEvent?.id) ? current : [...current, targetEvent!]);
      setBusyAction("asset");
      setEventIssue(null);
      const imageMime = modelImageMimeFor(file.name, file.type);
      const audioMime = audioMimeFor(file.name, file.type);
      const kind = imageMime ? "photo" : audioMime ? "audio" : file.type === "application/pdf" ? "pdf" : "text";
      const contentType = imageMime || audioMime || file.type || "text/plain";
      const fingerprint = ["asset-init", targetEvent.id, kind, file.name, contentType, file.size].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const init = await api.initAsset(targetEvent.id, { kind, filename: file.name, content_type: contentType, size_bytes: file.size }, idempotencyKey);
      await api.uploadAsset(init.assetId, init.uploadUrl, file, contentType);
      await api.finalizeAsset(init.assetId);
      mutationKeys.current.delete(fingerprint);
      const armed = armAutoAnalysis(
        targetEvent.id,
        kind === "audio" ? init.assetId : undefined,
        targetEvent.latestRun?.id || targetEvent.latestRunId || (run?.eventId === targetEvent.id ? run.id : undefined),
      );
      if (kind === "audio") {
        const targetProjectId = targetProject.id;
        const targetEventId = targetEvent.id;
        flash("录音已保存，正在规划分段；可以继续添加下一份录音");
        await loadSimpleProject(targetProjectId, targetEventId);
        void prepareLongAudioTranscription(
          file,
          file.name,
          init.assetId,
          targetEventId,
        ).then(async (transcription) => {
          flash(transcription.orchestrationMode === "chunked"
            ? `“${file.name}”的 ${transcription.chunkCount ?? transcription.chunks.length} 段正在并行识别`
            : `“${file.name}”正在识别说话人和时间点，完成后会自动整理重点`);
          if (routeRef.current.projectId === targetProjectId && routeRef.current.eventId === targetEventId) {
            await loadSimpleProject(targetProjectId, targetEventId, "replace");
          }
        }).catch((error) => setEventIssue(toIssue(error)));
        return true;
      } else {
        flash(armed ? "材料已加入，正在准备自动分析" : "材料已加入。这个浏览器不允许保存会话状态，请点击“重新启动分析”。");
      }
      await loadSimpleProject(targetProject.id, targetEvent.id);
      return true;
    } catch (error) {
      const issue = toIssue(error);
      const targetEventId = targetEvent?.id;
      if (targetProject && targetEventId) {
        await loadSimpleProject(targetProject.id, targetEventId).catch(() => undefined);
      }
      setEventIssue(issue);
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  function goSimple() {
    setSimpleFlow(true);
    if (project) {
      const preferredEventId = event?.projectId === project.id ? event.id : undefined;
      void loadSimpleProject(project.id, preferredEventId);
      return;
    }
    setScreen("simple");
  }

  function goProjects() {
    setSimpleFlow(false);
    invalidateNavigationRequests();
    navigateRoute({ view: "projects" });
    setProject(null);
    setEvent(null);
    setSelectedClaim(null);
    void loadProjects();
  }

  function currentDraftRunId(): string | null {
    return projectWorkflow.currentRunId
      || event?.latestRun?.id
      || event?.latestRunId
      || run?.id
      || null;
  }

  async function recordCurrentDraftAssessment(
    assessment: AiDraftAssessment["assessment"],
  ): Promise<void> {
    const runId = currentDraftRunId();
    if (!runId) return;
    setBusyAction("draft-assessment");
    try {
      const fingerprint = `draft-assessment:${runId}:${assessment}`;
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const saved = await api.recordAiDraftAssessment(runId, assessment, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      setDraftAssessment(saved);
      if (assessment === "basically_usable") {
        flash("已记录：AI 初稿基本可用。它仍不会自动进入正式报告");
      }
    } catch (error) {
      setClaimsIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function createMissingClaim(input: {
    statement: string;
    type: string;
    segmentIds: string[];
  }): Promise<void> {
    const targetEventId = projectWorkflow.currentEventId || event?.id;
    if (!targetEventId) return;
    setBusyAction("manual-claim");
    try {
      const fingerprint = [
        "manual-claim",
        targetEventId,
        input.type,
        input.statement,
        ...[...input.segmentIds].sort(),
      ].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const created = await api.createManualClaim(
        targetEventId,
        {
          statement: input.statement,
          type: input.type as Parameters<typeof api.createManualClaim>[1]["type"],
          segment_ids: input.segmentIds,
        },
        idempotencyKey,
      );
      mutationKeys.current.delete(fingerprint);
      if (project) await invalidateProjectReadModels(project.id);
      setShowMissingClaim(false);
      const snapshot = await loadReviewQueue("draft");
      if (snapshot) {
        setClaims((items) => sortClaimsForReview([
          ...items.filter((item) => item.id !== created.id),
          created,
        ]));
      }
      flash("漏项已加入待核对队列；确认前不会进入正式报告");
    } catch (error) {
      setClaimsIssue(toIssue(error));
      throw error;
    } finally {
      setBusyAction(null);
    }
  }

  async function startContinuousReviewFromDraft() {
    if (!draftAssessment) await recordCurrentDraftAssessment("needs_review");
    await enterContinuousReview();
  }

  async function confirmCurrentScenario(scenario: string, custom?: string) {
    if (!project) return;
    setBusyAction("scenario");
    setProjectIssue(null);
    try {
      const fingerprint = ["scenario", project.id, project.scenarioVersion ?? 0, scenario, custom || ""].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const updated = await api.confirmScenario(project, scenario, idempotencyKey, custom);
      mutationKeys.current.delete(fingerprint);
      setProject(updated);
      flash("使用场景已确认，后续沟通会沿用这个设置");
      if (screen === "simple") {
        const targetEventId = projectWorkflow.currentEventId || event?.id || routeRef.current.eventId;
        if (targetEventId) {
          setTranscriptFocusRequest({ id: Date.now(), eventId: targetEventId, tab: "summary" });
        } else {
          await enterAiDraft();
        }
      } else await loadProject(project.id);
    } catch (error) {
      setProjectIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function restoreAppRoute(requestedRoute: AppRoute): Promise<void> {
    const target = normalizeAppRoute(requestedRoute);
    if (target.view === "projects") {
      navigateRoute(target, "none");
      void loadProjects();
      return;
    }
    if (!target.projectId) {
      navigateRoute(target.view === "simple" ? target : { view: "simple" }, "none");
      return;
    }

    const sameProject = project?.id === target.projectId;
    const sameEvent = !target.eventId || event?.id === target.eventId;
    const restoreReadingTabIfNeeded = () => {
      if (!target.readingTab) return;
      const context = summaryReturnContext.current;
      const targetEventId = target.eventId || context?.eventId;
      if (!targetEventId) return;
      const canRestoreSummaryScroll = target.readingTab === "summary"
        && context?.eventId === targetEventId;
      if (canRestoreSummaryScroll) summaryReturnContext.current = null;
      setTranscriptFocusRequest({
        id: Date.now(),
        eventId: targetEventId,
        tab: target.readingTab,
        ...(canRestoreSummaryScroll ? { restoreScrollY: context.scrollY } : {}),
      });
    };
    if (sameProject && target.view === "project") {
      navigateRoute(target, "none");
      return;
    }
    if (sameProject && sameEvent && (target.view === "simple" || target.view === "event")) {
      navigateRoute(target, "none");
      if (target.view === "simple") restoreReadingTabIfNeeded();
      return;
    }
    if (sameProject && target.view === "results" && viewTab === (target.tab ?? "folder-summary") && viewState !== "idle") {
      navigateRoute(target, "none");
      return;
    }
    if (
      sameProject
      && target.view === "claim"
      && selectedClaim?.id === target.claimId
      && evidenceState !== "idle"
    ) {
      navigateRoute(target, "none");
      return;
    }
    if (sameProject && (target.view === "draft" || target.view === "review") && claimsState !== "idle") {
      navigateRoute(target, "none");
      return;
    }

    await loadSimpleProject(target.projectId, target.eventId, "none");
    if (target.view === "simple") {
      navigateRoute(target, "none");
      restoreReadingTabIfNeeded();
      return;
    }
    if (target.view === "project" || target.view === "event") {
      navigateRoute(target, "none");
      return;
    }
    if (target.view === "results") {
      await loadView(target.tab ?? "folder-summary", target.projectId, "none");
      navigateRoute(target, "none");
      return;
    }
    if (target.view === "draft" || target.view === "review") {
      await loadReviewQueue(target.view, target.projectId, "none");
      navigateRoute(target, "none");
      return;
    }
    if (target.view === "claim" && target.claimId) {
      if (target.origin === "results") {
        await loadView(target.originTab ?? "folder-summary", target.projectId, "none");
      } else if (target.origin === "draft" || target.origin === "review") {
        await loadReviewQueue(target.origin, target.projectId, "none");
      }
      await openClaim(
        target.claimId,
        target.origin,
        target.projectId,
        "none",
        target.originReadingTab,
      );
      navigateRoute(target, "none");
      return;
    }
    if (target.view === "run-debug" && target.runId) {
      await openRunDebug(target.runId, "none");
      navigateRoute(target, "none");
      return;
    }
    navigateRoute({ view: "simple", projectId: target.projectId, ...(target.eventId ? { eventId: target.eventId } : {}) }, "none");
  }

  routeRestoreAction.current = (nextRoute) => {
    void restoreAppRoute(nextRoute);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "auto";
    const initialRoute = parseAppRoute(window.location.search);
    routeRef.current = initialRoute;
    const currentState = isRecord(window.history.state) ? window.history.state : {};
    const currentDepth = typeof currentState.notiqueDepth === "number"
      ? currentState.notiqueDepth
      : 0;
    window.history.replaceState(
      { ...currentState, notiqueRoute: true, notiqueDepth: currentDepth },
      "",
      `${window.location.pathname}${serializeAppRoute(initialRoute)}${window.location.hash}`,
    );
    const timer = window.setTimeout(() => routeRestoreAction.current(initialRoute), 0);
    const onPopState = () => {
      const nextRoute = parseAppRoute(window.location.search);
      invalidateNavigationRequests();
      routeRef.current = nextRoute;
      setRouteState(nextRoute);
      routeRestoreAction.current(nextRoute);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("popstate", onPopState);
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, [invalidateNavigationRequests]);

  const claimRouteReadonly = isReadonlyClaimRoute(route, selectedClaim?.reviewStatus);

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="sidebar" aria-label="应用侧栏">
        <button
          className="sidebar-toggle"
          type="button"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
        >
          <span aria-hidden="true">{sidebarCollapsed ? "›" : "‹"}</span>
        </button>
        <button className="brand" onClick={goSimple} aria-label="Notique AI · 项目工作区"><span className="brand-mark">⌁</span><span className="sidebar-label">Notique AI</span></button>
        <div className="account"><span className="avatar">N</span><span className="sidebar-label"><strong>Notique</strong><small>Workspace</small></span></div>
        <nav aria-label="主要导航">
          <button className={screen === "simple" ? "active" : ""} onClick={goSimple} aria-label="项目工作区" title={sidebarCollapsed ? "项目工作区" : undefined}><span className="sidebar-nav-icon">◎</span><span className="sidebar-nav-label">项目工作区</span></button>
          <button className={screen === "projects" ? "active" : ""} onClick={goProjects} aria-label="高级工具" title={sidebarCollapsed ? "高级工具" : undefined}><span className="sidebar-nav-icon">▣</span><span className="sidebar-nav-label">高级工具</span></button>
          {project && screen !== "simple" && <button className={screen !== "projects" ? "active" : ""} onClick={() => navigateRoute({ view: "project", projectId: project.id, origin: "projects" })} aria-label={project.name} title={sidebarCollapsed ? project.name : undefined}><span className="sidebar-nav-icon">◫</span><span className="sidebar-nav-label">{project.name}</span></button>}
        </nav>
        <div className="sidebar-note"><strong>核心工作区</strong><p>按沟通顺序添加材料、分析、核对，再从确认内容生成报告。</p></div>
      </aside>
      <header className="mobile-header"><button className="brand" onClick={goSimple}>⌁ Notique AI</button><button className="icon-button" onClick={goProjects} aria-label="高级工具">···</button></header>
      <main>
        <aside className="public-workspace-notice" aria-label="公开共享测试空间提示">
          <strong>公开共享演示空间</strong>
          <span>所有访问者共享这个演示空间。请勿上传真实人员姓名、联系方式、地址、财务信息或其他敏感材料；仅使用公开、合成或已脱敏内容。</span>
        </aside>
        {screen === "simple" && <SimpleTestScreen
          key={project?.id ?? "none"}
          projects={projects}
          projectsState={projectsState}
          projectsIssue={projectsIssue}
          project={project}
          projectState={projectState}
          projectIssue={projectIssue}
          events={events}
          eventWorkflowSummaries={eventWorkflowSummaries}
          event={event}
          eventState={eventState}
          eventIssue={eventIssue}
          run={run}
          claims={claims}
          busy={busyAction}
          projectWorkflow={projectWorkflow}
          readingTab={route.readingTab}
          transcriptionRunsByAssetId={transcriptionRunsByAssetId}
          audioPreparationProgressByAssetId={audioPreparationProgressByAssetId}
          onUseProject={(id) => { setSimpleFlow(true); void loadSimpleProject(id); }}
          onUseEvent={(id) => { if (project) { setSimpleFlow(true); void loadSimpleProject(project.id, id); } }}
          onStartOwn={() => { setSimpleFlow(true); setShowNewProject(true); }}
          onAddTranscript={() => requirePublicWorkspaceAcknowledgement(() => { setSimpleFlow(true); if (project) setShowImport(true); else void beginSimpleTest(true); })}
          onAddFile={attachSimpleFile}
          onProjectWorkflowAction={() => void advanceProjectWorkflow()}
          onRetryTranscription={(audioAssetId) => void retryAudioTranscription(audioAssetId)}
          onConfirmScenario={confirmCurrentScenario}
          transcriptionRun={transcriptionRun}
          onReview={() => void enterAiDraft()}
          onResult={(tab = "brief-card") => void loadView(tab)}
          onOpenClaim={(id) => void openClaimFromTranscriptSummary(id)}
          onRetryArtifact={retryEventAiArtifact}
          onStartAnalysis={async (targetEvent) => { await startExtractionForEvent(targetEvent); }}
          onFocusTranscriptArtifact={(eventId, tab) => {
            setTranscriptFocusRequest({ id: Date.now(), eventId, tab });
            if (routeRef.current.view === "simple") {
              navigateRoute({
                ...routeRef.current,
                eventId,
                readingTab: tab,
              }, "replace");
            }
          }}
          onClearTranscriptArtifact={() => {
            setTranscriptFocusRequest(null);
            if (routeRef.current.view !== "simple" || !routeRef.current.readingTab) return;
            navigateRoute({ ...routeRef.current, readingTab: undefined }, "replace");
          }}
          transcriptFocusRequest={transcriptFocusRequest}
          onTranscriptFocusHandled={(requestId) => setTranscriptFocusRequest((current) => current?.id === requestId ? null : current)}
          onRequirePublicWorkspaceAcknowledgement={requirePublicWorkspaceAcknowledgement}
          externalInteractionActive={showNewProject
            || showNewEvent
            || showImport
            || showPublicWorkspaceConfirmation
            || Boolean(deletePreview)
            || showTrash
            || showMissingClaim}
          onDeleteProject={openProjectDeletePreview}
          onOpenTrash={() => { setShowTrash(true); void loadTrash(); }}
        />}
        {screen === "projects" && <ProjectsScreen state={projectsState} issue={projectsIssue} projects={projects} onRetry={loadProjects} onOpen={(id) => { setSimpleFlow(false); void loadProject(id); }} onCreate={() => setShowNewProject(true)} />}
        {screen === "project" && <ProjectScreen key={`${project?.id ?? "none"}-${project?.scenarioVersion ?? 0}`} state={projectState} issue={projectIssue} project={project} events={events} onBack={navigateBack} onRetry={() => project && void loadProject(project.id, "project", "replace")} onOpenEvent={(id) => void loadEvent(id)} onNewEvent={() => setShowNewEvent(true)} onImport={() => requirePublicWorkspaceAcknowledgement(() => { setSimpleFlow(false); setShowImport(true); })} onReview={() => void loadReviewQueue()} onResults={(tab) => void loadView(tab)} onConfirmScenario={confirmCurrentScenario} busy={busyAction === "scenario"} />}
        {screen === "event" && <EventScreen state={eventState} issue={eventIssue} event={event} run={run} transcriptionRun={transcriptionRun} claims={claims} claimsState={claimsState} claimsIssue={claimsIssue} onBack={navigateBack} onRetry={() => event && void loadEvent(event.id, "replace")} onDebug={() => run && void openRunDebug(run.id)} onRequirePublicWorkspaceAcknowledgement={requirePublicWorkspaceAcknowledgement} onStart={async () => {
          if (event) await startExtractionForEvent(event);
        }} onReview={() => { if (run?.id && runComplete.has(run.status)) void loadReviewQueue(); }} onOpenClaim={(id) => void openClaim(id, "event")} onAttach={async (input) => {
          if (!event) return;
          const localIssue = photoUploadIssue(input.filename, input.contentType, input.blob.size)
            ?? audioUploadIssue(input.filename, input.contentType, input.blob.size);
          if (localIssue) {
            setEventIssue(localIssue);
            return;
          }
          const imageMime = modelImageMimeFor(input.filename, input.contentType);
          const audioMime = audioMimeFor(input.filename, input.contentType);
          const preparedInput = imageMime
            ? { ...input, kind: "photo", contentType: imageMime }
            : audioMime
              ? { ...input, kind: "audio", contentType: audioMime }
              : input;
          setBusyAction("asset");
          setEventIssue(null);
          try {
            const fingerprint = ["asset-init", event.id, preparedInput.kind, preparedInput.filename, preparedInput.contentType, preparedInput.blob.size].join(":");
            const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
            mutationKeys.current.set(fingerprint, idempotencyKey);
            const init = await api.initAsset(event.id, { kind: preparedInput.kind, filename: preparedInput.filename, content_type: preparedInput.contentType, size_bytes: preparedInput.blob.size }, idempotencyKey);
            await api.uploadAsset(init.assetId, init.uploadUrl, preparedInput.blob, preparedInput.contentType);
            await api.finalizeAsset(init.assetId);
            mutationKeys.current.delete(fingerprint);
            const armed = armAutoAnalysis(
              event.id,
              preparedInput.kind === "audio" ? init.assetId : undefined,
              event.latestRun?.id || event.latestRunId || (run?.eventId === event.id ? run.id : undefined),
            );
            if (preparedInput.kind === "audio") {
              const transcription = await prepareLongAudioTranscription(
                preparedInput.blob,
                preparedInput.filename,
                init.assetId,
                event.id,
              );
              flash(transcription.orchestrationMode === "chunked"
                ? `录音已保存，${transcription.chunkCount ?? transcription.chunks.length} 段正在并行转写`
                : "录音已保存，正在生成逐字稿；完成后会自动整理重点");
            } else {
              flash(armed ? "材料已加入这次沟通，正在准备自动分析" : "材料已加入这次沟通。这个浏览器不允许保存会话状态，请点击“重新启动分析”。");
            }
            await loadEvent(event.id);
          } catch (error) {
            const issue = toIssue(error);
            await loadEvent(event.id).catch(() => undefined);
            setEventIssue(issue);
          } finally { setBusyAction(null); }
        }} onRetryTranscription={(audioAssetId) => void retryAudioTranscription(audioAssetId)} onRetryRunStatus={() => void retryRunStatus()} busy={busyAction} />}
        {screen === "draft" && <AiDraftScreen
          event={events.find((item) => item.id === projectWorkflow.currentEventId) ?? event}
          runId={currentDraftRunId()}
          claims={claims}
          occurrenceCandidates={occurrenceCandidates}
          assessment={draftAssessment}
          state={claimsState}
          issue={claimsIssue}
          busy={busyAction}
          onBack={navigateBack}
          onOpenClaim={(id) => void openClaim(id, "draft")}
          onAssessUsable={() => void recordCurrentDraftAssessment("basically_usable")}
          onStartReview={() => void startContinuousReviewFromDraft()}
          onContinueLater={() => void continueFromDraftWithoutReview()}
          onAddMissing={() => { setMissingClaimDefaultType("other"); setShowMissingClaim(true); }}
        />}
        {screen === "review" && <ReviewScreen state={claimsState} issue={claimsIssue} claims={claims} occurrenceCandidates={occurrenceCandidates} reviewSession={reviewSession} reviewClockNow={reviewClockNow} onBack={navigateBack} onRetry={() => void loadReviewQueue("review", undefined, "replace")} onOpen={(id) => void openClaim(id, "review")} onOccurrenceVerdict={(candidate, action) => void runOccurrenceVerdict(candidate, action)} onOccurrenceConvert={(candidate, newClaims) => void runOccurrenceConversion(candidate, newClaims)} busy={busyAction} />}
        {screen === "claim" && <ClaimScreen key={`${selectedClaim?.id ?? "none"}-${selectedClaim?.versionId ?? "none"}`} projectId={project?.id ?? null} claim={selectedClaim} mode={claimRouteReadonly ? "readonly" : "review"} backLabel={backLabelForRoute(route)} reviewClaims={claimRouteReadonly ? [] : claims} pendingOccurrenceCount={claimRouteReadonly ? 0 : occurrenceCandidates.filter((item) => item.status === "pending").length} evidence={evidence} evidenceState={evidenceState} issue={claimsIssue} busy={busyAction} onBack={navigateBack} onOpenReviewClaim={(id) => void openClaim(id, "review", undefined, "replace")} onVerdict={(action, reason, edit, retainRelationIds) => void runVerdict(action, reason, edit, retainRelationIds)} onWithdraw={(reason) => void withdrawClaim(reason)} onCreateRelation={runManualRelation} />}
        {screen === "review-summary" && <ReviewCompletionScreen
          project={project}
          session={reviewSession}
          destination={reviewSummaryDestination}
          onContinue={() => void continueAfterReviewSummary()}
        />}
        {screen === "results" && <ResultsScreen project={project} events={events} tab={viewTab} data={viewData} state={viewState} issue={viewIssue} busy={busyAction} loadDurationMs={viewLoadDurationMs} onBack={navigateBack} backLabel={backLabelForRoute(route)} onSelect={(tab) => void loadView(tab, undefined, "replace")} onRetry={() => void loadView(viewTab, undefined, "replace")} onOpenClaim={(id) => void openClaim(id, "results")} onResolveContradiction={(input) => void runContradictionResolution(input)} onCompleteAction={(claimId) => void completeAction(claimId)} onDecideDraftLink={(linkId, action) => void decideDraftLink(linkId, action)} onOpenAiSuggestions={() => void loadView("client-progress", undefined, "replace")} onAddAction={() => { setMissingClaimDefaultType("next_action"); setShowMissingClaim(true); }} />}
        {screen === "run-debug" && <RunDebugScreen state={runDebugState} issue={runDebugIssue} debug={runDebug} onBack={navigateBack} onRetry={() => run && void openRunDebug(run.id, "replace")} />}
      </main>
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreate={async (name) => {
        setBusyAction("new-project");
        try {
          const fingerprint = `create-project:${name}`;
          const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
          mutationKeys.current.set(fingerprint, idempotencyKey);
          const created = await api.createProject({ name }, idempotencyKey);
          mutationKeys.current.delete(fingerprint);
          setShowNewProject(false);
          await loadProjects();
          if (simpleFlow) await loadSimpleProject(created.id);
          else await loadProject(created.id);
        } catch (error) { setProjectsIssue(toIssue(error)); } finally { setBusyAction(null); }
      }} busy={busyAction === "new-project"} />}
      {showMissingClaim && (projectWorkflow.currentEventId || event?.id) && <MissingClaimModal
        eventId={projectWorkflow.currentEventId || event!.id}
        initialType={missingClaimDefaultType}
        busy={busyAction === "manual-claim"}
        onClose={() => setShowMissingClaim(false)}
        onCreate={createMissingClaim}
      />}
      {showNewEvent && project && <NewEventModal onClose={() => setShowNewEvent(false)} onCreate={async (input) => {
        setBusyAction("new-event");
        try {
          const fingerprint = ["create-event", project.id, input.event_type, input.title, input.occurred_at].join(":");
          const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
          mutationKeys.current.set(fingerprint, idempotencyKey);
          const created = await api.createEvent(project.id, input, idempotencyKey);
          mutationKeys.current.delete(fingerprint);
          setShowNewEvent(false);
          await loadProject(project.id);
          await loadEvent(created.id);
        } catch (error) { setProjectIssue(toIssue(error)); } finally { setBusyAction(null); }
      }} busy={busyAction === "new-event"} />}
      {showImport && project && <ImportModal project={project} onClose={() => setShowImport(false)} onImported={async (created) => {
        setShowImport(false);
        created.forEach((item) => armAutoAnalysis(item.id, undefined, item.latestRun?.id || item.latestRunId));
        flash(`已建立 ${created.length} 次沟通，当前一条会自动开始分析`);
        if (simpleFlow) {
          await loadSimpleProject(project.id, created[0]?.id);
        } else {
          await loadProject(project.id);
          if (created[0]) await loadEvent(created[0].id);
        }
      }} />}
      {showPublicWorkspaceConfirmation && <PublicWorkspaceConfirmationModal onCancel={cancelPublicWorkspaceAcknowledgement} onConfirm={confirmPublicWorkspaceAcknowledgement} />}
      {deletePreview && <ProjectDeleteModal preview={deletePreview} busy={busyAction === "project-delete"} onClose={() => setDeletePreview(null)} onConfirm={moveCurrentProjectToTrash} />}
      {showTrash && <ProjectTrashModal projects={trashProjects} state={trashState} issue={trashIssue} busy={busyAction} onClose={() => setShowTrash(false)} onRetry={loadTrash} onRestore={restoreDeletedProject} onPermanentDelete={permanentlyDeleteProject} />}
      {toast && <div className="toast" role="status">✓ {toast}{undoDeletedProject && <button onClick={() => void restoreDeletedProject(undoDeletedProject, true)}>撤销</button>}</div>}
    </div>
  );
}

type SimpleTestScreenProps = {
  projects: Project[];
  projectsState: AsyncState;
  projectsIssue: ApiIssue | null;
  project: Project | null;
  projectState: AsyncState;
  projectIssue: ApiIssue | null;
  events: Event[];
  eventWorkflowSummaries: Record<string, WorkflowEventSummary>;
  event: Event | null;
  eventState: AsyncState;
  eventIssue: ApiIssue | null;
  run: ExtractionRun | null;
  transcriptionRun: TranscriptionRun | null;
  transcriptionRunsByAssetId: Record<string, TranscriptionRun>;
  claims: Claim[];
  busy: string | null;
  projectWorkflow: ProjectWorkflowState;
  readingTab?: TranscriptArtifactTab;
  audioPreparationProgressByAssetId: Record<string, AudioPreparationProgress>;
  onUseProject: (id: string) => void;
  onUseEvent: (id: string) => void;
  onStartOwn: () => void;
  onAddTranscript: () => void;
  onAddFile: (file: File) => Promise<boolean>;
  onProjectWorkflowAction: () => void;
  onRetryTranscription: (audioAssetId: string) => void;
  onConfirmScenario: (scenario: string, custom?: string) => Promise<void>;
  onReview: () => void;
  onResult: (tab?: ResultTab) => void;
  onOpenClaim: (id: string) => void;
  onRetryArtifact: (eventId: string, kind: EventAiArtifactRun["kind"]) => Promise<void>;
  onStartAnalysis: (event: Event) => Promise<void>;
  onFocusTranscriptArtifact: (eventId: string, tab: TranscriptArtifactTab) => void;
  onClearTranscriptArtifact: () => void;
  transcriptFocusRequest: TranscriptFocusRequest | null;
  onTranscriptFocusHandled: (requestId: number) => void;
  onRequirePublicWorkspaceAcknowledgement: (action: () => void) => void;
  externalInteractionActive: boolean;
  onDeleteProject: () => void;
  onOpenTrash: () => void;
};

function restoreWindowScrollPosition(targetY: number, onDone: () => void): () => void {
  const target = Math.max(0, targetY);
  const startedAt = performance.now();
  let stableSince: number | null = null;
  let frame = 0;
  let stopped = false;
  const userNavigationKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

  const stop = (notify: boolean) => {
    if (stopped) return;
    stopped = true;
    if (frame) window.cancelAnimationFrame(frame);
    window.removeEventListener("wheel", handleUserIntent);
    window.removeEventListener("touchstart", handleUserIntent);
    window.removeEventListener("pointerdown", handleUserIntent);
    window.removeEventListener("keydown", handleKeyIntent);
    if (notify) onDone();
  };
  const handleUserIntent = () => stop(true);
  const handleKeyIntent = (event: KeyboardEvent) => {
    if (userNavigationKeys.has(event.key)) stop(true);
  };
  const restore = (now: number) => {
    if (stopped) return;
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const maxScrollY = Math.max(0, documentHeight - window.innerHeight);
    const targetIsAvailable = maxScrollY + 2 >= target;
    if (targetIsAvailable) {
      if (Math.abs(window.scrollY - target) > 2) {
        window.scrollTo({ top: target });
        stableSince = null;
      } else if (stableSince == null) {
        stableSince = now;
      }
      // Keep the target stable through the popstate/layout window. A later
      // summary render or native history restoration can otherwise reset it.
      if (stableSince != null && now - stableSince >= 250) {
        stop(true);
        return;
      }
    } else {
      stableSince = null;
    }
    if (now - startedAt >= 1_200) {
      if (targetIsAvailable) window.scrollTo({ top: target });
      stop(true);
      return;
    }
    frame = window.requestAnimationFrame(restore);
  };

  window.addEventListener("wheel", handleUserIntent, { passive: true });
  window.addEventListener("touchstart", handleUserIntent, { passive: true });
  window.addEventListener("pointerdown", handleUserIntent, { passive: true });
  window.addEventListener("keydown", handleKeyIntent);
  frame = window.requestAnimationFrame(restore);
  return () => stop(false);
}

function TranscriptArtifactsPanel({
  event,
  transcriptionRun,
  analysisRun,
  claims,
  pendingReviewCount,
  reviewReady,
  reviewBlocked,
  busy,
  onOpenClaim,
  onReview,
  onRetryArtifact,
  onStartAnalysis,
  onSelectTab,
  focusRequest,
  onFocusHandled,
}: {
  event: Event;
  transcriptionRun: TranscriptionRun | null;
  analysisRun: ExtractionRun | null;
  claims: Claim[];
  pendingReviewCount: number;
  reviewReady: boolean;
  reviewBlocked: boolean;
  busy: string | null;
  onOpenClaim: (id: string) => void;
  onReview: () => void;
  onRetryArtifact: (eventId: string, kind: EventAiArtifactRun["kind"]) => Promise<void>;
  onStartAnalysis: (event: Event) => Promise<void>;
  onSelectTab: (tab: TranscriptArtifactTab) => void;
  focusRequest: TranscriptFocusRequest | null;
  onFocusHandled: (requestId: number) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TranscriptArtifactTab>("readable");
  const [rawSegments, setRawSegments] = useState<TranscriptSegment[]>([]);
  const [runs, setRuns] = useState<EventAiArtifactRun[]>([]);
  const [artifacts, setArtifacts] = useState<EventAiArtifact[]>([]);
  const [state, setState] = useState<AsyncState>("loading");
  const [issue, setIssue] = useState<ApiIssue | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [sourceDrawer, setSourceDrawer] = useState<SummarySourceDrawerState | null>(null);
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set());
  const [readableDiffs, setReadableDiffs] = useState<Record<string, ReadableDiffViewState>>({});
  const [activePlaybackKey, setActivePlaybackKey] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackNodes = useRef(new Map<string, HTMLElement>());
  const pendingPlaybackTarget = useRef<{ key: string; startMs: number } | null>(null);
  const programmaticAudioSeek = useRef(false);
  const loadEpoch = useRef(0);
  const transcriptLoadEpoch = useRef(0);
  const activeDiffEventId = useRef(event.id);
  const diffLoadsInFlight = useRef(new Set<string>());
  const summaryScrollY = useRef(0);
  const manuallySelectedTab = useRef(false);
  const handledFocusRequestId = useRef<number | null>(null);
  const scrollRestoreCleanup = useRef<() => void>(() => undefined);
  const sourceDrawerExitTarget = useRef<string | null>(null);
  const transcriptRevision = [
    transcriptionRun?.id || "",
    transcriptionRun?.status || "",
    transcriptionRun?.derivedTranscriptAssetId || "",
    transcriptionRun?.segmentCount ?? transcriptionRun?.segments.length ?? 0,
    ...event.assets
      .filter((asset) => asset.kind === "audio" || asset.kind === "transcript" || stringValue(asset.metadata.transcription_status))
      .map((asset) => [asset.id, asset.versionId || "", asset.status || "", stringValue(asset.metadata.transcription_status) || ""].join(":"))
      .sort(),
  ].join("|");
  const previousTranscriptRevision = useRef(transcriptRevision);

  useEffect(() => () => scrollRestoreCleanup.current(), []);

  useEffect(() => {
    activeDiffEventId.current = event.id;
    diffLoadsInFlight.current.clear();
    playbackNodes.current.clear();
    pendingPlaybackTarget.current = null;
  }, [event.id]);

  const load = useCallback(async (quiet = false) => {
    const token = loadEpoch.current + 1;
    loadEpoch.current = token;
    if (!quiet) setState("loading");
    try {
      if (quiet) {
        const artifactData = await queryClient.fetchQuery({
          ...eventArtifactsQuery(event.id),
          staleTime: 0,
        });
        if (loadEpoch.current !== token) return;
        setRuns(artifactData.runs);
        setArtifacts(artifactData.artifacts);
        setIssue(null);
        return;
      }
      const [artifactData, segments] = await Promise.all([
        queryClient.fetchQuery(eventArtifactsQuery(event.id)),
        queryClient.fetchQuery(eventTranscriptSegmentsQuery(event.id)),
      ]);
      if (loadEpoch.current !== token) return;
      setRuns(artifactData.runs);
      setArtifacts(artifactData.artifacts);
      setRawSegments(segments);
      setIssue(null);
      setState(segments.length || artifactData.artifacts.length ? "ready" : "empty");
    } catch (error) {
      if (loadEpoch.current !== token) return;
      if (!quiet) {
        setIssue(toIssue(error));
        setState("error");
      }
    }
  }, [event.id, queryClient]);

  const refreshTranscript = useCallback(async () => {
    const token = transcriptLoadEpoch.current + 1;
    transcriptLoadEpoch.current = token;
    try {
      await queryClient.invalidateQueries({
        queryKey: eventTranscriptSegmentsQuery(event.id).queryKey,
        exact: true,
      });
      const segments = await queryClient.fetchQuery(eventTranscriptSegmentsQuery(event.id));
      if (transcriptLoadEpoch.current !== token) return;
      setRawSegments(segments);
      setIssue(null);
      setState(segments.length || artifacts.length ? "ready" : "empty");
    } catch (error) {
      if (transcriptLoadEpoch.current !== token) return;
      setIssue(toIssue(error));
      setState("error");
    }
  }, [artifacts.length, event.id, queryClient]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => {
      window.clearTimeout(timer);
      loadEpoch.current += 1;
      transcriptLoadEpoch.current += 1;
      void queryClient.cancelQueries({ queryKey: eventArtifactsQuery(event.id).queryKey, exact: true });
      void queryClient.cancelQueries({ queryKey: eventTranscriptSegmentsQuery(event.id).queryKey, exact: true });
    };
  }, [event.id, load, queryClient]);

  useEffect(() => {
    if (previousTranscriptRevision.current === transcriptRevision) return;
    previousTranscriptRevision.current = transcriptRevision;
    void refreshTranscript();
  }, [refreshTranscript, transcriptRevision]);

  const artifactRunning = runs.some((run) => run.status === "queued" || run.status === "processing");
  useEffect(() => {
    if (!artifactRunning) return;
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [artifactRunning, load]);

  const runningRunIds = runs
    .filter((artifactRun) => artifactRun.status === "queued" || artifactRun.status === "processing")
    .map((artifactRun) => artifactRun.id)
    .sort()
    .join(",");
  useEffect(() => {
    const ids = runningRunIds.split(",").filter(Boolean);
    if (!ids.length) return;
    const wake = () => {
      ids.forEach((runId) => {
        // This only wakes the already persisted Artifact Run. It does not
        // create another Run or another model request.
        void api.kickDispatcher({ kind: "artifact", runId }).catch(() => undefined);
      });
    };
    wake();
    const timer = window.setInterval(wake, ACTIVE_BACKGROUND_WAKE_MS);
    return () => window.clearInterval(timer);
  }, [runningRunIds]);

  const rawSegmentIds = useMemo(
    () => new Set(rawSegments.map((segment) => segment.id)),
    [rawSegments],
  );
  const summaryPair = selectTranscriptArtifactPair({
    runs,
    artifacts,
    kind: "summary",
    rawSegmentIds,
  });
  const readablePair = selectTranscriptArtifactPair({
    runs,
    artifacts,
    kind: "readable_transcript",
    rawSegmentIds,
  });
  const summaryRun = summaryPair.run ?? undefined;
  const readableRun = readablePair.run ?? undefined;
  const summaryArtifact = summaryPair.artifact ?? undefined;
  const readableArtifact = readablePair.artifact ?? undefined;
  const analysisRunning = Boolean(analysisRun && runInProgress.has(analysisRun.status));
  const analysisComplete = Boolean(analysisRun && runComplete.has(analysisRun.status));
  const summaryContent = isRecord(summaryArtifact?.content) ? summaryArtifact.content : null;
  const readableContent = isRecord(readableArtifact?.content) ? readableArtifact.content : null;
  const summarySections = summaryContent ? recordArray(summaryContent.sections) : [];
  const rawSegmentById = new Map(rawSegments.map((segment) => [segment.id, segment]));
  const readableDisplayGroups = groupReadableTranscriptSegments(
    (readableContent ? recordArray(readableContent.segments) : []).map((segment, index) => ({
      key: firstString(segment, ["readable_key"]) || `readable-${index}`,
      assetVersionId: rawSegmentById.get(stringValues(segment.source_segment_ids)[0] ?? "")?.asset_version_id ?? null,
      speaker: firstString(segment, ["speaker"]) ?? null,
      text: firstString(segment, ["readable_text"]) || "",
      startMs: typeof segment.start_ms === "number" ? segment.start_ms : null,
      endMs: typeof segment.end_ms === "number" ? segment.end_ms : null,
      sourceIds: stringValues(segment.source_segment_ids),
      edits: recordArray(segment.edits),
      needsCheck: segment.needs_human_check === true,
    })),
  );
  const rawDisplayGroups = groupConsecutiveSpeakerSegments(
    rawSegments.map((segment) => ({
      key: segment.id,
      assetVersionId: segment.asset_version_id,
      speaker: segment.speaker,
      text: segment.text,
      startMs: segment.start_ms,
      endMs: segment.end_ms,
      sourceIds: [segment.id],
      edits: [],
      needsCheck: false,
    })),
  );
  const sourceDrawerGroups = sourceDrawer
    ? rawDisplayGroups.filter((group) => group.sourceIds.some((id) => sourceDrawer.sourceIds.includes(id)))
    : [];
  const readerTab: "readable" | "raw" = tab === "readable" ? "readable" : "raw";

  useEffect(() => {
    if (!activePlaybackKey) return;
    const frame = window.requestAnimationFrame(() => {
      const node = playbackNodes.current.get(activePlaybackKey);
      if (!node) return;
      const bounds = node.getBoundingClientRect();
      if (bounds.top < 120 || bounds.bottom > window.innerHeight - 96) {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePlaybackKey]);

  useEffect(() => {
    if (state === "loading" || state === "idle") return;
    const hasSummary = Boolean(
      summaryArtifact
      || summaryRun?.status === "queued"
      || summaryRun?.status === "processing",
    );
    const hasReadable = Boolean(
      readableArtifact
      || readableRun?.status === "queued"
      || readableRun?.status === "processing",
    );
    const fallbackTab: TranscriptArtifactTab = hasReadable ? "readable" : hasSummary ? "summary" : "raw";
    if (
      focusRequest
      && focusRequest.eventId === event.id
      && handledFocusRequestId.current !== focusRequest.id
    ) {
      const shouldFallbackUnavailable = !manuallySelectedTab.current;
      const requestedTab = shouldFallbackUnavailable && focusRequest.tab === "summary" && !hasSummary
        ? fallbackTab
        : shouldFallbackUnavailable && focusRequest.tab === "readable" && !hasReadable
          ? fallbackTab
          : focusRequest.tab;
      handledFocusRequestId.current = focusRequest.id;
      // A URL/focus request is an explicit navigation choice. Keep that tab
      // selected after onFocusHandled clears the transient request instead of
      // immediately falling back to the preferred readable transcript.
      manuallySelectedTab.current = true;
      setTab(requestedTab);
      const restoreScrollY = focusRequest.restoreScrollY;
      if (restoreScrollY != null) {
        summaryScrollY.current = restoreScrollY;
        scrollRestoreCleanup.current();
        scrollRestoreCleanup.current = restoreWindowScrollPosition(restoreScrollY, () => {
          onFocusHandled(focusRequest.id);
        });
      } else {
        onFocusHandled(focusRequest.id);
      }
      return;
    }
    if (!focusRequest && !manuallySelectedTab.current) setTab(fallbackTab);
  }, [
    event.id,
    focusRequest,
    onFocusHandled,
    readableArtifact,
    readableRun,
    state,
    summaryArtifact,
    summaryRun,
  ]);

  function playbackKey(groupKey: string): string {
    return `${readerTab}:${groupKey}`;
  }

  function registerPlaybackNode(key: string, node: HTMLElement | null) {
    if (node) playbackNodes.current.set(key, node);
    else playbackNodes.current.delete(key);
  }

  function syncPlaybackHighlight() {
    const audio = audioRef.current;
    if (!audio) return;
    const currentMs = audio.currentTime * 1_000;
    const pending = pendingPlaybackTarget.current;
    if (pending && currentMs < pending.startMs - 80) {
      setActivePlaybackKey(pending.key);
      return;
    }
    pendingPlaybackTarget.current = null;
    const groups = readerTab === "readable" ? readableDisplayGroups : rawDisplayGroups;
    const groupKey = activeTranscriptGroupKeyAt(groups, currentMs);
    setActivePlaybackKey(groupKey ? playbackKey(groupKey) : null);
  }

  function playAt(milliseconds: number | null, targetKey: string, surface: "readable" | "raw" = readerTab) {
    if (!audioRef.current || milliseconds == null) return;
    const key = `${surface}:${targetKey}`;
    pendingPlaybackTarget.current = { key, startMs: milliseconds };
    setActivePlaybackKey(key);
    programmaticAudioSeek.current = true;
    audioRef.current.currentTime = Math.max(0, milliseconds / 1_000 - 3);
    window.setTimeout(() => { programmaticAudioSeek.current = false; }, 500);
    void audioRef.current.play().catch(() => undefined);
  }

  function selectArtifactTab(next: TranscriptArtifactTab) {
    manuallySelectedTab.current = true;
    if (tab === "summary") summaryScrollY.current = window.scrollY;
    setTab(next);
    onSelectTab(next);
    if (next === "summary") {
      window.setTimeout(() => window.scrollTo({ top: summaryScrollY.current }), 0);
    }
  }

  function locateRawSources(
    sourceIds: string[],
    summaryText: string,
    supportQuote: string,
    returnFocusId: string,
  ) {
    if (!sourceIds.length) return;
    summaryScrollY.current = window.scrollY;
    sourceDrawerExitTarget.current = null;
    setSelectedSourceIds(new Set(sourceIds));
    setSourceDrawer({ sourceIds, summaryText, supportQuote, returnFocusId });
  }

  function openSourcesInFullTranscript() {
    if (!sourceDrawer?.sourceIds.length) return;
    const sourceIds = sourceDrawer.sourceIds;
    const targetGroup = rawDisplayGroups.find((group) => group.sourceIds.includes(sourceIds[0]!));
    const targetId = `raw-group-${targetGroup?.sourceIds[0] || sourceIds[0]}`;
    sourceDrawerExitTarget.current = targetId;
    setSourceDrawer(null);
    selectArtifactTab("raw");
    window.setTimeout(() => {
      const target = document.getElementById(targetId);
      target?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      target?.focus({ preventScroll: true });
      sourceDrawerExitTarget.current = null;
    }, 60);
  }

  function openClaimFromSummary(claimId: string) {
    summaryScrollY.current = window.scrollY;
    onSelectTab("summary");
    onOpenClaim(claimId);
  }

  async function retrySummaryArtifact() {
    await onRetryArtifact(event.id, "summary");
    await load(true);
  }

  async function startAnalysisAndLoadArtifacts() {
    await onStartAnalysis(event);
    await load(true);
  }

  function toggleReadableDiff(
    key: string,
    sourceIds: string[],
    readableText: string,
  ) {
    if (openDiffs.has(key)) {
      setOpenDiffs((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      return;
    }

    setOpenDiffs((current) => new Set(current).add(key));
    if (readableDiffs[key] || diffLoadsInFlight.current.has(key)) return;

    const mappedRaw = mappedRawParagraph(sourceIds, rawSegments);
    if (mappedRaw.missingIds.length > 0) {
      setReadableDiffs((current) => ({
        ...current,
        [key]: { status: "fallback", reason: "mapping_incomplete" },
      }));
      return;
    }

    const requestEventId = event.id;
    diffLoadsInFlight.current.add(key);
    setReadableDiffs((current) => ({ ...current, [key]: { status: "loading" } }));
    void buildReadableWordDiff(mappedRaw.text, readableText)
      .then((result) => {
        if (activeDiffEventId.current !== requestEventId) return;
        setReadableDiffs((current) => ({ ...current, [key]: result }));
      })
      .catch(() => {
        if (activeDiffEventId.current !== requestEventId) return;
        setReadableDiffs((current) => ({
          ...current,
          [key]: { status: "fallback", reason: "diff_aborted" },
        }));
      })
      .finally(() => diffLoadsInFlight.current.delete(key));
  }

  if (state === "loading") return <LoadingBlock label="正在读取逐字稿与 AI 阅读版本…" />;
  if (state === "error" && issue) return <ErrorNotice issue={issue} onRetry={() => void load()} />;
  return <section className="transcript-workspace" aria-label="逐字稿阅读区">
    <section className={`summary-overview-card${summaryArtifact ? " ready" : summaryRun?.status === "failed" ? " failed" : summaryRun ? " running" : " empty"}`} aria-live="polite" aria-label="AI 摘要卡片">
      <header className="summary-overview-header">
        <div>
          <button aria-label="AI 摘要 · 本次重点" className={`summary-card-title${tab === "summary" ? " active" : ""}`} onClick={() => selectArtifactTab("summary")}>
            <span className="summary-spark" aria-hidden="true">✦</span>
            本次重点 <small>AI 草稿</small>
            {summaryRun || summaryArtifact ? <StatusBadge value={summaryRun?.status || "succeeded"} /> : <span className="summary-card-state">未生成</span>}
          </button>
          <p>{summaryArtifact ? "重点已经整理好；点击定位可跳到对应原句和时间。" : summaryRun?.status === "queued" ? "AI 摘要正在启动，原始逐字稿已经可以先读。" : summaryRun?.status === "processing" ? "AI 正在逐条整理重点，原始逐字稿已经可以先读。" : summaryRun?.status === "failed" ? "这次摘要没有通过引用安全检查，原始逐字稿不受影响。" : "新分析会在原始逐字稿完成后自动生成摘要。"}</p>
        </div>
        {summaryArtifact && <span className="summary-ready-check" aria-label="AI 摘要生成完成">✓</span>}
      </header>

      {tab === "summary" && (summaryArtifact ? <div className="summary-card-content">
        <aside className="summary-trust-note"><strong>AI 草稿</strong><span>原文定位不代表语义已经核对；重要信息确认后才进入可信记忆。</span></aside>
        {summarySections.map((section, sectionIndex) => <section key={firstString(section, ["kind"]) || sectionIndex}>
          <header><span className="section-kicker">{firstString(section, ["kind"])?.replaceAll("_", " ")}</span><h3>{firstString(section, ["title"]) || "会议重点"}</h3></header>
          <div className="summary-sentences">{recordArray(section.items).map((item, itemIndex) => {
            const ids = stringValues(item.source_segment_ids);
            const matchedClaims = matchingSummarySourceIndexes(
              ids,
              claims.map((claim) => claim.evidenceRefs.flatMap((ref) => ref.segmentIds)),
            ).map((index) => claims[index]);
            const availableMatchedClaims = reviewReady
              ? matchedClaims
              : matchedClaims.filter((claim) => claim.reviewStatus !== "pending");
            const matchedClaim = availableMatchedClaims.length === 1 ? availableMatchedClaims[0] : null;
            const revealIndex = sectionIndex * 4 + itemIndex;
            const summaryText = firstString(item, ["text"]) || "摘要内容";
            const supportQuote = firstString(item, ["support_quote"]) || "";
            const sourceTriggerId = `summary-source-${sectionIndex}-${itemIndex}`;
            return <article className="summary-reveal-line" style={{ animationDelay: `${Math.min(revealIndex, 12) * 85}ms` }} key={firstString(item, ["item_key"]) || itemIndex}>
              <div className="summary-point-copy"><mark>{summaryText}</mark><q>{supportQuote}</q></div>
              <div className="summary-point-actions">
                <button id={sourceTriggerId} className="summary-locate-button" aria-label={`查看 ${ids.length} 段原文`} onClick={() => locateRawSources(ids, summaryText, supportQuote, sourceTriggerId)}>查看来源</button>
                {matchedClaim && <button className="text-button" onClick={() => openClaimFromSummary(matchedClaim.id)}>{matchedClaim.reviewStatus === "pending" ? "核对这条意思" : "查看核对结果"}</button>}
                {availableMatchedClaims.length > 1 && <details className="summary-related-claims">
                  <summary className="text-button">{availableMatchedClaims.some((claim) => claim.reviewStatus === "pending") ? "查看相关待核对内容" : "查看相关核对结果"}（{availableMatchedClaims.length}）</summary>
                  <div>{availableMatchedClaims.map((claim) => <button className="text-button" key={claim.id} onClick={() => openClaimFromSummary(claim.id)}><span>{claim.statement}</span><StatusBadge value={claim.reviewStatus} /></button>)}</div>
                </details>}
              </div>
            </article>;
          })}</div>
        </section>)}
      </div> : summaryRun?.status === "queued" || summaryRun?.status === "processing" ? <div className="summary-card-loading" role="status">
        <div className="summary-loading-copy"><span className="spinner" /><strong>{summaryRun.status === "queued" ? "AI 摘要正在启动" : "正在生成 AI 摘要"}</strong></div>
        <div className="summary-loading-lines" aria-hidden="true"><i /><i /><i /></div>
      </div> : summaryRun?.status === "failed" ? <div className="summary-card-message failed"><h3>AI 摘要未通过安全检查</h3><span>系统拦下了引用或结构不可靠的版本。事实识别和原始逐字稿都已保留。</span><button className="button secondary" disabled={Boolean(busy)} onClick={() => void retrySummaryArtifact().catch(() => undefined)}>单独重新生成</button></div> : analysisRunning ? <div className="summary-card-loading" role="status"><div className="summary-loading-copy"><span className="spinner" /><strong>分析已启动，正在建立 AI 摘要任务</strong></div><div className="summary-loading-lines" aria-hidden="true"><i /><i /><i /></div></div> : analysisComplete ? <div className="summary-card-message"><strong>还没有 AI 摘要</strong><span>这次分析还没有可用的摘要版本，可以单独重新生成。</span><button className="button secondary" disabled={Boolean(busy)} onClick={() => void retrySummaryArtifact().catch(() => undefined)}>生成 AI 摘要</button></div> : <div className="summary-card-message"><strong>逐字稿已经准备好</strong><span>系统通常会自动生成重点；如果本次没有启动，可以直接重新尝试。</span><button className="button secondary" disabled={Boolean(busy)} onClick={() => void startAnalysisAndLoadArtifacts().catch(() => undefined)}>{busy === "extraction" ? "正在启动分析…" : "重新启动分析"}</button></div>)}
    </section>

    {tab === "summary" && rawSegments.length > 0 && <div className="summary-detail-entry"><span>{summaryArtifact ? "需要更多上下文时再展开完整逐字稿。" : "原始逐字稿已经可以阅读，不需要等待分析完成。"}</span><button className="text-button" onClick={() => selectArtifactTab(summaryArtifact && readableArtifact ? "readable" : "raw")}>{summaryArtifact ? "查看完整逐字稿" : "先看原始逐字稿"}</button></div>}

    {tab !== "summary" && <nav className="transcript-subtabs" aria-label="逐字稿版本">
      <button className={readerTab === "readable" ? "active" : ""} onClick={() => selectArtifactTab("readable")}>易读逐字稿 {readableRun || readableArtifact ? <StatusBadge value={readableRun?.status || "succeeded"} /> : <span>未生成</span>}{readablePair.legacyFallback && <span>历史版本</span>}</button>
      <button className={readerTab === "raw" ? "active" : ""} onClick={() => selectArtifactTab("raw")}>原始逐字稿 <span>{rawSegments.length}</span></button>
    </nav>}
    {transcriptionRun?.audioAssetId && <audio
      ref={audioRef}
      controls
      preload="metadata"
      src={`/api/v1/assets/${encodeURIComponent(transcriptionRun.audioAssetId)}/evidence-view`}
      onPlay={syncPlaybackHighlight}
      onTimeUpdate={syncPlaybackHighlight}
      onSeeking={() => {
        if (!programmaticAudioSeek.current) pendingPlaybackTarget.current = null;
      }}
      onSeeked={() => {
        programmaticAudioSeek.current = false;
        syncPlaybackHighlight();
      }}
      onEnded={() => {
        pendingPlaybackTarget.current = null;
        setActivePlaybackKey(null);
      }}
    />}

    {tab !== "summary" && readerTab === "readable" && <div className="artifact-panel readable-artifact">
      {readableArtifact ? readableDisplayGroups.map((group) => {
        const diffKey = `${event.id}:${group.key}`;
        const groupPlaybackKey = `readable:${group.key}`;
        const playing = activePlaybackKey === groupPlaybackKey;
        return <article ref={(node) => registerPlaybackNode(groupPlaybackKey, node)} className={`${group.needsCheck ? "needs-check" : ""}${playing ? " playing" : ""}`} aria-current={playing ? "true" : undefined} key={group.key}>
          <div className="readable-meta">
            <button aria-label={`从 ${formatTimestamp(group.startMs == null ? undefined : group.startMs / 1000)} 前三秒播放`} onClick={() => playAt(group.startMs, group.key)}>{formatTimestamp(group.startMs == null ? undefined : group.startMs / 1000)}</button>
            <strong>{displaySpeakerLabel(group.speaker)}</strong>
            {group.needsCheck && <em>请核对</em>}
            {(group.edits.length > 0 || group.needsCheck) && <details className="readable-more">
              <summary aria-label="查看整理详情">•••</summary>
              <div><button className="text-button" onClick={() => { setSelectedSourceIds(new Set(group.sourceIds)); selectArtifactTab("raw"); }}>查看原文</button><button className="text-button" onClick={() => toggleReadableDiff(diffKey, group.sourceIds, group.text)}>{openDiffs.has(diffKey) ? "收起差异" : "查看差异"}</button></div>
            </details>}
          </div>
          <p>{group.text}</p>
          {openDiffs.has(diffKey) && <ReadableTranscriptDiff state={readableDiffs[diffKey]} edits={group.edits} needsCheck={group.needsCheck} />}
        </article>;
      }) : <ArtifactFallback kind="readable_transcript" run={readableRun} busy={busy} analysisRunning={analysisRunning} analysisComplete={analysisComplete} onStartAnalysis={startAnalysisAndLoadArtifacts} onRetry={async () => {
        await onRetryArtifact(event.id, "readable_transcript");
        await load(true);
      }} onRaw={() => selectArtifactTab("raw")} />}
    </div>}

    {tab !== "summary" && readerTab === "raw" && <div className="artifact-panel raw-artifact">
      {selectedSourceIds.size > 0 && <header className="raw-focus-header"><strong>摘要或易读稿对应的原始位置</strong><button className="text-button" onClick={() => setSelectedSourceIds(new Set())}>查看完整原稿</button></header>}
      {rawSegments.length ? rawDisplayGroups.map((group) => {
        const groupPlaybackKey = `raw:${group.key}`;
        const playing = activePlaybackKey === groupPlaybackKey;
        const selected = group.sourceIds.some((id) => selectedSourceIds.has(id));
        return <article id={`raw-group-${group.sourceIds[0]}`} tabIndex={selected ? -1 : undefined} ref={(node) => registerPlaybackNode(groupPlaybackKey, node)} className={`${selected ? "selected" : ""}${playing ? " playing" : ""}`} aria-current={playing ? "true" : undefined} key={group.key}>
          {group.sourceIds.map((id) => <span className="raw-segment-anchor" id={`raw-segment-${id}`} key={id} aria-hidden="true" />)}
          <button aria-label={`从 ${formatTimestamp(group.startMs == null ? undefined : group.startMs / 1_000)} 前三秒播放`} onClick={() => playAt(group.startMs, group.key)}>{formatTimestamp(group.startMs == null ? undefined : group.startMs / 1_000)}</button><strong>{displaySpeakerLabel(group.speaker)}</strong><p>{group.text}</p>
        </article>;
      }) : <EmptyState title="还没有原始逐字稿" body="上传 Transcript 或等待录音转写完成后，原始版本会永久保留在这里。" />}
    </div>}

    {analysisComplete && reviewReady && pendingReviewCount > 0 && <footer className="focus-action-bar" aria-label="重点工作下一步">
      <div><strong>{pendingReviewCount} 条重要信息可以确认</strong><span>金额、日期、责任人和变化会优先排在前面。</span></div>
      <button className="button primary" disabled={Boolean(busy)} onClick={onReview}>核对重点</button>
    </footer>}
    {analysisComplete && !reviewBlocked && pendingReviewCount === 0 && claims.length > 0 && <footer className="focus-action-bar complete" aria-label="重点已经存档"><div><strong>本次重点已经处理完成</strong><span>确认过的内容已进入项目档案，原始来源仍然保留。</span></div><span className="focus-complete-mark">✓</span></footer>}
    {analysisRun
      && !(analysisComplete && reviewReady && pendingReviewCount > 0)
      && !(analysisComplete && !reviewBlocked && pendingReviewCount === 0 && claims.length > 0)
      && <div className="focus-action-placeholder" aria-hidden="true" />}

    {sourceDrawer && <Dialog.Root open onOpenChange={(open) => { if (!open) setSourceDrawer(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="source-drawer-backdrop" />
        <Dialog.Content
          className="source-drawer"
          onCloseAutoFocus={(closeEvent) => {
            if (sourceDrawerExitTarget.current) {
              closeEvent.preventDefault();
              return;
            }
            const target = document.getElementById(sourceDrawer.returnFocusId);
            if (!target) return;
            closeEvent.preventDefault();
            target.focus();
          }}
        >
          <header className="source-drawer-header">
            <div><span className="section-kicker">重点来源</span><Dialog.Title>{sourceDrawer.summaryText}</Dialog.Title><Dialog.Description>原句和时间只帮助定位；重要含义仍需人工确认。</Dialog.Description></div>
            <Dialog.Close asChild><button className="icon-button" aria-label="关闭来源">×</button></Dialog.Close>
          </header>
          <div className="source-drawer-body">
            {sourceDrawerGroups.length ? sourceDrawerGroups.map((group) => <article key={group.key}>
              <header><button onClick={() => playAt(group.startMs, group.key, "raw")} disabled={!transcriptionRun?.audioAssetId}>{formatTimestamp(group.startMs == null ? undefined : group.startMs / 1_000)}{transcriptionRun?.audioAssetId ? " · 播放" : ""}</button><strong>{displaySpeakerLabel(group.speaker)}</strong></header>
              <p>{highlightExactPhrase(group.text, sourceDrawer.supportQuote).map((part, index) => part.highlighted ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</p>
            </article>) : <p className="source-drawer-empty">当前摘要保留了来源编号，但原句暂时无法显示。完整原始逐字稿仍然安全保留。</p>}
          </div>
          <footer className="source-drawer-footer"><span>{sourceDrawer.sourceIds.length} 段原始记录</span><button className="text-button" onClick={openSourcesInFullTranscript}>在完整原稿中打开</button></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
  </section>;
}

const readableDiffRiskLabels: Record<ReadableDiffRisk, string> = {
  amount_or_date: "金额、日期或数量",
  negation: "否定语义",
  responsibility: "责任人或决策人",
};

function ReadableTranscriptDiff({ state, edits, needsCheck }: {
  state?: ReadableDiffViewState;
  edits: Record<string, unknown>[];
  needsCheck: boolean;
}) {
  const hasContextCorrection = edits.some((edit) => firstString(edit, ["kind"]) === "context_correction");
  if (!state || state.status === "loading") {
    return <div className="readable-diff loading" aria-live="polite"><span className="spinner" /><span>正在按这一段的原始映射生成完整对比…</span></div>;
  }

  if (state.status === "fallback") {
    const fallbackMessage = state.reason === "mapping_incomplete"
      ? "这一段的原始 Segment 映射不完整，不能安全生成完整对比。"
      : state.reason === "too_long"
        ? "这一段超过浏览器安全比较长度。"
        : state.reason === "empty_source"
          ? "这一段没有可用的映射原文。"
          : "完整对比在时间或复杂度上达到安全上限。";
    return <div className="readable-diff fallback">
      <p><strong>已回退到 AI 的整理记录</strong><span>{fallbackMessage} 以下内容仅用于阅读，最终仍以原始逐字稿为准。</span></p>
      {edits.length > 0 ? <div className="readable-edit-list">{edits.map((edit, editIndex) => <div key={editIndex}><del>{firstString(edit, ["original"]) || "（无）"}</del><span>→</span><ins>{firstString(edit, ["replacement"]) || "（删除）"}</ins><small>{firstString(edit, ["reason"])}</small></div>)}</div> : <small>AI 没有提供可回退的整理记录，请直接查看原始逐字稿。</small>}
    </div>;
  }

  const hasChangedPart = state.parts.some((part) => part.added || part.removed);
  return <div className="readable-diff ready">
    <header><div><strong>原稿 → 易读稿</strong><span>按本段映射的原始 Segment 完整比较；这里只帮助阅读，不是正式 Evidence。</span></div>{state.risks.length > 0 && <div className="readable-diff-risks">{state.risks.map((risk) => <em key={risk}>{readableDiffRiskLabels[risk]}</em>)}</div>}</header>
    {hasChangedPart ? <p className="readable-word-diff" aria-label="原始逐字稿与易读逐字稿的逐词差异">{state.parts.map((part, index) => {
      const className = part.risks.length > 0 ? `sensitive ${part.risks.map((risk) => `risk-${risk}`).join(" ")}` : undefined;
      if (part.added) return <ins className={className} key={index}>{part.value}</ins>;
      if (part.removed) return <del className={className} key={index}>{part.value}</del>;
      return <span key={index}>{part.value}</span>;
    })}</p> : <p className="readable-diff-identical">这一段与映射原文一致，没有文字变化。</p>}
    {(needsCheck || hasContextCorrection) && <p className="readable-diff-caution">AI 将这一段标为需要留意或涉及上下文修正，请优先对照原始逐字稿和录音。</p>}
  </div>;
}

function ArtifactFallback({ kind, run, busy, analysisRunning, analysisComplete, onStartAnalysis, onRetry, onRaw }: {
  kind: EventAiArtifactRun["kind"];
  run?: EventAiArtifactRun;
  busy: string | null;
  analysisRunning: boolean;
  analysisComplete: boolean;
  onStartAnalysis: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRaw: () => void;
}) {
  const name = kind === "summary" ? "AI 摘要" : "易读逐字稿";
  if (run?.status === "failed") {
    const title = kind === "summary" ? "AI 摘要未通过安全检查" : "易读逐字稿未通过完整性检查";
    const body = kind === "summary"
      ? "系统拦下了引用或结构不可靠的版本。事实识别和原始逐字稿都已保留。"
      : "系统没有采用可能遗漏、错位或改写事实的版本，已安全回退到原始逐字稿。";
    return <div className="artifact-fallback failed" role="status"><h3>{title}</h3><p>{body}</p><div><button className="button secondary" disabled={Boolean(busy)} onClick={() => void onRetry().catch(() => undefined)}>单独重新生成</button><button className="text-button" onClick={onRaw}>查看原始逐字稿</button></div></div>;
  }
  if (run?.status === "queued" || run?.status === "processing") return <div className="artifact-fallback"><span className="spinner" /><h3>{run.status === "queued" ? `${name}正在启动` : `正在生成 ${name}`}</h3><p>这项与事实识别独立运行。你现在可以直接阅读原始逐字稿。</p><button className="text-button" onClick={onRaw}>先看原始逐字稿</button></div>;
  if (analysisRunning) return <div className="artifact-fallback"><span className="spinner" /><h3>分析已启动，正在建立 {name} 任务</h3><p>原始逐字稿已经可以阅读，不需要重复点击。</p><button className="text-button" onClick={onRaw}>先看原始逐字稿</button></div>;
  if (!analysisComplete) return <div className="artifact-fallback"><h3>逐字稿已经准备好</h3><p>系统通常会自动生成重点；如果本次没有启动，可以直接重新尝试。</p><div><button className="button secondary" disabled={Boolean(busy)} onClick={() => void onStartAnalysis().catch(() => undefined)}>{busy === "extraction" ? "正在启动分析…" : "重新启动分析"}</button><button className="text-button" onClick={onRaw}>先看原始逐字稿</button></div></div>;
  return <div className="artifact-fallback"><h3>还没有 {name}</h3><p>新分析会自动生成；旧项目也可以只生成这一项，不必重新识别事实。</p><div><button className="button secondary" disabled={Boolean(busy)} onClick={() => void onRetry().catch(() => undefined)}>生成 {name}</button><button className="text-button" onClick={onRaw}>查看原始逐字稿</button></div></div>;
}

function AudioTranscriptionProgressPanel({
  preparation,
  run,
  label,
  durationMs,
  busy,
  onRetry,
}: {
  preparation: AudioPreparationProgress | null;
  run: TranscriptionRun | null;
  label?: string;
  durationMs: number | null;
  busy: string | null;
  onRetry: (audioAssetId: string) => void;
}) {
  const preparing = Boolean(preparation);
  const inspecting = preparation?.stage === "inspecting";
  const chunkedRun = !preparation && run?.orchestrationMode === "chunked" ? run : null;
  const total = preparation?.total ?? chunkedRun?.chunkCount ?? chunkedRun?.chunks.length ?? 0;
  const completed = preparation?.completed ?? chunkedRun?.completedChunkCount ?? 0;
  const progress = buildChunkProgress({
    total,
    completed,
    chunks: preparation?.chunks ?? chunkedRun?.chunks,
    chunkFractions: preparation?.chunks.map((chunk) => ({ index: chunk.index, fraction: chunk.fraction })),
  });
  const failedCount = chunkedRun?.chunks.filter((chunk) => chunk.status === "failed").length ?? 0;
  const failed = !preparation && run?.status === "failed";
  const singleRun = !preparation && run?.orchestrationMode !== "chunked" ? run : null;
  const hasChunkPlan = Boolean(preparation || chunkedRun);
  const chunksFinished = hasChunkPlan && !inspecting && progress.total > 0 && progress.remaining === 0;
  const title = inspecting
    ? "正在读取录音并规划分段"
    : preparation?.stage === "starting"
      ? "分段已经准备完毕，正在启动并行识别"
      : preparing
        ? "正在并行整理并上传录音分段"
        : chunkedRun
          ? failed
            ? "有分段识别没有完成"
            : "正在分段并行识别说话人和时间点"
          : singleRun
            ? failed
              ? "录音转写没有完成"
              : "正在识别说话人和时间点"
            : "正在准备逐字稿";
  const statusText = inspecting
    ? "读取时长后会立即显示分段数量"
    : hasChunkPlan && total > 0
      ? preparing
        ? `已准备 ${progress.completed}/${progress.total} 段 · ${progress.processing} 段并行处理中 · ${progress.percent}%`
        : `已完成 ${progress.completed}/${progress.total} 段 · ${progress.processing} 段识别中 · ${progress.queued} 段等待`
      : run?.errorCode || (singleRun ? statusLabel(singleRun.status) : "正在启动");
  const nextStepText = inspecting
    ? "录音已经保存；这里只读取时长，不会重复上传整份文件。"
    : singleRun
      ? failed
        ? "录音仍然安全保留，可以直接重新转写。"
        : "录音正在识别；完成后即可查看逐字稿并开始分析。"
    : progress.remaining > 0
      ? preparing
        ? `浏览器最多 4 段同时准备；全部登记后，后端最多 6 段同时识别。`
        : progress.processing > 0
          ? `${progress.processing} 段正在识别${progress.queued > 0 ? `，${progress.queued} 段等待并行空位` : ""}；每完成一段就会立即打勾。`
          : `还差 ${progress.remaining} 段完成识别；随后自动合并，完成后即可开始分析。`
      : preparing
        ? "所有分段已经准备好，正在交给并行识别。"
        : "所有分段已经识别，正在合并完整逐字稿；合并后即可开始分析。";
  const timeText = durationMs != null ? ` · 已用 ${formatReviewDuration(durationMs)}` : "";

  return <section className={`transcription-journey${failed ? " failed" : ""}`} aria-live="polite" data-testid="transcription-journey">
    <header>
      <span className="file-kind">AUD</span>
      <div><span className="section-kicker">录音处理进度{preparation?.filename || label ? ` · ${preparation?.filename ?? label}` : ""}</span><h3>{title}</h3><p>{statusText}{timeText}</p></div>
      {!inspecting && total > 0 && <strong className="transcription-percent">{progress.percent}%</strong>}
    </header>
    <div className={`transcription-progress-bar${inspecting ? " indeterminate" : ""}`} role="progressbar" aria-label="录音分段处理进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={inspecting ? undefined : progress.percent}>
      {!inspecting && progress.activePercent > progress.percent && <i className="transcription-progress-active" style={{ width: `${progress.activePercent}%` }} />}
      <span style={{ width: inspecting ? "34%" : `${progress.percent}%` }} />
    </div>
    {progress.nodes.length > 0 && <div className="transcription-chunk-nodes" aria-label={`${progress.total} 个录音分段`}>
      {progress.nodes.map((node) => <span className={`transcription-chunk-node ${node.status}`} key={node.index} aria-label={`第 ${node.index + 1} 段：${node.status === "completed" ? "已完成" : node.status === "processing" ? "处理中" : node.status === "failed" ? "失败" : "等待"}`}>
        <i>{node.status === "completed" ? "✓" : node.status === "failed" ? "!" : node.index + 1}</i>
        <small>第{node.index + 1}段</small>
        <em>{node.status === "completed" ? "已完成" : node.status === "processing" ? preparing ? "准备中" : "识别中" : node.status === "failed" ? "需重试" : "等待"}</em>
      </span>)}
    </div>}
    <div className="transcription-next-step"><strong>{failedCount > 0 ? `${failedCount} 段需要重试` : nextStepText}</strong><span>系统会自动继续，不需要手动开启后台任务。</span></div>
    <ol className="transcription-milestones" aria-label="距离可以开始分析的步骤">
      <li className="complete"><span>✓</span><b>录音已保存</b></li>
      <li className={chunksFinished ? "complete" : "active"}><span>{chunksFinished ? "✓" : "2"}</span><b>{hasChunkPlan ? "分段识别" : "识别逐字稿"}</b></li>
      <li className={chunksFinished && !preparing ? "active" : "pending"}><span>3</span><b>合并逐字稿</b></li>
      <li className="pending"><span>4</span><b>可开始分析</b></li>
    </ol>
    {failed && run && <button className="button secondary" disabled={Boolean(busy)} onClick={() => onRetry(run.audioAssetId)}>{busy === "transcription" ? "正在重试…" : failedCount > 0 ? `重试失败的 ${failedCount} 段` : "重新转写"}</button>}
  </section>;
}

function AnalysisProgressJourney({
  progress,
  timingItems,
}: {
  progress: AnalysisProgress;
  timingItems: ReturnType<typeof buildRunTimingItems>;
}) {
  const timingForNode = (key: AnalysisProgress["nodes"][number]["key"]) => {
    if (key === "verify") {
      return timingItems.find((item) => item.key === "verify_escalated" && item.status === "running")
        ?? timingItems.find((item) => item.key === "verify_escalated")
        ?? timingItems.find((item) => item.key === "verify");
    }
    return timingItems.find((item) => item.key === key);
  };
  const statusText = (node: AnalysisProgress["nodes"][number]) => {
    const timing = timingForNode(node.key);
    const duration = timing?.durationMs == null ? "" : ` · ${formatReviewDuration(timing.durationMs)}`;
    if (node.status === "completed") return `${node.key === "persist" ? "可以核对" : "已完成"}${duration}`;
    if (node.status === "processing") {
      if (node.key === "prepare") return `正在准备${duration}`;
      if (node.key === "inventory") return `xhigh 处理中${duration}`;
      if (node.key === "verify") return `${timing?.key === "verify_escalated" ? "加强复核" : "high 查漏中"}${duration}`;
      return `正在验证并保存${duration}`;
    }
    if (node.status === "failed") return "这一步没有完成";
    return "等待前一步";
  };

  return <section className="analysis-progress-journey" data-testid="analysis-progress-journey" aria-label="距离可以开始核对的分析进度">
    <div className="analysis-progress-track">
      {progress.nodes.map((node, index) => <div className={`analysis-progress-node ${node.status}`} key={node.key}>
        <span className="analysis-progress-node-mark">{node.status === "completed" ? "✓" : node.status === "failed" ? "!" : index + 1}</span>
        <span><strong>{node.label}</strong><small>{statusText(node)}</small></span>
      </div>)}
    </div>
    <div className="analysis-progress-next">
      <strong>{progress.remaining > 0 ? <>还差 {progress.remaining} 步即可开始核对</> : "分析已经完成，可以开始核对"}</strong>
      <span>系统会自动继续，不需要手动启动后台任务。百分比只在真实阶段完成后前进。</span>
    </div>
  </section>;
}

function SimpleTestScreen({
  projects,
  projectsState,
  projectsIssue,
  project,
  projectState,
  projectIssue,
  events,
  eventWorkflowSummaries,
  event,
  eventState,
  eventIssue,
  run,
  transcriptionRun,
  transcriptionRunsByAssetId,
  claims,
  busy,
  projectWorkflow,
  readingTab,
  audioPreparationProgressByAssetId,
  onUseProject,
  onUseEvent,
  onStartOwn,
  onAddTranscript,
  onAddFile,
  onProjectWorkflowAction,
  onRetryTranscription,
  onConfirmScenario,
  onReview,
  onResult,
  onOpenClaim,
  onRetryArtifact,
  onStartAnalysis,
  onFocusTranscriptArtifact,
  onClearTranscriptArtifact,
  transcriptFocusRequest,
  onTranscriptFocusHandled,
  onRequirePublicWorkspaceAcknowledgement,
  externalInteractionActive,
  onDeleteProject,
  onOpenTrash,
}: SimpleTestScreenProps) {
  const [showImportChoices, setShowImportChoices] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const [activeTab, setActiveTab] = useState<"materials" | "transcript" | "review" | "results">("materials");
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [scenario, setScenario] = useState("");
  const [customScenario, setCustomScenario] = useState("");
  const [timingNow, setTimingNow] = useState(() => Date.now());
  const audioFileRef = useRef<HTMLInputElement>(null);
  const photoFileRef = useRef<HTMLInputElement>(null);
  const interactionScope = useRef("");
  const userNavigatedFromWaiting = useRef(false);
  const autoFocusedSummaryKeys = useRef(new Set<string>());
  const sortedProjects = [...projects].sort((left, right) => {
    const leftSample = left.name.startsWith("[SYNTHETIC]") ? 0 : 1;
    const rightSample = right.name.startsWith("[SYNTHETIC]") ? 0 : 1;
    return leftSample - rightSample || left.name.localeCompare(right.name, "zh-CN");
  });
  const readyAssets = event?.assets.filter(assetIsAnalyzable) ?? [];
  const visibleAssets = event?.assets.filter((asset) => !assetIsGeneratedAiArtifact(asset)) ?? [];
  const materialsReady = readyAssets.length > 0;
  const currentTranscriptionRuns = event
    ? Object.values({
        ...transcriptionRunsByAssetId,
        ...(transcriptionRun ? { [transcriptionRun.audioAssetId]: transcriptionRun } : {}),
      }).filter((item) => item.eventId === event.id)
    : [];
  const transcriptionRunning = currentTranscriptionRuns.some((item) => runInProgress.has(item.status));
  const transcriptionDone = transcriptionRun?.status === "succeeded";
  const analysisRunning = Boolean(run && runInProgress.has(run.status));
  const analysisDone = Boolean(run && runComplete.has(run.status));
  const analysisFailed = Boolean(run && !analysisRunning && !analysisDone);
  const currentEventSummary = event ? eventWorkflowSummaries[event.id] : undefined;
  const extractionStatus = currentEventSummary?.statusSummary.extractionStatus ?? run?.status ?? null;
  const summaryStatus = currentEventSummary?.statusSummary.summaryStatus ?? null;
  const readableTranscriptStatus = currentEventSummary?.statusSummary.readableTranscriptStatus ?? null;
  const extractionRunId = currentEventSummary?.extraction?.run_id ?? run?.id ?? null;
  const readingAid = preferredReadingAid({
    summaryStatus,
    readableTranscriptStatus,
    extractionStatus,
  });
  const summaryFirstScopeKey = project?.id && event?.id && extractionRunId
    ? summaryFirstNavigationKey(project.id, event.id, extractionRunId)
    : null;
  const pendingCount = currentEventSummary
    ? currentEventSummary.statusSummary.pendingCount
    : event
      ? event.pendingClaimCount + event.pendingOccurrenceCount
    : project
      ? project.pendingClaimCount + project.pendingOccurrenceCount
      : 0;
  const loadingSelection = projectState === "loading" || eventState === "loading";
  const issue = eventIssue ?? projectIssue ?? projectsIssue;
  const audioAssets = event?.assets.filter((asset) =>
    asset.kind === "audio" && asset.metadata.transcription_chunk !== true) ?? [];
  const retryAudioAsset = audioAssets.find((asset) => asset.id === transcriptionRun?.audioAssetId) ?? audioAssets[0];
  const issueRetry = issue?.code.includes("TRANSCRIPTION") && retryAudioAsset
    ? () => onRetryTranscription(retryAudioAsset.id)
    : project && (issue?.code === "EXTRACTION_POLL_TIMEOUT" || (analysisFailed && materialsReady))
      ? onProjectWorkflowAction
      : undefined;
  const needsScenario = project?.scenarioStatus === "pending_confirmation"
    || Boolean(project?.scenarioCandidates?.length && project.scenarioStatus !== "confirmed");
  const factsRunningInBackground = factsStillRunning(extractionStatus);
  const factsCanBeReviewed = factsReadyForReview({
    extractionStatus,
    pendingCount,
    needsScenarioConfirmation: needsScenario,
  });
  const readingAidLabel = readingAid === "summary"
    ? "AI 摘要"
    : readingAid === "readable"
      ? "易读逐字稿"
      : "原始逐字稿";
  const currentDisplayStatus = currentEventSummary
    ? workflowEventDisplayStatus(currentEventSummary)
    : deriveGuidedDisplayStatus({
        assetCount: event?.assets.length ?? 0,
        analyzableAssetCount: readyAssets.length,
        transcriptionStatus: transcriptionRun?.status,
        runStatus: run?.status,
        pipelineStage: run?.pipelineStage,
        needsScenarioConfirmation: needsScenario,
        pendingCount,
      });
  const workflowPosition = projectWorkflow.currentPosition || Math.min(projectWorkflow.completed + 1, projectWorkflow.total);
  const workflowActionable = projectWorkflow.phase === "ready"
    || projectWorkflow.phase === "waiting_review"
    || projectWorkflow.phase === "empty_output"
    || projectWorkflow.phase === "complete"
    || projectWorkflow.phase === "draft_ready"
    || projectWorkflow.phase === "partially_reviewed"
    || projectWorkflow.phase === "error";
  const workflowActionLabels: Record<ProjectWorkflowState["phase"], string> = {
    idle: "正在准备整组材料",
    loading: "正在检查整组材料",
    empty: "请先导入材料",
    waiting_material: "等待当前材料准备完成",
    ready: projectWorkflow.completed > 0 ? "继续处理下一次沟通" : "开始处理全部沟通",
    running: "正在处理，请稍候",
    empty_output: "检查材料并重新处理",
    waiting_scenario: "请先确认使用场景",
    waiting_review: "核对这次结果",
    draft_ready: "查看 AI 草稿",
    partially_reviewed: "继续查看项目进展",
    complete: "打开会前速览",
    error: "重新检查并继续",
  };
  const workflowActionLabel = workflowActionLabels[projectWorkflow.phase];
  const workflowCopy: Record<ProjectWorkflowState["phase"], { title: string; body: string }> = {
    idle: {
      title: "准备整组材料",
      body: "系统会按 Project 中现有的沟通顺序处理。",
    },
    loading: {
      title: "正在检查整组材料",
      body: "正在读取每次沟通的材料和处理状态。",
    },
    empty: {
      title: "还没有可处理的材料",
      body: "先导入 Transcript、照片或录音，再从这里开始。",
    },
    waiting_material: {
      title: `第 ${workflowPosition}/${projectWorkflow.total} 次沟通还没准备好`,
      body: "这次沟通仍在上传或转写。系统会保留顺序，不会先处理后面的内容。",
    },
    ready: {
      title: projectWorkflow.completed > 0 ? "下一次沟通已经就绪" : "一次入口，按顺序处理整组沟通",
      body: projectWorkflow.pendingTotal > 0
        ? `前面还有 ${projectWorkflow.pendingTotal} 条 AI 草稿未核对，但不会阻止下一次分析。进入整组流程后，系统会在材料就绪时自动继续。`
        : "每次处理一条沟通。进入整组流程后会自动衔接分析；AI 草稿生成后可以立即阅读，核对可以现在做，也可以稍后继续。",
    },
    running: {
      title: `${extractionProgressLabel(run)} · 第 ${workflowPosition}/${projectWorkflow.total} 次沟通`,
      body: extractionProgressBody(run),
    },
    empty_output: {
      title: `第 ${workflowPosition}/${projectWorkflow.total} 次沟通没有生成可核对的记录`,
      body: "这次运行虽然结束了，但 Claim 和再次出现记录都是 0，不能算作完成，也不会继续处理后面的沟通。请检查材料后重新处理本次沟通。",
    },
    waiting_scenario: {
      title: `第 ${workflowPosition}/${projectWorkflow.total} 次沟通已处理`,
      body: "先在下方确认这组材料的使用场景，再核对本次结果。",
    },
    waiting_review: {
      title: `第 ${workflowPosition}/${projectWorkflow.total} 次沟通等你核对`,
      body: "你可以优先核对金额、日期、责任人、矛盾和低置信内容，也可以稍后继续。未核对草稿不会进入可信报告。",
    },
    draft_ready: {
      title: "本次分析已经完成，核对可以稍后继续",
      body: `${projectWorkflow.pendingTotal} 条 AI 草稿等待核对。你可以先使用摘要，也可以新增下一次沟通；只有确认过的内容会进入可信报告。`,
    },
    partially_reviewed: {
      title: "项目进展包含 AI 草稿和可信记忆",
      body: `${projectWorkflow.pendingTotal} 条内容仍待核对。未核对草稿不会进入 Timeline、Brief 或正式报告。`,
    },
    complete: {
      title: projectWorkflow.ignoredEmptyCount > 0 ? "所有有材料的沟通已经处理完成" : "整组沟通已经处理完成",
      body: projectWorkflow.ignoredEmptyCount > 0
        ? `${projectWorkflow.ignoredEmptyCount} 次沟通没有材料，未纳入处理。其余沟通已经完成并经过人工核对。`
        : "每次沟通的结果都已经经过人工核对。",
    },
    error: {
      title: "暂时无法确认当前进度",
      body: projectWorkflow.issue?.message || "材料和已有任务都已保留，可以重新检查后继续。",
    },
  };
  const currentWorkflowCopy = workflowCopy[projectWorkflow.phase];
  const workflowSelectedCurrent = Boolean(
    event?.id && event.id === projectWorkflow.currentEventId,
  );
  const showLiveTiming = transcriptionRunning || Boolean(
    run && workflowSelectedCurrent && (
      runInProgress.has(run.status)
      || projectWorkflow.phase === "waiting_scenario"
      || projectWorkflow.phase === "waiting_review"
    ),
  );
  useEffect(() => {
    if (!showLiveTiming) return;
    const timer = window.setInterval(() => setTimingNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run?.id, showLiveTiming]);
  const runTimingItems = run && workflowSelectedCurrent
    ? buildRunTimingItems(
        {
          status: run.status,
          createdAt: run.createdAt,
          queuedAt: run.queuedAt,
          firstQueuedAt: run.firstQueuedAt,
          currentQueuedAt: run.currentQueuedAt,
          startedAt: run.startedAt,
          firstStartedAt: run.firstStartedAt,
          currentStartedAt: run.currentStartedAt,
          processingAttemptNo: run.processingAttemptNo,
          dispatchAttemptNo: run.dispatchAttemptNo,
          finishedAt: run.finishedAt,
          stages: run.stages,
        },
        timingNow,
        {
          awaitingReview: projectWorkflow.phase === "waiting_scenario"
            || projectWorkflow.phase === "waiting_review",
        },
      )
    : [];
  const totalRunDurationMs = run && workflowSelectedCurrent
    ? runTotalDurationMs({
        status: run.status,
        createdAt: run.createdAt,
        queuedAt: run.queuedAt,
        firstQueuedAt: run.firstQueuedAt,
        currentQueuedAt: run.currentQueuedAt,
        startedAt: run.startedAt,
        firstStartedAt: run.firstStartedAt,
        currentStartedAt: run.currentStartedAt,
        processingAttemptNo: run.processingAttemptNo,
        dispatchAttemptNo: run.dispatchAttemptNo,
        finishedAt: run.finishedAt,
        stages: run.stages,
      }, timingNow)
    : null;
  const analysisProgress = run && workflowSelectedCurrent && projectWorkflow.phase === "running"
    ? buildAnalysisProgress({
        runStatus: run.status,
        pipelineStage: run.pipelineStage,
        stages: run.stages,
      })
    : null;
  const transcriptionTimingStart = transcriptionRun
    ? Date.parse(transcriptionRun.startedAt || transcriptionRun.queuedAt || transcriptionRun.createdAt || "")
    : Number.NaN;
  const transcriptionTimingEnd = transcriptionRun?.finishedAt
    ? Date.parse(transcriptionRun.finishedAt)
    : transcriptionRunning
      ? timingNow
      : Number.NaN;
  const transcriptionProcessingDurationMs = Number.isFinite(transcriptionTimingStart)
    && Number.isFinite(transcriptionTimingEnd)
    ? Math.max(0, transcriptionTimingEnd - transcriptionTimingStart)
    : null;
  const currentAudioPreparations = event
    ? Object.values(audioPreparationProgressByAssetId).filter((item) => item.eventId === event.id)
    : [];
  const materialPreparationActive = busy === "asset"
    || busy === "simple-start"
    || currentAudioPreparations.length > 0
    || transcriptionRunning;
  const workflowInputActuallyReady = materialsReady && !materialPreparationActive;
  const showProjectWorkflowCard = Boolean(project) && (
    projectWorkflow.phase === "empty"
      ? visibleAssets.length === 0 && !materialPreparationActive
      : projectWorkflow.phase === "ready"
        ? workflowInputActuallyReady
        : !["idle", "loading", "waiting_material"].includes(projectWorkflow.phase)
  );
  const workflowStepActionable = projectWorkflow.phase === "complete"
    || projectWorkflow.phase === "draft_ready"
    || projectWorkflow.phase === "partially_reviewed"
    ? true
    : workflowActionable
      && workflowSelectedCurrent
      && (projectWorkflow.phase !== "ready" || workflowInputActuallyReady);
  const workflowStepStateLabels: Record<ProjectWorkflowState["phase"], string> = {
    idle: "准备中",
    loading: "检查中",
    empty: "缺少材料",
    waiting_material: "等待材料",
    ready: "运行",
    running: "处理中",
    empty_output: "输出为空",
    waiting_scenario: "待确认场景",
    waiting_review: "待核对",
    draft_ready: "草稿可用",
    partially_reviewed: "部分已核对",
    complete: "已完成",
    error: "重新检查",
  };
  const workflowStepTitle = projectWorkflow.currentEventId && !workflowSelectedCurrent
    ? "请先选择当前沟通"
    : workflowActionLabel;
  const workflowStepBody = projectWorkflow.currentEventId && !workflowSelectedCurrent
    ? `当前顺序应处理“${projectWorkflow.currentEventTitle || "前一次沟通"}”，这里不会越过它。`
    : currentWorkflowCopy.body;
  const workflowReviewReady = pendingCount > 0 && analysisDone && !needsScenario;
  const workflowReviewBody = projectWorkflow.currentEventId && !workflowSelectedCurrent
    ? `请先选择“${projectWorkflow.currentEventTitle || "当前沟通"}”。`
    : projectWorkflow.phase === "waiting_scenario"
      ? "先确认使用场景，再核对本次生成的记录。"
      : workflowReviewReady
        ? `${pendingCount} 条内容等你确认`
        : "当前沟通处理完成后才能核对。";
  const compactWorkflowCard = projectWorkflow.phase === "empty"
    || projectWorkflow.phase === "complete"
    || projectWorkflow.phase === "draft_ready"
    || projectWorkflow.phase === "partially_reviewed";
  const materialInteractionActive = showImportChoices
    || showRecorder
    || showProjectMenu
    || externalInteractionActive;

  useEffect(() => {
    const nextScope = summaryFirstScopeKey ?? `${project?.id ?? "none"}:${event?.id ?? "none"}:no-run`;
    if (interactionScope.current === nextScope) return;
    interactionScope.current = nextScope;
    const storedMark = summaryFirstScopeKey
      ? readSummaryFirstNavigationMark(summaryFirstScopeKey)
      : null;
    userNavigatedFromWaiting.current = storedMark === "user";
    // An `auto` mark means this tab was already showing Summary before a
    // refresh. Do not treat it as an in-memory focus in the new page instance:
    // allowing the normal guarded effect to run once restores that reading
    // surface. A later explicit tab choice overwrites the mark with `user` and
    // remains protected from automatic navigation.
  }, [event?.id, project?.id, summaryFirstScopeKey]);

  useEffect(() => {
    if (!event?.id || !summaryFirstScopeKey) return;
    const alreadyFocused = autoFocusedSummaryKeys.current.has(summaryFirstScopeKey);
    if (!shouldAutoFocusSummary({
      summaryStatus,
      extractionStatus,
      activeWorkspaceTab: activeTab,
      userNavigated: userNavigatedFromWaiting.current,
      alreadyFocused,
      materialInteractionActive,
    })) return;
    autoFocusedSummaryKeys.current.add(summaryFirstScopeKey);
    storeSummaryFirstNavigationMark(summaryFirstScopeKey, "auto");
    const timer = window.setTimeout(() => {
      setActiveTab("transcript");
      onFocusTranscriptArtifact(event.id, "summary");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    activeTab,
    event?.id,
    extractionStatus,
    materialInteractionActive,
    onFocusTranscriptArtifact,
    summaryFirstScopeKey,
    summaryStatus,
  ]);

  useEffect(() => {
    if (!transcriptFocusRequest || transcriptFocusRequest.eventId !== event?.id) return;
    const timer = window.setTimeout(() => setActiveTab("transcript"), 0);
    return () => window.clearTimeout(timer);
  }, [event?.id, transcriptFocusRequest]);

  function markUserNavigation() {
    userNavigatedFromWaiting.current = true;
    if (summaryFirstScopeKey) storeSummaryFirstNavigationMark(summaryFirstScopeKey, "user");
  }

  function selectWorkspaceTab(next: "materials" | "transcript" | "review" | "results") {
    markUserNavigation();
    // A project-scope entry opens the record itself. The panel underneath is
    // only the explanation shown while that record is not reachable yet, so
    // reaching it costs one click rather than a menu, a card and a button.
    if (!busy) {
      if (next === "results" && !needsScenario && analysisDone) { onResult("client-progress"); return; }
      if (next === "review" && workflowReviewReady) { onReview(); return; }
    }
    setActiveTab(next);
    if (next === "transcript" && event) {
      onFocusTranscriptArtifact(event.id, readingTab ?? readingAid ?? "raw");
    } else if (next !== "transcript") {
      onClearTranscriptArtifact();
    }
  }

  function selectEvent(nextEventId: string) {
    interactionScope.current = "";
    userNavigatedFromWaiting.current = false;
    setActiveTab("materials");
    onUseEvent(nextEventId);
  }

  function openReadingAid(target: ReadingAidTarget) {
    if (!event) return;
    markUserNavigation();
    setActiveTab("transcript");
    onFocusTranscriptArtifact(event.id, target);
  }

  function afterProjectMenuCloses(action: () => void) {
    // Let Radix restore focus to the menu trigger before an action opens a
    // Dialog. The Dialog can then restore focus to that same trigger on close.
    window.requestAnimationFrame(action);
  }

  function chooseSupportingFile(change: ChangeEvent<HTMLInputElement>) {
    const file = change.target.files?.[0];
    change.target.value = "";
    if (file) void onAddFile(file);
  }

  return (
    <div className="page simple-page">
      {!project && <header className="simple-header">
        <span className="eyebrow">Notique Workspace</span>
        <h1>把每次沟通变成可核对的项目记忆</h1>
        <p>选择已有项目，或用 Transcript、录音和照片开始一个新项目。</p>
      </header>}

      <section className="simple-session" aria-label="当前项目和沟通">
        <div className="simple-session-copy">
          <span className="context-mark">N</span>
          <span><strong>{project ? project.name.replace(/^\[SYNTHETIC\]\s*/, "") : "尚未选择项目"}</strong><small>{event ? event.title : project ? "请选择一次沟通" : "可以先创建空白项目，也可以直接上传材料"}</small></span>
        </div>
        <label>
          <span>当前项目</span>
          <select
            aria-label="选择当前项目"
            value={project?.id ?? ""}
            disabled={projectsState === "loading" || Boolean(busy)}
            onChange={(change) => onUseProject(change.target.value)}
          >
            <option value="" disabled>{projectsState === "loading" ? "正在读取…" : "请选择"}</option>
            {sortedProjects.map((item) => (
              <option key={item.id} value={item.id}>
                {projectSelectionLabel(item, sortedProjects)}
              </option>
            ))}
          </select>
        </label>
        {events.length > 0 && <>
          <label className="simple-event-select">
            <span>当前沟通</span>
            <select aria-label="选择当前沟通" value={event?.id ?? ""} disabled={loadingSelection || Boolean(busy)} onChange={(change) => selectEvent(change.target.value)}>
              {events.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
          <button className="icon-button simple-new-event-mobile" disabled={Boolean(busy)} onClick={onAddTranscript} aria-label="添加一次沟通">＋</button>
        </>}
        <DropdownMenu.Root open={showProjectMenu} onOpenChange={setShowProjectMenu}>
          <div className="project-menu-wrap">
            <DropdownMenu.Trigger asChild>
              <button className="button secondary project-menu-trigger" disabled={Boolean(busy)}>项目菜单 ···</button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="project-menu" align="end" sideOffset={7} collisionPadding={12}>
                <DropdownMenu.Item asChild>
                  <button onClick={() => afterProjectMenuCloses(onStartOwn)}>新建项目</button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild>
                  <button onClick={() => afterProjectMenuCloses(onOpenTrash)}>回收站</button>
                </DropdownMenu.Item>
                <DropdownMenu.Item asChild disabled={!project}>
                  <button className="danger" disabled={!project} onClick={() => afterProjectMenuCloses(onDeleteProject)}>移到回收站</button>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </div>
        </DropdownMenu.Root>
      </section>

      {needsScenario && (
        <section className="simple-scenario-panel" aria-label="确认使用场景">
          <div>
            <span className="section-kicker">分析后的第一次确认</span>
            <h2>这组材料属于哪种工作场景？</h2>
            <p>只需要确认一次。后续记录会沿用这个场景，系统才能正确比较前后变化。</p>
          </div>
          <div className="scenario-options">
            {project?.scenarioCandidates?.map((item) => (
              <label className={scenario === item.key ? "selected" : ""} key={item.key}>
                <input type="radio" name="simple-scenario" value={item.key} checked={scenario === item.key} onChange={() => setScenario(item.key)} />
                <span><strong>{item.label}</strong><small>{confidenceText(item.confidence)}{item.description ? ` · ${item.description}` : ""}</small></span>
              </label>
            ))}
          </div>
          <label className="field"><span>需要时可改成更合适的名称</span><input value={customScenario} onChange={(change) => setCustomScenario(change.target.value)} placeholder="例如：保险理赔、房屋翻修或供应商评估" /></label>
          <button className="button primary" disabled={busy === "scenario" || (!scenario && !customScenario.trim())} onClick={() => void onConfirmScenario(scenario || "custom", customScenario.trim() || undefined)}>{busy === "scenario" ? "正在保存…" : "确认后继续"}</button>
        </section>
      )}

      <section className="simple-workspace" aria-label="项目工作区">
        <aside className="simple-meeting-rail">
          <header><div><span className="section-kicker">沟通记录</span><strong>{events.length} 次</strong></div>{events.length > 0 && <button className="icon-button" disabled={Boolean(busy)} onClick={onAddTranscript} aria-label="添加一次沟通">＋</button>}</header>
          <div className="simple-meeting-list">
            {events.map((item, index) => {
              const itemSummary = eventWorkflowSummaries[item.id];
              const itemDisplayStatus = workflowEventDisplayStatus(itemSummary);
              const materialCount = itemSummary?.statusSummary.materialCount;
              const itemPending = itemSummary?.statusSummary.pendingCount ?? 0;
              return (
                <button className={item.id === event?.id ? "active" : ""} key={item.id} disabled={loadingSelection || Boolean(busy)} onClick={() => selectEvent(item.id)}>
                  <span className="meeting-index">{index + 1}</span>
                  <span><strong>{item.title}</strong><small>{formatDate(item.occurredAt || item.createdAt)} · {materialCount == null ? "读取材料状态" : `${materialCount} 份材料`}</small></span>
                  {itemPending > 0 ? <span className="meeting-pending">{itemPending}</span> : <span className={`guided-status ${itemDisplayStatus.tone}`}>{itemDisplayStatus.label}</span>}
                </button>
              );
            })}
            {events.length === 0 && <p>还没有沟通记录。直接录音或上传材料时，系统会自动建立第一条。</p>}
          </div>
        </aside>

        <article className="simple-current-event">
          <header className="current-event-header">
            <div><span className="section-kicker">当前沟通</span><h2>{event?.title || "从第一份材料开始"}</h2><p>{event ? `${formatDate(event.occurredAt || event.createdAt, true)} · ${visibleAssets.length} 份材料` : "直接录音或上传 Transcript，系统会自动建立项目和第一次沟通。"}</p></div>
            <span className={`current-event-status guided-status ${currentDisplayStatus.tone}`}>{currentDisplayStatus.label}</span>
          </header>

          <nav className="meeting-tabs" aria-label="当前沟通内容">
            <button aria-label="Transcript · 本次重点" className={activeTab === "transcript" ? "active" : ""} onClick={() => selectWorkspaceTab("transcript")}><b>本次重点</b>{transcriptionDone && <span>{transcriptionRun?.segments.length}</span>}</button>
            <button className={activeTab === "materials" ? "active" : ""} onClick={() => selectWorkspaceTab("materials")}>材料 <span>{visibleAssets.length}</span></button>
            <button aria-label="待核对" className={activeTab === "review" ? "active" : ""} onClick={() => selectWorkspaceTab("review")}>待确认{pendingCount > 0 && <span>{pendingCount}</span>}</button>
            <span className="meeting-tabs-scope" aria-hidden="true" />
            <button aria-label="结果" className={`meeting-tabs-project${activeTab === "results" ? " active" : ""}`} onClick={() => selectWorkspaceTab("results")}>整个项目<i aria-hidden="true">→</i></button>
          </nav>

          {(currentAudioPreparations.length > 0 || currentTranscriptionRuns.some((item) => item.status !== "succeeded")) && <div className="transcription-journey-slot">
            {currentAudioPreparations.map((preparation) => <AudioTranscriptionProgressPanel
              key={`preparation:${preparation.audioAssetId}`}
              preparation={preparation}
              run={null}
              label={preparation.filename}
              durationMs={null}
              busy={busy}
              onRetry={onRetryTranscription}
            />)}
            {currentTranscriptionRuns
              .filter((item) => !audioPreparationProgressByAssetId[item.audioAssetId] && item.status !== "succeeded")
              .map((item) => <AudioTranscriptionProgressPanel
                key={item.id}
                preparation={null}
                run={item}
                label={visibleAssets.find((asset) => asset.id === item.audioAssetId)?.filename}
                durationMs={item.id === transcriptionRun?.id ? transcriptionProcessingDurationMs : null}
                busy={busy}
                onRetry={onRetryTranscription}
              />)}
          </div>}

          {factsRunningInBackground && readingAid && activeTab !== "transcript" && <aside className="workflow-reading-banner" aria-live="polite">
            <span className="workflow-reading-icon">✓</span>
            <div><strong>{readingAidLabel}已经可以阅读</strong><p>事实识别仍在后台，不需要留在等待页。{readingAid === "summary" ? " AI 草稿 · 原文定位不代表语义已经核对。" : " 原始逐字稿仍是最终核对依据。"}</p></div>
            <button className="button secondary" onClick={() => openReadingAid(readingAid)}>{readingAid === "summary" ? "先看 AI 摘要" : readingAid === "readable" ? "先看易读稿" : "查看原始逐字稿"}</button>
          </aside>}

          {!factsRunningInBackground && factsCanBeReviewed && activeTab === "materials" && <aside className="workflow-reading-banner ready" aria-live="polite">
            <span className="workflow-reading-icon">✓</span>
            <div><strong>事实识别已经完成</strong><p>你可以继续阅读当前摘要，重要内容已经可以核对；系统不会把你从这里跳走。</p></div>
            <span className="workflow-reading-actions">
              {readingAid === "raw" && <button className="text-button" onClick={() => openReadingAid("raw")}>查看原始逐字稿</button>}
              <button className="button secondary" onClick={() => { markUserNavigation(); onReview(); }}>核对重要内容</button>
            </span>
          </aside>}

          {!factsRunningInBackground && !factsCanBeReviewed && readingAid === "raw" && activeTab !== "transcript" && <aside className="workflow-reading-banner legacy" aria-live="polite">
            <span className="workflow-reading-icon">T</span>
            <div><strong>这个旧记录没有 AI 阅读版本</strong><p>原始逐字稿仍然完整保留，可以直接阅读和核对。</p></div>
            <button className="button secondary" onClick={() => openReadingAid("raw")}>查看原始逐字稿</button>
          </aside>}

          {activeTab === "materials" && <div className="meeting-tab-panel">
            {showProjectWorkflowCard && <section className={`project-workflow-card ${projectWorkflow.phase}${compactWorkflowCard ? " compact" : ""}`} aria-label="整组沟通处理" aria-live="polite">
              <div className="project-workflow-copy"><span className="section-kicker">整组处理 · {workflowStepStateLabels[projectWorkflow.phase]}</span><h2>{workflowStepTitle}</h2><p>{workflowStepBody}</p></div>
              {analysisProgress ? <div className="project-workflow-progress analysis"><div><span>本次分析</span><strong>{analysisProgress.percent}%</strong></div><progress aria-label="本次事实分析进度" max={100} value={analysisProgress.percent} /><small>已完成 {analysisProgress.completed}/{analysisProgress.total} 步</small></div> : projectWorkflow.phase !== "empty" && <div className="project-workflow-progress"><div><span>已完成</span><strong>{projectWorkflow.completed}/{projectWorkflow.total}</strong></div><progress max={Math.max(projectWorkflow.total, 1)} value={projectWorkflow.completed} /></div>}
              {(analysisProgress || runTimingItems.length > 0) && <details className="workflow-diagnostics">
                <summary>处理详情</summary>
                <div>
                  {analysisProgress && <AnalysisProgressJourney progress={analysisProgress} timingItems={runTimingItems} />}
                  {runTimingItems.length > 0 && <div className="workflow-timing" aria-label="本次处理分段计时">
                    <header><div><span className="section-kicker">本次处理计时</span><strong>{totalRunDurationMs == null ? "正在等待时间记录" : formatReviewDuration(totalRunDurationMs)}</strong></div><small>测试版本 · 每秒更新</small></header>
                    <p className="workflow-timing-explanation">后端会保存进度，并定期检查同一个模型任务是否完成。这里显示的是系统继续原任务的等待时间，不是重新调用模型，也不会重复收费。</p>
                    <div className="workflow-timing-grid">{runTimingItems.map((item) => <div className={item.status} key={item.key}><span>{item.label}{item.reasoningEffort ? ` · ${item.reasoningEffort}` : ""}</span><strong>{item.durationMs == null ? "等待" : formatReviewDuration(item.durationMs)}</strong>{typeof item.cachedTokens === "number" && item.cachedTokens > 0 && <small>复用 {item.cachedTokens.toLocaleString()} tokens</small>}</div>)}</div>
                  </div>}
                </div>
              </details>}
              {workflowActionable && <button className="project-workflow-action" disabled={!workflowStepActionable || Boolean(busy)} onClick={projectWorkflow.phase === "complete" ? () => onResult("brief-card") : onProjectWorkflowAction}>{busy === "project-workflow" ? "正在检查…" : workflowActionLabel}</button>}
            </section>}

            <section className="materials-section" aria-busy={busy === "asset" || busy === "simple-start"}>
              <header><div><h3>材料</h3><p>{event ? `所有新文件都会加入“${event.title}”` : "还没有当前沟通时，系统会自动建立。"}</p></div>{visibleAssets.length > 0 && <button className="button secondary" disabled={Boolean(busy)} onClick={() => setShowImportChoices((open) => !open)} aria-expanded={showImportChoices}>{showImportChoices ? "收起" : "＋ 添加材料"}</button>}</header>
              {(busy === "asset" || busy === "simple-start") && <MaterialSyncingCard detail={busy === "simple-start" ? "正在准备本次沟通，马上可以看到上传的材料。" : "文件已上传，正在刷新材料列表。"} />}
              {showImportChoices && <div className="simple-import-panel" aria-label="添加材料">
                <div className="simple-import-actions">
                  <button className="simple-import-action" disabled={Boolean(busy)} onClick={() => onRequirePublicWorkspaceAcknowledgement(() => setShowRecorder((open) => !open))}><span className="material-action-icon record">●</span><span><strong>直接录音</strong><small>使用这台设备的麦克风</small></span></button>
                  <button className="simple-import-action" disabled={Boolean(busy)} onClick={() => onRequirePublicWorkspaceAcknowledgement(() => audioFileRef.current?.click())}><span className="material-action-icon">↑</span><span><strong>上传已有录音</strong><small>MP3、M4A、WAV、WebM</small></span></button>
                  <input ref={audioFileRef} className="visually-hidden" type="file" accept={AUDIO_FILE_ACCEPT} disabled={Boolean(busy)} onChange={chooseSupportingFile} />
                  <button className="simple-import-action" disabled={Boolean(busy)} onClick={onAddTranscript}><span className="material-action-icon">T</span><span><strong>上传 Transcript</strong><small>TXT、VTT、SRT 或 JSON</small></span></button>
                  <button className="simple-import-action" disabled={Boolean(busy)} onClick={() => onRequirePublicWorkspaceAcknowledgement(() => photoFileRef.current?.click())}><span className="material-action-icon">▧</span><span><strong>添加照片</strong><small>JPG、PNG、WebP</small></span></button>
                  <input ref={photoFileRef} className="visually-hidden" type="file" accept={MODEL_IMAGE_FILE_ACCEPT} disabled={Boolean(busy)} onChange={chooseSupportingFile} />
                </div>
                {showRecorder && <DirectRecorder disabled={Boolean(busy)} onSave={onAddFile} onClose={() => setShowRecorder(false)} />}
              </div>}

              {materialPreparationActive && visibleAssets.length === 0 ? null : event && visibleAssets.length > 0 ? <div className="simple-material-list">
                {visibleAssets.map((asset) => {
                  const assetRun = asset.kind === "audio" ? transcriptionRunsByAssetId[asset.id] ?? null : null;
                  const storedTranscriptionStatus = stringValue(asset.metadata.transcription_status);
                  const canRetryTranscription = asset.kind === "audio" && assetRun?.status !== "succeeded" && storedTranscriptionStatus !== "succeeded";
                  return <article key={asset.id}><span className="file-kind">{asset.kind === "audio" ? "AUD" : asset.kind === "photo" ? "IMG" : asset.kind === "pdf" ? "PDF" : "TXT"}</span><span><b>{asset.filename}</b><small>{formatBytes(asset.sizeBytes)}{asset.kind === "audio" ? " · 保存后自动生成逐字稿" : ""}</small></span><StatusBadge value={assetRun?.status || storedTranscriptionStatus || asset.status} />{canRetryTranscription && <button className="text-button" disabled={Boolean(busy)} onClick={() => onRetryTranscription(asset.id)}>{assetRun && runInProgress.has(assetRun.status) ? "重新检查" : assetRun?.status === "failed" ? "重新转写" : "生成逐字稿"}</button>}</article>;
                })}
              </div> : <div className="materials-empty"><span>＋</span><strong>还没有材料</strong><p>可以直接开始录音，也可以上传已有材料。</p><div className="materials-empty-actions"><button className="button primary" disabled={Boolean(busy)} onClick={() => onRequirePublicWorkspaceAcknowledgement(() => { setShowImportChoices(true); setShowRecorder(true); })}>直接录音</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => setShowImportChoices(true)}>添加材料</button></div></div>}
            </section>
          </div>}

          {activeTab === "transcript" && <div className="meeting-tab-panel">
            {event ? <>
              <TranscriptArtifactsPanel
                key={event.id}
                event={event}
                transcriptionRun={transcriptionRun}
                analysisRun={run}
                claims={claims}
                pendingReviewCount={pendingCount}
                reviewReady={factsCanBeReviewed}
                reviewBlocked={needsScenario}
                busy={busy}
                onOpenClaim={onOpenClaim}
                onReview={() => { markUserNavigation(); onReview(); }}
                onRetryArtifact={onRetryArtifact}
                onStartAnalysis={onStartAnalysis}
                onSelectTab={(tab) => {
                  markUserNavigation();
                  onFocusTranscriptArtifact(event.id, tab);
                }}
                focusRequest={transcriptFocusRequest}
                onFocusHandled={onTranscriptFocusHandled}
              />
            </> : <div className="tab-empty"><span>T</span><h3>先选择一次沟通</h3><p>选择后可在 AI 摘要、易读逐字稿和原始逐字稿之间切换。</p><button className="button secondary" onClick={() => { setActiveTab("materials"); setShowImportChoices(true); }}>去添加材料</button></div>}
          </div>}

          {activeTab === "review" && <div className="meeting-tab-panel"><div className="tab-action-card"><span className="tab-action-icon">✓</span><div><span className="section-kicker">人工核对</span><h3>{workflowReviewReady ? `${pendingCount} 条事实或关系等你决定` : projectWorkflow.phase === "waiting_scenario" ? "请先确认使用场景" : pendingCount > 0 ? `${pendingCount} 条内容尚待核对` : "当前没有待核对内容"}</h3><p>{workflowReviewReady ? "优先检查金额、日期、责任人、矛盾和低置信内容。" : workflowReviewBody} 未经确认的内容不会进入项目报告。</p></div>{workflowReviewReady && <button className="button primary" disabled={Boolean(busy)} onClick={onReview}>核对重要内容</button>}</div></div>}

          {activeTab === "results" && <div className="meeting-tab-panel"><div className="tab-action-card"><span className="tab-action-icon">▤</span><div><span className="section-kicker">整个项目</span><h3>{needsScenario ? "先确认工作场景" : "先完成本次分析"}</h3><p>{needsScenario ? "确认工作场景后，这里会直接打开项目概览。" : "本次分析完成后，这里会直接打开项目概览：关键事实、需求、负责人和下一步。"}</p></div></div></div>}
        </article>
      </section>

      {loadingSelection && <LoadingBlock label="正在读取材料…" />}
      {issue && <ErrorNotice issue={issue} onRetry={issueRetry} />}
      {!project && projectsState === "empty" && <p className="simple-footnote">还没有项目。可以点击“新建项目”，也可以直接录音或上传材料，系统会自动创建。</p>}
      {run && !analysisRunning && !analysisDone && <div className="simple-recovery"><p>最近一次分析状态：{statusLabel(run.status)}。{run.errorMessage ? ` ${run.errorMessage}` : "材料没有丢失，可以按整组顺序重新处理。"}</p><button className="button secondary" disabled={!workflowStepActionable || Boolean(busy)} onClick={onProjectWorkflowAction}>{busy === "project-workflow" ? "正在检查…" : workflowSelectedCurrent ? "重新处理当前沟通" : "请先选择当前沟通"}</button></div>}
    </div>
  );
}

function PageHeader({ eyebrow, title, body, back, backLabel = "返回", actions }: { eyebrow?: string; title: string; body?: string; back?: () => void; backLabel?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-title-row">
        {back && <button className="back-button" onClick={back} aria-label={backLabel}><span aria-hidden="true">‹</span><span>{backLabel}</span></button>}
        <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{body && <p>{body}</p>}</div>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

function ProjectsScreen({ state, issue, projects, onRetry, onOpen, onCreate }: { state: AsyncState; issue: ApiIssue | null; projects: Project[]; onRetry: () => void; onOpen: (id: string) => void; onCreate: () => void }) {
  return (
    <div className="page list-page">
      <PageHeader title="Projects" body="把同一件事的多次沟通和材料放在一起。" actions={<button className="button primary" onClick={onCreate}>新建 Project</button>} />
      {state === "loading" && <LoadingBlock label="正在读取 Projects…" />}
      {state === "error" && issue && <ErrorNotice issue={issue} onRetry={onRetry} />}
      {state === "empty" && <EmptyState title="还没有 Project" body="先建立一件要持续跟进的事。它可以是客户项目、研究、课程或任何跨多次沟通的工作。" action={<button className="button primary" onClick={onCreate}>建立第一个 Project</button>} />}
      {state === "ready" && <div className="project-grid">{projects.map((item) => (
        <button className="project-card" key={item.id} onClick={() => onOpen(item.id)}>
          <span className="project-accent" />
          <div className="project-card-top"><span className="folder-icon">▰</span>{item.pendingCount ? <span className="count-pill">还有 {item.pendingCount} 条待核对</span> : null}</div>
          <h2>{item.name}</h2>
          <p>{item.scenario?.label ? `使用场景：${item.scenario.label}` : "使用场景会在第一份材料处理后由你确认"}</p>
          <div className="project-card-meta"><span>{item.eventCount == null ? "沟通数量待读取" : `${item.eventCount} 次沟通`}</span><span>{formatDate(item.updatedAt)}</span></div>
        </button>
      ))}</div>}
    </div>
  );
}

function ProjectScreen({ state, issue, project, events, onBack, onRetry, onOpenEvent, onNewEvent, onImport, onReview, onResults, onConfirmScenario, busy }: { state: AsyncState; issue: ApiIssue | null; project: Project | null; events: Event[]; onBack: () => void; onRetry: () => void; onOpenEvent: (id: string) => void; onNewEvent: () => void; onImport: () => void; onReview: () => void; onResults: (tab: ResultTab) => void; onConfirmScenario: (scenario: string, custom?: string) => Promise<void>; busy: boolean }) {
  const [scenario, setScenario] = useState("");
  const [custom, setCustom] = useState("");
  if (state === "loading") return <div className="page"><LoadingBlock label="正在读取 Project…" /></div>;
  if (state === "error" || !project) return <div className="page"><PageHeader title="Project" back={onBack} backLabel="返回项目列表" />{issue && <ErrorNotice issue={issue} onRetry={onRetry} />}</div>;
  const pendingReviewCount = project.pendingClaimCount + project.pendingOccurrenceCount;
  const needsScenario = project.scenarioStatus === "pending_confirmation" || Boolean(project.scenarioCandidates?.length && project.scenarioStatus !== "confirmed");
  return (
    <div className="page">
      <PageHeader eyebrow="Project" title={project.name} body={`${events.length} 次沟通 · ${statusLabel(project.scenarioStatus)}`} back={onBack} backLabel="返回项目列表" actions={<><button className="button secondary" onClick={onNewEvent}>新增沟通</button><button className="button primary" onClick={onImport}>导入 Transcript</button></>} />
      {issue && <ErrorNotice issue={issue} onRetry={onRetry} compact />}
      {needsScenario && <section className="scenario-panel">
        <div><span className="section-kicker">需要你确认</span><h2>这组材料属于哪种工作场景？</h2><p>场景只在第一份材料后确认一次。后续沟通会沿用，不会重复猜。</p></div>
        <div className="scenario-options">{project.scenarioCandidates?.map((item) => <label className={scenario === item.key ? "selected" : ""} key={item.key}><input type="radio" name="scenario" value={item.key} checked={scenario === item.key} onChange={() => setScenario(item.key)} /><span><strong>{item.label}</strong><small>{confidenceText(item.confidence)}{item.description ? ` · ${item.description}` : ""}</small></span></label>)}</div>
        <label className="field"><span>需要时可改成更合适的名称</span><input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="例如：顾问项目跟进" /></label>
        <button className="button primary" disabled={busy || (!scenario && !custom.trim())} onClick={() => void onConfirmScenario(scenario || "custom", custom.trim() || undefined)}>{busy ? "正在保存…" : "确认使用场景"}</button>
      </section>}
      {project.scenarioStatus === "confirmed" && <section className="project-status-row"><div><span className="section-kicker">已确认使用场景</span><strong>{project.scenario?.label || project.scenario?.key || "已确认"}</strong></div><button className="button secondary" onClick={() => onResults("folder-summary")}>打开当前结果</button></section>}
      <div className="project-screen-grid">
        <section className="panel event-panel">
          <div className="section-heading"><div><h2>沟通记录</h2><p>每份 Transcript 对应一次真实发生的沟通。</p></div><button className="text-button" onClick={onImport}>批量导入 1–10 份</button></div>
          {!events.length ? <EmptyState title="还没有沟通记录" body="可以一次导入多份 Transcript，也可以先新增一次沟通再粘贴文字或上传文件。" /> : <div className="event-list">{events.map((item, index) => <button key={item.id} onClick={() => onOpenEvent(item.id)}><span className="event-order">{index + 1}</span><span><strong>{item.title}</strong><small>{formatDate(item.occurredAt, true)} · {typeLabel(item.eventType)}</small></span><StatusBadge value={item.latestRun?.status || item.status} /><b>›</b></button>)}</div>}
        </section>
        <aside className="project-rail">
          <section className="panel action-panel"><h2>{pendingReviewCount > 0 ? `还有 ${pendingReviewCount} 条待核对` : "待核对记录"}</h2><p>AI 提取的内容先留在审核区。只有你确认的内容会进入正式结果。</p><button className="button primary full" onClick={onReview}>打开审核区</button></section>
          <section className="panel action-panel"><h2>已确认结果</h2><p>事项概况、变化、决定、偏好、问题和风险都只读取已确认记录。</p><button className="button secondary full" onClick={() => onResults("folder-summary")}>查看全部结果</button></section>
        </aside>
      </div>
      <GlossaryPanel projectId={project.id} />
      <section className="result-shortcuts"><div className="section-heading"><div><h2>会前查看</h2><p>从当前记录快速准备下一次沟通。</p></div></div><div>{resultTabs.slice(1).map((tab) => <button key={tab.key} onClick={() => onResults(tab.key)}><span>{tab.short.slice(0, 1)}</span><strong>{tab.label}</strong><b>›</b></button>)}</div></section>
    </div>
  );
}

const glossaryCategories: Array<{ value: GlossaryEntryCategory; label: string }> = [
  { value: "general", label: "通用" },
  { value: "person", label: "人名" },
  { value: "company", label: "公司" },
  { value: "industry_term", label: "行业术语" },
  { value: "material", label: "材料" },
  { value: "property", label: "地点或项目" },
];

function glossaryCategoryLabel(category: GlossaryEntryCategory): string {
  return glossaryCategories.find((item) => item.value === category)?.label ?? category;
}

function parseGlossaryVariants(value: string): string[] {
  return value
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function GlossaryPanel({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [state, setState] = useState<AsyncState>("loading");
  const [issue, setIssue] = useState<ApiIssue | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [canonicalValue, setCanonicalValue] = useState("");
  const [variants, setVariants] = useState("");
  const [category, setCategory] = useState<GlossaryEntryCategory>("general");

  const load = useCallback(async () => {
    setState("loading");
    setIssue(null);
    try {
      const result = await api.listGlossary(projectId);
      setEntries(result);
      setState(result.length ? "ready" : "empty");
    } catch (error) {
      setIssue(toIssue(error));
      setState("error");
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function clearForm() {
    setEditingId(null);
    setCanonicalValue("");
    setVariants("");
    setCategory("general");
  }

  function beginEdit(entry: GlossaryEntry) {
    setEditingId(entry.id);
    setCanonicalValue(entry.canonical_value);
    setVariants(entry.variants.join("，"));
    setCategory(entry.category);
    setDeleteId(null);
  }

  async function save() {
    if (!canonicalValue.trim()) return;
    const current = editingId ? entries.find((entry) => entry.id === editingId) : null;
    setBusy(editingId || "create");
    setIssue(null);
    try {
      const input = {
        canonicalValue: canonicalValue.trim(),
        variants: parseGlossaryVariants(variants),
        category,
      };
      if (current) {
        await api.updateGlossary(current, { ...input, isActive: current.is_active }, crypto.randomUUID());
      } else {
        await api.createGlossary(projectId, input, crypto.randomUUID());
      }
      clearForm();
      await load();
    } catch (error) {
      setIssue(toIssue(error));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(entry: GlossaryEntry) {
    setBusy(entry.id);
    setIssue(null);
    try {
      await api.updateGlossary(
        entry,
        {
          canonicalValue: entry.canonical_value,
          variants: entry.variants,
          category: entry.category,
          isActive: !entry.is_active,
        },
        crypto.randomUUID(),
      );
      if (editingId === entry.id) clearForm();
      await load();
    } catch (error) {
      setIssue(toIssue(error));
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: GlossaryEntry) {
    setBusy(entry.id);
    setIssue(null);
    try {
      await api.deleteGlossary(entry, crypto.randomUUID());
      if (editingId === entry.id) clearForm();
      setDeleteId(null);
      await load();
    } catch (error) {
      setIssue(toIssue(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel glossary-panel">
      <div className="section-heading">
        <div>
          <span className="section-kicker">项目设置</span>
          <h2>词汇表</h2>
          <p>记录正确写法和常见变体。启用的人工词条会用于后续材料分析。</p>
        </div>
      </div>
      {issue && <ErrorNotice issue={issue} onRetry={load} compact />}
      <div className="glossary-layout">
        <div className="glossary-form">
          <label className="field"><span>正确写法</span><input value={canonicalValue} maxLength={120} onChange={(event) => setCanonicalValue(event.target.value)} placeholder="例如：Nina Patel" /></label>
          <label className="field"><span>常见变体</span><textarea value={variants} onChange={(event) => setVariants(event.target.value)} placeholder="例如：Nena Patel，Nina P.&#10;用逗号或换行分开" /></label>
          <label className="field"><span>分类</span><select value={category} onChange={(event) => setCategory(event.target.value as GlossaryEntryCategory)}>{glossaryCategories.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
          <div className="button-row">
            {editingId && <button className="button secondary" type="button" onClick={clearForm}>取消</button>}
            <button className="button primary" type="button" disabled={!canonicalValue.trim() || Boolean(busy)} onClick={() => void save()}>{busy === (editingId || "create") ? "正在保存…" : editingId ? "保存修改" : "添加词条"}</button>
          </div>
        </div>
        <div className="glossary-list">
          {state === "loading" && <LoadingBlock label="正在读取词汇表…" />}
          {state === "empty" && <EmptyState title="还没有词条" body="先添加容易写错的人名、公司名或行业术语。" />}
          {entries.map((entry) => <article className={!entry.is_active ? "inactive" : ""} key={entry.id}>
            <div className="glossary-entry-main"><div><strong>{entry.canonical_value}</strong><span>{glossaryCategoryLabel(entry.category)} · {entry.source_type === "manual" ? "人工维护" : entry.source_label || "来自已确认记录"}</span></div>{!entry.is_active && <span className="status-badge neutral">已停用</span>}</div>
            <p>{entry.variants.length ? `常见变体：${entry.variants.join("、")}` : "没有记录变体"}</p>
            <div className="glossary-actions">
              <button className="text-button" disabled={Boolean(busy)} onClick={() => beginEdit(entry)}>编辑</button>
              <button className="text-button" disabled={Boolean(busy)} onClick={() => void toggle(entry)}>{entry.is_active ? "停用" : "启用"}</button>
              {deleteId === entry.id ? <><button className="text-button danger-text" disabled={Boolean(busy)} onClick={() => void remove(entry)}>{busy === entry.id ? "正在删除…" : "确认删除"}</button><button className="text-button" disabled={Boolean(busy)} onClick={() => setDeleteId(null)}>取消</button></> : <button className="text-button danger-text" disabled={Boolean(busy)} onClick={() => setDeleteId(entry.id)}>删除</button>}
            </div>
          </article>)}
        </div>
      </div>
    </section>
  );
}

function EventScreen({ state, issue, event, run, transcriptionRun, claims, claimsState, claimsIssue, onBack, onRetry, onStart, onReview, onDebug, onOpenClaim, onAttach, onRequirePublicWorkspaceAcknowledgement, onRetryTranscription, onRetryRunStatus, busy }: { state: AsyncState; issue: ApiIssue | null; event: Event | null; run: ExtractionRun | null; transcriptionRun: TranscriptionRun | null; claims: Claim[]; claimsState: AsyncState; claimsIssue: ApiIssue | null; onBack: () => void; onRetry: () => void; onStart: () => void; onReview: () => void; onDebug: () => void; onOpenClaim: (id: string) => void; onAttach: (input: { kind: string; filename: string; contentType: string; blob: Blob }) => Promise<void>; onRequirePublicWorkspaceAcknowledgement: (action: () => void) => void; onRetryTranscription: (audioAssetId: string) => void; onRetryRunStatus: () => void; busy: string | null }) {
  const [paste, setPaste] = useState("");
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (state === "loading") return <div className="page"><LoadingBlock label="正在读取这次沟通…" /></div>;
  if (state === "error" || !event) return <div className="page"><PageHeader title="沟通记录" back={onBack} backLabel="返回项目" />{issue && <ErrorNotice issue={issue} onRetry={onRetry} />}</div>;
  const readyAssets = event.assets.filter(assetIsAnalyzable);
  const canStart = readyAssets.length > 0 && !runInProgress.has(run?.status ?? "");
  const audioAssets = event.assets.filter((asset) =>
    asset.kind === "audio" && asset.metadata.transcription_chunk !== true);
  const retryAudioAsset = audioAssets.find((asset) => asset.id === transcriptionRun?.audioAssetId) ?? audioAssets[0];
  const retryIssue = issue?.code.includes("TRANSCRIPTION") && retryAudioAsset
    ? () => onRetryTranscription(retryAudioAsset.id)
    : issue?.code === "EXTRACTION_POLL_TIMEOUT"
      ? onRetryRunStatus
      : onRetry;
  return (
    <div className="page">
      <PageHeader eyebrow={typeLabel(event.eventType)} title={event.title} body={formatDate(event.occurredAt, true)} back={onBack} backLabel="返回项目" actions={<>{canStart && <button className="button primary" disabled={busy === "extraction"} onClick={onStart}>{busy === "extraction" ? "正在提交…" : run ? "重新提取" : "开始提取"}</button>}{runComplete.has(run?.status ?? "") && <button className="button secondary" onClick={onReview}>审核结果</button>}</>} />
      {issue && <ErrorNotice issue={issue} onRetry={retryIssue} />}
      {run && <section className={`run-banner ${run.status === "failed" ? "failed" : ""}`}><div className="run-state-icon">{runInProgress.has(run.status) ? <span className="spinner" /> : runComplete.has(run.status) ? "✓" : "!"}</div><div><span className="section-kicker">本次处理</span><h2>{extractionProgressLabel(run)}</h2><p>{run.errorMessage || (runInProgress.has(run.status) ? extractionProgressBody(run) : run.status === "completed_with_warnings" ? "质量门仍有提醒，请在审核区重点核对事实与关系。" : run.status === "failed" ? "材料仍然保留，可以直接重新分析。" : "请核对事实与关系；只有人工确认的内容会进入正式结果。")}</p>{run.errorCode && <small>{run.errorCode}</small>}<div className="run-recovery-actions">{run.status === "failed" && <button className="button secondary" disabled={!canStart || Boolean(busy)} onClick={onStart}>{busy === "extraction" ? "正在提交…" : "重新分析"}</button>}{issue?.code === "EXTRACTION_POLL_TIMEOUT" && <button className="button secondary" disabled={Boolean(busy)} onClick={onRetryRunStatus}>{busy === "run-status" ? "正在检查…" : "重新检查后台状态"}</button>}<button className="text-button run-debug-link" onClick={onDebug}>查看本次运行详情</button></div></div></section>}
      <div className="event-workspace">
        <section className="panel source-panel">
          <div className="section-heading"><div><h2>本次材料</h2><p>录音会先转成带说话人和时间点的逐字稿，再参与提取。</p></div><button className="button secondary small" disabled={busy === "asset"} onClick={() => onRequirePublicWorkspaceAcknowledgement(() => fileRef.current?.click())}>{busy === "asset" ? "正在同步…" : "上传材料"}</button></div>
          {busy === "asset" && <MaterialSyncingCard detail="文件已上传，正在刷新材料列表。" />}
          <input ref={fileRef} className="visually-hidden" type="file" accept={`.txt,.vtt,.srt,.json,${MODEL_IMAGE_FILE_ACCEPT},${AUDIO_FILE_ACCEPT}`} onChange={(change) => {
            const file = change.target.files?.[0];
            if (!file) return;
            const imageMime = modelImageMimeFor(file.name, file.type);
            const audioMime = audioMimeFor(file.name, file.type);
            const kind = imageMime ? "photo" : audioMime ? "audio" : "transcript";
            void onAttach({ kind, filename: file.name, contentType: imageMime || audioMime || file.type || "text/plain", blob: file });
            change.target.value = "";
          }} />
          {!event.assets.length ? <EmptyState title="还没有材料" body="上传 Transcript、录音或照片，也可以在下面粘贴一段文字。" /> : <div className="asset-list">{event.assets.map((asset) => {
            const assetRun = asset.kind === "audio" && transcriptionRun?.audioAssetId === asset.id ? transcriptionRun : null;
            const storedTranscriptionStatus = stringValue(asset.metadata.transcription_status);
            const canRetryTranscription = asset.kind === "audio" && assetRun?.status !== "succeeded" && storedTranscriptionStatus !== "succeeded";
            return <article key={asset.id}><span className="file-kind">{asset.kind === "photo" ? "IMG" : asset.kind === "audio" ? "AUD" : asset.kind === "pdf" ? "PDF" : "TXT"}</span><span><strong>{asset.filename}</strong><small>{typeLabel(asset.kind)} · {formatBytes(asset.sizeBytes)}</small>{asset.kind === "audio" && <audio controls preload="metadata" src={`/api/v1/assets/${encodeURIComponent(asset.id)}/evidence-view`} />}{canRetryTranscription && <button className="text-button asset-retry" disabled={Boolean(busy)} onClick={() => onRetryTranscription(asset.id)}>{assetRun && runInProgress.has(assetRun.status) ? "重新检查转写状态" : assetRun?.status === "failed" ? "重新转写" : "生成逐字稿"}</button>}</span><StatusBadge value={assetRun?.status || storedTranscriptionStatus || asset.status} /></article>;
          })}</div>}
          {transcriptionRun && <section className={`transcription-progress compact ${transcriptionRun.status === "failed" ? "failed" : ""}`}><div><span className="file-kind">TXT</span><span><strong>{runInProgress.has(transcriptionRun.status) ? transcriptionRun.orchestrationMode === "chunked" ? "正在分段并行生成逐字稿" : "正在生成逐字稿" : transcriptionRun.status === "succeeded" ? "带时间点逐字稿已就绪" : "录音转写失败"}</strong><small>{transcriptionRun.status === "succeeded" ? `${transcriptionRun.segmentCount ?? transcriptionRun.segments.length} 个说话片段` : transcriptionRun.orchestrationMode === "chunked" ? `已完成 ${transcriptionRun.completedChunkCount}/${transcriptionRun.chunkCount ?? transcriptionRun.chunks.length} 段` : transcriptionRun.errorCode || statusLabel(transcriptionRun.status)}</small></span></div>{transcriptionRun.segments.length > 0 && <><div className="transcript-preview">{transcriptionRun.segments.slice(0, 6).map((segment) => <p key={segment.id}><time>{formatTimestamp(segment.startMs / 1000)}</time><b>{displaySpeakerLabel(segment.speaker)}</b><span>{segment.text}</span></p>)}</div><button className="text-button transcript-open" onClick={() => setShowFullTranscript(true)}>查看完整逐字稿（{transcriptionRun.segments.length} 段）</button></>}{transcriptionRun.status === "failed" && <><p className="transcription-error-detail">{transcriptionRun.errorMessage || "本次转写结果没有通过完整性检查，录音文件仍然安全保留。"}</p><button className="button secondary" disabled={Boolean(busy)} onClick={() => onRetryTranscription(transcriptionRun.audioAssetId)}>{busy === "transcription" ? "正在重试…" : "重新转写"}</button></>}</section>}
          <div className="paste-box"><label htmlFor="paste-transcript">粘贴 Transcript 或补充文字</label><textarea id="paste-transcript" value={paste} onChange={(change) => setPaste(change.target.value)} placeholder="粘贴原文。没有时间点也可以使用，证据页会明确写无法定位具体时间。" /><button className="button secondary" disabled={!paste.trim() || busy === "asset"} onClick={() => onRequirePublicWorkspaceAcknowledgement(() => { const blob = new Blob([paste], { type: "text/plain" }); void onAttach({ kind: "text", filename: "pasted-note.txt", contentType: "text/plain", blob }).then(() => setPaste("")); })}>{busy === "asset" ? "正在保存…" : "加入这次沟通"}</button></div>
        </section>
        <aside className="event-rail">
          <section className="panel extraction-card"><h2>准备提取</h2><p>{readyAssets.length ? `${readyAssets.length} 份可分析材料已就绪。` : transcriptionRun && runInProgress.has(transcriptionRun.status) ? "录音仍在生成逐字稿，完成后才能分析。" : "至少需要一份 Transcript、文字或照片。"}</p><button className="button primary full" disabled={!canStart || busy === "extraction"} onClick={onStart}>{run ? "重新提取" : "开始提取"}</button>{!run && <small>系统会提取候选记录，并附上可以核对的原始证据。</small>}</section>
        </aside>
      </div>
      {claimsIssue && <ErrorNotice issue={claimsIssue} compact />}
      {claimsState === "loading" && <LoadingBlock label="正在读取候选记录…" />}
      {claims.length > 0 && <section className="inline-claims"><div className="section-heading"><div><h2>本次候选记录</h2><p>{claims.filter((item) => item.reviewStatus === "pending").length} 条仍待审核</p></div><button className="button secondary" onClick={onReview}>进入完整审核</button></div><div>{claims.slice(0, 5).map((claim) => <button key={claim.id} onClick={() => onOpenClaim(claim.id)}><span><small>{typeLabel(claim.type)}</small><strong>{claim.statement}</strong></span><StatusBadge value={claim.reviewStatus} /><b>›</b></button>)}</div></section>}
      {showFullTranscript && transcriptionRun && <TranscriptViewer run={transcriptionRun} onClose={() => setShowFullTranscript(false)} />}
    </div>
  );
}

function DebugField({ label, value, mono = false }: { label: string; value: unknown; mono?: boolean }) {
  const shown = stringValue(value) ?? "未记录";
  return <div className="debug-field"><span>{label}</span><strong className={mono ? "mono" : ""}>{shown}</strong></div>;
}

function RunDebugScreen({ state, issue, debug, onBack, onRetry }: { state: AsyncState; issue: ApiIssue | null; debug: RunDebug | null; onBack: () => void; onRetry: () => void }) {
  if (state === "loading") return <div className="page narrow-page"><PageHeader eyebrow="内部页" title="本次运行详情" back={onBack} backLabel="返回本次沟通" /><LoadingBlock label="正在读取服务器中的运行记录…" /></div>;
  if (state === "error" || !debug) return <div className="page narrow-page"><PageHeader eyebrow="内部页" title="本次运行详情" back={onBack} backLabel="返回本次沟通" />{issue ? <ErrorNotice issue={issue} onRetry={onRetry} /> : <EmptyState title="没有运行详情" body="服务器没有返回这次运行的数据。" />}</div>;
  const data = debug.data;
  const manifest = recordArray(data.input_manifest);
  const modelParams = isRecord(data.model_params) ? data.model_params : {};
  const reasoningEffort = stringValue(modelParams.reasoning_effort);
  const maxOutputTokens = stringValue(modelParams.max_output_tokens);
  const timeoutMs = firstString(modelParams, ["timeout_ms", "request_timeout_ms"]);
  const missingFrozenParameters = [
    !reasoningEffort && "reasoning effort",
    !maxOutputTokens && "max output tokens",
    !timeoutMs && "timeout",
  ].filter((value): value is string => Boolean(value));
  const errorDetails = isRecord(data.error_details) ? data.error_details : null;
  const warnings = errorDetails ? recordArray(errorDetails.warnings) : [];
  const stages = recordArray(data.stages);
  const artifactRuns = recordArray(data.artifact_runs);
  const validatedOutput = data.validated_output;
  const hasValidatedOutput = validatedOutput !== null && validatedOutput !== undefined;
  const rawJson = JSON.stringify(redactDebugValue(data), null, 2);
  return (
    <div className="page debug-page">
      <PageHeader eyebrow="内部页" title="本次运行详情" body="用于核对模型、输入、验证结果和成本。这里不影响正式结果。" back={onBack} backLabel="返回本次沟通" actions={<StatusBadge value={stringValue(data.status)} />} />
      <section className="debug-request"><span>本次页面请求 ID</span><code>{debug.requestId}</code></section>
      <div className="debug-grid">
        <section className="panel debug-section"><div className="section-heading"><div><h2>模型与执行参数</h2><p>这些值从本次 Run 保存的配置读取，不使用当前环境变量补齐。</p></div></div><div className="debug-fields"><DebugField label="Provider" value={data.provider} /><DebugField label="Model" value={data.model} /><DebugField label="Reasoning effort" value={reasoningEffort ?? "未冻结"} mono /><DebugField label="最大输出 token" value={maxOutputTokens ? `${maxOutputTokens} tokens` : "未冻结"} /><DebugField label="请求超时" value={timeoutMs ? `${timeoutMs} ms` : "未冻结"} /><DebugField label="Prompt" value={data.prompt_version} mono /><DebugField label="Schema" value={data.schema_version} mono /><DebugField label="Parser" value={data.parser_version} mono /><DebugField label="Provider Request ID" value={data.provider_request_id} mono /></div>{missingFrozenParameters.length > 0 && <p className="debug-config-warning" role="alert">这次 Run 没有完整冻结执行参数：{missingFrozenParameters.join("、")}。调试时不能用当前环境配置代替这次运行的实际值。</p>}</section>
        <section className="panel debug-section"><div className="section-heading"><div><h2>用量</h2><p>没有返回的用量保持空白。</p></div></div><div className="debug-fields"><DebugField label="Input tokens" value={data.input_tokens} /><DebugField label="Output tokens" value={data.output_tokens} /><DebugField label="Cached tokens" value={data.cached_tokens} /><DebugField label="Image units" value={data.image_units} /><DebugField label="Estimated cost USD" value={data.estimated_cost_usd} /><DebugField label="Attempt" value={data.attempt_no} /></div></section>
      </div>
      <section className="panel debug-section"><div className="section-heading"><div><h2>Input manifest</h2><p>这次提交给处理任务的材料版本。</p></div></div>{manifest.length ? <div className="manifest-list">{manifest.map((item, index) => <article key={firstString(item, ["asset_version_id"]) || index}><span className="event-order">{index + 1}</span><div><strong>{firstString(item, ["kind"]) || "未知类型"}</strong><code>{firstString(item, ["asset_version_id"]) || "缺少 Asset Version ID"}</code><small>Parser: {firstString(item, ["parser_version"]) || "未记录"}</small><small>SHA-256: {firstString(item, ["sha256"]) || "未记录"}</small></div></article>)}</div> : <EmptyState title="没有 Input manifest" body="服务器没有为这次运行返回任何输入材料。" />}</section>
      <section className="panel debug-section"><div className="section-heading"><div><h2>双 Agent 阶段</h2><p>同一 Run 的事实盘点、查漏纠错和必要的加强复核分别记录；成功阶段可在重试时复用。</p></div></div>{stages.length ? <div className="manifest-list">{stages.map((stage, index) => {
        const name = firstString(stage, ["stage"]);
        const label = name === "inventory" ? "Agent A · 识别事实" : name === "verify" ? "Agent B · 查漏纠错" : "Agent B · 加强复核";
        const stageDetails = isRecord(stage.error_details) ? stage.error_details : null;
        const escalationReasons = stageDetails && Array.isArray(stageDetails.escalation_reasons)
          ? stageDetails.escalation_reasons.filter((reason): reason is string => typeof reason === "string")
          : [];
        return <article key={firstString(stage, ["id"]) || index}><span className="event-order">{index + 1}</span><div><strong>{label}</strong><small>{statusLabel(firstString(stage, ["status"]))} · Reasoning {firstString(stage, ["reasoning_effort"]) || "未记录"}</small><small>Input {firstString(stage, ["input_tokens"]) || "—"} · Output {firstString(stage, ["output_tokens"]) || "—"} · {firstString(stage, ["duration_ms"]) || "—"} ms</small>{escalationReasons.length > 0 && <small>升级原因：{escalationReasons.join("、")}</small>}{firstString(stage, ["error_code"]) && <code>{firstString(stage, ["error_code"])}</code>}</div></article>;
      })}</div> : <EmptyState title="还没有阶段记录" body="任务开始调用模型后，这里会显示每一轮的真实状态。" />}</section>
      <section className="panel debug-section"><div className="section-heading"><div><h2>阅读辅助 Agent</h2><p>摘要和易读逐字稿独立运行；它们不会覆盖原始逐字稿，也不会直接进入正式项目记忆。</p></div></div>{artifactRuns.length ? <div className="manifest-list">{artifactRuns.map((artifactRun, index) => {
        const kind = firstString(artifactRun, ["kind"]);
        return <article key={firstString(artifactRun, ["id"]) || index}><span className="event-order">{index + 1}</span><div><strong>{kind === "summary" ? "Summary Agent · AI 摘要" : "Transcript Refiner · 易读逐字稿"}</strong><small>{statusLabel(firstString(artifactRun, ["status"]))} · Luna {firstString(artifactRun, ["reasoning_effort"]) || "high"}</small><small>Input {firstString(artifactRun, ["input_tokens"]) || "—"} · Output {firstString(artifactRun, ["output_tokens"]) || "—"} · Attempt {firstString(artifactRun, ["attempt_no"]) || "0"}</small>{firstString(artifactRun, ["provider_request_id"]) && <code>{firstString(artifactRun, ["provider_request_id"])}</code>}{firstString(artifactRun, ["error_code"]) && <code>{firstString(artifactRun, ["error_code"])}</code>}</div></article>;
      })}</div> : <EmptyState title="没有阅读辅助记录" body="旧 Run 或没有 Transcript 的 Run 不会生成摘要和易读逐字稿。" />}</section>
      <section className="panel debug-section"><div className="section-heading"><div><h2>验证提醒与错误</h2><p>程序验证没有通过的内容会在这里留下原因。</p></div></div>{warnings.length ? <div className="warning-list">{warnings.map((warning, index) => <article key={`${firstString(warning, ["code"]) || "warning"}:${index}`}><strong>{firstString(warning, ["code"]) || "未命名提醒"}</strong><pre>{JSON.stringify(redactDebugValue(warning), null, 2)}</pre></article>)}</div> : <p className="muted">服务器没有记录 validation warning。</p>}<div className="debug-error-row"><DebugField label="Error code" value={data.error_code} mono /><DebugField label="Outbox error" value={data.outbox_error_code} mono /><DebugField label="Outbox status" value={data.outbox_status} /></div>{errorDetails && !warnings.length && <pre className="debug-json small">{JSON.stringify(redactDebugValue(errorDetails), null, 2)}</pre>}</section>
      <section className="panel debug-section debug-output"><div className="section-heading"><div><h2>validated_output</h2><p>这是通过服务器 Schema 校验后保留下来的模型 JSON，仅供内部排查。</p></div></div>{hasValidatedOutput ? <pre className="debug-json">{JSON.stringify(redactDebugValue(validatedOutput), null, 2)}</pre> : <p className="muted">本次没有模型输出。</p>}</section>
      <section className="panel debug-section"><div className="section-heading"><div><h2>时间</h2><p>每个阶段都直接读取服务器时间。</p></div></div><div className="debug-fields"><DebugField label="Created" value={data.created_at} /><DebugField label="Queued" value={data.queued_at} /><DebugField label="Started" value={data.started_at} /><DebugField label="Finished" value={data.finished_at} /><DebugField label="Updated" value={data.updated_at} /><DebugField label="Next queue attempt" value={data.next_attempt_at} /></div></section>
      <details className="panel debug-raw"><summary>查看脱敏后的原始 JSON</summary><p>API Key、授权信息、Cookie、存储 Key 和 Idempotency Key 会被隐藏。</p><pre className="debug-json">{rawJson}</pre></details>
    </div>
  );
}

function OccurrenceEvidenceCard({ evidence }: { evidence: OccurrenceCandidate["evidence"][number] }) {
  return (
    <article className="occurrence-evidence-card">
      <div className="evidence-card-head"><span className="file-kind">{evidence.kind === "photo" ? "IMG" : evidence.kind === "document" ? "PDF" : "TXT"}</span><span><strong>{typeLabel(evidence.kind)} · {typeLabel(evidence.evidence_role)}</strong><small>Asset Version {evidence.asset_version_id}</small></span></div>
      {evidence.quote_raw && <blockquote>“{evidence.quote_raw}”</blockquote>}
      {evidence.observation && <p>{evidence.observation}</p>}
      <div className="evidence-coordinates">
        {(evidence.start_ms !== null || evidence.end_ms !== null) && <span>{formatTimestamp(evidence.start_ms == null ? undefined : evidence.start_ms / 1000)} 至 {formatTimestamp(evidence.end_ms == null ? undefined : evidence.end_ms / 1000)}</span>}
        {evidence.page_number && <span>第 {evidence.page_number} 页</span>}
        {evidence.segment_ids.length > 0 && <span>Segments: {evidence.segment_ids.join("、")}</span>}
      </div>
      {evidence.asset_view_url && <a className="evidence-open" href={evidence.asset_view_url} target="_blank" rel="noreferrer">打开原始材料</a>}
    </article>
  );
}

const occurrenceClaimTypeOptions: Array<{ value: OccurrenceNewClaim["type"]; label: string }> = [
  { value: "decision", label: "决定" },
  { value: "requirement", label: "要求" },
  { value: "budget", label: "预算" },
  { value: "timing", label: "时间计划" },
  { value: "preference", label: "偏好" },
  { value: "person_role", label: "人员与职责" },
  { value: "material", label: "材料" },
  { value: "measurement", label: "尺寸" },
  { value: "property_fact", label: "现场事实" },
  { value: "next_action", label: "下一步行动" },
  { value: "risk", label: "风险" },
  { value: "concern", label: "顾虑" },
  { value: "open_question", label: "待确认问题" },
  { value: "other", label: "其他" },
];

function canonicalOccurrenceType(value: string | null | undefined): OccurrenceNewClaim["type"] {
  return occurrenceClaimTypeOptions.some((option) => option.value === value)
    ? value as OccurrenceNewClaim["type"]
    : "other";
}

function OccurrenceReviewCard({ candidate, busy, onOpen, onVerdict, onConvert }: {
  candidate: OccurrenceCandidate;
  busy: string | null;
  onOpen: (id: string) => void;
  onVerdict: (candidate: OccurrenceCandidate, action: "confirm" | "reject") => void;
  onConvert: (candidate: OccurrenceCandidate, claims: OccurrenceNewClaim[]) => void;
}) {
  const [showConversion, setShowConversion] = useState(false);
  const [conversionText, setConversionText] = useState(
    candidate.proposed_statement || candidate.target_statement,
  );
  const defaultConversionType = canonicalOccurrenceType(
    candidate.proposed_type || candidate.target_type,
  );
  const [conversionTypes, setConversionTypes] = useState<Record<string, OccurrenceNewClaim["type"]>>({});
  const statements = [...new Set(
    conversionText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  )];
  const tooMany = statements.length > 10;
  const candidateBusy = busy === `occurrence:${candidate.id}`;
  const pending = candidate.status === "pending";
  return (
    <article className="occurrence-card">
      <header><div><span className="eyebrow">{typeLabel(candidate.target_type)}</span><h3>{candidate.target_statement}</h3></div><span className={`status-badge ${candidate.status === "rejected" ? "danger" : pending ? "warning" : "success"}`}>{candidate.status === "confirmed" ? "已确认再次出现" : candidate.status === "rejected" ? "未采纳" : candidate.status === "converted" ? "已转为新记录" : "待审核"}</span></header>
      {candidate.proposed_statement && candidate.proposed_statement !== candidate.target_statement && <p className="proposed-occurrence"><b>这次的说法：</b>{candidate.proposed_statement}</p>}
      <div className="occurrence-evidence-list">{candidate.evidence.length ? candidate.evidence.map((item, index) => <OccurrenceEvidenceCard key={`${item.asset_version_id}:${index}`} evidence={item} />) : <p className="uncertainty">服务器没有返回可核对的新证据，不能确认。</p>}</div>
      {showConversion && pending && <form className="occurrence-conversion" onSubmit={(event) => {
        event.preventDefault();
        if (!statements.length || tooMany) return;
        onConvert(candidate, statements.map((statement) => ({
          statement,
          type: conversionTypes[statement] || defaultConversionType,
        })));
      }}>
        <div><strong>把新变化单独留下</strong><p>每行写一条记录。生成后还要逐条核对，原记录不会被修改。</p></div>
        <label><span>要新增的记录</span><textarea value={conversionText} onChange={(event) => setConversionText(event.target.value)} rows={Math.max(3, Math.min(7, statements.length + 1))} maxLength={10000} autoFocus /></label>
        {statements.length > 0 && <div className="occurrence-conversion-rows"><span>必要时修改每条记录的类别</span>{statements.slice(0, 10).map((statement, index) => <label key={statement}><strong>{index + 1}. {statement}</strong><select aria-label={`第 ${index + 1} 条记录的类别`} value={conversionTypes[statement] || defaultConversionType} onChange={(event) => setConversionTypes((current) => ({ ...current, [statement]: event.target.value as OccurrenceNewClaim["type"] }))}>{occurrenceClaimTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}</div>}
        {tooMany && <p className="uncertainty">一次最多生成 10 条，请删掉或合并几行。</p>}
        <div className="occurrence-conversion-actions"><button className="button primary" type="submit" disabled={Boolean(busy) || !candidate.evidence.length || !statements.length || tooMany}>{candidateBusy ? "正在生成…" : `生成 ${statements.length || 0} 条待审核记录`}</button><button className="button quiet" type="button" disabled={Boolean(busy)} onClick={() => setShowConversion(false)}>取消</button></div>
      </form>}
      <div className="occurrence-actions"><button className="button primary" disabled={Boolean(busy) || !candidate.evidence.length || !pending} onClick={() => onVerdict(candidate, "confirm")}>{candidateBusy && !showConversion ? "正在保存…" : "确认只是再次提到"}</button>{pending && <button className="button quiet" disabled={Boolean(busy) || !candidate.evidence.length} onClick={() => setShowConversion((value) => !value)}>{showConversion ? "收起新增记录" : "这次有新变化"}</button>}<button className="button quiet danger-text" disabled={Boolean(busy) || !pending} onClick={() => onVerdict(candidate, "reject")}>不采纳这次记录</button><button className="text-button" onClick={() => onOpen(candidate.target_claim_id)}>查看原记录与旧证据</button></div>
    </article>
  );
}

const aiDraftSectionLabels = {
  decisions: "决定与要求",
  money_dates_owners: "金额、日期与负责人",
  preferences: "偏好与材料",
  open_questions: "仍待确认",
  risks: "风险与补证据",
  other: "其他重要事实",
} as const;

function AiDraftScreen({ event, runId, claims, occurrenceCandidates, assessment, state, issue, busy, onBack, onOpenClaim, onAssessUsable, onStartReview, onContinueLater, onAddMissing }: { event: Event | null; runId: string | null; claims: Claim[]; occurrenceCandidates: OccurrenceCandidate[]; assessment: AiDraftAssessment | null; state: AsyncState; issue: ApiIssue | null; busy: string | null; onBack: () => void; onOpenClaim: (id: string) => void; onAssessUsable: () => void; onStartReview: () => void; onContinueLater: () => void; onAddMissing: () => void }) {
  const runClaims = claims.some((claim) => claim.runId === runId)
    ? claims.filter((claim) => claim.runId === runId)
    : claims.filter((claim) => claim.reviewStatus === "pending");
  const runOccurrences = occurrenceCandidates.filter((candidate) => !runId || candidate.extraction_run_id === runId);
  const claimById = new Map(runClaims.map((claim) => [claim.id, claim]));
  const summaryItems = [...buildAiDraftSummary(runClaims)].sort((left, right) => {
    if (left.timestampStart !== null && right.timestampStart !== null) return left.timestampStart - right.timestampStart;
    if (left.timestampStart !== null) return -1;
    if (right.timestampStart !== null) return 1;
    return left.claimId.localeCompare(right.claimId);
  });
  const proposedRelationCount = runClaims.reduce((total, claim) => total + claim.relationsForReview.filter((relation) => relation.status === "proposed").length, 0);
  return (
    <div className="page ai-draft-page">
      <PageHeader eyebrow={event?.title || "本次沟通"} title="AI 会议信息初稿" body="按对话发生顺序先看 AI 抓到的重点。点击任意一条即可回到原句核对；初稿不会自动进入正式报告。" back={onBack} backLabel="返回核心工作台" actions={<span className="status-badge pending">待人工核对</span>} />
      {issue && <ErrorNotice issue={issue} compact />}
      {state === "loading" ? <LoadingBlock label="正在整理已经生成的 AI 初稿…" /> : <>
        <section className="draft-overview panel"><div><span className="section-kicker">AI 先做了什么</span><h2>{runClaims.length + runOccurrences.length} 条候选信息</h2><p>{runClaims.length} 条新事实 · {runOccurrences.length} 条再次出现 · {proposedRelationCount} 条关系判断</p></div><div className="draft-guardrail"><strong>这还是草稿</strong><p>你可以立即阅读、复制或稍后核对。草稿最多帮助后续 AI 发现可能的连续信息；只有人工确认内容才能进入 Timeline、Brief 和可信报告。</p></div></section>
        {summaryItems.length > 0 && <section className="panel draft-summary"><header><div><span className="section-kicker">会议重点</span><h2>沿着原对话快速核对</h2></div><span>{summaryItems.length} 条</span></header><ol>{summaryItems.map((item, index) => {
          const claim = claimById.get(item.claimId);
          return <li key={item.claimId} className={claim?.source === "human" ? "human-added" : ""}><button onClick={() => onOpenClaim(item.claimId)}><span className="draft-summary-order">{index + 1}</span><span className="draft-summary-body"><span className="draft-summary-meta"><b>{aiDraftSectionLabels[item.section]}</b>{item.timestampStart !== null && <time>{formatTimestamp(item.timestampStart / 1000)}</time>}{item.speaker && <em>{displaySpeakerLabel(item.speaker)}</em>}<StatusBadge value={item.reviewStatus} /></span><strong>{item.statement}</strong>{item.quote && <blockquote>“{item.quote}”</blockquote>}<span className="draft-summary-flags">{claim?.needsAdditionalEvidence && <i>需补证据</i>}{claim?.relationsForReview.some((relation) => relation.status === "proposed") && <i>需判断关系</i>}<u>查看原文并核对含义 ›</u></span></span></button></li>;
        })}</ol></section>}
        {runOccurrences.length > 0 && <section className="panel draft-section draft-occurrences"><header><h2>再次出现的旧信息</h2><span>{runOccurrences.length}</span></header><div>{runOccurrences.map((candidate) => <article key={candidate.id}><span className="claim-type">再次提到</span><p>{candidate.proposed_statement || candidate.target_statement}</p><small>核对时可以判断：只是再次出现、本次有新变化，或不采纳。</small></article>)}</div></section>}
        {runClaims.length + runOccurrences.length === 0 && <EmptyState title="AI 没有留下可核对内容" body="请先检查材料是否完整；不要把空结果当成分析完成。" />}
        <section className="draft-actions panel"><div><h2>按重要程度决定要不要现在核对</h2><p>金额、期限、责任人、矛盾和低置信内容建议优先核对；其余内容可以稍后继续。</p>{assessment && <span className="assessment-recorded">已记录：{assessment.assessment === "basically_usable" ? "初稿基本可用" : "需要核对和修正"}</span>}</div><div className="draft-action-buttons"><button className="button secondary" disabled={Boolean(busy) || Boolean(assessment)} onClick={onAssessUsable}>这份初稿基本可用</button><button className="button secondary" disabled={Boolean(busy)} onClick={onAddMissing}>AI 漏掉了重要信息</button><button className="button secondary" disabled={Boolean(busy)} onClick={onContinueLater}>稍后核对，继续处理项目</button><button className="button primary" disabled={Boolean(busy) || runClaims.length + runOccurrences.length === 0} onClick={onStartReview}>核对重要内容</button></div></section>
      </>}
    </div>
  );
}

function MissingClaimModal({ eventId, initialType = "other", busy, onClose, onCreate }: { eventId: string; initialType?: OccurrenceNewClaim["type"]; busy: boolean; onClose: () => void; onCreate: (input: { statement: string; type: string; segmentIds: string[] }) => Promise<void> }) {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [state, setState] = useState<AsyncState>("loading");
  const [issue, setIssue] = useState<ApiIssue | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statement, setStatement] = useState("");
  const [type, setType] = useState<OccurrenceNewClaim["type"]>(initialType);
  useEffect(() => { let active = true; void api.listEventTranscriptSegments(eventId).then((items) => { if (!active) return; setSegments(items); setState(items.length ? "ready" : "empty"); }).catch((error) => { if (!active) return; setIssue(toIssue(error)); setState("error"); }); return () => { active = false; }; }, [eventId]);
  const shown = segments.filter((segment) => !query.trim() || `${displaySpeakerLabel(segment.speaker)} ${segment.speaker || ""} ${segment.text}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function submit() { if (!statement.trim() || selected.size === 0) return; setIssue(null); try { await onCreate({ statement: statement.trim(), type, segmentIds: [...selected] }); } catch (error) { setIssue(toIssue(error)); } }
  return <Modal title={initialType === "next_action" ? "从原文补充下一步行动" : "补上 AI 漏掉的重要信息"} description="先选一段或多段原文，再用一句话写清事实。保存后仍需人工确认，才会进入正式结果。" onClose={busy ? () => undefined : onClose} wide><div className="missing-claim-layout">{issue && <ErrorNotice issue={issue} compact />}<label className="field"><span>搜索逐字稿</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索说话人、金额、日期或关键词" /></label>{state === "loading" && <LoadingBlock label="正在读取本次完整逐字稿…" />}{state === "empty" && <EmptyState title="没有可选择的逐字稿" body="这次沟通需要先有 Transcript，才能建立可追溯的人工补充。" />}{state === "ready" && <div className="segment-picker">{shown.map((segment) => <label key={segment.id} className={selected.has(segment.id) ? "selected" : ""}><input type="checkbox" checked={selected.has(segment.id)} disabled={!selected.has(segment.id) && selected.size >= 8} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(segment.id)) next.delete(segment.id); else next.add(segment.id); return next; })} /><time>{formatTimestamp(segment.start_ms == null ? undefined : segment.start_ms / 1000)}</time><span><b>{displaySpeakerLabel(segment.speaker)}</b>{segment.text}</span></label>)}</div>}<div className="manual-claim-fields"><label className="field"><span>这条信息属于</span><select value={type} onChange={(event) => setType(event.target.value as OccurrenceNewClaim["type"])}>{occurrenceClaimTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label className="field"><span>用一句话写清楚</span><textarea value={statement} onChange={(event) => setStatement(event.target.value)} placeholder={initialType === "next_action" ? "例如：负责人周五前发送三份候选方案。" : "例如：项目预算上限为 21,500 美元。"} /></label></div><p className="muted">已选 {selected.size} 段。需要关联旧记录时，先确认这条补充，再在记录详情中补关系。</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={busy || !statement.trim() || selected.size === 0} onClick={() => void submit()}>{busy ? "正在保存…" : "加入待核对队列"}</button></div></div></Modal>;
}

function ReviewCompletionScreen({ project, session, destination, onContinue }: { project: Project | null; session: ReviewSession | null; destination: ReviewSummaryDestination | null; onContinue: () => void }) {
  const outcome = session?.outcome;
  const aiInitial = (session?.initialPendingClaimCount ?? 0) + (session?.initialPendingOccurrenceCount ?? 0);
  return <div className="page review-completion-page"><PageHeader eyebrow={project?.name} title="本轮核对完成" body="下面展示 AI 初稿经过人工核对后发生了什么。正式报告仍只读取已确认内容。" /><section className="panel review-outcome-hero"><span className="completion-mark">✓</span><div><h2>AI 提出了 {aiInitial} 条候选信息</h2><p>你用 {formatReviewDuration(session?.durationMs ?? 0)} 完成本轮核对。</p></div></section><div className="review-outcome-grid"><article><strong>{outcome?.confirmedClaimCount ?? 0}</strong><span>直接确认的事实</span></article><article><strong>{outcome?.editedClaimCount ?? 0}</strong><span>修改后确认</span></article><article><strong>{outcome?.rejectedClaimCount ?? 0}</strong><span>未采纳</span></article><article><strong>{outcome?.humanAddedClaimCount ?? 0}</strong><span>AI 漏项后人工补充</span></article><article><strong>{outcome?.confirmedOccurrenceCount ?? 0}</strong><span>确认再次出现</span></article><article><strong>{(outcome?.acceptedRelationCount ?? 0) + (outcome?.rejectedRelationCount ?? 0)}</strong><span>人工判断的关系</span></article></div><section className="panel review-outcome-explanation"><h2>现在什么变成了正式内容？</h2><p>直接确认、修改后确认和经过确认的人工补充会进入 Verified Ledger；拒绝内容和未处理草稿不会进入报告，也不会影响下一次沟通。</p><button className="button primary" disabled={!destination} onClick={onContinue}>{destination?.complete ? "查看会前速览" : "准备下一次沟通"}</button></section></div>;
}

function ReviewScreen({ state, issue, claims, occurrenceCandidates, reviewSession, reviewClockNow, onBack, onRetry, onOpen, onOccurrenceVerdict, onOccurrenceConvert, busy }: { state: AsyncState; issue: ApiIssue | null; claims: Claim[]; occurrenceCandidates: OccurrenceCandidate[]; reviewSession: ReviewSession | null; reviewClockNow: number; onBack: () => void; onRetry: () => void; onOpen: (id: string) => void; onOccurrenceVerdict: (candidate: OccurrenceCandidate, action: "confirm" | "reject") => void; onOccurrenceConvert: (candidate: OccurrenceCandidate, claims: OccurrenceNewClaim[]) => void; busy: string | null }) {
  const [filter, setFilter] = useState<"pending" | "reviewed" | "all">("pending");
  const visible = claims.filter((item) => filter === "pending" ? item.reviewStatus === "pending" : filter === "reviewed" ? item.reviewStatus !== "pending" : true);
  const visibleOccurrences = occurrenceCandidates.filter((item) => filter === "pending" ? item.status === "pending" : filter === "reviewed" ? item.status !== "pending" : true);
  const elapsedMs = reviewSession?.status === "active"
    ? Math.max(0, reviewClockNow - Date.parse(reviewSession.startedAt))
    : reviewSession?.durationMs ?? 0;
  const initialCount = reviewSession
    ? reviewSession.initialPendingClaimCount + reviewSession.initialPendingOccurrenceCount
    : 0;
  const remainingCount = reviewSession
    ? reviewSession.remainingPendingClaimCount + reviewSession.remainingPendingOccurrenceCount
    : 0;
  return (
    <div className="page narrow-page">
      <PageHeader eyebrow="Review Queue" title="审核候选记录" body="逐条查看原始证据，再选择确认、修改或不采纳。" back={onBack} backLabel="返回 AI 初稿" />
      {issue && <ErrorNotice issue={issue} onRetry={onRetry} />}
      {reviewSession && <section className={`review-timing ${reviewSession.status}`}><div><span className="section-kicker">真实审核计时</span><strong>{reviewSession.status === "active" ? "正在计时" : reviewSession.status === "completed" ? "本次审核已完成" : "本次计时已结束"}</strong><p>{reviewSession.status === "active" ? `开始时 ${initialCount} 条，目前还剩 ${remainingCount} 条。刷新或关闭页面不会重置。` : `本次共处理 ${initialCount} 条，结果已由服务器保存。`}</p></div><time>{formatReviewDuration(elapsedMs)}</time>{reviewSession.status === "completed" && <span className={elapsedMs <= 120000 ? "timing-pass" : "timing-over"}>{elapsedMs <= 120000 ? "达到两分钟目标" : "超过两分钟目标"}</span>}</section>}
      <div className="filter-tabs"><button className={filter === "pending" ? "active" : ""} onClick={() => setFilter("pending")}>待审核</button><button className={filter === "reviewed" ? "active" : ""} onClick={() => setFilter("reviewed")}>已处理</button><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button></div>
      {state === "loading" && <LoadingBlock label="正在整理审核队列…" />}
      {(state === "empty" || (state === "ready" && !visible.length && !visibleOccurrences.length)) && <EmptyState title={filter === "pending" ? "目前没有待审核记录" : "这个筛选下没有记录"} body={claims.length || occurrenceCandidates.length ? "所有候选都已处理。" : "完成一次提取后，候选记录才会出现在这里。系统不会显示示例内容。"} />}
      {visible.length > 0 && <div className="review-list">{visible.map((claim) => {
        const hasProposedRelations = claim.relationsForReview.some((relation) => relation.status === "proposed");
        return <article key={claim.id} className={`review-card${claim.source === "human" ? " human-added" : ""}`}><button className="review-card-main" onClick={() => onOpen(claim.id)}><div className="review-card-top"><span className="eyebrow">{claim.source === "human" ? `人工补充 · ${typeLabel(claim.type)}` : typeLabel(claim.type)}</span><StatusBadge value={claim.lifecycle === "withdrawn" ? "withdrawn" : claim.reviewStatus} /></div><h2>{claim.statement || "这条记录没有可显示的陈述"}</h2><div className="claim-meta"><span>{claim.eventTitle || "来源沟通"}</span><span>{claim.source === "human" ? "由你补充" : confidenceText(claim.confidence)}</span><span>{claim.evidenceCount ?? claim.evidenceRefIds.length} 条证据</span>{hasProposedRelations && <span>{claim.relationsForReview.filter((relation) => relation.status === "proposed").length} 条关系待核对</span>}</div><UncertaintyNotice value={claim.uncertainty} compact /><EvidenceRequirementNotice claim={claim} compact /><span className="review-evidence-link">{claim.reviewStatus !== "pending" ? "查看证据和处理记录 ›" : hasProposedRelations ? "打开并逐条核对事实与关系 ›" : "打开证据并决定 ›"}</span></button></article>;
      })}</div>}
      {visibleOccurrences.length > 0 && <section className="occurrence-review-section"><div className="section-heading"><div><span className="section-kicker">再次出现</span><h2>这次说的内容可能已经记录过</h2><p>如果只是重复旧内容，可以把新证据附到原记录。如果里面有新变化，可以拆成新的待审核记录。</p></div></div><div className="occurrence-list">{visibleOccurrences.map((candidate) => <OccurrenceReviewCard key={candidate.id} candidate={candidate} busy={busy} onOpen={onOpen} onVerdict={onOccurrenceVerdict} onConvert={onOccurrenceConvert} />)}</div></section>}
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: EvidenceRef }) {
  const contextQuery = useQuery(evidenceContextQuery(evidence.id));
  const context = contextQuery.data ?? null;
  const contextIssue = contextQuery.error ? toIssue(contextQuery.error) : null;
  const contextLoading = contextQuery.isPending || (contextQuery.isFetching && !context);
  const audioStartSeconds = context?.audio?.start_ms != null
    ? Math.max(0, context.audio.start_ms / 1000)
    : typeof evidence.timestampStart === "number"
      ? Math.max(0, evidence.timestampStart)
      : undefined;
  const audioUrl = context?.audio?.view_url || evidence.audioUrl;
  const audioSource = audioUrl ? `${audioUrl}${audioStartSeconds == null ? "" : `#t=${audioStartSeconds}`}` : undefined;
  const quote = context?.target.quote_raw || evidence.quote;
  const beforeSegments = context?.context.before ?? [];
  const targetSegments = context?.context.target ?? [];
  const afterSegments = context?.context.after ?? [];
  const renderSegmentText = (text: string) => highlightExactPhrase(text, quote).map((part, index) => part.highlighted
    ? <mark key={`${part.text}:${index}`}>{part.text}</mark>
    : <span key={`${part.text}:${index}`}>{part.text}</span>);
  const renderContextSegment = (segment: EvidenceContext["context"]["target"][number], target = false) => <p key={segment.id} className={target ? "selected target" : "surrounding"}><time>{formatTimestamp(segment.start_ms == null ? undefined : segment.start_ms / 1000)}</time><b>{displaySpeakerLabel(segment.speaker)}</b><span>{renderSegmentText(segment.text)}</span></p>;
  return (
    <article className="evidence-card">
      <div className="evidence-card-head"><span className="file-kind">{audioSource ? "AUD" : evidence.kind.toLowerCase().includes("photo") || evidence.imageUrl ? "IMG" : evidence.kind.toLowerCase().includes("pdf") ? "PDF" : "TXT"}</span><span><strong>{context?.filename || evidence.filename || typeLabel(evidence.kind)}</strong><small>{evidence.role ? `${typeLabel(evidence.role)} · ` : ""}{formatTimestamp(context?.target.start_ms == null ? evidence.timestampStart : context.target.start_ms / 1000)}{evidence.page ? ` · 第 ${evidence.page} 页` : ""}</small></span></div>
      {/* Evidence URLs can be short-lived signed URLs and cannot use the build-time image loader. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {evidence.imageUrl && <img src={evidence.imageUrl} alt={evidence.caption || "原始图片证据"} />}
      {audioSource && <div className="evidence-audio"><audio controls preload="metadata" src={audioSource} /><small>播放会从目标原句前约 3 秒开始，方便直接听前后语气。</small></div>}
      {(context?.asset_view_url || evidence.viewUrl) && !evidence.imageUrl && <a className="evidence-open" href={context?.asset_view_url || evidence.viewUrl} target="_blank" rel="noreferrer">打开原始文件</a>}
      {quote && <blockquote className="evidence-target-quote">“{quote}”</blockquote>}
      {contextLoading && <p className="evidence-context-loading">正在定位目标原句和前后文…</p>}
      {contextIssue && <ErrorNotice issue={contextIssue} onRetry={() => { void contextQuery.refetch(); }} compact />}
      {context && (beforeSegments.length > 0 || targetSegments.length > 0 || afterSegments.length > 0) && <div className="evidence-context" aria-label="目标原句的前后文">{beforeSegments.map((segment) => renderContextSegment(segment))}{targetSegments.map((segment) => renderContextSegment(segment, true))}{afterSegments.map((segment) => renderContextSegment(segment))}</div>}
      {evidence.caption && evidence.caption !== evidence.quote && <p>{evidence.caption}</p>}
      {!evidence.quote && !evidence.imageUrl && !evidence.caption && <p className="muted">这条证据已记录，但服务器没有返回可在页面预览的内容。</p>}
    </article>
  );
}

function uncertaintyForEdit(value: unknown): ClaimEditSubmission["uncertainty"] {
  if (!isRecord(value)) return null;
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives.filter((item): item is string => typeof item === "string")
    : [];
  if (typeof value.reason !== "string" || typeof value.question !== "string") return null;
  return { reason: value.reason, question: value.question, alternatives };
}

function relationReviewLabel(type: string): string {
  if (type === "supersedes") return "取代原记录";
  if (type === "resolves") return "解决原问题";
  if (type === "contradicts") return "与原记录冲突";
  return "参考原记录";
}

function relationReviewEffect(type: string): string {
  if (type === "supersedes") return "接受后，旧记录会标记为已被取代。";
  if (type === "resolves") return "接受后，旧问题或风险会标记为已解决。";
  if (type === "contradicts") return "接受后，两条记录会作为待处理冲突同时保留。";
  return "接受后，两条记录会保留参考关系，不改变旧记录状态。";
}

function ClaimScreen({ projectId, claim, mode, backLabel, reviewClaims, pendingOccurrenceCount, evidence, evidenceState, issue, busy, onBack, onOpenReviewClaim, onVerdict, onWithdraw, onCreateRelation }: { projectId: string | null; claim: Claim | null; mode: "review" | "readonly"; backLabel: string; reviewClaims: Claim[]; pendingOccurrenceCount: number; evidence: EvidenceRef[]; evidenceState: AsyncState; issue: ApiIssue | null; busy: string | null; onBack: () => void; onOpenReviewClaim: (id: string) => void; onVerdict: (action: "confirm" | "reject" | "edit", reason?: string, edit?: ClaimEditSubmission, retainRelationIds?: string[]) => void; onWithdraw: (reason: string) => void; onCreateRelation: (input: ManualRelationSubmission) => Promise<void> }) {
  const [edit, setEdit] = useState(false);
  const [statement, setStatement] = useState(claim?.statement ?? "");
  const [claimType, setClaimType] = useState(claim?.type ?? "other");
  const [reason, setReason] = useState("");
  const [editEvidenceIds, setEditEvidenceIds] = useState<Set<string>>(new Set());
  const [secondaryEvidenceNote, setSecondaryEvidenceNote] = useState("");
  const [normalizedDecision, setNormalizedDecision] = useState<"retain" | "clear" | "">(
    claim?.normalizedValue ? "" : "clear",
  );
  const originalUncertainty = uncertaintyForEdit(claim?.uncertainty);
  const [evidenceNeedDecision, setEvidenceNeedDecision] = useState<"retain" | "clear" | "">(
    claim?.needsAdditionalEvidence ? "" : "clear",
  );
  const [uncertaintyDecision, setUncertaintyDecision] = useState<"retain" | "clear" | "">(
    originalUncertainty ? "" : "clear",
  );
  const [retainedRelationIds, setRetainedRelationIds] = useState<Set<string>>(new Set());
  const [relationDecisions, setRelationDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [relationOpen, setRelationOpen] = useState(false);
  const [relationTargets, setRelationTargets] = useState<RelationTarget[]>([]);
  const [relationTargetsState, setRelationTargetsState] = useState<AsyncState>("idle");
  const [relationIssue, setRelationIssue] = useState<ApiIssue | null>(null);
  const [relationType, setRelationType] = useState<RelationType>("resolves");
  const [relationTargetVersionId, setRelationTargetVersionId] = useState("");
  const [relationReason, setRelationReason] = useState("");
  if (!claim) return <div className="page narrow-page"><PageHeader title="记录" back={onBack} backLabel={backLabel} /><EmptyState title="没有找到这条记录" body="它可能已经更新，请返回来源页面重新打开。" /></div>;
  const readonly = mode === "readonly";
  const pending = claim.reviewStatus === "pending";
  const verified = claim.reviewStatus === "verified" && claim.lifecycle !== "withdrawn";
  const activeRelations = claim.relationsForReview.filter((relation) => relation.status === "active");
  const proposedRelations = claim.relationsForReview.filter((relation) => relation.status === "proposed");
  const relationsReviewed = proposedRelations.every((relation) => Boolean(relationDecisions[relation.id]));
  const acceptedRelationIds = proposedRelations
    .filter((relation) => relationDecisions[relation.id] === "accept")
    .map((relation) => relation.id);
  const evidenceReady = evidenceState === "ready";
  const reviewQueue = readonly ? [] : reviewClaims.filter((item) => item.reviewStatus === "pending");
  const reviewPosition = Math.max(0, reviewQueue.findIndex((item) => item.id === claim.id)) + 1;
  const editHasSupportingEvidence = evidence.some(
    (item) => editEvidenceIds.has(item.id) && (item.role === "direct" || item.role === "corroborating"),
  );
  const canSaveEdit = Boolean(
    evidenceReady &&
    statement.trim() &&
    claimType.trim() &&
    normalizedDecision &&
    evidenceNeedDecision &&
    uncertaintyDecision &&
    !(uncertaintyDecision === "retain" && evidenceNeedDecision === "clear") &&
    (editHasSupportingEvidence || secondaryEvidenceNote.trim()),
  );
  const eligibleRelationTargets = relationTargets.filter((target) => {
    if (target.claim_id === claim.id || target.claim_version_id === claim.versionId) return false;
    if (relationType !== "resolves") return true;
    return ["open_question", "risk", "concern", "requirement"].includes(target.type) || target.has_uncertainty;
  });
  const selectedRelationTarget = eligibleRelationTargets.find(
    (target) => target.claim_version_id === relationTargetVersionId,
  );
  async function openRelationForm() {
    setRelationOpen(true);
    if (!projectId || relationTargetsState === "loading" || relationTargetsState === "ready") return;
    setRelationTargetsState("loading");
    setRelationIssue(null);
    try {
      const targets = await api.listRelationTargets(projectId);
      setRelationTargets(targets);
      setRelationTargetsState(targets.length ? "ready" : "empty");
    } catch (error) {
      setRelationIssue(toIssue(error));
      setRelationTargetsState("error");
    }
  }
  async function submitManualRelation() {
    if (!selectedRelationTarget || relationReason.trim().length < 3) return;
    setRelationIssue(null);
    try {
      await onCreateRelation({
        type: relationType,
        target: selectedRelationTarget,
        reason: relationReason.trim(),
      });
      setRelationOpen(false);
      setRelationReason("");
      setRelationTargetVersionId("");
      setRelationTargetsState("idle");
      setRelationTargets([]);
    } catch (error) {
      setRelationIssue(toIssue(error));
    }
  }
  const submitEdit = () => onVerdict("edit", reason.trim(), {
    statement: statement.trim(),
    type: claimType.trim(),
    normalizedValue: normalizedDecision === "retain" ? claim.normalizedValue : null,
    needsAdditionalEvidence: uncertaintyDecision === "retain" || evidenceNeedDecision === "retain",
    uncertainty: uncertaintyDecision === "retain" ? originalUncertainty : null,
    retainRelationIds: [...retainedRelationIds],
    evidenceRefIds: [...editEvidenceIds],
    secondaryEvidenceNote: secondaryEvidenceNote.trim() || undefined,
  });
  return (
    <div className="page review-detail-page">
      <PageHeader eyebrow={claim.source === "human" ? `人工补充 · ${typeLabel(claim.type)}` : typeLabel(claim.type)} title={claim.statement || "无陈述"} body={`${claim.eventTitle || "来源沟通"} · ${claim.source === "human" ? "由你补充" : confidenceText(claim.confidence)}${pending && !readonly ? ` · 第 ${reviewPosition}/${reviewQueue.length} 条` : ""}`} back={onBack} backLabel={backLabel} actions={<StatusBadge value={claim.lifecycle === "withdrawn" ? "withdrawn" : claim.reviewStatus} />} />
      {issue && <ErrorNotice issue={issue} compact />}
      <div className="claim-layout">
        {reviewQueue.length > 0 && <aside className="review-queue-rail" aria-label="连续审核队列"><header><span className="section-kicker">连续审核</span><strong>{reviewPosition}/{reviewQueue.length}</strong><small>作出决定后自动进入下一条</small></header><div>{reviewQueue.map((item, index) => <button className={item.id === claim.id ? "active" : ""} key={item.id} disabled={Boolean(busy)} onClick={() => onOpenReviewClaim(item.id)}><span>{index + 1}</span><span><b>{typeLabel(item.type)}</b><small>{item.statement}</small></span>{item.relationsForReview.some((relation) => relation.status === "proposed") && <em>关系</em>}</button>)}</div>{pendingOccurrenceCount > 0 && <p>Claim 处理完后，还有 {pendingOccurrenceCount} 条“再次出现”记录需要决定。</p>}</aside>}
        <section className="evidence-column"><div className="section-heading"><div><h2>原始证据</h2><p>{readonly ? "下面保留这条已确认记录的原句、前后文和来源。" : "确认前，请检查原文是否真的支持这条陈述。"}</p></div></div>{evidenceState === "loading" && <LoadingBlock label="正在定位证据…" />}{evidenceState === "empty" && <EmptyState title="没有可核对的证据" body="这条候选不应被确认。请拒绝，或等待后端补全证据。" />}{evidenceState === "error" && <EmptyState title="证据未完整加载" body={`系统应完整返回 ${claim.evidenceRefIds.length} 条当前版本证据，实际收到 ${evidence.length} 条或存在请求失败。下面仅显示已经收到的材料，确认、核对声明和修改功能已停用。请返回后重新打开再试。`} />}{evidence.map((item) => <EvidenceCard key={item.id} evidence={item} />)}</section>
        <aside className={`verdict-panel${pending && !edit && !readonly ? " compact" : " panel detailed"}`}>{!(pending && !edit && !readonly) && <h2>{readonly ? (verified ? "已确认记录" : "未采纳记录") : edit && verified ? "修改已确认记录" : verified ? "已确认记录" : "处理记录"}</h2>}<UncertaintyNotice value={claim.uncertainty} /><EvidenceRequirementNotice claim={claim} />{readonly && <div className="readonly-claim-note"><strong>只读证据模式</strong><p>这条记录已经完成核对。这里仅用于查看原文，不会显示待审核队列或修改操作。</p></div>}{!readonly && (pending || (verified && edit)) && <>
          {edit ? <div className="edit-form">
            <label className="field"><span>修改后的陈述</span><textarea value={statement} onChange={(event) => setStatement(event.target.value)} /></label>
            <label className="field"><span>记录类型</span><select value={claimType} onChange={(event) => setClaimType(event.target.value)}>{occurrenceClaimTypeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
            <fieldset className="edit-review-choice"><legend>结构化值</legend>{claim.normalizedValue ? <><pre>{JSON.stringify(claim.normalizedValue, null, 2)}</pre><label><input type="radio" name="normalized-decision" checked={normalizedDecision === "retain"} onChange={() => setNormalizedDecision("retain")} />我已核对，修改后仍适用</label><label><input type="radio" name="normalized-decision" checked={normalizedDecision === "clear"} onChange={() => setNormalizedDecision("clear")} />清除，之后重新提取</label></> : <p>原记录没有结构化值，本次继续留空。</p>}</fieldset>
            <fieldset className="edit-review-choice"><legend>不确定性</legend>{originalUncertainty ? <><UncertaintyNotice value={originalUncertainty} compact /><label><input type="radio" name="uncertainty-decision" checked={uncertaintyDecision === "retain"} onChange={() => setUncertaintyDecision("retain")} />我已核对，修改后仍需保留</label><label><input type="radio" name="uncertainty-decision" checked={uncertaintyDecision === "clear"} onChange={() => setUncertaintyDecision("clear")} />问题已经消失，清除提醒</label></> : <p>原记录没有不确定性，本次继续留空。</p>}</fieldset>
            <fieldset className="edit-review-choice"><legend>是否仍需补充证据</legend>{claim.needsAdditionalEvidence ? <><p>原记录要求继续补证据。修改时必须明确保留或清除这项要求。</p><label><input type="radio" name="evidence-need-decision" checked={evidenceNeedDecision === "retain"} onChange={() => setEvidenceNeedDecision("retain")} />仍需补充证据</label><label><input type="radio" name="evidence-need-decision" checked={evidenceNeedDecision === "clear"} onChange={() => setEvidenceNeedDecision("clear")} />现有证据已经足够</label>{uncertaintyDecision === "retain" && evidenceNeedDecision === "clear" && <p className="uncertainty">保留结构化不确定性时，也必须保留补证要求。</p>}</> : <p>原记录没有额外补证要求，本次继续留空。</p>}</fieldset>
            {claim.relationsForReview.length > 0 && <fieldset className="edit-review-choice"><legend>这条记录与旧记录的关系</legend><p>只勾选修改后仍然成立的关系。系统会为新版本建立新关系，未勾选的关系不会生效。</p>{claim.relationsForReview.map((relation) => <label key={relation.id}><input type="checkbox" checked={retainedRelationIds.has(relation.id)} onChange={() => setRetainedRelationIds((current) => { const next = new Set(current); if (next.has(relation.id)) next.delete(relation.id); else next.add(relation.id); return next; })} /><span><b>{relationReviewLabel(relation.type)}</b><small>{relation.targetStatement}</small>{relation.reason && <small>{relation.reason}</small>}</span></label>)}</fieldset>}
            <div className="edit-evidence"><strong>重新选择支持修改后陈述的证据</strong><p>系统不会自动沿用旧证据。至少勾选一条直接或佐证材料；只有背景参考时，请补充人工依据。</p>{evidence.map((item) => <label key={item.id}><input type="checkbox" disabled={!evidenceReady} checked={editEvidenceIds.has(item.id)} onChange={() => setEditEvidenceIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} /><span><b>{typeLabel(item.role)}</b> · {item.quote || item.caption || item.filename || typeLabel(item.kind)}</span></label>)}</div>
            <label className="field"><span>补充证据说明</span><textarea value={secondaryEvidenceNote} onChange={(event) => setSecondaryEvidenceNote(event.target.value)} placeholder="没有可勾选的证据时，请说明你依据了什么补充信息。" /></label>
            <label className="field"><span>修改原因，可选</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <div className="button-row"><button className="button secondary" onClick={() => setEdit(false)}>取消</button><button className="button primary" disabled={busy === "edit" || !canSaveEdit} onClick={submitEdit}>{busy === "edit" ? "正在保存…" : "保存并确认"}</button></div>
          </div> : <div className="verdict-actions">
            {proposedRelations.length > 0 && <fieldset className="relation-review-gate">
              <legend>逐条核对关系</legend>
              <p>当前记录：{claim.statement}</p>
              {proposedRelations.map((relation) => <article key={relation.id}>
                <header><b>{relationReviewLabel(relation.type)}</b><span>{relation.type}</span></header>
                <p><strong>旧记录：</strong>{relation.targetStatement}</p>
                {relation.reason && <small><strong>模型依据：</strong>{relation.reason}</small>}
                <small className="relation-effect">{relationReviewEffect(relation.type)}</small>
                <div role="group" aria-label={`${relationReviewLabel(relation.type)}：${relation.targetStatement}`}>
                  <label><input type="radio" name={`relation-${relation.id}`} checked={relationDecisions[relation.id] === "accept"} onChange={() => setRelationDecisions((current) => ({ ...current, [relation.id]: "accept" }))} />接受关系</label>
                  <label><input type="radio" name={`relation-${relation.id}`} checked={relationDecisions[relation.id] === "reject"} onChange={() => setRelationDecisions((current) => ({ ...current, [relation.id]: "reject" }))} />拒绝关系</label>
                </div>
              </article>)}
              {!relationsReviewed && <p className="uncertainty">每条关系都必须选择接受或拒绝，才能确认记录。</p>}
            </fieldset>}
            <div className="review-quick-actions" aria-label="核对操作">
              <button className="button primary" disabled={Boolean(busy) || !evidenceReady || !relationsReviewed} onClick={() => onVerdict("confirm", "", undefined, acceptedRelationIds)} aria-label="确认并加入正式结果">确认</button>
              <button className="button secondary" disabled={Boolean(busy) || !evidenceReady} onClick={() => setEdit(true)} aria-label="修改后确认">修改</button>
              <button className="button quiet danger-text" disabled={Boolean(busy)} onClick={() => onVerdict("reject", "")} aria-label="不采纳这条记录">不采纳</button>
            </div>
          </div>}
        </>}{!readonly && verified && !edit && <><div className="withdraw-box"><p>这条记录现在参与事项概况和后续沟通上下文。内容需要修正时建立新版本；只有整条记录不再有效时才撤回。</p><button className="button secondary full" disabled={Boolean(busy) || !evidenceReady} onClick={() => setEdit(true)}>修改已确认记录</button><label className="field"><span>撤回原因</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么这条已确认记录需要退出当前结果" /></label><button className="button secondary danger-text full" disabled={busy === "withdraw" || !reason.trim()} onClick={() => onWithdraw(reason.trim())}>{busy === "withdraw" ? "正在撤回…" : "撤回已确认记录"}</button></div><div className="manual-relation-box"><strong>这条记录补充或改变了旧记录？</strong><p>当系统漏掉两条已确认记录之间的关系时，可以在这里补上。旧内容会继续保留在时间线中。</p>{activeRelations.length > 0 && <div className="active-relation-list"><span>已经生效</span>{activeRelations.map((relation) => <article key={relation.id}><b>{relationReviewLabel(relation.type)}</b><p>{relation.targetStatement}</p>{relation.reason && <small>{relation.reason}</small>}</article>)}</div>}{!relationOpen ? <button className="button secondary full" disabled={Boolean(busy) || !projectId} onClick={() => void openRelationForm()}>{activeRelations.length > 0 ? "再关联一条旧记录" : "关联旧记录"}</button> : <div className="manual-relation-form">{relationIssue && <ErrorNotice issue={relationIssue} compact />}{relationTargetsState === "loading" && <LoadingBlock label="正在读取当前记录…" />}{relationTargetsState === "error" && <button className="button secondary full" onClick={() => { setRelationTargetsState("idle"); void openRelationForm(); }}>重新读取</button>}{relationTargetsState === "empty" && <p className="muted">当前没有其他可关联的已确认记录。</p>}{(relationTargetsState === "ready" || relationTargetsState === "empty") && <><label className="field"><span>关系</span><select value={relationType} onChange={(event) => { setRelationType(event.target.value as RelationType); setRelationTargetVersionId(""); }}><option value="resolves">这条新记录解决了旧问题或风险</option><option value="supersedes">这条新记录取代了旧记录</option><option value="informed_by">这条新记录参考了旧记录</option><option value="contradicts">两条记录互相冲突，仍需处理</option></select></label><label className="field"><span>旧记录</span><select value={relationTargetVersionId} onChange={(event) => setRelationTargetVersionId(event.target.value)}><option value="">请选择一条当前有效记录</option>{eligibleRelationTargets.map((target) => <option value={target.claim_version_id} key={target.claim_version_id}>{target.event_title} · {typeLabel(target.type)} · {target.statement}</option>)}</select></label>{relationType === "resolves" && eligibleRelationTargets.length === 0 && <p className="muted">当前没有可以关闭的待确认问题、风险或前置条件。</p>}<label className="field"><span>判断依据</span><textarea value={relationReason} onChange={(event) => setRelationReason(event.target.value)} placeholder="说明为什么这两条记录存在这个关系" /></label><div className="button-row"><button className="button secondary" onClick={() => setRelationOpen(false)}>取消</button><button className="button primary" disabled={busy === "manual-relation" || !selectedRelationTarget || relationReason.trim().length < 3} onClick={() => void submitManualRelation()}>{busy === "manual-relation" ? "正在保存…" : "保存关系"}</button></div></>}</div>}</div></>}{claim.lifecycle === "withdrawn" && <p className="muted">这条记录已经退出当前结果和后续上下文，仍保留在历史时间线中。</p>}</aside>
      </div>
    </div>
  );
}

function ResultsScreen({ project, events, tab, data, state, issue, busy, loadDurationMs, onBack, backLabel, onSelect, onRetry, onOpenClaim, onResolveContradiction, onCompleteAction, onDecideDraftLink, onOpenAiSuggestions, onAddAction }: { project: Project | null; events: Event[]; tab: ResultTab; data: unknown; state: AsyncState; issue: ApiIssue | null; busy: string | null; loadDurationMs: number | null; onBack: () => void; backLabel: string; onSelect: (tab: ResultTab) => void; onRetry: () => void; onOpenClaim: (id: string) => void; onResolveContradiction: (input: ContradictionResolutionInput) => void; onCompleteAction: (claimId: string) => void; onDecideDraftLink: (linkId: string, action: "accept" | "reject") => void; onOpenAiSuggestions: () => void; onAddAction: () => void }) {
  const current = resultTabs.find((item) => item.key === tab)!;
  const pendingReviewCount = (project?.pendingClaimCount ?? 0) + (project?.pendingOccurrenceCount ?? 0);
  const showPendingReviewCount = pendingReviewCount > 0 && (tab === "folder-summary" || tab === "timeline");
  const secondaryTabActive = secondaryResultTabs.some((item) => item.key === tab);
  const content = <ResultContent tab={tab} data={data} events={events} onOpenClaim={onOpenClaim} onSelect={onSelect} onResolveContradiction={onResolveContradiction} onCompleteAction={onCompleteAction} onDecideDraftLink={onDecideDraftLink} onOpenAiSuggestions={onOpenAiSuggestions} onAddAction={onAddAction} busyAction={busy} />;
  return (
    <div className="page results-page">
      <PageHeader eyebrow={project?.name} title="项目进展" body="项目概览会分开显示 AI 草稿与可信记忆；时间线、下一步和会前准备只使用已经确认的内容。" back={onBack} backLabel={backLabel} actions={loadDurationMs == null ? undefined : <span className="report-load-timing">报告读取 {formatReviewDuration(loadDurationMs)}</span>} />
      {showPendingReviewCount && <p className="pending-review-note">还有 {pendingReviewCount} 条待核对。它们仍在审核区，没有进入下面的已确认结果。</p>}
      <div className="result-layout"><aside className="result-nav"><div className="result-nav-primary">{primaryResultTabs.map((item) => <button className={item.key === tab ? "active" : ""} key={item.key} onClick={() => onSelect(item.key)}><span>{item.short.slice(0, 1)}</span>{item.label}<b>›</b></button>)}</div><details className="result-nav-more" open={secondaryTabActive || undefined}><summary>更多报告 <span>{secondaryResultTabs.length}</span></summary><div>{secondaryResultTabs.map((item) => <button className={item.key === tab ? "active" : ""} key={item.key} onClick={() => onSelect(item.key)}><span>{item.short.slice(0, 1)}</span>{item.label}<b>›</b></button>)}</div></details></aside><section className="result-content"><div className="section-heading"><div><span className="section-kicker">{tab === "client-progress" ? "AI 草稿 + 可信记忆" : tab === "actions" ? "站内行动" : "只读可信记忆"}</span><h2>{current.label}</h2></div>{isRecord(data) && stringValue(data.generated_at) && <small>生成于 {formatDate(stringValue(data.generated_at), true)}</small>}</div>{issue && state !== "error" && <ErrorNotice issue={issue} onRetry={onRetry} compact />}{busy === "open-claim" && <LoadingBlock label="正在读取记录…" />}{state === "loading" && <LoadingBlock label={`正在生成${current.label}…`} />}{state === "error" && issue && <ErrorNotice issue={issue} onRetry={onRetry} />}{state === "empty" && content}{state === "ready" && content}</section></div>
    </div>
  );
}

function NewProjectModal({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (name: string) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState("");
  return (
    <Modal title="新建项目" description="Notique 会持续整理同一项目中的沟通重点、已确认信息、未决问题和下一步。" onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onCreate(name.trim()); }}>
        <label className="field">
          <span>项目名称</span>
          <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Oak Street Renovation" />
        </label>
        <p className="form-note">AI 草稿会先生成供你阅读；分析第一批材料后，只需确认一次工作场景。只有你确认过的内容会进入可信记忆。</p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>取消</button>
          <button className="button primary" disabled={!name.trim() || busy}>{busy ? "正在创建…" : "创建项目"}</button>
        </div>
      </form>
    </Modal>
  );
}

function NewEventModal({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (input: { title: string; event_type: string; occurred_at: string }) => Promise<void>; busy: boolean }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState("meeting");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 16));
  return <Modal title="新增一次沟通" description="一次会面、Showing、Estimate 或 Walkthrough 对应一个 Event。" onClose={onClose}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (title.trim() && date) void onCreate({ title: title.trim(), event_type: type, occurred_at: new Date(date).toISOString() }); }}><label className="field"><span>标题</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：第二次需求讨论" /></label><div className="form-grid"><label className="field"><span>类型</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="meeting">Meeting</option><option value="showing">Showing</option><option value="estimate">Estimate</option><option value="walkthrough">Walkthrough</option></select></label><label className="field"><span>发生时间</span><input type="datetime-local" value={date} onChange={(event) => setDate(event.target.value)} /></label></div><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!title.trim() || !date || busy}>{busy ? "正在创建…" : "创建并加入材料"}</button></div></form></Modal>;
}

function ImportModal({ project, onClose, onImported }: { project: Project; onClose: () => void; onImported: (events: Event[]) => Promise<void> }) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [issue, setIssue] = useState<ApiIssue | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const importCreateKeys = useRef(new Map<string, string>());
  const activeSession = useRef<{ fingerprint: string; session: ImportSession } | null>(null);
  function chooseFiles(change: ChangeEvent<HTMLInputElement>) {
    setIssue(null);
    const files = Array.from(change.target.files ?? []);
    if (files.length < 1 || files.length > 10) { setIssue({ code: "BAD_REQUEST", message: "一次请选择 1 至 10 份 Transcript。", status: 400 }); return; }
    const invalid = files.find((file) => !acceptedTranscriptTypes.some((extension) => file.name.toLowerCase().endsWith(extension)));
    if (invalid) { setIssue({ code: "ASSET_UNSUPPORTED_FORMAT", message: `${invalid.name} 暂不支持。请选择 TXT、VTT、SRT 或 JSON。`, status: 415 }); return; }
    const start = Date.now() - (files.length - 1) * 60 * 60 * 1000;
    setRows(files.map((file, index) => ({ key: `${file.name}-${file.lastModified}-${index}`, file, title: file.name.replace(/\.[^.]+$/, ""), occurredAt: new Date(start + index * 60 * 60 * 1000).toISOString().slice(0, 16), eventType: "meeting" })));
  }
  function move(index: number, direction: -1 | 1) {
    setRows((current) => { const target = index + direction; if (target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!rows.length || rows.some((row) => !row.title.trim() || !row.occurredAt)) return;
    setBusy(true);
    setIssue(null);
    try {
      const fingerprint = ["transcript-import", project.id, ...rows.map((row) => `${row.file.name}:${row.file.type}:${row.file.size}:${row.file.lastModified}`)].join(":");
      let session = activeSession.current?.fingerprint === fingerprint ? activeSession.current.session : null;
      if (!session) {
        setProgress("正在建立导入会话…");
        const idempotencyKey = importCreateKeys.current.get(fingerprint) || crypto.randomUUID();
        importCreateKeys.current.set(fingerprint, idempotencyKey);
        session = await api.beginTranscriptImport(project.id, rows.map((row) => row.file), idempotencyKey);
        importCreateKeys.current.delete(fingerprint);
        activeSession.current = { fingerprint, session };
      }
      if (!session.id || session.items.length !== rows.length) throw new Error("服务器没有为全部文件建立上传位置，未创建任何 Event。");
      for (let index = 0; index < rows.length; index += 1) {
        setProgress(`正在上传 ${index + 1}/${rows.length}：${rows[index].file.name}`);
        await api.uploadTranscriptItem(session, session.items[index], rows[index].file);
      }
      setProgress("正在按确认顺序建立 Event…");
      const created = await api.finalizeTranscriptImport(session.id, rows.map((row, index) => ({ item_id: session.items[index].id, title: row.title.trim(), occurred_at: new Date(row.occurredAt).toISOString(), event_type: row.eventType })));
      activeSession.current = null;
      await onImported(created);
    } catch (error) { setIssue(toIssue(error)); setProgress(null); } finally { setBusy(false); }
  }
  return <Modal title="批量导入 Transcript" description={`为 ${project.name} 建立 1 至 10 次按时间排序的沟通。Finalize 失败时不会创建半套 Event。`} onClose={busy ? () => undefined : onClose} wide><form className="modal-form" onSubmit={(event) => void submit(event)}>{issue && <ErrorNotice issue={issue} compact />}{!rows.length ? <label className="file-drop"><input type="file" multiple accept=".txt,.vtt,.srt,.json" onChange={chooseFiles} /><span className="empty-symbol">＋</span><strong>选择 1–10 份 Transcript</strong><small>支持 TXT、VTT、SRT、常见 Zoom 文本和结构化 JSON</small></label> : <><div className="import-summary"><strong>{rows.length} 份文件</strong><span>请确认顺序、标题和发生时间</span><label>重新选择<input type="file" multiple accept=".txt,.vtt,.srt,.json" onChange={chooseFiles} /></label></div><div className="import-rows">{rows.map((row, index) => <article key={row.key}><span className="event-order">{index + 1}</span><div className="import-row-main"><input aria-label="Event 标题" value={row.title} onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, title: event.target.value } : item))} /><div><select aria-label="Event 类型" value={row.eventType} onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, eventType: event.target.value as ImportRow["eventType"] } : item))}><option value="meeting">Meeting</option><option value="showing">Showing</option><option value="estimate">Estimate</option><option value="walkthrough">Walkthrough</option></select><input aria-label="发生时间" type="datetime-local" value={row.occurredAt} onChange={(event) => setRows((current) => current.map((item) => item.key === row.key ? { ...item, occurredAt: event.target.value } : item))} /></div><small>{row.file.name} · {formatBytes(row.file.size)}</small></div><div className="order-actions"><button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label="上移">↑</button><button type="button" disabled={index === rows.length - 1} onClick={() => move(index, 1)} aria-label="下移">↓</button></div></article>)}</div></>}{progress && <div className="progress-line"><span className="spinner" />{progress}</div>}<div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!rows.length || busy || rows.some((row) => !row.title.trim() || !row.occurredAt)}>{busy ? "正在导入…" : `导入并建立 ${rows.length || ""} 次沟通`}</button></div></form></Modal>;
}
