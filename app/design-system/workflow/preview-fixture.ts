import type { Bullet, ReviewCard, WorkspaceSnapshot } from "@/lib/shared/workflow-v2";

const rows = [
  { id: "budget", text: "本次装修预算大约三十万元，希望先把硬装方案确定下来。", kind: "record", reason: "", supportStatus: "partially_supports", needsDecision: false, reasonCode: null },
  { id: "timing", text: "希望年底前搬入，具体开工时间等报价确认后再定。", kind: "record", reason: "", supportStatus: "fully_supports", needsDecision: false, reasonCode: null },
  { id: "fee", text: "安装费用还没有确定，需要向供应商确认。", kind: "question", reason: "费用确定后，才能决定是否采用这套方案。", supportStatus: "fully_supports", needsDecision: false, reasonCode: null },
  { id: "quote", text: "向供应商询问包含安装的完整报价。", kind: "action", reason: "对应上面的费用问题，加入后可记录跟进结果。", supportStatus: "fully_supports", needsDecision: true, reasonCode: "action_choice" },
] as const;

export function createWorkflowPreview(): WorkspaceSnapshot {
  const bullets: Bullet[] = rows.map((r) => ({ id: r.id, text: r.text, claimRefs: [{ claimId: r.id, claimVersionId: `${r.id}-v1` }], reviewState: "draft", origin: r.kind === "action" ? "ai_suggestion" : "source_statement", sourceStatus: "ready" }));
  const reviewCards: ReviewCard[] = rows.map((r) => ({ id: `card-${r.id}`, revision: 1, kind: r.kind, title: r.text, memberRefs: [{ claimId: r.id, claimVersionId: `${r.id}-v1` }], members: [{ kind: r.kind, claimId: r.id, claimVersionId: `${r.id}-v1`, statement: r.text, reviewState: "draft", origin: r.kind === "action" ? "ai_suggestion" : "source_statement", supportStatus: r.supportStatus, evidenceRefIds: [`evidence-${r.id}`] }], suggestedOperation: r.kind === "action" ? "accept_action" : "confirm", needsDecision: r.needsDecision, reasonCode: r.reasonCode, reason: r.reason, disposition: "active", sourceStatus: "ready", latestDecisionId: null, decisionRevision: null }));
  return {
    access: { workspaceId: "preview", actorId: "preview", canEdit: true },
    snapshotId: "preview-1", contextVersion: 1, sourceRevision: 1,
    coverage: { totalSegments: 4, completedSegments: 4, complete: true, unprocessedRanges: [] },
    bullets, reviewCards, actions: [],
    questions: [{ id: "fee", claimRef: { claimId: "fee", claimVersionId: "fee-v1" }, revision: 1, resolutionState: "open", answerRefs: [], latestOutcome: null }],
    narrative: null, counts: { draftCount: 4, needsDecisionCount: 1, openActionCount: 0 }, nextCursor: null,
  };
}

export const previewSources = [
  { evidenceRefId: "evidence-budget", timestamp: "01:08", speaker: "客户", quote: "预算的话，大约三十五万吧。我想先把硬装方案定下来，软装后面再看。" },
  { evidenceRefId: "evidence-timing", timestamp: "02:31", speaker: "客户", quote: "最好年底前能搬进去，开工时间就等报价确认之后再定。" },
  { evidenceRefId: "evidence-fee", timestamp: "04:16", speaker: "顾问", quote: "安装这一块还没有确定，我再问一下供应商，有了报价我们再决定。" },
  { evidenceRefId: "evidence-quote", timestamp: "04:16", speaker: "顾问", quote: "安装这一块还没有确定，我再问一下供应商，有了报价我们再决定。" },
];
