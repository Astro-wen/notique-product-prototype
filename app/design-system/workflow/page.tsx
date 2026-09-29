"use client";

import { useRef, useState } from "react";
import { RecordWorkspace } from "@/app/features/workflow/components/record-workspace";
import { createWorkflowPreview, previewSources } from "./preview-fixture";
import { buildRecordText, recordCounts } from "@/lib/domain/workflow-v2";
import { parseWorkflowRequest, type WorkspaceSnapshot } from "@/lib/shared/workflow-v2";

/** Isolated synthetic interaction preview. Production callbacks are wired by the workspace page. */
export default function WorkflowPreviewPage() {
  const [snapshot, setSnapshot] = useState(createWorkflowPreview);
  const state = useRef(snapshot);
  const [readOnly, setReadOnly] = useState(false);
  const [failNext, setFailNext] = useState(false);

  function mutate(expected: number, work: (next: WorkspaceSnapshot) => void) {
    if (readOnly) throw new Error("当前为只读模式。");
    if (failNext) { setFailNext(false); throw new Error("示例网络中断，请重试。你的输入仍然保留。"); }
    if (state.current.contextVersion !== expected) throw new Error("记录已更新，请按最新内容继续。");
    const next = structuredClone(state.current);
    work(next);
    next.contextVersion += 1;
    next.snapshotId = `preview-${next.contextVersion}`;
    next.counts = recordCounts(next.bullets, next.reviewCards, next.actions, next.questions);
    state.current = next;
    setSnapshot(next);
  }
  return <>
    <aside style={{ padding: "10px 24px", background: "#edf2ff", color: "#2d56cf", fontSize: 13, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }} aria-label="交互预览控制">
      <span>交互预览 · 合成示例，刷新重置</span>
      <label><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> 只读模式</label>
      <button onClick={() => setFailNext(true)} disabled={failNext} style={{ color: "inherit", background: "white", border: "1px solid #b9c9ff", padding: "4px 8px", borderRadius: 4 }}>模拟下次保存失败</button>
    </aside>
    <RecordWorkspace title="新居装修 · 方案沟通" subtitle="9 月 28 日 · 18 分钟 · 一份沟通记录" snapshot={snapshot} sources={previewSources} canEdit={!readOnly}
      onDecide={async (id, raw) => {
        const request = parseWorkflowRequest("DecisionRequest", raw);
        mutate(request.expectedContextVersion, (next) => {
          const card = next.reviewCards.find((c) => c.id === id);
          if (!card || card.revision !== request.expectedCardRevision) throw new Error("这条内容已经变化。");
          if (request.operation === "defer" || request.operation === "restore") {
            card.disposition = request.operation === "defer" ? "deferred" : "active";
          } else {
            for (const member of request.members) {
              const bullet = next.bullets.find((b) => b.claimRefs.some((ref) => ref.claimId === member.claimId && ref.claimVersionId === member.claimVersionId));
              if (!bullet) throw new Error("原版本已变化。");
              if (request.operation === "reject") next.bullets = next.bullets.filter((b) => b.id !== bullet.id);
              else {
                bullet.reviewState = "accepted";
                if (request.operation === "edit") {
                  bullet.text = member.newText!;
                  bullet.origin = member.origin!;
                  bullet.claimRefs = [{ claimId: member.claimId, claimVersionId: `${member.claimId}-v${card.revision + 1}` }];
                  card.memberRefs = bullet.claimRefs;
                  card.members = [{ ...card.members[0], ...bullet.claimRefs[0], statement: bullet.text, reviewState: "accepted", origin: bullet.origin, supportStatus: "fully_supports", evidenceRefIds: member.evidenceRefIds ?? [] }];
                } else card.members.forEach((m) => { m.reviewState = "accepted"; });
                if (request.operation === "accept_action" && !next.actions.some((a) => a.id === member.claimId)) next.actions.push({ id: member.claimId, revision: 1, claimRef: bullet.claimRefs[0], executionState: "open", questionRefs: [{ ...next.questions[0].claimRef, revision: next.questions[0].revision }], basisState: "current", basisDetails: [], latestOutcome: null });
              }
            }
            card.disposition = "processed";
          }
          card.revision += 1;
        });
      }}
      onTransition={async (id, raw) => {
        const request = parseWorkflowRequest("ActionTransitionRequest", raw);
        mutate(request.expectedContextVersion, (next) => {
          const action = next.actions.find((a) => a.id === id);
          if (!action || action.revision !== request.expectedActionRevision) throw new Error("行动已更新。");
          action.executionState = request.operation === "complete" ? "completed" : request.operation === "cancel" ? "cancelled" : "open";
          action.revision += 1;
        });
      }}
      onAnswer={async (id, raw) => {
        const request = parseWorkflowRequest("QuestionAnswerRequest", raw);
        mutate(request.expectedContextVersion, (next) => {
          const question = next.questions.find((q) => q.id === id);
          if (!question || question.revision !== request.expectedQuestionRevision) throw new Error("问题已更新。");
          const claimRef = { claimId: `answer-${id}`, claimVersionId: `answer-${id}-v1` };
          question.resolutionState = "resolved";
          question.answerRefs = [claimRef];
          question.revision += 1;
          const outcome = { id: `outcome-${id}`, revision: 1, text: request.answerText, answerRefs: [claimRef], updatedAt: new Date().toISOString() };
          question.latestOutcome = outcome;
          next.bullets.push({ id: claimRef.claimId, text: request.answerText, claimRefs: [claimRef], reviewState: "accepted", origin: "user_input", sourceStatus: "ready" });
          const card = next.reviewCards.find((c) => c.memberRefs.some((r) => r.claimId === id));
          if (card) { card.disposition = "processed"; card.revision += 1; }
          next.actions.filter((a) => a.questionRefs.some((r) => r.claimId === id)).forEach((a) => { a.latestOutcome = outcome; });
        });
      }}
      onReport={async (raw) => {
        const request = parseWorkflowRequest("ReportRequest", raw);
        return buildRecordText({ title: "新居装修 · 方案沟通", ...state.current, ...request });
      }}
    />
  </>;
}
