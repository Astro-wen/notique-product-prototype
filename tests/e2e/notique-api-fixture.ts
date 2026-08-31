import { expect, type Page, type Route } from "@playwright/test";

type MutationRecord = {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
};

type ReadRecord = {
  method: "GET";
  path: string;
};

type FixtureAction = {
  claim_id: string;
  claim_version_id: string;
  statement: string;
  owner: string | null;
  due_at: string | null;
  event_id: string;
  event_title: string;
  review_status: "pending" | "verified" | "rejected";
  status: "ai_suggested" | "confirmed" | "completed" | "not_adopted";
  evidence_ref_ids: string[];
  completed_by_claim_id: string | null;
};

const requestId = "playwright-v19-local-fixture";
const now = "2026-08-15T16:00:00.000Z";

function envelope(data: unknown) {
  return { data, request_id: requestId };
}

function projectRecord(
  id: string,
  name: string,
  options: {
    eventCount?: number;
    pendingClaimCount?: number;
    deletedAt?: string | null;
  } = {},
) {
  return {
    id,
    workspace_id: "workspace-playwright",
    name,
    scenario: "real_estate_buyer_journey",
    scenario_status: "confirmed",
    scenario_candidates: [],
    scenario_version: 1,
    locale: "zh-CN",
    ledger_version: 4,
    context_version: 8,
    event_count: options.eventCount ?? 1,
    pending_claim_count: options.pendingClaimCount ?? 0,
    pending_occurrence_count: 0,
    deleted_at: options.deletedAt ?? null,
    created_at: "2026-08-15T10:00:00.000Z",
    updated_at: now,
  };
}

function eventRecord(
  id: string,
  projectId: string,
  title: string,
  activeRunId: string | null,
  pendingClaimCount = 0,
) {
  return {
    id,
    project_id: projectId,
    event_type: "meeting",
    title,
    occurred_at: "2026-08-15T11:00:00.000Z",
    sequence_no: 1,
    material_status: "ready",
    active_run_id: activeRunId,
    pending_claim_count: pendingClaimCount,
    pending_occurrence_count: 0,
    metadata: {},
    created_at: "2026-08-15T11:00:00.000Z",
    updated_at: now,
  };
}

function assetRecord(id: string, projectId: string, eventId: string) {
  return {
    id,
    project_id: projectId,
    event_id: eventId,
    kind: "transcript",
    filename: `${eventId}.txt`,
    current_version_id: `${id}-version-1`,
    processing_status: "ready",
    captured_at: null,
    metadata: {},
    version: {
      id: `${id}-version-1`,
      asset_id: id,
      version_no: 1,
      content_sha256: "0".repeat(64),
      mime_type: "text/plain",
      size_bytes: 1024,
      parser_version: "playwright",
      r2_original_key: `fixture/${id}`,
      r2_model_key: null,
      derived_from_asset_version_id: null,
      transform: null,
      finalized_at: now,
    },
    created_at: "2026-08-15T11:00:00.000Z",
    updated_at: now,
  };
}

function audioAssetRecord(id: string, projectId: string, eventId: string) {
  return {
    ...assetRecord(id, projectId, eventId),
    kind: "audio",
    filename: "buyer-interview.m4a",
    processing_status: "processing",
    metadata: {
      transcription_run_id: "transcription-a",
      transcription_status: "processing",
    },
    version: {
      ...assetRecord(id, projectId, eventId).version,
      mime_type: "audio/mp4",
      size_bytes: 32_500_000,
    },
  };
}

function progressTranscriptSegments() {
  return [
    { id: "speaker-seg-a", ordinal: 0, speaker: "A", start_ms: 0, end_ms: 1_000, text: "Opening." },
    { id: "speaker-seg-b", ordinal: 1, speaker: "B", start_ms: 1_000, end_ms: 2_000, text: "Reply." },
    { id: "speaker-seg-c", ordinal: 2, speaker: "C", start_ms: 2_000, end_ms: 3_000, text: "Follow-up." },
  ];
}

function chunkedTranscriptionRun(completed = false) {
  const now = new Date().toISOString();
  return {
    id: "transcription-a",
    event_id: "event-a",
    audio_asset_id: "audio-event-a",
    status: completed ? "succeeded" : "processing",
    model: "gpt-4o-transcribe-diarize",
    orchestration_mode: "chunked",
    chunk_count: 10,
    completed_chunk_count: completed ? 10 : 4,
    derived_transcript_asset_id: completed ? "transcript-event-a" : null,
    segment_count: completed ? 3 : null,
    duration_ms: completed ? 3_000 : null,
    created_at: new Date(Date.now() - 74_000).toISOString(),
    queued_at: new Date(Date.now() - 73_000).toISOString(),
    started_at: new Date(Date.now() - 72_000).toISOString(),
    finished_at: completed ? now : null,
    segments: completed ? progressTranscriptSegments() : [],
    chunks: Array.from({ length: 10 }, (_, index) => ({
      id: `transcription-a-chunk-${index}`,
      index,
      start_ms: index * 175_000,
      end_ms: (index + 1) * 180_000,
      status: completed || index < 4 ? "succeeded" : index < 7 ? "processing" : "queued",
      processing_attempt_no: completed || index < 7 ? 1 : 0,
      error_code: null,
    })),
  };
}

function extractionRun(id: string, projectId: string, eventId: string) {
  return {
    id,
    project_id: projectId,
    event_id: eventId,
    status: "succeeded",
    idempotency_key: `${id}-key`,
    input_hash: `${id}-hash`,
    context_version: 8,
    provider: "openai",
    model: "gpt-5.6-luna",
    prompt_version: "v9",
    schema_version: "v4",
    error_code: null,
    pipeline_stage: "verify",
    processing_attempt_no: 1,
    dispatch_attempt_no: 1,
    created_at: "2026-08-15T11:01:00.000Z",
    queued_at: "2026-08-15T11:01:00.000Z",
    first_queued_at: "2026-08-15T11:01:00.000Z",
    current_queued_at: "2026-08-15T11:01:00.000Z",
    started_at: "2026-08-15T11:01:02.000Z",
    first_started_at: "2026-08-15T11:01:02.000Z",
    current_started_at: "2026-08-15T11:01:02.000Z",
    finished_at: "2026-08-15T11:01:45.000Z",
    updated_at: "2026-08-15T11:01:45.000Z",
    stages: [],
  };
}

function processingExtractionRun(id: string, projectId: string, eventId: string) {
  return {
    ...extractionRun(id, projectId, eventId),
    status: "processing",
    pipeline_stage: "inventory",
    finished_at: null,
    updated_at: "2026-08-15T11:01:20.000Z",
  };
}

function freshProcessingExtractionRun(id: string, projectId: string, eventId: string) {
  const timestamp = new Date().toISOString();
  return {
    ...processingExtractionRun(id, projectId, eventId),
    created_at: timestamp,
    queued_at: timestamp,
    first_queued_at: timestamp,
    current_queued_at: timestamp,
    started_at: timestamp,
    first_started_at: timestamp,
    current_started_at: timestamp,
    updated_at: timestamp,
  };
}

function analysisProgressExtractionRun(id: string, projectId: string, eventId: string) {
  const nowMs = Date.now();
  const createdAt = new Date(nowMs - 31_000).toISOString();
  const startedAt = new Date(nowMs - 28_000).toISOString();
  const stageStartedAt = new Date(nowMs - 27_000).toISOString();
  return {
    ...processingExtractionRun(id, projectId, eventId),
    created_at: createdAt,
    queued_at: createdAt,
    first_queued_at: createdAt,
    current_queued_at: createdAt,
    started_at: startedAt,
    first_started_at: startedAt,
    current_started_at: startedAt,
    updated_at: new Date(nowMs).toISOString(),
    stages: [{
      stage: "inventory",
      status: "processing",
      attempt: 1,
      reasoning_effort: "xhigh",
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      started_at: stageStartedAt,
      finished_at: null,
      duration_ms: null,
    }],
  };
}

function evidenceRef(id: string, segmentId: string, eventId = "event-a") {
  return {
    id,
    kind: "transcript_quote",
    role: "direct",
    quote_raw: segmentId === "seg-summary-target"
      ? "预算上限是 120 万美元。"
      : "周五前发送三套房源。",
    speaker: "Buyer",
    start_ms: segmentId === "seg-summary-target" ? 48_000 : 72_000,
    end_ms: segmentId === "seg-summary-target" ? 53_000 : 77_000,
    filename: `${eventId}.txt`,
    asset_id: `asset-${eventId}`,
    event_id: eventId,
    segment_ids: [segmentId],
  };
}

function claimRecord(
  id: string,
  statement: string,
  type: string,
  reviewStatus: "pending" | "verified" | "rejected",
  segmentId: string,
) {
  const evidence = evidenceRef(`evidence-${id}`, segmentId);
  return {
    id,
    project_id: "project-a",
    event_id: "event-a",
    event_title: "A 初次沟通",
    extraction_run_id: "run-a",
    source: "ai",
    type,
    materiality: "high",
    confidence: 0.96,
    needs_additional_evidence: false,
    review_status: reviewStatus,
    lifecycle_status: "active",
    current_version: {
      id: `${id}-version-1`,
      version_no: 1,
      statement,
      normalized_value: null,
      uncertainty: null,
      source: "ai",
    },
    relations_for_review: [],
    evidence_ref_ids: [evidence.id],
    evidence_refs: [evidence],
    batch_review_attested: false,
    created_at: "2026-08-15T11:02:00.000Z",
    updated_at: now,
  };
}

function artifactRun(id: string, projectId: string, eventId: string, kind: "summary" | "readable_transcript") {
  return {
    id,
    project_id: projectId,
    event_id: eventId,
    extraction_run_id: projectId === "project-a" ? "run-a" : "run-b-old",
    kind,
    status: "succeeded",
    provider: "openai",
    model: "gpt-5.6-luna",
    reasoning_effort: "high",
    prompt_version: "v1",
    schema_version: "v1",
    attempt_no: 1,
    provider_request_id: `response-${id}`,
    input_tokens: 100,
    output_tokens: 100,
    cached_tokens: 0,
    error_code: null,
    queued_at: "2026-08-15T11:01:00.000Z",
    started_at: "2026-08-15T11:01:02.000Z",
    finished_at: "2026-08-15T11:01:20.000Z",
    created_at: "2026-08-15T11:01:00.000Z",
    updated_at: "2026-08-15T11:01:20.000Z",
  };
}

function summaryArtifact(projectId: string, eventId: string) {
  const isProjectA = projectId === "project-a";
  const fillerItems = Array.from({ length: isProjectA ? 24 : 2 }, (_, index) => ({
    item_key: `filler-${index}`,
    text: `${isProjectA ? "A" : "B"} 摘要背景 ${index + 1}`,
    support_quote: `背景原文 ${index + 1}`,
    source_segment_ids: [`seg-${eventId}-filler-${index}`],
  }));
  const targetItem = {
    item_key: "summary-target",
    text: isProjectA ? "预算上限是 120 万美元" : "B 项目只确认学区范围",
    support_quote: isProjectA ? "预算上限是 120 万美元。" : "只看北区学区。",
    // This intentionally reuses A's Segment ID. If A's delayed Claim leaks into
    // B state, the B summary incorrectly gains a review CTA and the race test fails.
    source_segment_ids: ["seg-summary-target"],
  };
  const verifiedItem = {
    item_key: "summary-verified-action",
    text: "经纪人周五前发送三套房源",
    support_quote: "周五前发送三套房源。",
    source_segment_ids: ["seg-timeline"],
  };
  return {
    id: `artifact-summary-${eventId}`,
    project_id: projectId,
    event_id: eventId,
    run_id: `artifact-run-summary-${eventId}`,
    kind: "summary",
    artifact_version: 1,
    input_hash: `summary-${eventId}`,
    content: {
      sections: [{
        kind: "meeting_summary",
        title: isProjectA ? "A 项目会议重点" : "B 项目会议重点",
        items: [...fillerItems, ...(isProjectA ? [verifiedItem] : []), targetItem],
      }],
    },
    derived_asset_id: null,
    derived_asset_version_id: null,
    created_at: now,
    updated_at: now,
  };
}

function readableArtifact(projectId: string, eventId: string) {
  return {
    id: `artifact-readable-${eventId}`,
    project_id: projectId,
    event_id: eventId,
    run_id: `artifact-run-readable-${eventId}`,
    kind: "readable_transcript",
    artifact_version: 1,
    input_hash: `readable-${eventId}`,
    content: {
      segments: [{
        readable_key: `readable-${eventId}-1`,
        source_segment_ids: ["seg-summary-target"],
        speaker: "Buyer",
        start_ms: 48_000,
        readable_text: projectId === "project-a" ? "预算上限是 120 万美元。" : "只看北区学区。",
        edits: [],
        needs_human_check: false,
      }],
    },
    derived_asset_id: `asset-readable-${eventId}`,
    derived_asset_version_id: `asset-readable-${eventId}-version-1`,
    created_at: now,
    updated_at: now,
  };
}

function transcriptSegments(projectId: string, eventId: string) {
  const targetText = projectId === "project-a" ? "预算上限是 120 万美元。" : "只看北区学区。";
  return [
    ...Array.from({ length: projectId === "project-a" ? 24 : 2 }, (_, index) => ({
      id: `seg-${eventId}-filler-${index}`,
      event_id: eventId,
      asset_version_id: `asset-${eventId}-version-1`,
      ordinal: index,
      speaker: "Buyer",
      start_ms: index * 2_000,
      end_ms: index * 2_000 + 1_500,
      text: `背景原文 ${index + 1}`,
    })),
    {
      id: "seg-summary-target",
      event_id: eventId,
      asset_version_id: `asset-${eventId}-version-1`,
      ordinal: 30,
      speaker: "Buyer",
      start_ms: 48_000,
      end_ms: 53_000,
      text: targetText,
    },
    ...(projectId === "project-a" ? [{
      id: "seg-timeline",
      event_id: eventId,
      asset_version_id: `asset-${eventId}-version-1`,
      ordinal: 31,
      speaker: "Agent",
      start_ms: 72_000,
      end_ms: 77_000,
      text: "周五前发送三套房源。",
    }] : []),
  ];
}

function evidenceContext(evidenceId: string) {
  const timeline = evidenceId.includes("timeline");
  const segmentId = timeline ? "seg-timeline" : "seg-summary-target";
  const text = timeline ? "周五前发送三套房源。" : "预算上限是 120 万美元。";
  return {
    evidence_ref_id: evidenceId,
    project_id: "project-a",
    event_id: "event-a",
    claim_version_id: timeline
      ? "claim-timeline-verified-version-1"
      : "claim-summary-pending-version-1",
    kind: "transcript_quote",
    evidence_role: "direct",
    asset_version_id: "asset-event-a-version-1",
    asset_id: "asset-event-a",
    filename: "event-a.txt",
    target: {
      segment_ids: [segmentId],
      quote_raw: text,
      start_ms: timeline ? 72_000 : 48_000,
      end_ms: timeline ? 77_000 : 53_000,
      page_number: null,
      bbox: null,
      observation: null,
    },
    context: {
      before: [{
        id: `${segmentId}-before`,
        event_id: "event-a",
        asset_version_id: "asset-event-a-version-1",
        ordinal: 1,
        speaker: "Agent",
        start_ms: 44_000,
        end_ms: 47_000,
        text: "先确认一下目前的计划。",
      }],
      target: [{
        id: segmentId,
        event_id: "event-a",
        asset_version_id: "asset-event-a-version-1",
        ordinal: 2,
        speaker: timeline ? "Agent" : "Buyer",
        start_ms: timeline ? 72_000 : 48_000,
        end_ms: timeline ? 77_000 : 53_000,
        text,
      }],
      after: [{
        id: `${segmentId}-after`,
        event_id: "event-a",
        asset_version_id: "asset-event-a-version-1",
        ordinal: 3,
        speaker: "Buyer",
        start_ms: 78_000,
        end_ms: 81_000,
        text: "好的，就按这个做。",
      }],
    },
    asset_view_url: null,
    audio: null,
  };
}

type Gate = {
  waitUntilRequested: Promise<void>;
  markRequested: () => void;
  waitUntilReleased: Promise<void>;
  release: () => void;
};

function gate(): Gate {
  let markRequested: () => void = () => {};
  let release: () => void = () => {};
  const waitUntilRequested = new Promise<void>((resolve) => { markRequested = resolve; });
  const waitUntilReleased = new Promise<void>((resolve) => { release = resolve; });
  return { waitUntilRequested, markRequested, waitUntilReleased, release };
}

export class NotiqueApiFixture {
  readonly writes: MutationRecord[] = [];
  readonly blockedWrites: MutationRecord[] = [];
  readonly reads: ReadRecord[] = [];
  readonly completedReads: ReadRecord[] = [];
  readonly failedReads: ReadRecord[] = [];
  readonly returnedActionClaimIds: string[][] = [];
  holdProjectAClaims = false;
  holdProjectASnapshot = false;
  simulateProjectARunCompletionRefresh = false;
  summaryFirstMode = false;
  summarySharedClaims = false;
  summaryIncompleteEvidence = false;
  transcriptionProgressMode = false;
  transcriptionProgressCompleted = false;
  failTranscriptReadingRequests = false;
  analysisProgressMode = false;
  compactTranscriptMode = false;

  private readonly claimsGate = gate();
  private readonly snapshotGate = gate();
  private readonly completionProjectGate = gate();
  private readonly completionEventGate = gate();
  private projectARunReads = 0;
  private projectACompletionRefreshArmed = false;
  private summaryFirstExtractionStatus: "processing" | "succeeded" = "processing";
  private summaryFirstSummaryStatus: "processing" | "succeeded" | "failed" | null = "processing";
  private summaryFirstReadableStatus: "processing" | "succeeded" | "failed" | null = "processing";
  private staleSummaryArtifactDuringNewRun = false;
  private readonly allowedMutations = new Set<string>();
  private readonly manualClaims = new Map<string, ReturnType<typeof claimRecord>>();
  private activeProjectIds = new Set(["project-a", "project-b"]);
  private trashProjectIds = new Set(["project-trash"]);
  private actions: FixtureAction[] = [
    {
      claim_id: "claim-action-confirmed",
      claim_version_id: "claim-action-confirmed-version-1",
      statement: "经纪人周五前发送三套符合预算的房源",
      owner: "经纪人",
      due_at: "2026-08-21T17:00:00.000Z",
      event_id: "event-a",
      event_title: "A 初次沟通",
      review_status: "verified",
      status: "confirmed",
      evidence_ref_ids: ["evidence-claim-timeline-verified"],
      completed_by_claim_id: null,
    },
    {
      claim_id: "claim-action-pending",
      claim_version_id: "claim-action-pending-version-1",
      statement: "PENDING MUST NOT LEAK INTO FORMAL NEXT",
      owner: null,
      due_at: null,
      event_id: "event-a",
      event_title: "A 初次沟通",
      review_status: "pending",
      status: "ai_suggested",
      evidence_ref_ids: ["evidence-pending"],
      completed_by_claim_id: null,
    },
    {
      claim_id: "claim-action-rejected",
      claim_version_id: "claim-action-rejected-version-1",
      statement: "REJECTED MUST NOT LEAK INTO FORMAL NEXT",
      owner: null,
      due_at: null,
      event_id: "event-a",
      event_title: "A 初次沟通",
      review_status: "rejected",
      status: "not_adopted",
      evidence_ref_ids: ["evidence-rejected"],
      completed_by_claim_id: null,
    },
  ];

  allowMutation(method: string, path: string) {
    this.allowedMutations.add(`${method.toUpperCase()} ${path}`);
  }

  readCount(path: string) {
    return this.reads.filter((read) => read.path === path).length;
  }

  completedReadCount(path: string) {
    return this.completedReads.filter((read) => read.path === path).length;
  }

  failedReadCount(path: string) {
    return this.failedReads.filter((read) => read.path === path).length;
  }

  enableSummaryFirstFlow(options: {
    summaryStatus?: "processing" | "succeeded" | "failed";
    readableStatus?: "processing" | "succeeded" | "failed";
  } = {}) {
    this.summaryFirstMode = true;
    this.summaryFirstExtractionStatus = "processing";
    this.summaryFirstSummaryStatus = options.summaryStatus ?? "processing";
    this.summaryFirstReadableStatus = options.readableStatus ?? "processing";
  }

  completeSummary() {
    this.summaryFirstSummaryStatus = "succeeded";
  }

  completeReadableTranscript() {
    this.summaryFirstReadableStatus = "succeeded";
  }

  completeFacts() {
    this.summaryFirstExtractionStatus = "succeeded";
  }

  enableSharedSummaryClaims() {
    this.summarySharedClaims = true;
  }

  enableIncompleteSummaryEvidence() {
    this.summaryIncompleteEvidence = true;
  }

  enableTranscriptionProgress() {
    this.transcriptionProgressMode = true;
  }

  completeTranscriptionProgress(options: { failReadingRequests?: boolean } = {}) {
    this.transcriptionProgressCompleted = true;
    this.failTranscriptReadingRequests = options.failReadingRequests === true;
  }

  enableCompactTranscript() {
    this.compactTranscriptMode = true;
  }

  enableAnalysisProgress() {
    this.analysisProgressMode = true;
  }

  enableNewSummaryRunWithStaleArtifact() {
    this.enableSummaryFirstFlow({ summaryStatus: "processing", readableStatus: "failed" });
    this.staleSummaryArtifactDuringNewRun = true;
  }

  enableLegacyRawFlow() {
    this.summaryFirstMode = true;
    this.summaryFirstExtractionStatus = "succeeded";
    this.summaryFirstSummaryStatus = null;
    this.summaryFirstReadableStatus = null;
  }

  waitForProjectAClaimsRequest() {
    return this.claimsGate.waitUntilRequested;
  }

  releaseProjectAClaims() {
    this.claimsGate.release();
  }

  waitForProjectASnapshotRequest() {
    return this.snapshotGate.waitUntilRequested;
  }

  releaseProjectASnapshot() {
    this.snapshotGate.release();
  }

  waitForProjectACompletionProjectRefresh() {
    return this.completionProjectGate.waitUntilRequested;
  }

  waitForProjectACompletionEventRefresh() {
    return this.completionEventGate.waitUntilRequested;
  }

  releaseProjectACompletionProjectRefresh() {
    this.completionProjectGate.release();
  }

  releaseProjectACompletionEventRefresh() {
    this.completionEventGate.release();
  }

  releaseProjectACompletionRefresh() {
    this.releaseProjectACompletionProjectRefresh();
    this.releaseProjectACompletionEventRefresh();
  }

  private project(id: string) {
    if (id === "project-a") return projectRecord(id, "Buyer A", { pendingClaimCount: 1 });
    if (id === "project-b") return projectRecord(id, "Buyer B");
    if (id === "project-trash") {
      return projectRecord(id, "Recovered Buyer", {
        eventCount: 0,
        deletedAt: this.trashProjectIds.has(id) ? "2026-08-15T15:00:00.000Z" : null,
      });
    }
    return null;
  }

  private eventsForProject(projectId: string) {
    if (projectId === "project-a") {
      return [eventRecord("event-a", projectId, "A 初次沟通", "run-a", 1)];
    }
    if (projectId === "project-b") {
      return [eventRecord("event-b", projectId, "B 初次沟通", null)];
    }
    return [];
  }

  private workflowSnapshot(projectId: string) {
    const project = this.project(projectId)!;
    const events = this.eventsForProject(projectId);
    const isA = projectId === "project-a";
    const summaryStatus = isA && this.analysisProgressMode
      ? "processing"
      : isA && this.summaryFirstMode
      ? this.summaryFirstSummaryStatus
      : "succeeded";
    const readableStatus = isA && this.analysisProgressMode
      ? "processing"
      : isA && this.summaryFirstMode
      ? this.summaryFirstReadableStatus
      : "succeeded";
    const extractionStatus = isA && this.analysisProgressMode
      ? "processing"
      : isA && this.summaryFirstMode
      ? this.summaryFirstExtractionStatus
      : isA ? "succeeded" : null;
    const extractionIsRunning = extractionStatus === "processing";
    const snapshotTimestamp = new Date().toISOString();
    const summaryRunId = events[0] && this.staleSummaryArtifactDuringNewRun
      ? `artifact-run-summary-new-${events[0].id}`
      : events[0] ? `artifact-run-summary-${events[0].id}` : null;
    const artifactSummary = events[0] && summaryStatus && summaryRunId
      ? { ...artifactRun(summaryRunId, projectId, events[0].id, "summary"), status: summaryStatus }
      : null;
    const artifactReadable = events[0] && readableStatus
      ? { ...artifactRun(`artifact-run-readable-${events[0].id}`, projectId, events[0].id, "readable_transcript"), status: readableStatus }
      : null;
    return {
      project,
      workflow: {
        phase: events.length ? (isA ? extractionIsRunning ? "running" : "draft_ready" : "complete") : "empty",
        total: events.length,
        completed: isA ? 0 : events.length,
        trust_state: isA ? "draft_ready" : "trusted",
        pending_total: isA ? 1 : 0,
        current_position: events.length ? 1 : 0,
        current_event_id: isA ? "event-a" : null,
        current_run_id: isA ? "run-a" : null,
        next_action: {
          kind: isA ? "open_draft" : events.length ? "open_brief" : "add_material",
          event_id: isA ? "event-a" : null,
          run_id: isA ? "run-a" : null,
          requires_user_confirmation: false,
        },
      },
      events: events.map((event) => ({
        id: event.id,
        title: event.title,
        occurred_at: event.occurred_at,
        sequence_no: event.sequence_no,
        material_status: "ready",
        display_status: isA ? extractionIsRunning ? "inventory" : "waiting_review" : "complete",
        status_summary: {
          material_count: 1,
          material_ready_count: 1,
          material_processing_count: 0,
          material_failed_count: 0,
          transcription_status: null,
          extraction_status: extractionStatus,
          pending_count: isA ? 1 : 0,
          candidate_count: isA ? 2 : 0,
          summary_status: summaryStatus,
          readable_transcript_status: readableStatus,
        },
        materials: { total: 1, ready: 1, processing: 0, failed: 0 },
        transcription: null,
        extraction: isA ? {
          run_id: "run-a",
          status: extractionStatus,
          stage: extractionIsRunning ? "inventory" : "verify",
          error_code: null,
          processing_attempt_no: 1,
          dispatch_attempt_no: 1,
          created_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:00.000Z",
          queued_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:00.000Z",
          first_queued_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:00.000Z",
          current_queued_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:00.000Z",
          started_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:02.000Z",
          first_started_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:02.000Z",
          current_started_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:02.000Z",
          finished_at: extractionIsRunning ? null : "2026-08-15T11:01:45.000Z",
          updated_at: extractionIsRunning ? snapshotTimestamp : "2026-08-15T11:01:45.000Z",
        } : null,
        ai_artifacts: {
          summary: artifactSummary,
          readable_transcript: artifactReadable,
        },
        pending_claim_count: isA ? 1 : 0,
        pending_occurrence_count: 0,
        candidate_count: isA ? 2 : 0,
      })),
    };
  }

  private verifiedActions() {
    const actions = this.actions
      .filter((action) => action.review_status === "verified")
      .map((action) => ({
        claim_id: action.claim_id,
        claim_version_id: action.claim_version_id,
        statement: action.statement,
        owner: action.owner,
        due_at: action.due_at,
        event_id: action.event_id,
        event_title: action.event_title,
        status: action.status,
        evidence_ref_ids: action.evidence_ref_ids,
        completed_by_claim_id: action.completed_by_claim_id,
      }));
    this.returnedActionClaimIds.push(actions.map((action) => action.claim_id));
    return actions;
  }

  private async fulfill(route: Route, data: unknown, status = 200) {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  }

  private async handleMutation(route: Route, method: string, path: string) {
    const request = route.request();
    const rawBody = request.postData();
    let body: unknown = rawBody;
    if (rawBody) {
      try { body = JSON.parse(rawBody); } catch { /* Keep non-JSON request data intact. */ }
    }
    const record: MutationRecord = {
      method,
      path,
      body,
      idempotencyKey: request.headers()["idempotency-key"] ?? null,
    };
    this.writes.push(record);
    if (!this.allowedMutations.has(`${method} ${path}`)) {
      this.blockedWrites.push(record);
      await route.abort("blockedbyclient");
      return;
    }

    if (method === "POST" && path === "/api/v1/projects/project-trash/restore") {
      this.trashProjectIds.delete("project-trash");
      this.activeProjectIds.add("project-trash");
      await this.fulfill(route, envelope({ project: this.project("project-trash") }));
      return;
    }

    const claimVerdictMatch = path.match(/^\/api\/v1\/claims\/([^/]+)\/verdicts$/);
    if (method === "POST" && claimVerdictMatch) {
      const claimId = decodeURIComponent(claimVerdictMatch[1]);
      const action = typeof body === "object" && body !== null && "action" in body
        ? (body as { action?: unknown }).action
        : null;
      const reviewStatus = action === "reject" ? "rejected" : "verified";
      const statement = claimId === "claim-summary-shared"
        ? "客户仍需确认 120 万美元是否包含装修预算"
        : "预算上限是 120 万美元";
      const type = claimId === "claim-summary-shared" ? "open_question" : "budget";
      await this.fulfill(route, envelope({
        claim: claimRecord(claimId, statement, type, reviewStatus, "seg-summary-target"),
        verdict_id: `verdict-${claimId}-${reviewStatus}`,
      }));
      return;
    }

    const manualClaimMatch = path.match(/^\/api\/v1\/events\/([^/]+)\/manual-claims$/);
    if (method === "POST" && manualClaimMatch) {
      const payload = typeof body === "object" && body !== null
        ? body as { statement?: unknown; type?: unknown; segment_ids?: unknown }
        : {};
      const statement = typeof payload.statement === "string" ? payload.statement : "人工补充行动";
      const type = typeof payload.type === "string" ? payload.type : "next_action";
      const segmentId = Array.isArray(payload.segment_ids) && typeof payload.segment_ids[0] === "string"
        ? payload.segment_ids[0]
        : "seg-summary-target";
      const claim = claimRecord("claim-manual-action", statement, type, "pending", segmentId);
      const humanClaim = {
        ...claim,
        source: "human",
        current_version: { ...claim.current_version, source: "human" },
      };
      this.manualClaims.set(claim.id, humanClaim);
      await this.fulfill(route, envelope({
        claim: humanClaim,
      }));
      return;
    }

    if (method === "POST" && path === "/api/v1/actions/claim-action-confirmed/complete") {
      this.actions = this.actions.map((action) => action.claim_id === "claim-action-confirmed"
        ? { ...action, status: "completed", completed_by_claim_id: "claim-action-completion" }
        : action);
      await this.fulfill(route, envelope({
        completion: {
          actionClaimId: "claim-action-confirmed",
          completionClaimId: "claim-action-completion",
        },
      }));
      return;
    }

    if (method === "POST" && path === "/api/v1/jobs/dispatch") {
      await this.fulfill(route, envelope({ accepted: true }), 202);
      return;
    }

    await this.fulfill(route, {
      error: { code: "METHOD_NOT_ALLOWED", message: "Mutation is not implemented by the local fixture." },
      request_id: requestId,
    }, 405);
  }

  async install(page: Page) {
    page.on("response", (response) => {
      const request = response.request();
      const url = new URL(request.url());
      if (request.method().toUpperCase() !== "GET" || !url.pathname.startsWith("/api/")) return;
      this.completedReads.push({ method: "GET", path: url.pathname });
    });
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (request.method().toUpperCase() !== "GET" || !url.pathname.startsWith("/api/")) return;
      this.failedReads.push({ method: "GET", path: url.pathname });
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const path = new URL(request.url()).pathname;

      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        await this.handleMutation(route, method, path);
        return;
      }

      if (method === "HEAD" || method === "OPTIONS") {
        await route.fulfill({ status: 204, body: "" });
        return;
      }

      this.reads.push({ method: "GET", path });

      if (path === "/api/v1/projects") {
        const projects = [...this.activeProjectIds]
          .map((id) => this.project(id))
          .filter(Boolean);
        await this.fulfill(route, envelope({ projects }));
        return;
      }

      if (path === "/api/v1/projects/trash") {
        const projects = [...this.trashProjectIds]
          .map((id) => this.project(id))
          .filter(Boolean);
        await this.fulfill(route, envelope({ projects }));
        return;
      }

      const workflowMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/workflow-snapshot$/);
      if (workflowMatch) {
        const projectId = decodeURIComponent(workflowMatch[1]);
        if (projectId === "project-a" && this.holdProjectASnapshot) {
          this.snapshotGate.markRequested();
          await this.snapshotGate.waitUntilReleased;
        }
        await this.fulfill(route, envelope({ workflow_snapshot: this.workflowSnapshot(projectId) }));
        return;
      }

      const actionsMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/actions$/);
      if (actionsMatch) {
        await this.fulfill(route, envelope({ actions: this.verifiedActions() }));
        return;
      }

      const draftMemoryMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/draft-memory$/);
      if (draftMemoryMatch) {
        await this.fulfill(route, envelope({ draft_memory: { claims: [], links: [] } }));
        return;
      }

      const timelineMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/views\/timeline$/);
      if (timelineMatch) {
        await this.fulfill(route, envelope({ view: [{
          event: { id: "event-a", title: "A 初次沟通", occurredAt: "2026-08-15T11:00:00.000Z" },
          summary: "已确认行动进入时间线。",
          moments: [{
            id: "timeline-moment-1",
            kind: "new",
            displayText: "经纪人承诺周五前发送三套房源",
            transcriptStartMs: 72_000,
            after: {
              claimId: "claim-timeline-verified",
              claimVersionId: "claim-timeline-verified-version-1",
              type: "next_action",
              statement: "经纪人周五前发送三套房源",
            },
            evidence: [{ speaker: "Agent", startMs: 72_000, quoteRaw: "周五前发送三套房源。" }],
          }],
        }] }));
        return;
      }

      const folderSummaryMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/views\/folder-summary$/);
      if (folderSummaryMatch) {
        await this.fulfill(route, envelope({ view: {
          scenario: "real_estate_buyer_journey",
          currentClaims: [{
            claimId: "claim-timeline-verified",
            claimVersionId: "claim-timeline-verified-version-1",
            type: "next_action",
            statement: "经纪人周五前发送三套房源",
          }],
          recentDeltas: [],
        } }));
        return;
      }

      const projectEventsMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/events$/);
      if (projectEventsMatch) {
        const projectId = decodeURIComponent(projectEventsMatch[1]);
        await this.fulfill(route, envelope({ events: this.eventsForProject(projectId) }));
        return;
      }

      const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1]);
        if (
          projectId === "project-a"
          && this.simulateProjectARunCompletionRefresh
          && this.projectACompletionRefreshArmed
        ) {
          this.completionProjectGate.markRequested();
          await this.completionProjectGate.waitUntilReleased;
        }
        const project = this.project(projectId);
        if (!project || (!this.activeProjectIds.has(projectId) && !this.trashProjectIds.has(projectId))) {
          await this.fulfill(route, {
            error: { code: "NOT_FOUND", message: "Project not found." },
            request_id: requestId,
          }, 404);
          return;
        }
        await this.fulfill(route, envelope({ project }));
        return;
      }

      const eventArtifactsMatch = path.match(/^\/api\/v1\/events\/([^/]+)\/ai-artifacts$/);
      if (eventArtifactsMatch) {
        if (this.failTranscriptReadingRequests && eventArtifactsMatch[1] === "event-a") {
          await this.fulfill(route, {
            error: { code: "TEMPORARY_UNAVAILABLE", message: "Artifact reading is temporarily unavailable." },
            request_id: requestId,
          }, 503);
          return;
        }
        const eventId = decodeURIComponent(eventArtifactsMatch[1]);
        const projectId = eventId === "event-a" ? "project-a" : "project-b";
        const summaryStatus = projectId === "project-a" && this.summaryFirstMode
          ? this.summaryFirstSummaryStatus
          : "succeeded";
        const readableStatus = projectId === "project-a" && this.summaryFirstMode
          ? this.summaryFirstReadableStatus
          : "succeeded";
        await this.fulfill(route, envelope({
          runs: [
            ...(summaryStatus ? [{
              ...artifactRun(
                this.staleSummaryArtifactDuringNewRun
                  ? `artifact-run-summary-new-${eventId}`
                  : `artifact-run-summary-${eventId}`,
                projectId,
                eventId,
                "summary",
              ),
              status: summaryStatus,
              error_code: summaryStatus === "failed" ? "MODEL_OUTPUT_INVALID" : null,
            }] : []),
            ...(readableStatus ? [{
              ...artifactRun(`artifact-run-readable-${eventId}`, projectId, eventId, "readable_transcript"),
              status: readableStatus,
              error_code: readableStatus === "failed" ? "MODEL_OUTPUT_INVALID" : null,
            }] : []),
          ],
          artifacts: [
            ...(summaryStatus === "succeeded" || this.staleSummaryArtifactDuringNewRun
              ? [summaryArtifact(projectId, eventId)]
              : []),
            ...(readableStatus === "succeeded" ? [readableArtifact(projectId, eventId)] : []),
          ],
        }));
        return;
      }

      const transcriptMatch = path.match(/^\/api\/v1\/events\/([^/]+)\/transcript-segments$/);
      if (transcriptMatch) {
        const eventId = decodeURIComponent(transcriptMatch[1]);
        if (this.failTranscriptReadingRequests && eventId === "event-a") {
          await this.fulfill(route, {
            error: { code: "TEMPORARY_UNAVAILABLE", message: "Transcript reading is temporarily unavailable." },
            request_id: requestId,
          }, 503);
          return;
        }
        const projectId = eventId === "event-a" ? "project-a" : "project-b";
        const segments = this.compactTranscriptMode && eventId === "event-a"
          ? Array.from({ length: 8 }, (_, index) => ({
              id: `compact-seg-${index}`,
              event_id: eventId,
              asset_version_id: "asset-event-a-version-1",
              ordinal: index,
              speaker: index % 2 === 0 ? "Buyer" : "Agent",
              start_ms: index * 4_000,
              end_ms: index * 4_000 + 3_000,
              text: index % 2 === 0 ? `Buyer detail ${index + 1}.` : `Agent response ${index + 1}.`,
            }))
          : this.transcriptionProgressMode && eventId === "event-a"
          ? progressTranscriptSegments()
          : transcriptSegments(projectId, eventId);
        await this.fulfill(route, envelope({ segments }));
        return;
      }

      const transcriptionRunMatch = path.match(/^\/api\/v1\/transcription-runs\/([^/]+)$/);
      if (transcriptionRunMatch) {
        const runId = decodeURIComponent(transcriptionRunMatch[1]);
        if (this.transcriptionProgressMode && runId === "transcription-a") {
          await this.fulfill(route, envelope({ transcription_run: chunkedTranscriptionRun(this.transcriptionProgressCompleted) }));
          return;
        }
      }

      const eventMatch = path.match(/^\/api\/v1\/events\/([^/]+)$/);
      if (eventMatch) {
        const eventId = decodeURIComponent(eventMatch[1]);
        if (
          eventId === "event-a"
          && this.simulateProjectARunCompletionRefresh
          && this.projectACompletionRefreshArmed
        ) {
          this.completionEventGate.markRequested();
          await this.completionEventGate.waitUntilReleased;
        }
        const projectId = eventId === "event-a" ? "project-a" : eventId === "event-b" ? "project-b" : "project-trash";
        const foundEvent = this.eventsForProject(projectId).find((item) => item.id === eventId);
        const event = foundEvent && eventId === "event-a" && this.projectACompletionRefreshArmed
          ? { ...foundEvent, title: "A 完成刷新后的沟通" }
          : foundEvent;
        if (!event) {
          await this.fulfill(route, {
            error: { code: "NOT_FOUND", message: "Event not found." },
            request_id: requestId,
          }, 404);
          return;
        }
        await this.fulfill(route, envelope({
          event,
          assets: this.transcriptionProgressMode && eventId === "event-a"
            ? [audioAssetRecord("audio-event-a", projectId, eventId)]
            : [assetRecord(`asset-${eventId}`, projectId, eventId)],
        }));
        return;
      }

      const runClaimsMatch = path.match(/^\/api\/v1\/extraction-runs\/([^/]+)\/claims$/);
      if (runClaimsMatch) {
        const runId = decodeURIComponent(runClaimsMatch[1]);
        if (runId === "run-a" && this.holdProjectAClaims) {
          this.claimsGate.markRequested();
          await this.claimsGate.waitUntilReleased;
        }
        const summaryClaim = claimRecord(
            "claim-summary-pending",
            "预算上限是 120 万美元",
            "budget",
            "pending",
            "seg-summary-target",
          );
        if (this.summaryIncompleteEvidence) {
          const extra = evidenceRef(
            "evidence-claim-summary-pending-extra",
            "seg-timeline",
          );
          summaryClaim.evidence_ref_ids.push(extra.id);
          summaryClaim.evidence_refs.push(extra);
        }
        const claims = runId === "run-a" ? [
          summaryClaim,
          claimRecord(
            "claim-timeline-verified",
            "经纪人周五前发送三套房源",
            "next_action",
            "verified",
            "seg-timeline",
          ),
          ...(this.summarySharedClaims ? [claimRecord(
            "claim-summary-shared",
            "客户仍需确认 120 万美元是否包含装修预算",
            "open_question",
            "pending",
            "seg-summary-target",
          )] : []),
        ] : [];
        await this.fulfill(route, envelope({
          run: extractionRun(runId, "project-a", "event-a"),
          claims,
          occurrence_candidates: [],
        }));
        return;
      }

      const runMatch = path.match(/^\/api\/v1\/extraction-runs\/([^/]+)$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);
        if (runId === "run-a" && this.analysisProgressMode) {
          await this.fulfill(route, envelope({ run: analysisProgressExtractionRun(runId, "project-a", "event-a") }));
          return;
        }
        if (runId === "run-a" && this.summaryFirstMode) {
          const summaryFirstRun = this.summaryFirstExtractionStatus === "processing"
            ? freshProcessingExtractionRun(runId, "project-a", "event-a")
            : extractionRun(runId, "project-a", "event-a");
          await this.fulfill(route, envelope({ run: summaryFirstRun }));
          return;
        }
        if (runId === "run-a" && this.simulateProjectARunCompletionRefresh) {
          this.projectARunReads += 1;
          if (this.projectARunReads === 1) {
            await this.fulfill(route, envelope({ run: processingExtractionRun(runId, "project-a", "event-a") }));
            return;
          }
          this.projectACompletionRefreshArmed = true;
        }
        await this.fulfill(route, envelope({ run: extractionRun(runId, "project-a", "event-a") }));
        return;
      }

      const claimHistoryMatch = path.match(/^\/api\/v1\/claims\/([^/]+)\/history$/);
      if (claimHistoryMatch) {
        const claimId = decodeURIComponent(claimHistoryMatch[1]);
        const summaryClaim = claimRecord(
          "claim-summary-pending",
          "预算上限是 120 万美元",
          "budget",
          "pending",
          "seg-summary-target",
        );
        if (this.summaryIncompleteEvidence) {
          const extra = evidenceRef("evidence-claim-summary-pending-extra", "seg-timeline");
          summaryClaim.evidence_ref_ids.push(extra.id);
          summaryClaim.evidence_refs.push(extra);
        }
        const claim = this.manualClaims.get(claimId) ?? (claimId === "claim-summary-pending"
          ? summaryClaim
          : claimId === "claim-summary-shared"
            ? claimRecord(claimId, "客户仍需确认 120 万美元是否包含装修预算", "open_question", "pending", "seg-summary-target")
            : claimRecord("claim-timeline-verified", "经纪人周五前发送三套房源", "next_action", "verified", "seg-timeline"));
        await this.fulfill(route, envelope({ current_claim: claim }));
        return;
      }

      const evidenceContextMatch = path.match(/^\/api\/v1\/evidence-refs\/([^/]+)\/context$/);
      if (evidenceContextMatch) {
        const evidenceId = decodeURIComponent(evidenceContextMatch[1]);
        await this.fulfill(route, envelope({ evidence_context: evidenceContext(evidenceId) }));
        return;
      }

      if (path.startsWith("/api/v1/projects/") && path.includes("/views/")) {
        await this.fulfill(route, envelope({ view: [] }));
        return;
      }

      await this.fulfill(route, {
        error: { code: "NOT_FOUND", message: `No local E2E fixture for ${method} ${path}.` },
        request_id: requestId,
      }, 404);
    });
  }

  assertNoUnexpectedWrites() {
    expect(
      this.blockedWrites,
      "local E2E fixture blocked an API mutation that was not explicitly allowlisted",
    ).toEqual([]);
  }
}
