"use client";

import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { resolveSimpleImportTarget } from "@/lib/domain/simple-import-target";
import {
  planProjectWorkflow,
  projectNeedsScenarioConfirmation,
  type ProjectWorkflowPlan,
} from "@/lib/domain/project-workflow";
import {
  ApiClientError,
  ApiIssue,
  Claim,
  ClaimEditSubmission,
  Event,
  EvidenceRef,
  ExtractionRun,
  GlossaryEntry,
  GlossaryEntryCategory,
  ImportSession,
  OccurrenceCandidate,
  OccurrenceNewClaim,
  Project,
  ProjectViewName,
  RelationTarget,
  RelationType,
  ReviewSession,
  RunDebug,
  TranscriptionRun,
  api,
  normalizeClaim,
  toIssue,
} from "./api-client";

type Screen = "simple" | "projects" | "project" | "event" | "review" | "claim" | "results" | "run-debug";
type AsyncState = "idle" | "loading" | "ready" | "empty" | "error";
type ResultTab = ProjectViewName;

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
  details: Array<{ event: Event; run: ExtractionRun | null; candidateCount?: number }>;
  plan: ProjectWorkflowPlan;
};

const resultTabs: Array<{ key: ResultTab; label: string; short: string }> = [
  { key: "folder-summary", label: "事项概况", short: "概况" },
  { key: "timeline", label: "时间线", short: "时间线" },
  { key: "decisions", label: "决定", short: "决定" },
  { key: "preferences", label: "偏好", short: "偏好" },
  { key: "open-questions", label: "待确认问题", short: "问题" },
  { key: "risks", label: "风险与矛盾", short: "风险" },
  { key: "gap-check", label: "资料缺口", short: "缺口" },
  { key: "next-meeting-agenda", label: "下次沟通清单", short: "清单" },
  { key: "brief-card", label: "会前速览", short: "速览" },
];

const runInProgress = new Set(["queued", "processing", "extracting"]);
const runComplete = new Set(["succeeded", "completed", "completed_with_warnings"]);
const acceptedTranscriptTypes = [".txt", ".vtt", ".srt", ".json"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (value) return value;
  }
  return undefined;
}

function formatDate(value?: string, includeTime = false): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", includeTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function formatReviewDuration(value: number): string {
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
      message: "录音超过 25 MB，尚未上传。",
      status: 413,
      details: { kind: "audio", filename, size_bytes: sizeBytes, max_size_bytes: MAX_AUDIO_BYTES },
    };
  }
  return null;
}

function transcriptionRunIdFromEvent(value: Event): string | undefined {
  for (const asset of [...value.assets].reverse()) {
    if (asset.kind !== "audio") continue;
    const runId = stringValue(asset.metadata.transcription_run_id);
    if (runId) return runId;
  }
  return undefined;
}

function assetIsAnalyzable(asset: Event["assets"][number]): boolean {
  return asset.status === "ready" && Boolean(asset.versionId) && asset.kind !== "audio";
}

const idleProjectWorkflow: ProjectWorkflowState = {
  phase: "idle",
  total: 0,
  completed: 0,
  currentPosition: 0,
  ignoredEmptyCount: 0,
};

async function inspectProjectWorkflow(projectId: string): Promise<ProjectWorkflowSnapshot> {
  const [latestProject, latestEvents] = await Promise.all([
    api.getProject(projectId),
    api.listEvents(projectId),
  ]);
  const details = await Promise.all(latestEvents.map(async (listedEvent) => {
    const currentEvent = await api.getEvent(listedEvent.id);
    const runId = currentEvent.latestRun?.id || currentEvent.latestRunId || listedEvent.latestRunId;
    const latestRun = runId ? await api.getRun(runId) : null;
    const review = latestRun && runComplete.has(latestRun.status)
      ? await api.getRunReview(latestRun.id)
      : null;
    return {
      event: currentEvent,
      run: latestRun,
      candidateCount: review
        ? review.claims.length + review.occurrenceCandidates.length
        : undefined,
    };
  }));
  const plan = planProjectWorkflow({
    events: details.map(({ event: currentEvent, run: latestRun, candidateCount }) => ({
      id: currentEvent.id,
      title: currentEvent.title,
      occurredAt: currentEvent.occurredAt,
      createdAt: currentEvent.createdAt,
      hasMaterial: currentEvent.assets.length > 0,
      ready: currentEvent.assets.some(assetIsAnalyzable),
      runId: latestRun?.id || currentEvent.latestRunId,
      runStatus: latestRun?.status,
      candidateCount,
      pendingCount: currentEvent.pendingClaimCount + currentEvent.pendingOccurrenceCount,
    })),
    needsScenarioConfirmation: projectNeedsScenarioConfirmation({
      scenarioStatus: latestProject.scenarioStatus,
      scenarioCandidateCount: latestProject.scenarioCandidates?.length ?? 0,
    }),
  });
  return { project: latestProject, events: latestEvents, details, plan };
}

function formatTimestamp(value?: string | number): string {
  if (value == null || value === "") return "无法定位具体时间";
  if (typeof value === "string" && value.includes(":")) return value;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function confidenceText(value?: number): string {
  if (value == null) return "未提供排序分";
  const normalized = value <= 1 ? value * 100 : value;
  return `模型排序分 ${Math.round(normalized)}`;
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

function typeLabel(value?: string): string {
  const labels: Record<string, string> = {
    fact: "事实",
    preference: "偏好",
    commitment: "承诺",
    decision: "决定",
    risk: "风险",
    open_question: "待确认问题",
    question: "待确认问题",
    requirement: "要求",
    constraint: "限制",
    direct: "直接证据",
    corroborating: "佐证材料",
    contextual: "背景参考",
  };
  return labels[(value ?? "").toLowerCase()] ?? (value || "记录").replaceAll("_", " ");
}

function statusLabel(value?: string): string {
  const labels: Record<string, string> = {
    draft: "等待材料",
    ready: "材料已就绪",
    uploading: "正在上传",
    parsing: "正在读取",
    queued: "已进入队列",
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
    unassessed: "等待判断使用场景",
    assessing: "正在判断使用场景",
    pending_confirmation: "等待确认使用场景",
    confirmed: "使用场景已确认",
  };
  return labels[(value ?? "").toLowerCase()] ?? value ?? "状态未知";
}

function extractionProgressLabel(run?: ExtractionRun | null): string {
  if (!run || !runInProgress.has(run.status)) return statusLabel(run?.status);
  if (run.pipelineStage === "inventory") return "正在识别事实";
  if (run.pipelineStage === "verify") return "正在查漏纠错";
  if (run.pipelineStage === "verify_escalated") return "正在加强复核";
  return "正在准备分析";
}

function extractionProgressBody(run?: ExtractionRun | null): string {
  if (run?.pipelineStage === "inventory") return "第一轮正在逐条盘点原子事实和证据，不会直接写入正式结果。";
  if (run?.pipelineStage === "verify") return "第二轮正在检查遗漏、重复、原子性和跨沟通关系。";
  if (run?.pipelineStage === "verify_escalated") return "确定性质量门发现风险，正在用更强推理重新复核。";
  return "任务已经进入后台，页面会继续读取真实状态，不会重复提交。";
}

function issueTitle(issue: ApiIssue): string {
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
  if (issue.code === "EVENT_NOT_READY") return "这次沟通还没有准备好可处理的材料。请等文件状态变为“材料已就绪”。";
  if (issue.code === "NOT_FOUND" || issue.status === 404) return "请求的内容不存在。后端接口可能尚未完成，或这条数据已经被删除。";
  if (issue.code === "NETWORK_ERROR" || issue.status === 0) return "无法连接后端服务，请确认本地服务正在运行。";
  if (issue.status >= 500) return "服务端没有完成这次请求。本次没有写入假数据或半成品，请保留 Request ID 供排查。";
  return issue.message;
}

function ErrorNotice({ issue, onRetry, compact = false }: { issue: ApiIssue; onRetry?: () => void; compact?: boolean }) {
  return (
    <section className={`notice notice-error ${compact ? "notice-compact" : ""}`} role="alert">
      <span className="notice-mark">!</span>
      <div>
        <strong>{issueTitle(issue)}</strong>
        <p>{issueMessage(issue)}</p>
        {issue.requestId && <small>Request ID: {issue.requestId}</small>}
      </div>
      {onRetry && <button className="button secondary" onClick={onRetry}>重试</button>}
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

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function TranscriptViewer({ run, onClose }: { run: TranscriptionRun; onClose: () => void }) {
  return (
    <Modal
      title="完整逐字稿"
      description={`${run.segments.length} 个带说话人和时间点的片段`}
      onClose={onClose}
      wide
    >
      <div className="full-transcript" data-testid="full-transcript">
        {run.segments.length > 0 ? run.segments.map((segment) => (
          <article key={segment.id}>
            <time>{formatTimestamp(segment.startMs / 1000)}</time>
            <strong>{segment.speaker}</strong>
            <p>{segment.text}</p>
          </article>
        )) : <p className="muted">服务器没有返回可显示的逐字稿片段。</p>}
      </div>
    </Modal>
  );
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

async function loadBriefDisplayData(projectId: string): Promise<BriefDisplayData> {
  const [briefValue, summaryValue, agendaValue] = await Promise.all([
    api.getView(projectId, "brief-card"),
    api.getView(projectId, "folder-summary"),
    api.getView(projectId, "next-meeting-agenda"),
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

function ViewItem({ item, onOpenClaim }: { item: Record<string, unknown>; onOpenClaim: (id: string) => void }) {
  const title = firstString(item, ["statement", "displayText", "display_text", "summary", "title", "question", "label", "text", "slot", "delta_text", "current_value"]) ?? "已确认记录";
  const description = firstString(item, ["description", "reason", "detail", "answer", "change", "previous_value"]);
  const type = firstString(item, ["type", "claim_type", "sourceKind", "source_kind", "delta_type", "status", "materiality"]);
  const date = firstString(item, ["occurredAt", "occurred_at", "event_date", "openedAt", "opened_at", "updatedAt", "updated_at", "createdAt", "created_at"]);
  const claimId = firstString(item, ["claim_id", "claimId"]);
  const versionId = firstString(item, ["claim_version_id", "claimVersionId", "version_id"]);
  const rejected = item.rejectedOptions ?? item.rejected_options;
  const selected = stringValue(item.selectedOption ?? item.selected_option);
  const reason = stringValue(item.reason);
  const openDays = typeof (item.openDays ?? item.open_days) === "number" ? Number(item.openDays ?? item.open_days) : undefined;
  const repeatCount = typeof (item.repeatCount ?? item.repeat_count) === "number" ? Number(item.repeatCount ?? item.repeat_count) : undefined;
  const evidenceIds = Array.isArray(item.evidence_ref_ids) ? item.evidence_ref_ids.map(stringValue).filter(Boolean) : [];
  return (
    <article className="view-card">
      <div className="view-card-top">
        <div>{type && <span className="eyebrow">{typeLabel(type)}</span>}<h3>{title}</h3></div>
        {date && <time>{formatDate(date)}</time>}
      </div>
      {description && description !== title && <p>{description}</p>}
      {selected && <p><b>已选择：</b>{selected}</p>}
      {Array.isArray(rejected) && <p><b>未选择：</b>{rejected.map(stringValue).filter(Boolean).join("、") || "尚未记录"}</p>}
      {reason && reason !== description && <p><b>原因：</b>{reason}</p>}
      {(openDays !== undefined || repeatCount !== undefined) && <p>{openDays !== undefined ? `已开放 ${openDays} 天` : ""}{openDays !== undefined && repeatCount !== undefined ? " · " : ""}{repeatCount !== undefined ? `在 ${repeatCount} 次后续沟通中再次出现` : ""}</p>}
      {evidenceIds.length > 0 && <p>{evidenceIds.length} 条原始证据</p>}
      {(claimId || versionId) && <button className="text-button" onClick={() => onOpenClaim(claimId || versionId!)}>查看记录与证据</button>}
    </article>
  );
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

function ResultContent({ tab, data, events, onOpenClaim, onSelect, onResolveContradiction, busyAction }: { tab: ResultTab; data: unknown; events: Event[]; onOpenClaim: (id: string) => void; onSelect: (tab: ResultTab) => void; onResolveContradiction: (input: ContradictionResolutionInput) => void; busyAction: string | null }) {
  const emptyReason = viewEmptyReason(data);
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
    return <div className="timeline-groups">{groups.map((group, index) => {
      const event = isRecord(group.event) ? group.event : {};
      const eventId = firstString(event, ["id"]);
      const eventRecord = events.find((item) => item.id === eventId);
      const pendingReviewCount = (eventRecord?.pendingClaimCount ?? 0) + (eventRecord?.pendingOccurrenceCount ?? 0);
      const claims = recordArray(group.claims).map(claimViewItem);
      const deltas = recordArray(group.deltas);
      return <section className="timeline-group" key={eventId || index}><header><div><span className="section-kicker">第 {index + 1} 次沟通</span><h3>{firstString(event, ["title"]) || "未命名沟通"}</h3></div><time>{formatDate(firstString(event, ["occurredAt", "occurred_at"]))}</time></header>{pendingReviewCount > 0 && <p className="pending-review-note compact">还有 {pendingReviewCount} 条待核对，尚未进入本页结果。</p>}<p>{firstString(group, ["summary"])}</p>{claims.length > 0 && <ResultSection title="已确认记录"><div className="view-grid">{claims.map((item, claimIndex) => <ViewItem key={firstString(item, ["claim_id"]) || claimIndex} item={item} onOpenClaim={onOpenClaim} />)}</div></ResultSection>}{deltas.length > 0 && <ResultSection title="本次变化"><div className="view-grid">{deltas.map((item, deltaIndex) => <ViewItem key={firstString(item, ["id"]) || deltaIndex} item={item} onOpenClaim={onOpenClaim} />)}</div></ResultSection>}</section>;
    })}</div>;
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
    return <div className="brief-grid">
      <BriefGroup title="当前最重要的情况" items={stateItem ? [stateItem] : []} kind="state" empty="还没有可用记录" onOpenClaim={onOpenClaim} onSelect={onSelect} />
      <BriefGroup title="最近变化" items={deltaItems} kind="delta" empty="还没有变化" onOpenClaim={onOpenClaim} onSelect={onSelect} />
      <BriefGroup title="下次要问" items={agendaItems} kind="agenda" empty="还没有待确认事项" onOpenClaim={onOpenClaim} onSelect={onSelect} />
      <BriefGroup title="需要留意的风险" items={riskItem ? [riskItem] : []} kind="risk" empty="还没有风险记录" onOpenClaim={onOpenClaim} onSelect={onSelect} warning />
      {missing > 0 && <article className="view-card brief-warning"><span className="eyebrow">信息完整度</span><h3>还有 {missing} 个位置没有足够依据</h3><p>这些位置保持空白，没有用推测补齐。</p></article>}
    </div>;
  }
  const rows = objectItems(data).map((item) => tab === "decisions" || tab === "preferences" || tab === "open-questions" ? claimViewItem(item) : item);
  if (!rows.length) {
    const copy: Record<ResultTab, [string, string]> = {
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
  const labels: Record<string, string> = { budget: "预算", financing: "资金或贷款", timeline: "时间计划", decision_makers: "谁参与决定", must_haves: "必须满足的条件" };
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
  const [screen, setScreen] = useState<Screen>("simple");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsState, setProjectsState] = useState<AsyncState>("loading");
  const [projectsIssue, setProjectsIssue] = useState<ApiIssue | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [projectState, setProjectState] = useState<AsyncState>("idle");
  const [projectIssue, setProjectIssue] = useState<ApiIssue | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [eventState, setEventState] = useState<AsyncState>("idle");
  const [eventIssue, setEventIssue] = useState<ApiIssue | null>(null);
  const [run, setRun] = useState<ExtractionRun | null>(null);
  const [transcriptionRun, setTranscriptionRun] = useState<TranscriptionRun | null>(null);
  const [reviewSession, setReviewSession] = useState<ReviewSession | null>(null);
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
  const [runDebug, setRunDebug] = useState<RunDebug | null>(null);
  const [runDebugState, setRunDebugState] = useState<AsyncState>("idle");
  const [runDebugIssue, setRunDebugIssue] = useState<ApiIssue | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewEvent, setShowNewEvent] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [simpleFlow, setSimpleFlow] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [projectWorkflow, setProjectWorkflow] = useState<ProjectWorkflowState>(idleProjectWorkflow);
  const [selectedClaimIds, setSelectedClaimIds] = useState<Set<string>>(new Set());
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
  const localDispatchTranscriptionRuns = useRef(new Set<string>());
  const completingReviewSessions = useRef(new Set<string>());
  const projectWorkflowRefreshToken = useRef(0);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  useEffect(() => {
    if (reviewSession?.status !== "active") return;
    const timer = window.setInterval(() => setReviewClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [reviewSession?.id, reviewSession?.status]);

  const loadProjects = useCallback(async () => {
    setProjectsState("loading");
    setProjectsIssue(null);
    try {
      const result = await api.listProjects();
      setProjects(result);
      setProjectsState(result.length ? "ready" : "empty");
    } catch (error) {
      setProjectsIssue(toIssue(error));
      setProjectsState("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProjects]);

  const loadProject = useCallback(async (projectId: string, nextScreen: Screen = "project") => {
    setProjectState("loading");
    setProjectIssue(null);
    setScreen(nextScreen);
    try {
      const [nextProject, nextEvents] = await Promise.all([api.getProject(projectId), api.listEvents(projectId)]);
      setProject(nextProject);
      setEvents(nextEvents);
      setProjectState("ready");
    } catch (error) {
      const issue = toIssue(error);
      setProjectIssue(issue);
      setProjectState("error");
      if (issue.status === 404) setProject(null);
    }
  }, []);

  const loadClaimsForRun = useCallback(async (runId: string) => {
    setClaimsState("loading");
    setClaimsIssue(null);
    try {
      const result = await api.getRunClaims(runId);
      setClaims(result);
      setClaimsState(result.length ? "ready" : "empty");
    } catch (error) {
      setClaimsIssue(toIssue(error));
      setClaimsState("error");
    }
  }, []);

  const loadTranscriptionForEvent = useCallback(async (nextEvent: Event) => {
    const transcriptionRunId = transcriptionRunIdFromEvent(nextEvent);
    if (!transcriptionRunId) {
      setTranscriptionRun(null);
      return;
    }
    try {
      setTranscriptionRun(await api.getTranscriptionRun(transcriptionRunId));
    } catch (error) {
      const issue = toIssue(error);
      if (issue.status === 404) {
        setTranscriptionRun(null);
        return;
      }
      throw error;
    }
  }, []);

  const refreshProjectWorkflow = useCallback(async (
    projectId: string,
  ): Promise<ProjectWorkflowSnapshot | null> => {
    const token = projectWorkflowRefreshToken.current + 1;
    projectWorkflowRefreshToken.current = token;
    setProjectWorkflow((current) => current.phase === "running"
      ? current
      : { ...current, phase: "loading", issue: undefined });
    try {
      const snapshot = await inspectProjectWorkflow(projectId);
      if (projectWorkflowRefreshToken.current !== token) return null;
      setProject(snapshot.project);
      setProjectWorkflow(snapshot.plan);
      return snapshot;
    } catch (error) {
      if (projectWorkflowRefreshToken.current !== token) return null;
      setProjectWorkflow({
        ...idleProjectWorkflow,
        phase: "error",
        issue: toIssue(error),
      });
      return null;
    }
  }, []);

  const loadSimpleProject = useCallback(async (projectId: string, preferredEventId?: string) => {
    setScreen("simple");
    setProjectState("loading");
    setProjectIssue(null);
    setEvent(null);
    setEventState("idle");
    setEventIssue(null);
    setRun(null);
    setTranscriptionRun(null);
    setClaims([]);
    setClaimsState("idle");
    try {
      const [nextProject, nextEvents] = await Promise.all([api.getProject(projectId), api.listEvents(projectId)]);
      setProject(nextProject);
      setEvents(nextEvents);
      setProjectState("ready");
      const target = nextEvents.find((item) => item.id === preferredEventId) ?? nextEvents[0] ?? null;
      if (!target) {
        setEvent(null);
        setRun(null);
        setClaims([]);
        setClaimsState("idle");
        return;
      }
      setEventState("loading");
      const nextEvent = await api.getEvent(target.id);
      setEvent(nextEvent);
      setEventState("ready");
      await loadTranscriptionForEvent(nextEvent);
      const runId = nextEvent.latestRun?.id || nextEvent.latestRunId;
      if (!runId) {
        setRun(null);
        setClaims([]);
        setClaimsState("idle");
        return;
      }
      const nextRun = await api.getRun(runId);
      setRun(nextRun);
      if (runComplete.has(nextRun.status)) await loadClaimsForRun(nextRun.id);
    } catch (error) {
      const issue = toIssue(error);
      setProjectIssue(issue);
      setProjectState("error");
      setEventIssue(issue);
      setEventState("error");
    }
  }, [loadClaimsForRun, loadTranscriptionForEvent]);

  useEffect(() => {
    if (screen !== "simple" || project || projectsState !== "ready") return;
    const sample = projects.find((item) => item.name.startsWith("[SYNTHETIC]"));
    if (!sample) return;
    const timer = window.setTimeout(() => void loadSimpleProject(sample.id), 0);
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
    void api.kickDispatcher().catch(() => undefined);
    let attempts = 0;
    const timer = window.setInterval(async () => {
      if (attempts >= 360) {
        window.clearInterval(timer);
        const issue: ApiIssue = {
          code: "EXTRACTION_POLL_TIMEOUT",
          message: "等待分析结果的时间过长。材料和后台任务都已保留，可以重新检查任务状态。",
          status: 408,
        };
        setProjectWorkflow((current) => current.currentRunId === runId
          ? { ...current, phase: "error", issue }
          : current);
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

  const loadEvent = useCallback(async (eventId: string) => {
    setEventState("loading");
    setEventIssue(null);
    setScreen("event");
    try {
      const nextEvent = await api.getEvent(eventId);
      setEvent(nextEvent);
      setEventState("ready");
      await loadTranscriptionForEvent(nextEvent);
      const runId = nextEvent.latestRun?.id || nextEvent.latestRunId;
      if (runId) {
        const nextRun = await api.getRun(runId);
        setRun(nextRun);
        if (runComplete.has(nextRun.status)) await loadClaimsForRun(nextRun.id);
      } else {
        setRun(null);
        setClaims([]);
        setClaimsState("idle");
      }
    } catch (error) {
      setEventIssue(toIssue(error));
      setEventState("error");
    }
  }, [loadClaimsForRun, loadTranscriptionForEvent]);

  useEffect(() => {
    if (!run || run.status !== "queued" || localDispatchRuns.current.has(run.id)) return;
    localDispatchRuns.current.add(run.id);
    void api.kickDispatcher().catch(() => {
      // The durable Run remains queued when an explicit dispatch request fails,
      // so polling and the scheduled sweeper can recover without duplicating it.
    });
  }, [run]);

  useEffect(() => {
    if (!transcriptionRun || transcriptionRun.status !== "queued" || localDispatchTranscriptionRuns.current.has(transcriptionRun.id)) return;
    localDispatchTranscriptionRuns.current.add(transcriptionRun.id);
    void api.kickDispatcher().catch(() => {
      // The durable transcription Run remains recoverable by the same endpoint
      // or the scheduled sweeper.
    });
  }, [transcriptionRun]);

  const activeTranscriptionRunId = transcriptionRun?.id;
  const activeTranscriptionRunStatus = transcriptionRun?.status;

  useEffect(() => {
    if (!activeTranscriptionRunId || !runInProgress.has(activeTranscriptionRunStatus ?? "")) return;
    const runId = activeTranscriptionRunId;
    const pollKey = `${runId}:${transcriptionPollCycle}`;
    if (transcriptionPollingRunKey.current !== pollKey) {
      transcriptionPollingRunKey.current = pollKey;
      transcriptionPollAttempts.current = 0;
    }
    const timer = window.setInterval(async () => {
      if (transcriptionPollAttempts.current >= 240) {
        window.clearInterval(timer);
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
        setTranscriptionRun(latest);
        if (!runInProgress.has(latest.status)) {
          window.clearInterval(timer);
          if (latest.status === "succeeded" && event?.id) {
            const refreshed = await api.getEvent(event.id);
            setEvent(refreshed);
            setEventIssue(null);
            flash(`逐字稿已生成，包含 ${latest.segmentCount ?? latest.segments.length} 个带时间点的片段`);
          } else if (latest.status === "failed") {
            setEventIssue({
              code: latest.errorCode || "TRANSCRIPTION_FAILED",
              message: "录音仍然保留在这次沟通中。请检查错误后点击“重新转写”。",
              status: 502,
            });
          }
        }
      } catch (error) {
        const issue = toIssue(error);
        if (issue.status >= 500 || issue.status === 0) return;
        window.clearInterval(timer);
        setEventIssue(issue);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeTranscriptionRunId, activeTranscriptionRunStatus, event?.id, flash, transcriptionPollCycle]);

  const activeExtractionRunId = run?.id;
  const activeExtractionRunStatus = run?.status;

  useEffect(() => {
    if (!activeExtractionRunId || !runInProgress.has(activeExtractionRunStatus ?? "")) return;
    const runId = activeExtractionRunId;
    const pollKey = `${runId}:${runPollCycle}`;
    if (pollingRunKey.current !== pollKey) {
      pollingRunKey.current = pollKey;
      pollAttempts.current = 0;
    }
    const timer = window.setInterval(async () => {
      // Luna Max may legitimately spend several minutes reasoning before it
      // returns structured output. Keep the simple test screen live for up to
      // 15 minutes; the server remains the source of truth if the page closes.
      if (pollAttempts.current >= 360) {
        window.clearInterval(timer);
        const issue: ApiIssue = {
          code: "EXTRACTION_POLL_TIMEOUT",
          message: "等待分析结果的时间过长。材料和后台任务都已保留，可以重新检查任务状态。",
          status: 408,
        };
        setEventIssue(issue);
        setProjectWorkflow((current) => current.currentRunId === runId
          ? { ...current, phase: "error", issue }
          : current);
        return;
      }
      pollAttempts.current += 1;
      try {
        const latest = await api.getRun(runId);
        setRun(latest);
        if (!runInProgress.has(latest.status)) {
          window.clearInterval(timer);
          if (runComplete.has(latest.status)) {
            setEventIssue(null);
            await loadClaimsForRun(latest.id);
            const refreshes: Promise<unknown>[] = [];
            if (project?.id) {
              refreshes.push(api.getProject(project.id).then((latestProject) => setProject(latestProject)));
            }
            if (event?.id) {
              refreshes.push(api.getEvent(event.id).then((latestEvent) => setEvent(latestEvent)));
            }
            await Promise.all(refreshes);
          } else if (latest.status === "failed") {
            setEventIssue({
              code: latest.errorCode || "EXTRACTION_FAILED",
              message: latest.errorMessage || "这次分析没有完成。材料仍然保留，可以直接重新分析。",
              status: 502,
            });
          }
        }
      } catch (error) {
        const issue = toIssue(error);
        if (issue.status >= 500 || issue.status === 0) return;
        window.clearInterval(timer);
        setClaimsIssue(issue);
        setProjectWorkflow((current) => current.currentRunId === runId
          ? { ...current, phase: "error", issue }
          : current);
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeExtractionRunId, activeExtractionRunStatus, event?.id, loadClaimsForRun, project?.id, runPollCycle]);

  const syncReviewTiming = useCallback(async (latestProject: Project) => {
    const pendingTotal = latestProject.pendingClaimCount + latestProject.pendingOccurrenceCount;
    if (pendingTotal > 0) {
      const fingerprint = `review-start:${latestProject.id}`;
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      try {
        setReviewSession(await api.startReviewSession(latestProject.id, idempotencyKey));
      } catch (error) {
        const issue = toIssue(error);
        if (issue.code !== "REVIEW_SESSION_CONFLICT") throw error;
        setReviewSession(await api.getReviewSession(latestProject.id));
      }
      return;
    }
    const latest = await api.getReviewSession(latestProject.id);
    setReviewSession(latest);
    if (latest?.status === "completed") {
      mutationKeys.current.delete(`review-start:${latestProject.id}`);
    }
  }, []);

  useEffect(() => {
    if (
      !project ||
      !reviewSession ||
      reviewSession.status !== "active" ||
      project.pendingClaimCount + project.pendingOccurrenceCount > 0 ||
      completingReviewSessions.current.has(reviewSession.id)
    ) return;
    completingReviewSessions.current.add(reviewSession.id);
    const fingerprint = `review-complete:${reviewSession.id}`;
    const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
    mutationKeys.current.set(fingerprint, idempotencyKey);
    void api.completeReviewSession(reviewSession.id, idempotencyKey)
      .then((completed) => {
        mutationKeys.current.delete(fingerprint);
        mutationKeys.current.delete(`review-start:${project.id}`);
        setReviewSession(completed);
        flash(`本次审核完成，用时 ${formatReviewDuration(completed.durationMs ?? 0)}`);
      })
      .catch((error) => setClaimsIssue(toIssue(error)))
      .finally(() => completingReviewSessions.current.delete(reviewSession.id));
  }, [flash, project, reviewSession]);

  const loadReviewQueue = useCallback(async () => {
    if (!project) return;
    setScreen("review");
    setClaimsState("loading");
    setClaimsIssue(null);
    try {
      const [latestProject, latestEvents] = await Promise.all([
        api.getProject(project.id),
        api.listEvents(project.id),
      ]);
      setProject(latestProject);
      setEvents(latestEvents);
      const runIds = [...new Set(latestEvents.map((item) => item.latestRun?.id || item.latestRunId).filter((value): value is string => Boolean(value)))];
      if (!runIds.length) {
        setClaims([]);
        setOccurrenceCandidates([]);
        setClaimsState("empty");
        await syncReviewTiming(latestProject);
        return;
      }
      const results = await Promise.allSettled(runIds.map((runId) => api.getRunReview(runId)));
      const failed = results.find((item): item is PromiseRejectedResult => item.status === "rejected");
      const foundClaims = results.flatMap((item) => item.status === "fulfilled" ? item.value.claims : []);
      const foundOccurrences = results.flatMap((item) => item.status === "fulfilled" ? item.value.occurrenceCandidates : []);
      if (failed && !foundClaims.length && !foundOccurrences.length) throw failed.reason;
      const uniqueClaims = [...new Map(foundClaims.map((item) => [item.id, item])).values()];
      const uniqueOccurrences = [...new Map(foundOccurrences.map((item) => [item.id, item])).values()];
      setClaims(uniqueClaims);
      setOccurrenceCandidates(uniqueOccurrences);
      setClaimsState(uniqueClaims.length || uniqueOccurrences.length ? "ready" : "empty");
      await syncReviewTiming(latestProject);
    } catch (error) {
      setClaimsIssue(toIssue(error));
      setClaimsState("error");
    }
  }, [project, syncReviewTiming]);

  const loadView = useCallback(async (tab: ResultTab) => {
    if (!project) return;
    setViewTab(tab);
    setScreen("results");
    setViewState("loading");
    setViewIssue(null);
    try {
      const [result, nextProject, nextEvents] = await Promise.all([
        tab === "brief-card"
          ? loadBriefDisplayData(project.id)
          : api.getView(project.id, tab),
        api.getProject(project.id),
        api.listEvents(project.id),
      ]);
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
      const issue = toIssue(error);
      setViewIssue(issue);
      setViewState(issue.status === 404 ? "empty" : "error");
      setViewData(null);
    }
  }, [project]);

  const openRunDebug = useCallback(async (runId: string) => {
    setScreen("run-debug");
    setRunDebugState("loading");
    setRunDebugIssue(null);
    setRunDebug(null);
    try {
      const result = await api.getRunDebug(runId);
      setRunDebug(result);
      setRunDebugState("ready");
    } catch (error) {
      setRunDebugIssue(toIssue(error));
      setRunDebugState("error");
    }
  }, []);

  async function openClaim(claimOrVersionId: string) {
    let listClaim = claims.find((item) => item.id === claimOrVersionId || item.versionId === claimOrVersionId) ?? null;
    let nextClaim: Claim | null = null;
    setBusyAction("open-claim");
    try {
      let lookupId = listClaim?.id ?? claimOrVersionId;
      let history: unknown;
      try {
        history = await api.getClaimHistory(lookupId);
      } catch (error) {
        const issue = toIssue(error);
        if (!project || issue.status !== 404) throw error;
        const [summaryView, timelineView] = await Promise.all([
          api.getView(project.id, "folder-summary"),
          api.getView(project.id, "timeline"),
        ]);
        listClaim = [...claimsFromVerifiedView(summaryView), ...claimsFromVerifiedView(timelineView)]
          .find((item) => item.id === claimOrVersionId || item.versionId === claimOrVersionId) ?? null;
        if (!listClaim) throw error;
        lookupId = listClaim.id;
        history = await api.getClaimHistory(lookupId);
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
      setClaimsIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
    if (!nextClaim?.id) return;
    setSelectedClaim(nextClaim);
    setScreen("claim");
    setEvidence([]);
    setEvidenceState("loading");
    try {
      const embedded = nextClaim.evidenceRefs;
      const missingIds = nextClaim.evidenceRefIds.filter((id) => !embedded.some((item) => item.id === id));
      const fetched = await Promise.allSettled(missingIds.map((id) => api.getEvidence(id)));
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
    } catch {
      setEvidenceState("error");
    }
  }

  const pendingClaims = useMemo(() => claims.filter((item) => item.reviewStatus === "pending"), [claims]);
  const selectedBatch = useMemo(
    () => pendingClaims.filter(
      (item) => selectedClaimIds.has(item.id)
        && !item.relationsForReview.some((relation) => relation.status === "proposed"),
    ),
    [pendingClaims, selectedClaimIds],
  );

  async function runVerdict(
    action: "confirm" | "reject" | "edit",
    reason?: string,
    edit?: ClaimEditSubmission,
    retainRelationIds?: string[],
  ) {
    if (!selectedClaim) return;
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
      setSelectedClaim(updated);
      setClaims((items) => items.map((item) => item.id === selectedClaim.id ? updated : item));
      if (project) {
        const [latestProject, latestEvents] = await Promise.all([
          api.getProject(project.id),
          api.listEvents(project.id),
        ]);
        setProject(latestProject);
        setEvents(latestEvents);
        await syncReviewTiming(latestProject);
      }
      flash(action === "reject" ? "已记录为不采纳" : action === "edit" ? "修改已保存并确认" : "记录已确认");
      if (action === "edit") await openClaim(updated.id);
    } catch (error) {
      const issue = toIssue(error);
      setClaimsIssue(issue);
      if (issue.code === "CLAIM_VERSION_CONFLICT") flash("这条记录已被其他操作修改，请刷新后再决定");
    } finally {
      setBusyAction(null);
    }
  }

  async function attestSelectedClaimForBatch() {
    if (!selectedClaim) return;
    if (evidenceState !== "ready") {
      flash("证据尚未完整加载，暂时不能记录为已核对");
      return;
    }
    setBusyAction("evidence-review-attestation");
    setClaimsIssue(null);
    try {
      const fingerprint = [
        "evidence-review-attestation",
        selectedClaim.id,
        selectedClaim.versionId,
      ].join(":");
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const updated = await api.attestEvidenceReview(selectedClaim, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      setSelectedClaim(updated);
      setClaims((items) => items.map((item) => item.id === updated.id ? updated : item));
      setScreen("review");
      flash("已记录本次证据核对，可以在列表中选择批量确认");
    } catch (error) {
      setClaimsIssue(toIssue(error));
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
      setSelectedClaim(updated);
      setClaims((items) => items.map((item) => item.id === selectedClaim.id ? updated : item));
      flash("这条记录已撤回，仍会保留在历史时间线中");
    } catch (error) {
      setClaimsIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function batchConfirm() {
    if (!selectedBatch.length) return;
    setBusyAction("batch");
    try {
      const fingerprint = `batch:${selectedBatch.map((item) => `${item.id}:${item.versionId}`).sort().join(",")}`;
      const idempotencyKey = mutationKeys.current.get(fingerprint) || crypto.randomUUID();
      mutationKeys.current.set(fingerprint, idempotencyKey);
      const updated = await api.batchConfirm(selectedBatch, idempotencyKey);
      mutationKeys.current.delete(fingerprint);
      const byId = new Map(updated.map((item) => [item.id, item]));
      setClaims((items) => items.map((item) => byId.get(item.id) ?? item));
      setSelectedClaimIds(new Set());
      if (project) {
        const [latestProject, latestEvents] = await Promise.all([
          api.getProject(project.id),
          api.listEvents(project.id),
        ]);
        setProject(latestProject);
        setEvents(latestEvents);
        await syncReviewTiming(latestProject);
      }
      flash(`已确认 ${selectedBatch.length} 条记录`);
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
      flash(action === "confirm" ? "已确认这次再次出现，并保存新的原始证据" : "这次再次出现未被采纳");
      await loadReviewQueue();
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
      flash(`已生成 ${converted.length} 条待审核记录，原记录没有改动`);
      await loadReviewQueue();
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
      const [latestProject, latestEvents] = await Promise.all([
        api.getProject(project.id),
        api.listEvents(project.id),
      ]);
      setProject(latestProject);
      setEvents(latestEvents);
      flash("记录关系已保存，当前结果已经重新计算");
      await openClaim(selectedClaim.id);
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
  ): Promise<TranscriptionRun> {
    const fingerprint = ["transcription", audioAssetId, retryOfRunId].join(":");
    const key = transcriptionKeys.current.get(fingerprint) || crypto.randomUUID();
    transcriptionKeys.current.set(fingerprint, key);
    const next = await api.startTranscription(audioAssetId, key);
    transcriptionKeys.current.delete(fingerprint);
    setTranscriptionRun(next);
    setTranscriptionPollCycle((current) => current + 1);
    const refreshed = await api.getEvent(targetEventId);
    setEvent(refreshed);
    return next;
  }

  async function retryAudioTranscription(audioAssetId: string) {
    if (!event) return;
    setBusyAction("transcription");
    setEventIssue(null);
    try {
      let current = transcriptionRun?.audioAssetId === audioAssetId ? transcriptionRun : null;
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
          }
        }
      }
      if (current && runInProgress.has(current.status)) {
        await api.kickDispatcher().catch(() => undefined);
        const latest = await api.getTranscriptionRun(current.id);
        if (runInProgress.has(latest.status)) {
          setTranscriptionRun(latest);
          setTranscriptionPollCycle((value) => value + 1);
          flash("已重新检查后台任务，会继续等待转写结果");
          return;
        }
        if (latest.status === "succeeded") {
          setTranscriptionRun(latest);
          setEvent(await api.getEvent(event.id));
          flash("逐字稿已经生成");
          return;
        }
      }
      await launchTranscription(audioAssetId, event.id, current?.id || "retry-without-run");
      flash("已重新开始转写，录音不会重复上传");
    } catch (error) {
      setEventIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function retryRunStatus() {
    if (!run || !event) return;
    setBusyAction("run-status");
    setEventIssue(null);
    try {
      await api.kickDispatcher().catch(() => undefined);
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

  async function startExtractionForEvent(targetEvent: Event) {
    const ids = targetEvent.assets
      .filter(assetIsAnalyzable)
      .map((asset) => asset.versionId)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) {
      setEventIssue({ code: "EVENT_NOT_READY", message: "当前材料还没有可用于分析的已完成版本。", status: 409 });
      return;
    }
    setBusyAction("extraction");
    setEventIssue(null);
    try {
      const nextRun = await requestExtractionForEvent(targetEvent);
      setRun(nextRun);
      setRunPollCycle((value) => value + 1);
      setClaims([]);
      setClaimsState("idle");
      flash("分析已经开始，可以稍后回来查看");
    } catch (error) {
      setEventIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function advanceProjectWorkflow() {
    if (!project) return;
    setBusyAction("project-workflow");
    setEventIssue(null);
    try {
      projectWorkflowRefreshToken.current += 1;
      const snapshot = await inspectProjectWorkflow(project.id);
      setProject(snapshot.project);
      setEvents(snapshot.events);
      setProjectWorkflow(snapshot.plan);
      const current = snapshot.plan.currentEventId
        ? snapshot.details.find((item) => item.event.id === snapshot.plan.currentEventId)
        : undefined;

      if (snapshot.plan.phase === "waiting_review") {
        if (current) {
          setEvent(current.event);
          setEventState("ready");
          setRun(current.run);
        }
        await loadReviewQueue();
        return;
      }
      if (snapshot.plan.phase === "waiting_scenario") {
        if (current) await loadSimpleProject(project.id, current.event.id);
        flash("先确认使用场景，再核对这次结果");
        return;
      }
      if (snapshot.plan.phase === "waiting_material") {
        if (current) await loadSimpleProject(project.id, current.event.id);
        flash("前一次沟通的材料还没有准备好，暂时不会越过它处理后面的内容");
        return;
      }
      if (snapshot.plan.phase === "complete") {
        flash("全部沟通都已处理并核对完成");
        return;
      }
      if (snapshot.plan.phase === "empty" || !current) {
        flash("当前 Project 还没有可处理的材料");
        return;
      }

      setScreen("simple");
      setEvent(current.event);
      setEventState("ready");
      setEventIssue(null);
      setRun(current.run);
      setClaims([]);
      setClaimsState("idle");
      await loadTranscriptionForEvent(current.event);

      if (snapshot.plan.phase === "running" && current.run) {
        await api.kickDispatcher().catch(() => undefined);
        setRunPollCycle((value) => value + 1);
        flash(`继续等待第 ${snapshot.plan.currentPosition}/${snapshot.plan.total} 次沟通的处理结果`);
        return;
      }

      const nextRun = await requestExtractionForEvent(current.event);
      setRun(nextRun);
      setRunPollCycle((value) => value + 1);
      setProjectWorkflow({
        ...snapshot.plan,
        phase: "running",
        currentRunId: nextRun.id,
      });
      flash(`正在处理第 ${snapshot.plan.currentPosition}/${snapshot.plan.total} 次沟通`);
    } catch (error) {
      const issue = toIssue(error);
      setEventIssue(issue);
      setProjectWorkflow((current) => ({ ...current, phase: "error", issue }));
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
      const name = `测试记录 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(now)}`;
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
      flash("空白测试已经建立。Transcript 会成为第一条沟通，录音或照片会自动建立第一条沟通。");
      return { project: created, event: null };
    } catch (error) {
      setProjectsIssue(toIssue(error));
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function attachSimpleFile(file: File) {
    const localIssue = photoUploadIssue(file.name, file.type, file.size)
      ?? audioUploadIssue(file.name, file.type, file.size);
    if (localIssue) {
      setEventIssue(localIssue);
      return;
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
      if (!target) return;
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
      if (kind === "audio") {
        await launchTranscription(init.assetId, targetEvent.id);
        flash("录音已保存，正在生成带说话人和时间点的逐字稿");
      } else {
        flash("材料已加入");
      }
      await loadSimpleProject(targetProject.id, targetEvent.id);
    } catch (error) {
      const issue = toIssue(error);
      const targetEventId = targetEvent?.id;
      if (targetProject && targetEventId) {
        await loadSimpleProject(targetProject.id, targetEventId).catch(() => undefined);
      }
      setEventIssue(issue);
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
    setScreen("projects");
    setProject(null);
    setEvent(null);
    setSelectedClaim(null);
    void loadProjects();
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
      if (screen === "simple") await loadSimpleProject(project.id, event?.id);
      else await loadProject(project.id);
    } catch (error) {
      setProjectIssue(toIssue(error));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={goSimple}><span>⌁</span> Notique AI</button>
        <div className="account"><span className="avatar">N</span><span><strong>Notique</strong><small>Workspace</small></span></div>
        <nav aria-label="主要导航">
          <button className={screen === "simple" ? "active" : ""} onClick={goSimple}><span>◎</span>核心测试</button>
          <button className={screen === "projects" ? "active" : ""} onClick={goProjects}><span>▣</span>高级工具</button>
          {project && screen !== "simple" && <button className={screen !== "projects" ? "active" : ""} onClick={() => setScreen("project")}><span>◫</span>{project.name}</button>}
        </nav>
        <div className="sidebar-note"><strong>核心测试版</strong><p>按四个大按钮完成一次测试。高级工具不影响这条主流程。</p></div>
      </aside>
      <header className="mobile-header"><button className="brand" onClick={goSimple}>⌁ Notique AI</button><button className="icon-button" onClick={goProjects} aria-label="高级工具">···</button></header>
      <main>
        {screen === "simple" && <SimpleTestScreen
          key={`${project?.id ?? "none"}-${project?.scenarioVersion ?? 0}`}
          projects={projects}
          projectsState={projectsState}
          projectsIssue={projectsIssue}
          project={project}
          projectState={projectState}
          projectIssue={projectIssue}
          events={events}
          event={event}
          eventState={eventState}
          eventIssue={eventIssue}
          run={run}
          claims={claims}
          busy={busyAction}
          projectWorkflow={projectWorkflow}
          onUseProject={(id) => { setSimpleFlow(true); void loadSimpleProject(id); }}
          onUseEvent={(id) => { if (project) { setSimpleFlow(true); void loadSimpleProject(project.id, id); } }}
          onStartOwn={() => void beginSimpleTest()}
          onAddTranscript={() => { setSimpleFlow(true); if (project) setShowImport(true); else void beginSimpleTest(true); }}
          onAddFile={(file) => void attachSimpleFile(file)}
          onProjectWorkflowAction={() => void advanceProjectWorkflow()}
          onRetryTranscription={(audioAssetId) => void retryAudioTranscription(audioAssetId)}
          onConfirmScenario={confirmCurrentScenario}
          transcriptionRun={transcriptionRun}
          onReview={() => void loadReviewQueue()}
          onResult={() => void loadView("folder-summary")}
        />}
        {screen === "projects" && <ProjectsScreen state={projectsState} issue={projectsIssue} projects={projects} onRetry={loadProjects} onOpen={(id) => { setSimpleFlow(false); void loadProject(id); }} onCreate={() => setShowNewProject(true)} />}
        {screen === "project" && <ProjectScreen key={`${project?.id ?? "none"}-${project?.scenarioVersion ?? 0}`} state={projectState} issue={projectIssue} project={project} events={events} onBack={goProjects} onRetry={() => project && void loadProject(project.id)} onOpenEvent={(id) => void loadEvent(id)} onNewEvent={() => setShowNewEvent(true)} onImport={() => { setSimpleFlow(false); setShowImport(true); }} onReview={() => void loadReviewQueue()} onResults={(tab) => void loadView(tab)} onConfirmScenario={confirmCurrentScenario} busy={busyAction === "scenario"} />}
        {screen === "event" && <EventScreen state={eventState} issue={eventIssue} event={event} run={run} transcriptionRun={transcriptionRun} claims={claims} claimsState={claimsState} claimsIssue={claimsIssue} onBack={() => project ? void loadProject(project.id) : goProjects()} onRetry={() => event && void loadEvent(event.id)} onDebug={() => run && void openRunDebug(run.id)} onStart={async () => {
          if (event) await startExtractionForEvent(event);
        }} onReview={() => { if (run?.id && runComplete.has(run.status)) void loadReviewQueue(); }} onOpenClaim={(id) => void openClaim(id)} onAttach={async (input) => {
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
            if (preparedInput.kind === "audio") {
              await launchTranscription(init.assetId, event.id);
              flash("录音已保存，正在生成逐字稿");
            } else {
              flash("材料已加入这次沟通");
            }
            await loadEvent(event.id);
          } catch (error) {
            const issue = toIssue(error);
            await loadEvent(event.id).catch(() => undefined);
            setEventIssue(issue);
          } finally { setBusyAction(null); }
        }} onRetryTranscription={(audioAssetId) => void retryAudioTranscription(audioAssetId)} onRetryRunStatus={() => void retryRunStatus()} busy={busyAction} />}
        {screen === "review" && <ReviewScreen state={claimsState} issue={claimsIssue} claims={claims} occurrenceCandidates={occurrenceCandidates} reviewSession={reviewSession} reviewClockNow={reviewClockNow} selected={selectedClaimIds} onBack={() => setScreen(simpleFlow ? "simple" : "project")} onRetry={() => void loadReviewQueue()} onOpen={(id) => void openClaim(id)} onToggle={(id) => setSelectedClaimIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} onBatch={() => void batchConfirm()} onOccurrenceVerdict={(candidate, action) => void runOccurrenceVerdict(candidate, action)} onOccurrenceConvert={(candidate, newClaims) => void runOccurrenceConversion(candidate, newClaims)} batchCount={selectedBatch.length} busy={busyAction} />}
        {screen === "claim" && <ClaimScreen key={`${selectedClaim?.id ?? "none"}-${selectedClaim?.versionId ?? "none"}`} projectId={project?.id ?? null} claim={selectedClaim} evidence={evidence} evidenceState={evidenceState} issue={claimsIssue} busy={busyAction} onBack={() => setScreen("review")} onVerdict={(action, reason, edit, retainRelationIds) => void runVerdict(action, reason, edit, retainRelationIds)} onBatchReviewAttest={() => void attestSelectedClaimForBatch()} onWithdraw={(reason) => void withdrawClaim(reason)} onCreateRelation={runManualRelation} />}
        {screen === "results" && <ResultsScreen project={project} events={events} tab={viewTab} data={viewData} state={viewState} issue={viewIssue} busy={busyAction} onBack={() => setScreen(simpleFlow ? "simple" : "project")} onSelect={(tab) => void loadView(tab)} onRetry={() => void loadView(viewTab)} onOpenClaim={(id) => void openClaim(id)} onResolveContradiction={(input) => void runContradictionResolution(input)} />}
        {screen === "run-debug" && <RunDebugScreen state={runDebugState} issue={runDebugIssue} debug={runDebug} onBack={() => setScreen("event")} onRetry={() => run && void openRunDebug(run.id)} />}
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
          await loadProject(created.id);
        } catch (error) { setProjectsIssue(toIssue(error)); } finally { setBusyAction(null); }
      }} busy={busyAction === "new-project"} />}
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
        flash(`已建立 ${created.length} 次沟通`);
        if (simpleFlow) {
          await loadSimpleProject(project.id, created[0]?.id);
        } else {
          await loadProject(project.id);
          if (created[0]) await loadEvent(created[0].id);
        }
      }} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
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
  event: Event | null;
  eventState: AsyncState;
  eventIssue: ApiIssue | null;
  run: ExtractionRun | null;
  transcriptionRun: TranscriptionRun | null;
  claims: Claim[];
  busy: string | null;
  projectWorkflow: ProjectWorkflowState;
  onUseProject: (id: string) => void;
  onUseEvent: (id: string) => void;
  onStartOwn: () => void;
  onAddTranscript: () => void;
  onAddFile: (file: File) => void;
  onProjectWorkflowAction: () => void;
  onRetryTranscription: (audioAssetId: string) => void;
  onConfirmScenario: (scenario: string, custom?: string) => Promise<void>;
  onReview: () => void;
  onResult: () => void;
};

function SimpleTestScreen({
  projects,
  projectsState,
  projectsIssue,
  project,
  projectState,
  projectIssue,
  events,
  event,
  eventState,
  eventIssue,
  run,
  transcriptionRun,
  claims,
  busy,
  projectWorkflow,
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
}: SimpleTestScreenProps) {
  const [showImportChoices, setShowImportChoices] = useState(false);
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [scenario, setScenario] = useState("");
  const [customScenario, setCustomScenario] = useState("");
  const sortedProjects = [...projects].sort((left, right) => {
    const leftSample = left.name.startsWith("[SYNTHETIC]") ? 0 : 1;
    const rightSample = right.name.startsWith("[SYNTHETIC]") ? 0 : 1;
    return leftSample - rightSample || left.name.localeCompare(right.name, "zh-CN");
  });
  const readyAssets = event?.assets.filter(assetIsAnalyzable) ?? [];
  const materialsReady = readyAssets.length > 0;
  const transcriptionRunning = Boolean(transcriptionRun && runInProgress.has(transcriptionRun.status));
  const transcriptionDone = transcriptionRun?.status === "succeeded";
  const transcriptionFailed = transcriptionRun?.status === "failed";
  const analysisRunning = Boolean(run && runInProgress.has(run.status));
  const analysisDone = Boolean(run && runComplete.has(run.status));
  const analysisFailed = Boolean(run && !analysisRunning && !analysisDone);
  const pendingCount = event
    ? event.pendingClaimCount + event.pendingOccurrenceCount
    : project
      ? project.pendingClaimCount + project.pendingOccurrenceCount
      : 0;
  const verifiedCount = claims.filter((claim) => claim.reviewStatus === "verified" && claim.lifecycle !== "withdrawn").length;
  const loadingSelection = projectState === "loading" || eventState === "loading";
  const issue = eventIssue ?? projectIssue ?? projectsIssue;
  const audioAssets = event?.assets.filter((asset) => asset.kind === "audio") ?? [];
  const retryAudioAsset = audioAssets.find((asset) => asset.id === transcriptionRun?.audioAssetId) ?? audioAssets[0];
  const issueRetry = issue?.code.includes("TRANSCRIPTION") && retryAudioAsset
    ? () => onRetryTranscription(retryAudioAsset.id)
    : project && (issue?.code === "EXTRACTION_POLL_TIMEOUT" || (analysisFailed && materialsReady))
      ? onProjectWorkflowAction
      : undefined;
  const needsScenario = project?.scenarioStatus === "pending_confirmation"
    || Boolean(project?.scenarioCandidates?.length && project.scenarioStatus !== "confirmed");
  const workflowPosition = projectWorkflow.currentPosition || Math.min(projectWorkflow.completed + 1, projectWorkflow.total);
  const workflowActionable = projectWorkflow.phase === "ready"
    || projectWorkflow.phase === "waiting_review"
    || projectWorkflow.phase === "empty_output"
    || projectWorkflow.phase === "error";
  const workflowActionLabels: Record<ProjectWorkflowState["phase"], string> = {
    idle: "正在准备整组材料",
    loading: "正在检查整组材料",
    empty: "请先导入材料",
    waiting_material: "等待当前材料准备完成",
    ready: projectWorkflow.completed > 0 ? "继续处理下一次沟通" : "开始处理全部沟通",
    running: "正在处理，请稍候",
    empty_output: "重新处理这次沟通",
    waiting_scenario: "请先确认使用场景",
    waiting_review: "核对这次结果",
    complete: "整组处理已完成",
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
      title: projectWorkflow.completed > 0 ? "可以继续下一次沟通" : "一次入口，按顺序处理整组沟通",
      body: "每次处理一条沟通。处理完成后会停下来让你核对，确认过的内容才会带入下一次。",
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
      body: "请确认或不采纳本次生成的记录。待核对内容清空后，才能继续下一次沟通。",
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
  const workflowStepActionable = workflowActionable && workflowSelectedCurrent;
  const workflowStepComplete = projectWorkflow.completed > 0
    || projectWorkflow.phase === "waiting_scenario"
    || projectWorkflow.phase === "waiting_review"
    || projectWorkflow.phase === "complete";
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
    complete: "已完成",
    error: "重新检查",
  };
  const workflowStepTitle = projectWorkflow.currentEventId && !workflowSelectedCurrent
    ? "请先选择当前沟通"
    : workflowActionLabel;
  const workflowStepBody = projectWorkflow.currentEventId && !workflowSelectedCurrent
    ? `当前顺序应处理“${projectWorkflow.currentEventTitle || "前一次沟通"}”，这里不会越过它。`
    : currentWorkflowCopy.body;
  const workflowReviewReady = projectWorkflow.phase === "waiting_review" && workflowSelectedCurrent;
  const workflowReviewBody = projectWorkflow.currentEventId && !workflowSelectedCurrent
    ? `请先选择“${projectWorkflow.currentEventTitle || "当前沟通"}”。`
    : projectWorkflow.phase === "waiting_scenario"
      ? "先确认使用场景，再核对本次生成的记录。"
      : workflowReviewReady
        ? `${pendingCount} 条内容等你确认`
        : "当前沟通处理完成后才能核对。";

  function chooseSupportingFile(change: ChangeEvent<HTMLInputElement>) {
    const file = change.target.files?.[0];
    change.target.value = "";
    if (file) onAddFile(file);
  }

  return (
    <div className="page simple-page">
      <header className="simple-header">
        <span className="eyebrow">核心流程测试</span>
        <h1>用真实材料走完一次</h1>
        <p>选一组现成材料，或者上传自己的 Transcript、照片或录音。录音会先生成带说话人和时间点的逐字稿，再进入分析。</p>
      </header>

      <section className="simple-session" aria-label="测试材料">
        <div className="simple-session-copy">
          <strong>{project ? project.name.replace(/^\[SYNTHETIC\]\s*/, "") : "先选择测试材料"}</strong>
          <small>{event ? event.title : project ? "请选择其中一次记录" : "可以使用现成案例，也可以上传自己的材料"}</small>
        </div>
        <label>
          <span>整组材料</span>
          <select
            aria-label="选择整组测试材料"
            value={project?.id ?? ""}
            disabled={projectsState === "loading" || Boolean(busy)}
            onChange={(change) => onUseProject(change.target.value)}
          >
            <option value="" disabled>{projectsState === "loading" ? "正在读取…" : "请选择"}</option>
            {sortedProjects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name.startsWith("[SYNTHETIC]") ? `现成案例：${item.name.replace(/^\[SYNTHETIC\]\s*/, "")}` : item.name}
              </option>
            ))}
          </select>
        </label>
        {events.length > 0 && (
          <label>
            <span>这次要分析的记录</span>
            <select aria-label="选择要分析的记录" value={event?.id ?? ""} disabled={loadingSelection || Boolean(busy)} onChange={(change) => onUseEvent(change.target.value)}>
              {events.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
          </label>
        )}
      </section>

      {project && (
        <section className={`project-workflow-card ${projectWorkflow.phase}`} aria-label="整组沟通处理" aria-live="polite">
          <div className="project-workflow-copy">
            <span className="section-kicker">整组处理</span>
            <h2>{currentWorkflowCopy.title}</h2>
            <p>{currentWorkflowCopy.body}</p>
          </div>
          <div className="project-workflow-progress">
            <div><span>已完成</span><strong>{projectWorkflow.completed}/{projectWorkflow.total}</strong></div>
            <progress max={Math.max(projectWorkflow.total, 1)} value={projectWorkflow.completed} />
          </div>
          <button
            className="project-workflow-action"
            disabled={!workflowActionable || Boolean(busy)}
            onClick={onProjectWorkflowAction}
          >
            {busy === "project-workflow" ? "正在检查…" : workflowActionLabel}
          </button>
        </section>
      )}

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
          <label className="field"><span>需要时可改成更合适的名称</span><input value={customScenario} onChange={(change) => setCustomScenario(change.target.value)} placeholder="例如：房屋翻修项目" /></label>
          <button className="button primary" disabled={busy === "scenario" || (!scenario && !customScenario.trim())} onClick={() => void onConfirmScenario(scenario || "custom", customScenario.trim() || undefined)}>{busy === "scenario" ? "正在保存…" : "确认后继续"}</button>
        </section>
      )}

      <section className="simple-steps" aria-label="四步测试流程">
        <button className={`simple-step-button ${materialsReady ? "complete" : ""}`} onClick={() => setShowImportChoices((open) => !open)} aria-expanded={showImportChoices}>
          <span className="simple-step-number">1</span>
          <span className="simple-step-copy"><strong>导入材料</strong><small>{transcriptionRunning ? "正在把录音转成逐字稿" : materialsReady ? `${readyAssets.length} 份材料可以使用` : "加入 Transcript、照片或录音"}</small></span>
          <span className="simple-step-state">{transcriptionRunning ? "转写中" : materialsReady ? "已就绪" : "开始"}</span>
        </button>
        <button className={`simple-step-button ${workflowStepComplete ? "complete" : ""}`} disabled={!workflowStepActionable || Boolean(busy)} onClick={onProjectWorkflowAction}>
          <span className="simple-step-number">2</span>
          <span className="simple-step-copy"><strong>{workflowStepTitle}</strong><small>{workflowStepBody}</small></span>
          <span className="simple-step-state">{workflowSelectedCurrent || !projectWorkflow.currentEventId ? workflowStepStateLabels[projectWorkflow.phase] : "顺序锁定"}</span>
        </button>
        <button className={`simple-step-button ${verifiedCount > 0 ? "complete" : ""}`} disabled={!workflowReviewReady || Boolean(busy)} onClick={onReview}>
          <span className="simple-step-number">3</span>
          <span className="simple-step-copy"><strong>核对证据</strong><small>{workflowReviewBody}</small></span>
          <span className="simple-step-state">{workflowReviewReady ? "核对" : projectWorkflow.phase === "waiting_scenario" ? "等待场景" : verifiedCount > 0 ? `已确认 ${verifiedCount}` : "等待"}</span>
        </button>
        <button className="simple-step-button" disabled={!analysisDone || Boolean(busy)} onClick={onResult}>
          <span className="simple-step-number">4</span>
          <span className="simple-step-copy"><strong>查看报告</strong><small>{verifiedCount > 0 ? "查看已经确认的内容" : analysisDone ? "未确认的内容不会进入报告" : "完成前三步后查看结果"}</small></span>
          <span className="simple-step-state">查看</span>
        </button>
      </section>

      {showImportChoices && (
        <section className="simple-import-panel" aria-label="添加材料">
          <div>
            <h2>添加自己的材料</h2>
            <p>{project ? "Transcript 会建立一条新记录。照片和录音会加到当前记录，录音完成转写后自动成为可分析材料。" : "可以直接上传录音或照片，系统会自动建立测试和第一条记录。"}</p>
          </div>
          <div className="simple-import-actions">
            <button className="simple-import-action" disabled={Boolean(busy)} onClick={onAddTranscript}><span>TXT</span><strong>上传 Transcript</strong><small>TXT、VTT、SRT 或 JSON</small></button>
            <label className={`simple-import-action ${busy ? "disabled" : ""}`}><span>AUD</span><strong>上传录音</strong><small>{event ? "自动区分说话人并保留时间点" : project ? "会自动建立第一条沟通记录" : "会自动建立测试和第一条沟通记录"}</small><input type="file" accept={AUDIO_FILE_ACCEPT} disabled={Boolean(busy)} onChange={chooseSupportingFile} /></label>
            <label className={`simple-import-action ${busy ? "disabled" : ""}`}><span>IMG</span><strong>添加照片</strong><small>{event ? `加入“${event.title}” · 支持 JPG、PNG、WebP` : project ? "会自动建立第一条沟通记录" : "会自动建立测试和第一条沟通记录"}</small><input type="file" accept={MODEL_IMAGE_FILE_ACCEPT} disabled={Boolean(busy)} onChange={chooseSupportingFile} /></label>
            <button className="simple-import-action quiet-choice" disabled={Boolean(busy)} onClick={onStartOwn}><span>NEW</span><strong>新建一次测试</strong><small>使用一组新的材料</small></button>
          </div>
          {event && event.assets.length > 0 && (
            <div className="simple-material-list">
              {event.assets.map((asset) => {
                const assetRun = asset.kind === "audio" && transcriptionRun?.audioAssetId === asset.id ? transcriptionRun : null;
                const storedTranscriptionStatus = stringValue(asset.metadata.transcription_status);
                const canRetryTranscription = asset.kind === "audio" && assetRun?.status !== "succeeded" && storedTranscriptionStatus !== "succeeded";
                return <span key={asset.id}><b>{asset.filename}</b><StatusBadge value={assetRun?.status || storedTranscriptionStatus || asset.status} />{canRetryTranscription && <button className="text-button" disabled={Boolean(busy)} onClick={() => onRetryTranscription(asset.id)}>{assetRun && runInProgress.has(assetRun.status) ? "重新检查" : assetRun?.status === "failed" ? "重新转写" : "生成逐字稿"}</button>}</span>;
              })}
            </div>
          )}
          {transcriptionRun && <section className={`transcription-progress ${transcriptionFailed ? "failed" : ""}`}>
            <div><span className="file-kind">AUD</span><span><strong>{transcriptionRunning ? "正在识别说话人和时间点" : transcriptionDone ? "录音逐字稿已经生成" : "录音转写没有完成"}</strong><small>{transcriptionDone ? `${transcriptionRun.segmentCount ?? transcriptionRun.segments.length} 个片段${transcriptionRun.durationMs ? ` · ${formatTimestamp(transcriptionRun.durationMs / 1000)}` : ""}` : transcriptionRun.errorCode || statusLabel(transcriptionRun.status)}</small></span></div>
            {transcriptionDone && transcriptionRun.segments.length > 0 && <><div className="transcript-preview">{transcriptionRun.segments.slice(0, 5).map((segment) => <p key={segment.id}><time>{formatTimestamp(segment.startMs / 1000)}</time><b>{segment.speaker}</b><span>{segment.text}</span></p>)}</div><button className="text-button transcript-open" onClick={() => setShowFullTranscript(true)}>查看完整逐字稿（{transcriptionRun.segments.length} 段）</button></>}
            {transcriptionFailed && <button className="button secondary" disabled={Boolean(busy)} onClick={() => onRetryTranscription(transcriptionRun.audioAssetId)}>{busy === "transcription" ? "正在重试…" : "重新转写"}</button>}
          </section>}
        </section>
      )}

      {loadingSelection && <LoadingBlock label="正在读取材料…" />}
      {issue && <ErrorNotice issue={issue} onRetry={issueRetry} />}
      {!project && projectsState === "empty" && <p className="simple-footnote">还没有可选材料。点击“导入材料”后再选择“新建一次测试”。</p>}
      {run && !analysisRunning && !analysisDone && <div className="simple-recovery"><p>最近一次分析状态：{statusLabel(run.status)}。{run.errorMessage ? ` ${run.errorMessage}` : "材料没有丢失，可以按整组顺序重新处理。"}</p><button className="button secondary" disabled={!workflowStepActionable || Boolean(busy)} onClick={onProjectWorkflowAction}>{busy === "project-workflow" ? "正在检查…" : workflowSelectedCurrent ? "重新处理当前沟通" : "请先选择当前沟通"}</button></div>}
      {showFullTranscript && transcriptionRun && <TranscriptViewer run={transcriptionRun} onClose={() => setShowFullTranscript(false)} />}
    </div>
  );
}

function PageHeader({ eyebrow, title, body, back, actions }: { eyebrow?: string; title: string; body?: string; back?: () => void; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-title-row">
        {back && <button className="back-button" onClick={back} aria-label="返回">‹</button>}
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
  if (state === "error" || !project) return <div className="page"><PageHeader title="Project" back={onBack} />{issue && <ErrorNotice issue={issue} onRetry={onRetry} />}</div>;
  const pendingReviewCount = project.pendingClaimCount + project.pendingOccurrenceCount;
  const needsScenario = project.scenarioStatus === "pending_confirmation" || Boolean(project.scenarioCandidates?.length && project.scenarioStatus !== "confirmed");
  return (
    <div className="page">
      <PageHeader eyebrow="Project" title={project.name} body={`${events.length} 次沟通 · ${statusLabel(project.scenarioStatus)}`} back={onBack} actions={<><button className="button secondary" onClick={onNewEvent}>新增沟通</button><button className="button primary" onClick={onImport}>导入 Transcript</button></>} />
      {issue && <ErrorNotice issue={issue} onRetry={onRetry} compact />}
      {needsScenario && <section className="scenario-panel">
        <div><span className="section-kicker">需要你确认</span><h2>这组材料属于哪种工作场景？</h2><p>场景只在第一份材料后确认一次。后续沟通会沿用，不会重复猜。</p></div>
        <div className="scenario-options">{project.scenarioCandidates?.map((item) => <label className={scenario === item.key ? "selected" : ""} key={item.key}><input type="radio" name="scenario" value={item.key} checked={scenario === item.key} onChange={() => setScenario(item.key)} /><span><strong>{item.label}</strong><small>{confidenceText(item.confidence)}{item.description ? ` · ${item.description}` : ""}</small></span></label>)}</div>
        <label className="field"><span>需要时可改成更合适的名称</span><input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="例如：顾问项目跟进" /></label>
        <button className="button primary" disabled={busy || (!scenario && !custom.trim())} onClick={() => void onConfirmScenario(scenario || "custom", custom.trim() || undefined)}>{busy ? "正在保存…" : "确认使用场景"}</button>
      </section>}
      {project.scenarioStatus === "confirmed" && <section className="project-status-row"><div><span className="section-kicker">已确认使用场景</span><strong>{project.scenario?.label || project.scenario?.key || "已确认"}</strong></div><button className="button secondary" onClick={() => onResults("folder-summary")}>打开当前结果</button></section>}
      <div className="project-overview-grid">
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

function EventScreen({ state, issue, event, run, transcriptionRun, claims, claimsState, claimsIssue, onBack, onRetry, onStart, onReview, onDebug, onOpenClaim, onAttach, onRetryTranscription, onRetryRunStatus, busy }: { state: AsyncState; issue: ApiIssue | null; event: Event | null; run: ExtractionRun | null; transcriptionRun: TranscriptionRun | null; claims: Claim[]; claimsState: AsyncState; claimsIssue: ApiIssue | null; onBack: () => void; onRetry: () => void; onStart: () => void; onReview: () => void; onDebug: () => void; onOpenClaim: (id: string) => void; onAttach: (input: { kind: string; filename: string; contentType: string; blob: Blob }) => Promise<void>; onRetryTranscription: (audioAssetId: string) => void; onRetryRunStatus: () => void; busy: string | null }) {
  const [paste, setPaste] = useState("");
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (state === "loading") return <div className="page"><LoadingBlock label="正在读取这次沟通…" /></div>;
  if (state === "error" || !event) return <div className="page"><PageHeader title="沟通记录" back={onBack} />{issue && <ErrorNotice issue={issue} onRetry={onRetry} />}</div>;
  const readyAssets = event.assets.filter(assetIsAnalyzable);
  const canStart = readyAssets.length > 0 && !runInProgress.has(run?.status ?? "");
  const audioAssets = event.assets.filter((asset) => asset.kind === "audio");
  const retryAudioAsset = audioAssets.find((asset) => asset.id === transcriptionRun?.audioAssetId) ?? audioAssets[0];
  const retryIssue = issue?.code.includes("TRANSCRIPTION") && retryAudioAsset
    ? () => onRetryTranscription(retryAudioAsset.id)
    : issue?.code === "EXTRACTION_POLL_TIMEOUT"
      ? onRetryRunStatus
      : onRetry;
  return (
    <div className="page">
      <PageHeader eyebrow={typeLabel(event.eventType)} title={event.title} body={formatDate(event.occurredAt, true)} back={onBack} actions={<>{canStart && <button className="button primary" disabled={busy === "extraction"} onClick={onStart}>{busy === "extraction" ? "正在提交…" : run ? "重新提取" : "开始提取"}</button>}{runComplete.has(run?.status ?? "") && <button className="button secondary" onClick={onReview}>审核结果</button>}</>} />
      {issue && <ErrorNotice issue={issue} onRetry={retryIssue} />}
      {run && <section className={`run-banner ${run.status === "failed" ? "failed" : ""}`}><div className="run-state-icon">{runInProgress.has(run.status) ? <span className="spinner" /> : runComplete.has(run.status) ? "✓" : "!"}</div><div><span className="section-kicker">本次处理</span><h2>{extractionProgressLabel(run)}</h2><p>{run.errorMessage || (runInProgress.has(run.status) ? extractionProgressBody(run) : run.status === "completed_with_warnings" ? "质量门仍有提醒，请在审核区重点核对事实与关系。" : run.status === "failed" ? "材料仍然保留，可以直接重新分析。" : "请核对事实与关系；只有人工确认的内容会进入正式结果。")}</p>{run.errorCode && <small>{run.errorCode}</small>}<div className="run-recovery-actions">{run.status === "failed" && <button className="button secondary" disabled={!canStart || Boolean(busy)} onClick={onStart}>{busy === "extraction" ? "正在提交…" : "重新分析"}</button>}{issue?.code === "EXTRACTION_POLL_TIMEOUT" && <button className="button secondary" disabled={Boolean(busy)} onClick={onRetryRunStatus}>{busy === "run-status" ? "正在检查…" : "重新检查后台状态"}</button>}<button className="text-button run-debug-link" onClick={onDebug}>查看本次运行详情</button></div></div></section>}
      <div className="event-workspace">
        <section className="panel source-panel">
          <div className="section-heading"><div><h2>本次材料</h2><p>录音会先转成带说话人和时间点的逐字稿，再参与提取。</p></div><button className="button secondary small" onClick={() => fileRef.current?.click()}>上传材料</button></div>
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
          {transcriptionRun && <section className={`transcription-progress compact ${transcriptionRun.status === "failed" ? "failed" : ""}`}><div><span className="file-kind">TXT</span><span><strong>{runInProgress.has(transcriptionRun.status) ? "正在生成逐字稿" : transcriptionRun.status === "succeeded" ? "带时间点逐字稿已就绪" : "录音转写失败"}</strong><small>{transcriptionRun.status === "succeeded" ? `${transcriptionRun.segmentCount ?? transcriptionRun.segments.length} 个说话片段` : transcriptionRun.errorCode || statusLabel(transcriptionRun.status)}</small></span></div>{transcriptionRun.segments.length > 0 && <><div className="transcript-preview">{transcriptionRun.segments.slice(0, 6).map((segment) => <p key={segment.id}><time>{formatTimestamp(segment.startMs / 1000)}</time><b>{segment.speaker}</b><span>{segment.text}</span></p>)}</div><button className="text-button transcript-open" onClick={() => setShowFullTranscript(true)}>查看完整逐字稿（{transcriptionRun.segments.length} 段）</button></>}{transcriptionRun.status === "failed" && <button className="button secondary" disabled={Boolean(busy)} onClick={() => onRetryTranscription(transcriptionRun.audioAssetId)}>{busy === "transcription" ? "正在重试…" : "重新转写"}</button>}</section>}
          <div className="paste-box"><label htmlFor="paste-transcript">粘贴 Transcript 或补充文字</label><textarea id="paste-transcript" value={paste} onChange={(change) => setPaste(change.target.value)} placeholder="粘贴原文。没有时间点也可以使用，证据页会明确写无法定位具体时间。" /><button className="button secondary" disabled={!paste.trim() || busy === "asset"} onClick={async () => { const blob = new Blob([paste], { type: "text/plain" }); await onAttach({ kind: "text", filename: "pasted-note.txt", contentType: "text/plain", blob }); setPaste(""); }}>{busy === "asset" ? "正在保存…" : "加入这次沟通"}</button></div>
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
  if (state === "loading") return <div className="page narrow-page"><PageHeader eyebrow="内部页" title="本次运行详情" back={onBack} /><LoadingBlock label="正在读取服务器中的运行记录…" /></div>;
  if (state === "error" || !debug) return <div className="page narrow-page"><PageHeader eyebrow="内部页" title="本次运行详情" back={onBack} />{issue ? <ErrorNotice issue={issue} onRetry={onRetry} /> : <EmptyState title="没有运行详情" body="服务器没有返回这次运行的数据。" />}</div>;
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
  const validatedOutput = data.validated_output;
  const hasValidatedOutput = validatedOutput !== null && validatedOutput !== undefined;
  const rawJson = JSON.stringify(redactDebugValue(data), null, 2);
  return (
    <div className="page debug-page">
      <PageHeader eyebrow="内部页" title="本次运行详情" body="用于核对模型、输入、验证结果和成本。这里不影响正式结果。" back={onBack} actions={<StatusBadge value={stringValue(data.status)} />} />
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

function ReviewScreen({ state, issue, claims, occurrenceCandidates, reviewSession, reviewClockNow, selected, onBack, onRetry, onOpen, onToggle, onBatch, onOccurrenceVerdict, onOccurrenceConvert, batchCount, busy }: { state: AsyncState; issue: ApiIssue | null; claims: Claim[]; occurrenceCandidates: OccurrenceCandidate[]; reviewSession: ReviewSession | null; reviewClockNow: number; selected: Set<string>; onBack: () => void; onRetry: () => void; onOpen: (id: string) => void; onToggle: (id: string) => void; onBatch: () => void; onOccurrenceVerdict: (candidate: OccurrenceCandidate, action: "confirm" | "reject") => void; onOccurrenceConvert: (candidate: OccurrenceCandidate, claims: OccurrenceNewClaim[]) => void; batchCount: number; busy: string | null }) {
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
      <PageHeader eyebrow="Review Queue" title="审核候选记录" body="逐条核对陈述和证据。打开一条记录并明确标记已核对后，才能把它加入批量确认。" back={onBack} actions={batchCount > 0 && <button className="button primary" disabled={Boolean(busy)} onClick={onBatch}>{busy === "batch" ? "正在确认…" : `确认所选 ${batchCount} 条`}</button>} />
      {issue && <ErrorNotice issue={issue} onRetry={onRetry} />}
      {reviewSession && <section className={`review-timing ${reviewSession.status}`}><div><span className="section-kicker">真实审核计时</span><strong>{reviewSession.status === "active" ? "正在计时" : reviewSession.status === "completed" ? "本次审核已完成" : "本次计时已结束"}</strong><p>{reviewSession.status === "active" ? `开始时 ${initialCount} 条，目前还剩 ${remainingCount} 条。刷新或关闭页面不会重置。` : `本次共处理 ${initialCount} 条，结果已由服务器保存。`}</p></div><time>{formatReviewDuration(elapsedMs)}</time>{reviewSession.status === "completed" && <span className={elapsedMs <= 120000 ? "timing-pass" : "timing-over"}>{elapsedMs <= 120000 ? "达到两分钟目标" : "超过两分钟目标"}</span>}</section>}
      <div className="filter-tabs"><button className={filter === "pending" ? "active" : ""} onClick={() => setFilter("pending")}>待审核</button><button className={filter === "reviewed" ? "active" : ""} onClick={() => setFilter("reviewed")}>已处理</button><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button></div>
      {state === "loading" && <LoadingBlock label="正在整理审核队列…" />}
      {(state === "empty" || (state === "ready" && !visible.length && !visibleOccurrences.length)) && <EmptyState title={filter === "pending" ? "目前没有待审核记录" : "这个筛选下没有记录"} body={claims.length || occurrenceCandidates.length ? "所有候选都已处理。" : "完成一次提取后，候选记录才会出现在这里。系统不会显示示例内容。"} />}
      {visible.length > 0 && <div className="review-list">{visible.map((claim) => {
        const hasProposedRelations = claim.relationsForReview.some((relation) => relation.status === "proposed");
        const batchEligible = claim.reviewStatus === "pending" && claim.batchReviewAttested && !hasProposedRelations;
        return <article key={claim.id} className="review-card"><label className="claim-select" title={hasProposedRelations ? "包含待核对关系，请逐条处理" : claim.batchReviewAttested ? "加入批量确认" : "请先打开并核对证据"}><input type="checkbox" disabled={!batchEligible} checked={selected.has(claim.id) && batchEligible} onChange={() => onToggle(claim.id)} aria-label={`选择 ${claim.statement}`} /></label><button className="review-card-main" onClick={() => onOpen(claim.id)}><div className="review-card-top"><span className="eyebrow">{typeLabel(claim.type)}</span><StatusBadge value={claim.lifecycle === "withdrawn" ? "withdrawn" : claim.reviewStatus} /></div><h2>{claim.statement || "这条记录没有可显示的陈述"}</h2><div className="claim-meta"><span>{claim.eventTitle || "来源沟通"}</span><span>{confidenceText(claim.confidence)}</span><span>{claim.evidenceCount ?? claim.evidenceRefIds.length} 条证据</span>{hasProposedRelations && <span>{claim.relationsForReview.filter((relation) => relation.status === "proposed").length} 条关系待核对</span>}</div><UncertaintyNotice value={claim.uncertainty} compact /><EvidenceRequirementNotice claim={claim} compact /><span className="review-evidence-link">{claim.reviewStatus !== "pending" ? "查看证据和处理记录 ›" : hasProposedRelations ? "打开并逐条核对事实与关系 ›" : claim.batchReviewAttested ? "证据已核对，可批量选择 ›" : "打开并核对证据后才能批量选择 ›"}</span></button></article>;
      })}</div>}
      {visibleOccurrences.length > 0 && <section className="occurrence-review-section"><div className="section-heading"><div><span className="section-kicker">再次出现</span><h2>这次说的内容可能已经记录过</h2><p>如果只是重复旧内容，可以把新证据附到原记录。如果里面有新变化，可以拆成新的待审核记录。</p></div></div><div className="occurrence-list">{visibleOccurrences.map((candidate) => <OccurrenceReviewCard key={candidate.id} candidate={candidate} busy={busy} onOpen={onOpen} onVerdict={onOccurrenceVerdict} onConvert={onOccurrenceConvert} />)}</div></section>}
    </div>
  );
}

function EvidenceCard({ evidence }: { evidence: EvidenceRef }) {
  const audioStart = typeof evidence.timestampStart === "number"
    ? evidence.timestampStart
    : undefined;
  const audioEnd = typeof evidence.timestampEnd === "number"
    ? evidence.timestampEnd
    : undefined;
  const audioSource = evidence.audioUrl
    ? `${evidence.audioUrl}${audioStart == null ? "" : `#t=${Math.max(0, audioStart)},${audioEnd == null ? "" : Math.max(audioStart, audioEnd)}`}`
    : undefined;
  return (
    <article className="evidence-card">
      <div className="evidence-card-head"><span className="file-kind">{audioSource ? "AUD" : evidence.kind.toLowerCase().includes("photo") || evidence.imageUrl ? "IMG" : evidence.kind.toLowerCase().includes("pdf") ? "PDF" : "TXT"}</span><span><strong>{evidence.filename || typeLabel(evidence.kind)}</strong><small>{evidence.role ? `${evidence.role} evidence · ` : ""}{formatTimestamp(evidence.timestampStart)}{evidence.page ? ` · 第 ${evidence.page} 页` : ""}</small></span></div>
      {/* Evidence URLs can be short-lived signed URLs and cannot use the build-time image loader. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {evidence.imageUrl && <img src={evidence.imageUrl} alt={evidence.caption || "原始图片证据"} />}
      {audioSource && <div className="evidence-audio"><audio controls preload="metadata" src={audioSource} /><small>播放会从这句原文附近开始。逐字稿和时间点由服务器保存，可随时回到原录音核对。</small></div>}
      {evidence.viewUrl && !evidence.imageUrl && <a className="evidence-open" href={evidence.viewUrl} target="_blank" rel="noreferrer">打开原始文件</a>}
      {evidence.quote && <blockquote>“{evidence.quote}”</blockquote>}
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

function ClaimScreen({ projectId, claim, evidence, evidenceState, issue, busy, onBack, onVerdict, onBatchReviewAttest, onWithdraw, onCreateRelation }: { projectId: string | null; claim: Claim | null; evidence: EvidenceRef[]; evidenceState: AsyncState; issue: ApiIssue | null; busy: string | null; onBack: () => void; onVerdict: (action: "confirm" | "reject" | "edit", reason?: string, edit?: ClaimEditSubmission, retainRelationIds?: string[]) => void; onBatchReviewAttest: () => void; onWithdraw: (reason: string) => void; onCreateRelation: (input: ManualRelationSubmission) => Promise<void> }) {
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
  if (!claim) return <div className="page narrow-page"><PageHeader title="记录" back={onBack} /><EmptyState title="没有找到这条记录" body="它可能已经更新。返回审核区重新打开。" /></div>;
  const pending = claim.reviewStatus === "pending";
  const verified = claim.reviewStatus === "verified" && claim.lifecycle !== "withdrawn";
  const activeRelations = claim.relationsForReview.filter((relation) => relation.status === "active");
  const proposedRelations = claim.relationsForReview.filter((relation) => relation.status === "proposed");
  const relationsReviewed = proposedRelations.every((relation) => Boolean(relationDecisions[relation.id]));
  const acceptedRelationIds = proposedRelations
    .filter((relation) => relationDecisions[relation.id] === "accept")
    .map((relation) => relation.id);
  const evidenceReady = evidenceState === "ready";
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
    <div className="page narrow-page">
      <PageHeader eyebrow={typeLabel(claim.type)} title={claim.statement || "无陈述"} body={`${claim.eventTitle || "来源沟通"} · ${confidenceText(claim.confidence)}`} back={onBack} actions={<StatusBadge value={claim.lifecycle === "withdrawn" ? "withdrawn" : claim.reviewStatus} />} />
      {issue && <ErrorNotice issue={issue} compact />}
      <div className="claim-layout">
        <section className="evidence-column"><div className="section-heading"><div><h2>原始证据</h2><p>确认前，请检查原文是否真的支持这条陈述。</p></div></div>{evidenceState === "loading" && <LoadingBlock label="正在定位证据…" />}{evidenceState === "empty" && <EmptyState title="没有可核对的证据" body="这条候选不应被确认。请拒绝，或等待后端补全证据。" />}{evidenceState === "error" && <EmptyState title="证据未完整加载" body={`系统应完整返回 ${claim.evidenceRefIds.length} 条当前版本证据，实际收到 ${evidence.length} 条或存在请求失败。下面仅显示已经收到的材料，确认、核对声明和修改功能已停用。请返回后重新打开再试。`} />}{evidence.map((item) => <EvidenceCard key={item.id} evidence={item} />)}</section>
        <aside className="panel verdict-panel"><h2>{edit && verified ? "修改已确认记录" : pending ? "你的决定" : verified ? "已确认记录" : "处理记录"}</h2><UncertaintyNotice value={claim.uncertainty} /><EvidenceRequirementNotice claim={claim} />{(pending || (verified && edit)) && <>
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
            <button className="button primary full" disabled={Boolean(busy) || !evidenceReady || !relationsReviewed} onClick={() => onVerdict("confirm", reason.trim(), undefined, acceptedRelationIds)}>确认并加入正式结果</button>
            <button className="button secondary full" disabled={Boolean(busy) || !evidenceReady} onClick={() => setEdit(true)}>修改后确认</button>
            <div className="batch-review-attestation"><strong>需要一次批量处理多条？</strong>{proposedRelations.length > 0 ? <p>这条记录包含关系判断，不能批量确认。请在上方逐条接受或拒绝。</p> : <><p>请先核对上方原始证据。点击下面的按钮会留下本次核对记录，但不会确认这条内容。</p>{claim.batchReviewAttested ? <span className="review-attested-state">本版本的证据已核对，可以返回列表批量选择。</span> : <button className="button secondary full" disabled={Boolean(busy) || !evidenceReady} onClick={onBatchReviewAttest}>{busy === "evidence-review-attestation" ? "正在记录…" : "我已核对证据，返回列表"}</button>}</>}</div>
            <label className="field"><span>拒绝原因，可选</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
            <button className="button quiet danger-text" disabled={Boolean(busy)} onClick={() => onVerdict("reject", reason.trim())}>不采纳这条记录</button>
          </div>}
        </>}{verified && !edit && <><div className="withdraw-box"><p>这条记录现在参与事项概况和后续沟通上下文。内容需要修正时建立新版本；只有整条记录不再有效时才撤回。</p><button className="button secondary full" disabled={Boolean(busy) || !evidenceReady} onClick={() => setEdit(true)}>修改已确认记录</button><label className="field"><span>撤回原因</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明为什么这条已确认记录需要退出当前结果" /></label><button className="button secondary danger-text full" disabled={busy === "withdraw" || !reason.trim()} onClick={() => onWithdraw(reason.trim())}>{busy === "withdraw" ? "正在撤回…" : "撤回已确认记录"}</button></div><div className="manual-relation-box"><strong>这条记录补充或改变了旧记录？</strong><p>当系统漏掉两条已确认记录之间的关系时，可以在这里补上。旧内容会继续保留在时间线中。</p>{activeRelations.length > 0 && <div className="active-relation-list"><span>已经生效</span>{activeRelations.map((relation) => <article key={relation.id}><b>{relationReviewLabel(relation.type)}</b><p>{relation.targetStatement}</p>{relation.reason && <small>{relation.reason}</small>}</article>)}</div>}{!relationOpen ? <button className="button secondary full" disabled={Boolean(busy) || !projectId} onClick={() => void openRelationForm()}>{activeRelations.length > 0 ? "再关联一条旧记录" : "关联旧记录"}</button> : <div className="manual-relation-form">{relationIssue && <ErrorNotice issue={relationIssue} compact />}{relationTargetsState === "loading" && <LoadingBlock label="正在读取当前记录…" />}{relationTargetsState === "error" && <button className="button secondary full" onClick={() => { setRelationTargetsState("idle"); void openRelationForm(); }}>重新读取</button>}{relationTargetsState === "empty" && <p className="muted">当前没有其他可关联的已确认记录。</p>}{(relationTargetsState === "ready" || relationTargetsState === "empty") && <><label className="field"><span>关系</span><select value={relationType} onChange={(event) => { setRelationType(event.target.value as RelationType); setRelationTargetVersionId(""); }}><option value="resolves">这条新记录解决了旧问题或风险</option><option value="supersedes">这条新记录取代了旧记录</option><option value="informed_by">这条新记录参考了旧记录</option><option value="contradicts">两条记录互相冲突，仍需处理</option></select></label><label className="field"><span>旧记录</span><select value={relationTargetVersionId} onChange={(event) => setRelationTargetVersionId(event.target.value)}><option value="">请选择一条当前有效记录</option>{eligibleRelationTargets.map((target) => <option value={target.claim_version_id} key={target.claim_version_id}>{target.event_title} · {typeLabel(target.type)} · {target.statement}</option>)}</select></label>{relationType === "resolves" && eligibleRelationTargets.length === 0 && <p className="muted">当前没有可以关闭的待确认问题、风险或前置条件。</p>}<label className="field"><span>判断依据</span><textarea value={relationReason} onChange={(event) => setRelationReason(event.target.value)} placeholder="说明为什么这两条记录存在这个关系" /></label><div className="button-row"><button className="button secondary" onClick={() => setRelationOpen(false)}>取消</button><button className="button primary" disabled={busy === "manual-relation" || !selectedRelationTarget || relationReason.trim().length < 3} onClick={() => void submitManualRelation()}>{busy === "manual-relation" ? "正在保存…" : "保存关系"}</button></div></>}</div>}</div></>}{claim.lifecycle === "withdrawn" && <p className="muted">这条记录已经退出当前结果和后续上下文，仍保留在历史时间线中。</p>}</aside>
      </div>
    </div>
  );
}

function ResultsScreen({ project, events, tab, data, state, issue, busy, onBack, onSelect, onRetry, onOpenClaim, onResolveContradiction }: { project: Project | null; events: Event[]; tab: ResultTab; data: unknown; state: AsyncState; issue: ApiIssue | null; busy: string | null; onBack: () => void; onSelect: (tab: ResultTab) => void; onRetry: () => void; onOpenClaim: (id: string) => void; onResolveContradiction: (input: ContradictionResolutionInput) => void }) {
  const current = resultTabs.find((item) => item.key === tab)!;
  const pendingReviewCount = (project?.pendingClaimCount ?? 0) + (project?.pendingOccurrenceCount ?? 0);
  const showPendingReviewCount = pendingReviewCount > 0 && (tab === "folder-summary" || tab === "timeline");
  return (
    <div className="page results-page">
      <PageHeader eyebrow={project?.name} title="已确认结果" body="这些页面只读取已确认且仍有效的记录。撤回内容只保留在历史时间线。" back={onBack} />
      {showPendingReviewCount && <p className="pending-review-note">还有 {pendingReviewCount} 条待核对。它们仍在审核区，没有进入下面的已确认结果。</p>}
      <div className="result-layout"><aside className="result-nav">{resultTabs.map((item) => <button className={item.key === tab ? "active" : ""} key={item.key} onClick={() => onSelect(item.key)}><span>{item.short.slice(0, 1)}</span>{item.label}<b>›</b></button>)}</aside><section className="result-content"><div className="section-heading"><div><span className="section-kicker">Verified only</span><h2>{current.label}</h2></div>{isRecord(data) && stringValue(data.generated_at) && <small>生成于 {formatDate(stringValue(data.generated_at), true)}</small>}</div>{issue && state !== "error" && <ErrorNotice issue={issue} onRetry={onRetry} compact />}{busy === "open-claim" && <LoadingBlock label="正在读取记录…" />}{state === "loading" && <LoadingBlock label={`正在生成${current.label}…`} />}{state === "error" && issue && <ErrorNotice issue={issue} onRetry={onRetry} />}{state === "empty" && <ResultContent tab={tab} data={data} events={events} onOpenClaim={onOpenClaim} onSelect={onSelect} onResolveContradiction={onResolveContradiction} busyAction={busy} />}{state === "ready" && <ResultContent tab={tab} data={data} events={events} onOpenClaim={onOpenClaim} onSelect={onSelect} onResolveContradiction={onResolveContradiction} busyAction={busy} />}</section></div>
    </div>
  );
}

function NewProjectModal({ onClose, onCreate, busy }: { onClose: () => void; onCreate: (name: string) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState("");
  return <Modal title="新建 Project" description="名称只用来帮助你认出这件事，使用场景会在第一份材料后确认。" onClose={onClose}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onCreate(name.trim()); }}><label className="field"><span>Project 名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：秋季产品研究" /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!name.trim() || busy}>{busy ? "正在创建…" : "创建"}</button></div></form></Modal>;
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
