/** Shared wire contract for Workflow V2. Keep in sync with both technical plans. */
export type VersionRef = { claimId: string; claimVersionId: string };
export type ReviewState = "draft" | "accepted";
export type ContentOrigin = "source_statement" | "ai_suggestion" | "user_input" | "user_selection";
export type SourceStatus = "ready" | "stale" | "missing";
export type MemberDecisionOperation = "confirm" | "edit" | "reject" | "defer" | "restore" | "accept_action" | "resolve_conflict";
export type DecisionOperation = MemberDecisionOperation | "review_members";
export type ContextWrite = { expectedContextVersion: number };
export type Coverage = {
  totalSegments: number;
  completedSegments: number;
  complete: boolean;
  unprocessedRanges: Array<{ assetVersionId: string; firstOrdinal: number; lastOrdinal: number }>;
};
export type Bullet = {
  conflictWith?: VersionRef[];
  applicability?: string;
  id: string;
  text: string;
  claimRefs: VersionRef[];
  reviewState: ReviewState;
  origin: ContentOrigin;
  sourceStatus: SourceStatus;
};
export type ReviewMember = VersionRef & {
  kind: "record" | "question" | "action";
  statement: string;
  reviewState: ReviewState | "rejected";
  origin: ContentOrigin;
  supportStatus: "fully_supports" | "partially_supports" | "does_not_support" | "unreviewed";
  evidenceRefIds: string[];
  answerTargets?: Array<{ questionRef: VersionRef; revision: number; text: string | null }>;
};
export type ReviewCard = {
  eventId?: string;
  sameIntent?: { recordRef: VersionRef; actionRef: VersionRef };
  actionOverlap?: { manualRef: VersionRef; modelRef: VersionRef };
  createdAt?: string;
  conflicts?: Array<{ relationId: string; existing: ReviewMember; candidateRef: VersionRef; existingActionState?: Action["executionState"] }>;
  id: string;
  revision: number;
  kind: "record" | "question" | "action" | "conflict";
  title: string;
  memberRefs: VersionRef[];
  members: ReviewMember[];
  suggestedOperation: DecisionOperation;
  needsDecision: boolean;
  reasonCode: "accepted_change" | "blocking_question" | "action_choice" | null;
  reason: string;
  disposition: "active" | "deferred" | "processed";
  sourceStatus: SourceStatus;
  latestDecisionId: string | null;
  decisionRevision: number | null;
};
export type Narrative = {
  text: string;
  sentenceRefs: Array<{ text: string; claimRefs: VersionRef[]; reviewState: ReviewState; topic?: { key: string; title: string } }>;
  basedOnContextVersion: number;
  freshness: "current" | "stale" | "updating" | "failed";
  scope: "accepted" | "draft" | "mixed";
};
export type LatestOutcome = {
  freshness?: "current" | "stale";
  id: string;
  revision: number;
  text: string;
  answerRefs: VersionRef[];
  resultRefs?: VersionRef[];
  updatedAt: string;
};
export type ActionBasis = {
  acceptedRef: VersionRef;
  acceptedText: string | null;
  currentRef: VersionRef | null;
  currentText: string | null;
  sourceStatus: SourceStatus;
};
export type Action = {
  id: string;
  claimRef: VersionRef;
  revision: number;
  executionState: "open" | "completed" | "cancelled";
  questionRefs: Array<VersionRef & { revision: number }>;
  basisState: "current" | "needs_review";
  basisDetails: ActionBasis[];
  latestOutcome: LatestOutcome | null;
  ownerHint?: string;
  dueAt?: string;
};
export type ActionHistoryEntry = {
  id: string;
  claimRef: VersionRef;
  text: string | null;
  sourceStatus: SourceStatus;
  executionState: Action["executionState"];
  replacementRef: VersionRef | null;
  replacementText: string | null;
  latestOutcome: LatestOutcome | null;
};
export type Question = {
  id: string;
  claimRef: VersionRef;
  revision: number;
  resolutionState: "open" | "resolved";
  answerRefs: VersionRef[];
  latestOutcome: LatestOutcome | null;
};
export type ReaffirmedMention = {
  id: string;
  claimRef: VersionRef;
  currentRef: VersionRef | null;
  targetEventId: string | null;
  kind: "record" | "question" | "action";
  statement: string | null;
  targetText: string | null;
  currentText: string | null;
  associationState: "proposed" | "confirmed";
  targetState: "current" | "changed" | "retired" | "unavailable";
  sourceStatus: SourceStatus;
  sources: Array<{ assetVersionId: string | null; quote: string | null; sourceStatus: SourceStatus }>;
};
export type WorkspaceSnapshot = {
  reaffirmedMentions?: ReaffirmedMention[];
  actionHistory?: ActionHistoryEntry[];
  analysisRunId?: string | null;
  reviewProgress?: ReviewProgress;
  recentDecisions?: Array<{id:string;revision:number;operation:string;summary:string;createdAt:string;reverted:boolean;choiceMode?:ConflictChoice["mode"]}>;
  access: { workspaceId: string; actorId: string; canEdit: boolean };
  snapshotId: string;
  contextVersion: number;
  sourceRevision: number;
  coverage: Coverage;
  bullets: Bullet[];
  reviewCards: ReviewCard[];
  actions: Action[];
  questions: Question[];
  narrative: Narrative | null;
  counts: { draftCount: number; needsDecisionCount: number; openActionCount: number };
  nextCursor: string | null;
};
export type ProjectOverview = {
  access: WorkspaceSnapshot['access'];
  nextCursor: string | null;
  counts: { draftCount: number; needsDecisionCount: number; openActionCount: number; openQuestionCount: number };
  snapshotId: string;
  contextVersion: number;
  currentBullets: Array<Bullet & { eventId: string; executionState?: Action["executionState"] }>;
  recentChanges: Array<{ id: string; eventId: string; text: string; claimRefs: VersionRef[]; createdAt: string }>;
  openQuestions: Array<Question & { eventId: string }>;
  nextActions: Array<Action & { eventId: string }>;
  recordSummaries: Array<{ eventId: string; title: string; occurredAt: string; narrative: Narrative | null; coverage: Coverage; counts: WorkspaceSnapshot["counts"]; reviewProgress: ReviewProgress }>;
};
export type ConflictChoice = {
  mode: "keep_existing" | "use_candidate" | "coexist";
  existingRef: VersionRef;
  candidateRef: VersionRef;
  applicability?: string;
};
export type QuestionAnswerChoice = VersionRef & { mode: "keep" | "reopen" };
export type DecisionMember = VersionRef & {
  operation: MemberDecisionOperation;
  newText?: string;
  origin?: ContentOrigin;
  evidenceRefIds?: string[];
  conflictChoice?: ConflictChoice;
  questionChange?: { answerChoices: QuestionAnswerChoice[] };
  factChange?: { questionChoices: QuestionAnswerChoice[] };
};
export type DecisionRequest = ContextWrite & {
  operation: DecisionOperation;
  expectedCardRevision: number;
  members: DecisionMember[];
  deferUntil?: string | null;
};
export type MentionDecisionRequest = ContextWrite & {
  targetRef: VersionRef;
  operation: "confirm" | "reject" | "convert";
};
export type MutationReceipt = {
  mutationId: string;
  contextVersion: number;
  changedRefs: Array<{ entityType: "claim" | "card" | "action" | "question" | "outcome" | "decision"; id: string; revision: number }>;
  affectedViews: Array<"workspace" | "overview" | "narrative" | "report">;
  refreshState: "current" | "updating";
};
export type AnswerDecision = {
  mode: "replace" | "coexist";
  priorAnswerRefs: VersionRef[];
  applicability?: string;
};
export type OutcomeContent = {
  text: string;
  evidenceRefs: string[];
  resolveQuestions: Array<{ questionId: string; revision: number; answerText: string }>;
  answerDecisions?: Array<AnswerDecision & { questionId: string }>;
};
export type OutcomeRequest = ContextWrite & OutcomeContent & {
  expectedActionRevision: number;
  completeAction: boolean;
};
export type QuestionAnswerRequest = ContextWrite & {
  expectedQuestionRevision: number;
  answerText: string;
  evidenceRefs: string[];
  answerDecision?: AnswerDecision;
};
export type OutcomeCorrectionRequest = ContextWrite & {
  expectedOutcomeRevision: number;
} & ({ operation: "withdraw" } | { operation: "replace"; replacement: OutcomeContent });
export type ActionTransitionRequest = ContextWrite & {
  expectedActionRevision: number;
  operation: "complete" | "reopen" | "cancel";
};
export type RevertDecisionRequest = ContextWrite & { expectedDecisionRevision: number };
export type SourceHighlightRequest = ContextWrite & {
  assetVersionId: string;
  ranges: Array<{ segmentId: string; startOffset: number; endOffset: number }>;
};
export type ReviewProgressRequest = {
  snapshotId: string;
  lastCardId: string | null;
  mode: "bookmark" | "finish_session";
};
export type ReviewProgress = { lastCardId: string | null; finishedAt: string | null; remainingCount: number };
export type ReportRequest = ContextWrite & {
  scope: "accepted" | "mixed";
  eventIds: string[];
  format: "markdown" | "plain_text";
};
export type ReportSnapshot = {
  id: string;
  contextVersion: number;
  scope: ReportRequest["scope"];
  content: string;
  createdAt: string;
};
export type StartAnalysisRequest = { sourceRevision: number; mode: "initial" | "reorganize" };
export type RetryAnalysisRequest = { expectedRunRevision: number; stageIds: string[] };
export type AnalysisState = "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";
export type AnalysisQualityNotes = {
  omittedStatements: string[];
  inventoryLimitReached: boolean;
  finalClaimLimitReached: boolean;
  followUpOmitted: boolean;
};
export type AnalysisRun = {
  id: string;
  revision: number;
  state: AnalysisState;
  stages: Array<{ id: string; name: string; state: AnalysisState; retryable: boolean; errorCode: string | null }>;
  coverage: Coverage;
  inputRevision: number;
  retryable: boolean;
  qualityNotes?: AnalysisQualityNotes;
};
export type WorkspaceQuery = { cursor?: string; snapshotId?: string; limit?: number; minContextVersion?: number };
export type OverviewQuery = WorkspaceQuery;

export type McpConnectionRequest = { enabled: boolean };

export type WorkflowRequestMap = {
  McpConnectionRequest: McpConnectionRequest;
  MentionDecisionRequest: MentionDecisionRequest;
  DecisionRequest: DecisionRequest;
  OutcomeRequest: OutcomeRequest;
  QuestionAnswerRequest: QuestionAnswerRequest;
  OutcomeCorrectionRequest: OutcomeCorrectionRequest;
  ActionTransitionRequest: ActionTransitionRequest;
  RevertDecisionRequest: RevertDecisionRequest;
  SourceHighlightRequest: SourceHighlightRequest;
  ReviewProgressRequest: ReviewProgressRequest;
  ReportRequest: ReportRequest;
  StartAnalysisRequest: StartAnalysisRequest;
  RetryAnalysisRequest: RetryAnalysisRequest;
  WorkspaceQuery: WorkspaceQuery;
  OverviewQuery: OverviewQuery;
};

export class WorkflowValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "WorkflowValidationError";
    this.field = field;
  }
}

type RecordValue = Record<string, unknown>;
const memberOperations: readonly MemberDecisionOperation[] = ["confirm", "edit", "reject", "defer", "restore", "accept_action", "resolve_conflict"];
const operations: readonly DecisionOperation[] = [...memberOperations, "review_members"];
function invalid(field: string, message: string): never { throw new WorkflowValidationError(field, message); }
function record(value: unknown, field = "request"): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(field, "应为一个对象");
  return value as RecordValue;
}
function keys(value: RecordValue, allowed: readonly string[], field = "request") {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${field}.${key}`, "包含未定义的字段");
}
function text(value: unknown, field: string, max = 128, min = 1): string {
  if (typeof value !== "string") return invalid(field, "应为文字");
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return invalid(field, `长度应为 ${min} 至 ${max}`);
  return trimmed;
}
function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid(field, "整数超出允许范围");
  return value;
}
function choice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) return invalid(field, "选项无效");
  return value as T;
}
function list<T>(value: unknown, field: string, parse: (value: unknown, field: string) => T, min = 0, max = 20): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid(field, `条目数应为 ${min} 至 ${max}`);
  return value.map((item, index) => parse(item, `${field}[${index}]`));
}
function unique<T>(values: T[], key: (item: T) => string, field: string): T[] {
  if (new Set(values.map(key)).size !== values.length) invalid(field, "包含重复条目");
  return values;
}
function ids(value: unknown, field: string, min = 0, max = 20): string[] {
  return unique(list(value, field, (v, p) => text(v, p), min, max), (v) => v, field);
}
function ref(value: unknown, field: string): VersionRef {
  const v = record(value, field);
  keys(v, ["claimId", "claimVersionId"], field);
  return { claimId: text(v.claimId, `${field}.claimId`), claimVersionId: text(v.claimVersionId, `${field}.claimVersionId`) };
}
function timestamp(value: unknown, field: string): string {
  const v = text(value, field, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) invalid(field, "日期需要包含时间和时区");
  const day = Number(v.slice(8, 10));
  const month = Number(v.slice(5, 7));
  const year = Number(v.slice(0, 4));
  if (month < 1 || month > 12 || day < 1 || day > ([31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0) || Number(v.slice(11, 13)) > 23) invalid(field, "日期无效");
  return new Date(v).toISOString();
}
export function parseAnalysisQualityNotes(value: unknown): AnalysisQualityNotes {
  const v=record(value,"qualityNotes");
  keys(v,["omittedStatements","inventoryLimitReached","finalClaimLimitReached","followUpOmitted"],"qualityNotes");
  for(const name of ["inventoryLimitReached","finalClaimLimitReached","followUpOmitted"]) {
    if(typeof v[name]!=="boolean") invalid(`qualityNotes.${name}`,"应为布尔值");
  }
  return {
    omittedStatements:unique(list(v.omittedStatements,"qualityNotes.omittedStatements",(value,path)=>text(value,path,8000),0,200),value=>value,"qualityNotes.omittedStatements"),
    inventoryLimitReached:v.inventoryLimitReached as boolean,
    finalClaimLimitReached:v.finalClaimLimitReached as boolean,
    followUpOmitted:v.followUpOmitted as boolean,
  };
}
function context(v: RecordValue): ContextWrite { return { expectedContextVersion: integer(v.expectedContextVersion, "expectedContextVersion") }; }

function answerDecision(value: unknown, field: string, withQuestion = false): AnswerDecision & { questionId?: string } {
  const v = record(value, field);
  keys(v, ["mode", "priorAnswerRefs", "applicability", ...(withQuestion ? ["questionId"] : [])], field);
  const mode = choice(v.mode, `${field}.mode`, ["replace", "coexist"]);
  const priorAnswerRefs = unique(list(v.priorAnswerRefs, `${field}.priorAnswerRefs`, ref, 1), (r) => r.claimId, field);
  return {
    mode, priorAnswerRefs,
    ...(withQuestion ? { questionId: text(v.questionId, `${field}.questionId`) } : {}),
    ...(mode === "coexist" ? { applicability: text(v.applicability, `${field}.applicability`, 4000) } : {}),
  };
}

function outcomeContent(v: RecordValue, prefix = ""): OutcomeContent {
  const field = (name: string) => prefix ? `${prefix}.${name}` : name;
  const body = text(v.text, field("text"), 10_000, 0);
  const evidenceRefs = ids(v.evidenceRefs, field("evidenceRefs"));
  if (!body && evidenceRefs.length === 0) invalid(field("text"), "请补充结果文字或依据");
  const resolveQuestions = unique(list(v.resolveQuestions, field("resolveQuestions"), (value, p) => {
    const q = record(value, p);
    keys(q, ["questionId", "revision", "answerText"], p);
    return { questionId: text(q.questionId, `${p}.questionId`), revision: integer(q.revision, `${p}.revision`, 1), answerText: text(q.answerText, `${p}.answerText`, 4000) };
  }), (q) => q.questionId, field("resolveQuestions"));
  const decisions = v.answerDecisions === undefined ? undefined : unique(
    list(v.answerDecisions, field("answerDecisions"), (value, p) => answerDecision(value, p, true) as AnswerDecision & { questionId: string }),
    (d) => d.questionId, field("answerDecisions"),
  );
  if (decisions?.some((d) => !resolveQuestions.some((q) => q.questionId === d.questionId))) invalid(field("answerDecisions"), "旧答案选择必须对应本次回答的问题");
  return { text: body, evidenceRefs, resolveQuestions, ...(decisions ? { answerDecisions: decisions } : {}) };
}

function decisionRequest(value: unknown): DecisionRequest {
  const v = record(value);
  keys(v, ["operation", "expectedContextVersion", "expectedCardRevision", "members", "deferUntil"]);
  const operation = choice(v.operation, "operation", operations);
  const members = unique(list(v.members, "members", (value, field): DecisionMember => {
    const m = record(value, field);
    keys(m, ["claimId", "claimVersionId", "operation", "newText", "origin", "evidenceRefIds", "conflictChoice", "questionChange", "factChange"], field);
    const memberOperation = choice(m.operation, `${field}.operation`, memberOperations);
    if (operation === "review_members" ? !["confirm", "edit", "reject", "accept_action"].includes(memberOperation) : memberOperation !== operation) invalid(`${field}.operation`, "成员操作与本次决定不一致");
    const result: DecisionMember = { claimId: text(m.claimId, `${field}.claimId`), claimVersionId: text(m.claimVersionId, `${field}.claimVersionId`), operation: memberOperation };
    if (memberOperation === "edit") {
      result.newText = text(m.newText, `${field}.newText`, 4000);
      result.origin = choice<"source_statement" | "user_input">(m.origin, `${field}.origin`, ["source_statement", "user_input"]);
      result.evidenceRefIds = ids(m.evidenceRefIds, `${field}.evidenceRefIds`);
      if (result.origin === "source_statement" && result.evidenceRefIds.length === 0) invalid(`${field}.evidenceRefIds`, "原话修正需要关联依据");
    } else if (m.newText !== undefined || m.origin !== undefined || m.evidenceRefIds !== undefined) invalid(field, "文本修改需要使用修改操作");
    if (m.questionChange !== undefined) {
      if (memberOperation !== "edit") invalid(field, "问题调整需要使用修改操作");
      const change = record(m.questionChange, `${field}.questionChange`);
      keys(change, ["answerChoices"], `${field}.questionChange`);
      result.questionChange = { answerChoices: unique(list(change.answerChoices, `${field}.questionChange.answerChoices`, (value, name) => {
        const item = record(value, name);
        keys(item, ["claimId", "claimVersionId", "mode"], name);
        return { claimId: text(item.claimId, `${name}.claimId`), claimVersionId: text(item.claimVersionId, `${name}.claimVersionId`), mode: choice<"keep"|"reopen">(item.mode, `${name}.mode`, ["keep", "reopen"]) };
      }, 0, 100), a => a.claimId, `${field}.questionChange.answerChoices`) };
    }
    if (m.factChange !== undefined) {
      if (memberOperation !== "edit" || m.questionChange !== undefined) invalid(field, "信息关联选择需要对应信息修改");
      const change = record(m.factChange, `${field}.factChange`);
      keys(change, ["questionChoices"], `${field}.factChange`);
      result.factChange = { questionChoices: unique(list(change.questionChoices, `${field}.factChange.questionChoices`, (value, name) => {
        const item = record(value, name);
        keys(item, ["claimId", "claimVersionId", "mode"], name);
        return { claimId: text(item.claimId, `${name}.claimId`), claimVersionId: text(item.claimVersionId, `${name}.claimVersionId`), mode: choice<"keep"|"reopen">(item.mode, `${name}.mode`, ["keep", "reopen"]) };
      }, 0, 100), a => a.claimId, `${field}.factChange.questionChoices`) };
    }
    if (memberOperation === "resolve_conflict") {
      const c = record(m.conflictChoice, `${field}.conflictChoice`);
      keys(c, ["mode", "existingRef", "candidateRef", "applicability"], `${field}.conflictChoice`);
      const mode = choice(c.mode, `${field}.conflictChoice.mode`, ["keep_existing", "use_candidate", "coexist"]);
      const existingRef = ref(c.existingRef, `${field}.conflictChoice.existingRef`);
      const candidateRef = ref(c.candidateRef, `${field}.conflictChoice.candidateRef`);
      if (existingRef.claimVersionId === candidateRef.claimVersionId) invalid(field, "冲突需要两个不同版本");
      result.conflictChoice = { mode, existingRef, candidateRef, ...(mode === "coexist" ? { applicability: text(c.applicability, `${field}.conflictChoice.applicability`, 4000) } : {}) };
    } else if (m.conflictChoice !== undefined) invalid(field, "该操作没有冲突选择");
    return result;
  }, 1), (m) => m.claimId, "members");
  if (v.deferUntil !== undefined && operation !== "defer") invalid("deferUntil", "仅稍后处理可指定时间");
  return { ...context(v), operation, expectedCardRevision: integer(v.expectedCardRevision, "expectedCardRevision", 1), members, ...(operation === "defer" ? { deferUntil: v.deferUntil == null ? null : timestamp(v.deferUntil, "deferUntil") } : {}) };
}

const contentFields = ["text", "evidenceRefs", "resolveQuestions", "answerDecisions"];
const validators: { [K in keyof WorkflowRequestMap]: (value: unknown) => WorkflowRequestMap[K] } = {
  McpConnectionRequest(value) {
    const v = record(value);
    keys(v, ["enabled"]);
    if (typeof v.enabled !== "boolean") invalid("enabled", "请选择开启或断开只读授权");
    return {enabled: v.enabled};
  },
  MentionDecisionRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "targetRef", "operation"]);
    return { ...context(v), targetRef: ref(v.targetRef, "targetRef"), operation: choice(v.operation, "operation", ["confirm", "reject", "convert"]) };
  },
  DecisionRequest: decisionRequest,
  OutcomeRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "expectedActionRevision", "completeAction", ...contentFields]);
    if (typeof v.completeAction !== "boolean") invalid("completeAction", "请明确是否同时完成行动");
    return { ...context(v), ...outcomeContent(v), expectedActionRevision: integer(v.expectedActionRevision, "expectedActionRevision", 1), completeAction: v.completeAction };
  },
  QuestionAnswerRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "expectedQuestionRevision", "answerText", "evidenceRefs", "answerDecision"]);
    return { ...context(v), expectedQuestionRevision: integer(v.expectedQuestionRevision, "expectedQuestionRevision", 1), answerText: text(v.answerText, "answerText", 4000), evidenceRefs: ids(v.evidenceRefs, "evidenceRefs"), ...(v.answerDecision === undefined ? {} : { answerDecision: answerDecision(v.answerDecision, "answerDecision") }) };
  },
  OutcomeCorrectionRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "expectedOutcomeRevision", "operation", "replacement"]);
    const base = { ...context(v), expectedOutcomeRevision: integer(v.expectedOutcomeRevision, "expectedOutcomeRevision", 1) };
    const operation = choice(v.operation, "operation", ["replace", "withdraw"]);
    if (operation === "withdraw") {
      if (v.replacement !== undefined) invalid("replacement", "撤回操作无需替换内容");
      return { ...base, operation };
    }
    const replacement = record(v.replacement, "replacement");
    keys(replacement, contentFields, "replacement");
    return { ...base, operation, replacement: outcomeContent(replacement, "replacement") };
  },
  ActionTransitionRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "expectedActionRevision", "operation"]);
    return { ...context(v), expectedActionRevision: integer(v.expectedActionRevision, "expectedActionRevision", 1), operation: choice(v.operation, "operation", ["complete", "reopen", "cancel"]) };
  },
  RevertDecisionRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "expectedDecisionRevision"]);
    return { ...context(v), expectedDecisionRevision: integer(v.expectedDecisionRevision, "expectedDecisionRevision", 1) };
  },
  SourceHighlightRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "assetVersionId", "ranges"]);
    const ranges = list(v.ranges, "ranges", (item, field) => {
      const r = record(item, field);
      keys(r, ["segmentId", "startOffset", "endOffset"], field);
      const startOffset = integer(r.startOffset, `${field}.startOffset`);
      const endOffset = integer(r.endOffset, `${field}.endOffset`, 1);
      if (endOffset <= startOffset) invalid(field, "选录范围应包含原文");
      return { segmentId: text(r.segmentId, `${field}.segmentId`), startOffset, endOffset };
    }, 1);
    if (ranges.reduce((total, r) => total + r.endOffset - r.startOffset, 0) > 4000) invalid("ranges", "每次选录最多 4,000 字符");
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j];
      if (a.segmentId === b.segmentId && a.startOffset < b.endOffset && b.startOffset < a.endOffset) invalid("ranges", "选录范围有重复或交叠");
    }
    return { ...context(v), assetVersionId: text(v.assetVersionId, "assetVersionId"), ranges };
  },
  ReviewProgressRequest(value) {
    const v = record(value);
    keys(v, ["snapshotId", "lastCardId", "mode"]);
    return { snapshotId: text(v.snapshotId, "snapshotId"), lastCardId: v.lastCardId === null ? null : text(v.lastCardId, "lastCardId"), mode: choice(v.mode, "mode", ["bookmark", "finish_session"]) };
  },
  ReportRequest(value) {
    const v = record(value);
    keys(v, ["expectedContextVersion", "scope", "eventIds", "format"]);
    return { ...context(v), scope: choice(v.scope, "scope", ["accepted", "mixed"]), eventIds: ids(v.eventIds, "eventIds", 0, 100), format: choice(v.format, "format", ["markdown", "plain_text"]) };
  },
  StartAnalysisRequest(value) {
    const v = record(value);
    keys(v, ["sourceRevision", "mode"]);
    return { sourceRevision: integer(v.sourceRevision, "sourceRevision"), mode: choice(v.mode, "mode", ["initial", "reorganize"]) };
  },
  RetryAnalysisRequest(value) {
    const v = record(value);
    keys(v, ["expectedRunRevision", "stageIds"]);
    return { expectedRunRevision: integer(v.expectedRunRevision, "expectedRunRevision", 1), stageIds: ids(v.stageIds, "stageIds", 1, 100) };
  },
  WorkspaceQuery: parseQuery,
  OverviewQuery: parseQuery,
};

function parseQuery(value: unknown): WorkspaceQuery {
  const v = record(value);
  keys(v, ["cursor", "snapshotId", "limit", "minContextVersion"]);
  const numeric = (x: unknown, field: string, min: number, max: number) => {
    const n = typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x;
    return integer(n, field, min, max);
  };
  const snapshotId = v.snapshotId === undefined ? undefined : text(v.snapshotId, "snapshotId");
  const cursor = v.cursor === undefined ? undefined : text(v.cursor, "cursor", 2048);
  if (cursor && !snapshotId) invalid("snapshotId", "翻页需要沿用原快照");
  return {
    limit: v.limit === undefined ? 20 : numeric(v.limit, "limit", 1, 50),
    ...(cursor ? { cursor } : {}), ...(snapshotId ? { snapshotId } : {}),
    ...(v.minContextVersion === undefined ? {} : { minContextVersion: numeric(v.minContextVersion, "minContextVersion", 0, Number.MAX_SAFE_INTEGER) }),
  };
}

/** Syntax validation is shared. Authorization, source support and version checks remain server-side. */
export function parseWorkflowRequest<K extends keyof WorkflowRequestMap>(name: K, input: unknown): WorkflowRequestMap[K] {
  return validators[name](input);
}


/** Consent controls record reads. Fixed tool discovery is available to verified assistants. */
export type McpConnectionStatus = {
  authenticated: boolean;
  enabled: boolean;
  scope: "mcp:read";
  endpoint: "/mcp";
  expiresAt: string | null;
  accountEmail: string | null;
};

export function parseMcpConnectionStatus(value: unknown): McpConnectionStatus {
  const v = record(value);
  keys(v, ["authenticated", "enabled", "scope", "endpoint", "expiresAt", "accountEmail"]);
  if (typeof v.authenticated !== "boolean" || typeof v.enabled !== "boolean") invalid("enabled", "连接状态无效");
  if (v.enabled && !v.authenticated) invalid("authenticated", "授权需要登录身份");
  const expiresAt = v.expiresAt === null ? null : timestamp(v.expiresAt, "expiresAt");
  const accountEmail = v.accountEmail === null ? null : text(v.accountEmail, "accountEmail", 320);
  if (v.authenticated !== Boolean(accountEmail)) invalid("accountEmail", "登录账号与状态不一致");
  return {authenticated: v.authenticated, enabled: v.enabled, scope: choice(v.scope, "scope", ["mcp:read"]), endpoint: choice(v.endpoint, "endpoint", ["/mcp"]), expiresAt, accountEmail};
}
