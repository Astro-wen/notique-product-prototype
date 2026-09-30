import {
  parseWorkflowRequest,
  WorkflowValidationError,
  type Bullet,
  type Action,
  type Coverage,
  type Question,
  type ReaffirmedMention,
  type ReportRequest,
  type ReviewCard,
  type SourceHighlightRequest,
  type VersionRef,
} from "../shared/workflow-v2.ts";

/** Ordinary drafts remain readable without becoming compulsory review work. */
export function priorityCards(cards: readonly ReviewCard[]): ReviewCard[] {
  const rank = { accepted_change: 0, blocking_question: 1, action_choice: 2 };
  return cards.filter((card) => card.needsDecision && card.disposition === "active")
    .sort((a, b) => (a.reasonCode === null ? 3 : rank[a.reasonCode]) - (b.reasonCode === null ? 3 : rank[b.reasonCode]) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id));
}

/** Answers occupy the original question's place in the current record. History
 * still retains the question and its exact answer relations. */
export function currentRecordBullets(bullets: readonly Bullet[], questions: readonly Question[]): Bullet[] {
  if (!questions.length) return [...bullets];
  const byVersion = new Map(bullets.flatMap(b => b.claimRefs.map(r => [r.claimVersionId, b] as const)));
  const resolved = new Map(questions.filter(q => q.resolutionState === "resolved").map(q => [q.claimRef.claimVersionId, q]));
  const output: Bullet[] = [];
  const emitted = new Set<string>();
  const emit = (b: Bullet) => { if (!emitted.has(b.id)) { emitted.add(b.id); output.push(b); } };
  const replacing = new Set([...resolved.values()].flatMap(q => q.answerRefs.map(r => r.claimVersionId)));
  for (const bullet of bullets) {
    const question = bullet.claimRefs.map(r => resolved.get(r.claimVersionId)).find(Boolean);
    const answers = question?.answerRefs.flatMap(r => { const b = byVersion.get(r.claimVersionId); return b && b.sourceStatus === "ready" ? [b] : []; }) ?? [];
    if (answers.length) answers.forEach(emit);
    else if (!bullet.claimRefs.some(r => replacing.has(r.claimVersionId))) emit(bullet);
  }
  // Standalone answers and versions without a visible question stay available.
  for (const bullet of bullets) if (!emitted.has(bullet.id) && bullet.claimRefs.some(r => replacing.has(r.claimVersionId))) emit(bullet);
  return output;
}

/** Fold explicit review pairs into one reading entry. Export keeps both versions. */
export function recordDisplayBullets(bullets:readonly Bullet[], cards:readonly ReviewCard[]):Bullet[] {
  const hidden=new Set<string>();
  for(const card of cards) {
    if(card.actionOverlap && card.disposition!=='processed') {
      const manual=bullets.find(b=>b.claimRefs.some(r=>sameVersion(r,card.actionOverlap!.manualRef)));
      const model=bullets.find(b=>b.claimRefs.some(r=>sameVersion(r,card.actionOverlap!.modelRef)));
      if(manual && model)hidden.add(model.reviewState==='accepted' && manual.reviewState!=='accepted'?manual.id:model.id);
    }
    if(!card.sameIntent)continue;
    const find=(ref:VersionRef)=>bullets.find(b=>b.claimRefs.some(r=>r.claimId===ref.claimId && r.claimVersionId===ref.claimVersionId));
    const record=find(card.sameIntent.recordRef),action=find(card.sameIntent.actionRef);
    if(!record || !action)continue;
    const candidate=card.kind==='conflict' && card.conflicts?.length?find(card.conflicts[0].candidateRef):undefined;
    const primary=candidate ?? (record.reviewState==='accepted'?record:action);
    hidden.add(primary===record?action.id:record.id);
  }
  return bullets.filter(b=>!hidden.has(b.id));
}

export function recordCounts(bullets: readonly Bullet[], cards: readonly ReviewCard[], actions: readonly { executionState: string }[], questions: readonly Question[] = []) {
  return {
    draftCount: currentRecordBullets(bullets, questions).filter((b) => b.reviewState === "draft").length,
    needsDecisionCount: priorityCards(cards).length,
    openActionCount: actions.filter((a) => a.executionState === "open").length,
  };
}

/** Rendering never rewrites user wording or asks a model to regenerate it. */
export function buildRecordText(input: {
  title: string;
  bullets: readonly Bullet[];
  questions: readonly Question[];
  actions?: readonly Action[];
  coverage: Coverage;
  reaffirmedMentions?: readonly ReaffirmedMention[];
  scope: ReportRequest["scope"];
  format: ReportRequest["format"];
}): string {
  const markdown = input.format === "markdown";
  const literal = (s: string) => markdown ? s.replace(/[\\`*_{}[\]()#+.!<>|~-]/g, "\\$&").replace(/\r?\n/g, " ") : s;
  const lines = [markdown ? `# ${literal(input.title)}` : input.title, ""];
  if (!input.coverage.complete) lines.push(`已整理 ${input.coverage.completedSegments}/${input.coverage.totalSegments} 段，部分材料仍待处理。`, "");
  const bullets = currentRecordBullets(input.bullets, input.questions).filter((b) => input.scope === "mixed" || b.reviewState === "accepted");
  for (const bullet of bullets) {
    if (bullet.sourceStatus !== "ready") {
      // Source text that has become inaccessible is omitted even from mixed exports.
      lines.push(`- 待补依据：${bullet.id}`);
      continue;
    }
    const label = bullet.reviewState === "draft" ? bullet.origin === "user_input" ? "用户补充 · 待确认" : bullet.origin === "user_selection" ? "用户选录 · 待确认" : "AI 草稿" : bullet.origin === "user_selection" ? "用户选录" : bullet.origin === "user_input" ? "用户补充" : "已采纳";
    const body = bullet.applicability ? `${bullet.text} · 适用情况：${bullet.applicability}` : bullet.text;
    const action=input.actions?.find(a=>bullet.claimRefs.some(r=>sameVersion(r,a.claimRef)));
    const execution=action?` · ${action.executionState==='completed'?'已完成':action.executionState==='cancelled'?'已取消':'待跟进'}`:'';
    lines.push(`- ${literal(body)}${markdown ? "  " : " "}· ${label}${execution}${bullet.conflictWith?.length ? " · 新旧信息待选择" : ""}`);
  }
  const mentions=input.scope==='mixed'?(input.reaffirmedMentions ?? []).filter(m=>m.associationState!=='confirmed' || m.targetState!=='current' || m.sourceStatus!=='ready' || m.targetText===null):[];
  for(const mention of mentions) {
    if(mention.sourceStatus!=='ready' || !mention.statement){lines.push(`- 再次提及，出处待核对：${mention.id}`);continue;}
    const state=mention.associationState==='proposed'?'AI 关联待核对':mention.targetState==='changed'?'关联的原事项已更新':mention.targetState==='retired'?'关联的原事项已移出当前跟进':mention.targetState==='current'?'原事项的依据需要重新核对':'关联的原事项不可访问';
    lines.push(`- ${literal(mention.statement)} · 再次提及 · ${state}`);
  }
  if (!bullets.length && !mentions.length) lines.push(input.scope === "accepted" ? "当前范围尚无已采纳内容。" : "正在整理这份记录。");
  return lines.join("\n");
}

export type SourceSegment = {
  id: string;
  assetVersionId: string;
  ordinal: number;
  textRaw: string;
};

/** Resolve selections against immutable source text, never caller-supplied quotes. */
export function selectSourceRanges(input: SourceHighlightRequest, source: readonly SourceSegment[]): {
  quote: string;
  ranges: SourceHighlightRequest["ranges"];
  segmentIds: string[];
} {
  const request = parseWorkflowRequest("SourceHighlightRequest", input);
  const segments = new Map(source.filter((s) => s.assetVersionId === request.assetVersionId).map((s) => [s.id, s]));
  const ranges = request.ranges.map((range) => {
    const segment = segments.get(range.segmentId);
    if (!segment) throw new WorkflowValidationError("ranges", "原文片段与所选材料版本不一致");
    if (range.endOffset > segment.textRaw.length) throw new WorkflowValidationError("ranges", "选录范围超出原文");
    for (const offset of [range.startOffset, range.endOffset]) {
      const left = segment.textRaw.charCodeAt(offset - 1), right = segment.textRaw.charCodeAt(offset);
      if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) throw new WorkflowValidationError("ranges", "请选取完整字符");
    }
    return { ...range, ordinal: segment.ordinal, quote: segment.textRaw.slice(range.startOffset, range.endOffset) };
  }).sort((a, b) => a.ordinal - b.ordinal || a.segmentId.localeCompare(b.segmentId) || a.startOffset - b.startOffset);
  // Canonicalize adjacent selections so split and continuous selection deduplicate.
  const canonical: SourceHighlightRequest["ranges"] = [];
  for (const range of ranges) {
    const last = canonical.at(-1);
    if (last?.segmentId === range.segmentId && last.endOffset === range.startOffset) last.endOffset = range.endOffset;
    else canonical.push({ segmentId: range.segmentId, startOffset: range.startOffset, endOffset: range.endOffset });
  }
  const quote = canonical.map((r) => segments.get(r.segmentId)!.textRaw.slice(r.startOffset, r.endOffset)).join("\n");
  if (!quote.trim()) throw new WorkflowValidationError("ranges", "请选取有内容的原话");
  return { quote, ranges: canonical, segmentIds: [...new Set(canonical.map((r) => r.segmentId))] };
}

export function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.claimId === right.claimId && left.claimVersionId === right.claimVersionId;
}
