"use client";

import { useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Check, ChevronDown, Copy, Link2, Plus, Undo2 } from "lucide-react";
import { NqButton as BaseButton, NqStatus } from "@/app/components/notique-ui";
import { Modal } from "@/app/components/modal";
import { currentRecordBullets, recordDisplayBullets } from "@/lib/domain/workflow-v2";
import { readingTopics, pendingItems } from '@/lib/domain/record-reading';
import { userMayAcceptSupport } from "@/lib/domain/review-support";
import type { MentionDecisionRequest, ReviewProgress, ReviewProgressRequest, SourceHighlightRequest, ActionTransitionRequest, DecisionRequest, MemberDecisionOperation, OutcomeRequest, OutcomeCorrectionRequest, QuestionAnswerRequest, ReportRequest, ReviewCard, RevertDecisionRequest, WorkspaceSnapshot } from "@/lib/shared/workflow-v2";
import { useMemoryDrafts,useDraftCheckpoint } from "./memory-drafts";
import { SourceHighlightEditor, type HighlightSource } from "./source-highlight-editor";
import { QuestionEditor } from "./question-editor";
import { MemberReview } from "./member-review";
import { FactAnswerReview, factChangeFor, factChoicesFor, type FactChoices } from "./fact-answer-review";
import { ConflictReview } from "./conflict-review";
import { ActionBasisReview } from "./action-basis-review";
import { OutcomeEditor, type OutcomeTarget } from "./outcome-editor";
import { ApiClientError } from "@/app/api-client";
import { WORKFLOW_LEAVE_EVENT } from "../state-navigation";
import styles from "./record-workspace.module.css";

export type RecordSource = { evidenceRefId: string; quote: string; speaker: string; timestamp: string; audioUrl?: string; audioStartSeconds?: number; viewUrl?: string };
export type RecordWorkspaceProps = {
  analysisPanel?: ReactNode;
  retainedInputs?: ReactNode;
  analysisHasCoverage?: boolean;
  analysisHasNarrative?: boolean;
  focusClaimId?:string;
  onMention?: (id:string,request:MentionDecisionRequest)=>Promise<void>;
  onProgress?: (body:ReviewProgressRequest)=>Promise<ReviewProgress>;
  onHighlight?: (body:SourceHighlightRequest)=>Promise<void>;
  onHighlightSources?: ()=>Promise<HighlightSource[]>;
  onRevert?: (id:string,request:RevertDecisionRequest)=>Promise<void>;
  embedded?: boolean;
  processing?: boolean;
  eventId?: string;
  projectId?: string;
  onOpenTranscript?: () => void;
  onOpenRecord?: (eventId:string,claimId?:string)=>void;
  onSources?: (ids: string[]) => Promise<RecordSource[]>;
  onOutcome?: (actionId: string, request: OutcomeRequest) => Promise<void>;
  onCorrection?: (outcomeId: string, request: OutcomeCorrectionRequest) => Promise<void>;
  title: string;
  subtitle: string;
  snapshot: WorkspaceSnapshot;
  canEdit?: boolean;
  sources: RecordSource[];
  onDecide: (cardId: string, request: DecisionRequest) => Promise<void>;
  onTransition: (actionId: string, request: ActionTransitionRequest) => Promise<void>;
  onAnswer: (questionId: string, request: QuestionAnswerRequest) => Promise<void>;
  onReport: (request: ReportRequest, signal?:AbortSignal) => Promise<string>;
  onContinue?: () => void;
};
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
const noDrafts:never[]=[];
const emptyDraftSnapshot=()=>noDrafts;
function NqButton(props: ComponentProps<typeof BaseButton>) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  return <BaseButton {...props} disabled={!ready || props.disabled} />;
}

type Editor = { questionChoices?:FactChoices; touched?:boolean; initialOrigin?:"source_statement"|"user_input"; base?: WorkspaceSnapshot; conflict?: boolean; kind: "edit" | "answer"; id: string; value: string; initial: string; origin: "source_statement" | "user_input" };

export function RecordWorkspace({ retainedInputs, analysisPanel, analysisHasCoverage=false, analysisHasNarrative=false, focusClaimId, onMention, onProgress, onHighlight, onHighlightSources, onRevert, embedded = false, processing = false, eventId, projectId, onOpenRecord, onSources, onOutcome, onCorrection, title, subtitle, snapshot, sources, onDecide, onTransition, onAnswer, onReport, onContinue, canEdit = true }: RecordWorkspaceProps) {
  const memory=useMemoryDrafts();
  const retainedDrafts=useSyncExternalStore(memory?.subscribe ?? subscribeReady,memory?.getSnapshot ?? emptyDraftSnapshot,emptyDraftSnapshot);
  const [recoveries]=useState(()=>({inline:memory?.restored('inline'),outcome:memory?.restored('outcome'),members:memory?.restored('members'),conflict:memory?.restored('conflict'),highlight:memory?.restored('highlight'),question:memory?.restored('question')}));
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const focusedRequest=useRef<string|null>(null);
  const contentRoot=useRef<HTMLDivElement>(null);
  const lastSeen=useRef(snapshot.reviewProgress?.lastCardId ?? null);
  const lastSaved=useRef(snapshot.reviewProgress?.lastCardId ?? null);
  const [resumeCard]=useState(snapshot.reviewProgress?.lastCardId ?? null);
  const [resumed,setResumed]=useState(false);
  const [priorityLimit,setPriorityLimit]=useState(5);
  const [highlightOpen,setHighlightOpen]=useState(Boolean(recoveries.highlight));
  const [outcomeEditor, setOutcomeEditor] = useState<OutcomeTarget | null>(()=>{
    const d=recoveries.outcome;if(!d)return null;
    const target=(d.targetKind==='question'?snapshot.questions:snapshot.actions).find(x=>x.id===d.targetId);
    if(!target || d.correctionId && target.latestOutcome?.id!==d.correctionId || Object.keys(d.answers).some(id=>!snapshot.questions.some(q=>q.id===id && (d.targetKind==='question'?q.id===d.targetId:('questionRefs' in target && (target.questionRefs.some(r=>r.claimId===q.id) || !d.correctionId && snapshot.reviewCards.some(c=>c.sourceStatus==='ready' && c.eventId===snapshot.reviewCards.find(a=>a.memberRefs.some(r=>r.claimId===target.id))?.eventId && c.memberRefs.some(r=>r.claimId===q.id))))))))return null;
    return {kind:d.targetKind,id:d.targetId,...(d.correctionId?{correction:target.latestOutcome!}:{})};
  });
  const [conflictTarget,setConflictTarget]=useState<string|null>(()=>recoveries.conflict && snapshot.reviewCards.some(c=>c.id===recoveries.conflict!.targetId && c.conflicts?.length)?recoveries.conflict.targetId:null);
  const [questionTarget,setQuestionTarget]=useState<string|null>(()=>recoveries.question && snapshot.questions.some(q=>q.id===recoveries.question!.targetId) && snapshot.reviewCards.some(c=>c.memberRefs.some(r=>r.claimId===recoveries.question!.targetId))?recoveries.question.targetId:null);
  const [basisTarget,setBasisTarget]=useState<string|null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(()=>{
    const d=recoveries.inline;if(!d)return null;
    const card=snapshot.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===d.claimId)),question=snapshot.questions.find(q=>q.id===d.claimId);
    if(d.mode==='edit' && (!card || card.members.length!==1 || card.members[0].reviewState==='rejected' || !snapshot.bullets.some(b=>b.claimRefs.some(r=>r.claimId===d.claimId))) || d.mode==='answer' && !question)return null;
    const text=d.mode==='edit'?card!.members[0].statement:'';
    return {kind:d.mode,questionChoices:d.questionChoices,id:d.mode==='edit'?card!.id:question!.id,value:d.value ?? text,initial:text,origin:d.origin,initialOrigin:d.origin,touched:d.value!==undefined,base:snapshot,conflict:true};
  });
  const inlineEditorId=editor?.id;
  useEffect(()=>{
    if(inlineEditorId)document.getElementById(`workflow-editor-${inlineEditorId}`)?.scrollIntoView({block:'nearest',behavior:'smooth'});
  },[inlineEditorId]);
  const [memberTarget,setMemberTarget]=useState<{cardId:string;editClaimId?:string}|null>(()=>recoveries.members && snapshot.reviewCards.some(c=>c.id===recoveries.members!.targetId && ['record','action'].includes(c.kind) && Object.keys(recoveries.members!.choices).every(id=>c.members.some(m=>m.claimId===id)))?{cardId:recoveries.members.targetId,editClaimId:recoveries.members.editClaimId}:null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const writing = [...pending].some(id => id !== "report" && id !== "progress");
  const [queuedEditor, setQueuedEditor] = useState<{kind:Editor['kind'];id:string;afterContextVersion:number}|null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [sourceCard, setSourceCard] = useState<ReviewCard | null>(null);
  const sourceEpoch=useRef(0);
  const [loadedSources, setLoadedSources] = useState<RecordSource[]>([]);
  const [sourceState, setSourceState] = useState<"idle" | "loading" | "error">("idle");
  const [sourceTrigger, setSourceTrigger] = useState<string>();
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const copyController=useRef<AbortController|null>(null);
  useEffect(()=>()=>{copyController.current?.abort(new DOMException('已切换记录','AbortError'));},[]);
  const [filter, setFilter] = useState<"all" | "decisions" | "accepted">("all");
  const inputId = useId();
  const lastDecision=snapshot.recentDecisions?.[0];
  const priorities = pendingItems(snapshot);
  const inlineClaim=editor?.kind==='answer'?editor.id:editor?.base?.reviewCards.find(c=>c.id===editor.id)?.members[0]?.claimId;
  useDraftCheckpoint(editor && inlineClaim && (editor.touched || editor.origin!==editor.initialOrigin)?{kind:'inline',targetId:editor.id,mode:editor.kind,claimId:inlineClaim,...(editor.touched?{value:editor.value}:{}),origin:editor.origin,...(editor.questionChoices?{questionChoices:editor.questionChoices}:{})}:null);
  const unrestored=Boolean(recoveries.inline&&!editor || recoveries.outcome&&!outcomeEditor || recoveries.members&&!memberTarget || recoveries.conflict&&!conflictTarget || recoveries.question&&!questionTarget);
  const dirty = (editor !== null && (editor.touched || editor.value !== editor.initial || editor.origin!==editor.initialOrigin)) || outcomeEditor !== null || conflictTarget !== null || highlightOpen || memberTarget!==null || questionTarget!==null || unrestored && retainedDrafts.length>0;
  const decisionLocked = writing || dirty || pending.has('report');
  function changeFilter(next: typeof filter) {
    if (dirty && next !== filter) { setError("请先保存或取消当前输入，再切换重点范围。"); return; }
    if (next === "decisions") setPriorityLimit(5);
    setFilter(next);
  }
  useLayoutEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const beforeNavigate = (event: Event) => { event.preventDefault(); setError("当前输入尚未保存，请先保存或取消，再离开这份记录。"); };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(WORKFLOW_LEAVE_EVENT,beforeNavigate);
    return () => {window.removeEventListener("beforeunload", beforeUnload);window.removeEventListener(WORKFLOW_LEAVE_EVENT,beforeNavigate);};
  }, [dirty]);

  async function run(id: string, work: () => Promise<void>, success: string | (() => string)) {
    setError("");
    setPending((ids) => new Set([...ids, id]));
    try { await work(); setFeedback(typeof success === "function" ? success() : success); }
    catch (cause) { setQueuedEditor(null);setFeedback(""); if (cause instanceof ApiClientError && cause.status === 409) setEditor(value=>value?{...value,conflict:true}:null); const details=cause instanceof ApiClientError?cause.details as {affectedItems?:Array<{text?:string}>}|undefined:undefined;
      const affected=details?.affectedItems?.flatMap(item=>item.text?[item.text]:[]).join("、");
      setError((cause instanceof Error ? cause.message : "保存失败，请重试。你的输入仍然保留。")+(affected?` 受影响内容：${affected}`:"")); }
    finally { setPending((ids) => { const next = new Set(ids); next.delete(id); return next; }); }
  }
  async function trackWrite(id: string, work: () => Promise<void>) {
    setPending(ids => new Set([...ids, id]));
    try { await work(); }
    finally { setPending(ids => { const next = new Set(ids); next.delete(id); return next; }); }
  }
  function openEditor(next: Editor) {
    if(copyController.current){setError('正在同步记录，复制完成后再修改。');return;}
    if (dirty && editor?.id !== next.id) { setError("当前还有未保存的输入，请先保存或取消。"); return; }
    if(outcomeEditor) {setError("请先保存或取消当前结果。");return;}
    if ([...pending].some((id) => id !== 'report' && id !== 'progress')) {
      setQueuedEditor({kind:next.kind,id:next.id,afterContextVersion:snapshot.contextVersion});
      setFeedback("");
      return;
    }
    setError(""); setEditor({...next,base:snapshot,initialOrigin:next.origin,questionChoices:{}});
  }
  useEffect(() => {
    if (!queuedEditor || pending.size || snapshot.contextVersion <= queuedEditor.afterContextVersion) return;
    const frame=requestAnimationFrame(()=>{
      if (queuedEditor.kind === 'edit') {
        const card=snapshot.reviewCards.find((item)=>item.id===queuedEditor.id);
        const member=card?.members.length===1?card.members[0]:null;
        if (!member || member.reviewState==='rejected') {
          setError("这条内容已经变化，请重新打开后编辑。");setQueuedEditor(null);return;
        }
        const origin=member.origin==='user_input'||!member.evidenceRefIds.length?'user_input':'source_statement';
        setEditor({kind:'edit',id:card!.id,value:member.statement,initial:member.statement,origin,initialOrigin:origin,base:snapshot,questionChoices:{}});
      } else if (snapshot.questions.some((question)=>question.id===queuedEditor.id)) {
        setEditor({kind:'answer',id:queuedEditor.id,value:'',initial:'',origin:'user_input',initialOrigin:'user_input',base:snapshot,questionChoices:{}});
      } else {setError("问题已经变化，请重新打开后编辑。");setQueuedEditor(null);return;}
      setError("");setFeedback("");setQueuedEditor(null);
    });
    return ()=>cancelAnimationFrame(frame);
  },[queuedEditor,pending.size,snapshot]);
  useEffect(() => {
    if (!queuedEditor) return;
    const timeout=window.setTimeout(()=>{
      setQueuedEditor(null);setFeedback("");
      setError("上一项仍在保存，请核对最新记录后再修改。");
    },15_000);
    return ()=>window.clearTimeout(timeout);
  },[queuedEditor]);
  function openQuestion(id:string) {
    if(dirty){setError("请先保存或取消当前输入。");return;}setError("");setQuestionTarget(id);
  }
  function decision(card: ReviewCard, operation: MemberDecisionOperation, claimId?:string) {
    return run(card.id, () => onDecide(card.id, {
      expectedContextVersion: snapshot.contextVersion, expectedCardRevision: card.revision,
      operation, members: card.memberRefs.filter(ref=>!claimId || ref.claimId===claimId).map((ref) => ({ ...ref, operation })),
      ...(operation === "defer" ? { deferUntil: null } : {}),
    }), operation === "accept_action" ? "已加入跟进，记录已更新。" : operation === "defer" ? "已留待稍后，记录仍然保留。" : operation === "reject" ? "已移出当前记录。" : "已更新这条记录，其他内容保持不变。");
  }
  async function saveEditor() {
    if (!editor) return;
    const current = editor;
    const base = current.base ?? snapshot;
    await run(current.id, async () => {
      if (current.kind === "edit") {
        const card = base.reviewCards.find((c) => c.id === current.id);
        if (!card || card.members.length !== 1) throw new Error("这条内容已经变化，请重新打开后编辑。");
        const member = card.members[0];
        await onDecide(card.id, { expectedContextVersion: base.contextVersion, expectedCardRevision: card.revision, operation: "edit", members: [{ claimId: member.claimId, claimVersionId: member.claimVersionId, operation: "edit", newText: current.value, origin: current.origin, evidenceRefIds: current.origin === "source_statement" ? member.evidenceRefIds : [],...(member.answerTargets?.length?{factChange:factChangeFor(member,current.questionChoices)}:{}) }] });
      } else {
        const question = base.questions.find((q) => q.id === current.id);
        if (!question) throw new Error("问题已更新，请刷新后继续。");
        await onAnswer(question.id, { expectedContextVersion: base.contextVersion, expectedQuestionRevision: question.revision, answerText: current.value, evidenceRefs: [] });
      }
      memory?.clear('inline');setEditor((value) => value?.id === current.id ? null : value);
    }, current.kind === "edit" ? "修改已保存，记录已更新。" : "答案已保存，已更新重点。");
  }
  async function copy(scope: ReportRequest["scope"]) {
    if(copyController.current)return;
    if(dirty && !writing){setError('请先保存或取消当前输入，再复制记录。');return;}
    const controller=new AbortController();
    copyController.current=controller;
    const timeout=window.setTimeout(()=>controller.abort(new Error('同步超过15秒，请核对保存结果后重新复制。你的输入仍然保留。')),15_000);
    setCopyFallback(null);setFeedback('正在同步记录…');
    let copied = false;
    try {
      await run("report", async () => {
        const content = await onReport({ expectedContextVersion: snapshot.contextVersion, scope, eventIds: eventId ? [eventId] : [], format: "plain_text" },controller.signal);
        controller.signal.throwIfAborted();window.clearTimeout(timeout);
        try { await navigator.clipboard.writeText(content); copied = true; }
        catch { controller.signal.throwIfAborted();setCopyFallback(content); }
      }, () => copied ? scope === "mixed" ? "已复制记录，草稿与已采纳内容均带标识。" : "已复制已采纳内容。" : "记录已准备好，请在窗口中复制。");
    } finally {window.clearTimeout(timeout);if(copyController.current===controller)copyController.current=null;}
  }
  async function openSources(card: ReviewCard, trigger: string) {
    const epoch=++sourceEpoch.current;
    setSourceCard(card); setSourceTrigger(trigger); setLoadedSources([]); setSourceState("idle");
    if (!onSources) return;
    setSourceState("loading");
    try { const loaded=await onSources([...new Set(card.members.flatMap(m=>m.evidenceRefIds))]);if(sourceEpoch.current===epoch){setLoadedSources(loaded);setSourceState("idle");} }
    catch { if(sourceEpoch.current===epoch)setSourceState("error"); }
  }
  const shownSources = onSources ? loadedSources : sources;
  const RecordElement = embedded ? "section" : "main";
  const recordBullets = recordDisplayBullets(currentRecordBullets(snapshot.bullets, snapshot.questions),snapshot.reviewCards);
  const prioritySelection=priorities.slice(0,priorityLimit);
  const selectedPriorityIds=new Set(prioritySelection.flatMap(c=>c.claimIds));
  const shownBullets = recordBullets.filter((bullet) => {
    if (filter === "accepted") return bullet.reviewState === "accepted";
    if (filter === "decisions") return bullet.claimRefs.some(r=>selectedPriorityIds.has(r.claimId));
    return true;
  });
  // The focused queue follows the same impact order as server counts. The
  // complete reading view retains its original narrative order.
  if(filter==='decisions')shownBullets.sort((a,b)=>prioritySelection.findIndex(c=>c.claimIds.some(id=>a.claimRefs.some(x=>x.claimId===id)))-prioritySelection.findIndex(c=>c.claimIds.some(id=>b.claimRefs.some(x=>x.claimId===id))));
  useEffect(()=>{
    if(!onProgress || !ready || dirty || pending.size || processing || (resumeCard && !resumed))return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const visible=new Map<Element,number>();
    const markPosition=(cardId:string)=>{
      lastSeen.current=cardId;
      if(timer)clearTimeout(timer);
      if(cardId===lastSaved.current)return;
      timer=setTimeout(()=>{void onProgress({snapshotId:snapshot.snapshotId,lastCardId:cardId,mode:'bookmark'}).then(()=>{lastSaved.current=cardId;}).catch(()=>undefined);},900);
    };
    const root=contentRoot.current;
    const focusPosition=(event:FocusEvent)=>{
      const node=event.target instanceof Element?event.target.closest<HTMLElement>('[data-review-card]'):null;
      if(node?.dataset.reviewCard && root?.contains(node))markPosition(node.dataset.reviewCard);
    };
    const observer=new IntersectionObserver(entries=>{
      for(const e of entries) {if(e.isIntersecting)visible.set(e.target,e.boundingClientRect.top);else visible.delete(e.target);}
      // An explicit keyboard or control focus identifies the item being read.
      // Fall back to scroll position once that focused item leaves the viewport.
      const focused=document.activeElement?.closest<HTMLElement>('[data-review-card]');
      const rect=focused?.getBoundingClientRect();
      const focusedVisible=focused && root?.contains(focused) && rect && rect.bottom>0 && rect.top<innerHeight;
      const node=focusedVisible?focused:[...visible.keys()].sort((a,b)=>a.getBoundingClientRect().top-b.getBoundingClientRect().top)[0] as HTMLElement|undefined;
      if(node?.dataset.reviewCard)markPosition(node.dataset.reviewCard);
    },{rootMargin:'-15% 0px -35% 0px',threshold:0.1});
    root?.addEventListener('focusin',focusPosition);
    for(const node of root?.querySelectorAll('[data-review-card]') ?? [])observer.observe(node);
    return ()=>{observer.disconnect();root?.removeEventListener('focusin',focusPosition);if(timer)clearTimeout(timer);};
  },[onProgress,ready,dirty,pending.size,processing,snapshot.snapshotId,snapshot.reviewProgress?.finishedAt,resumeCard,resumed,filter,priorityLimit]);
  useEffect(()=>{
    if(!ready || !focusClaimId || focusedRequest.current===focusClaimId)return;
    const bullet=recordBullets.find(b=>b.claimRefs.some(r=>r.claimId===focusClaimId));
    const target=document.getElementById(`workflow-question-${focusClaimId}`) ?? document.getElementById(`workflow-action-${focusClaimId}`) ?? (bullet?document.getElementById(`record-bullet-${bullet.id}`):null);
    if(target){for(let node=target.parentElement;node;node=node.parentElement)if(node instanceof HTMLDetailsElement)node.open=true;focusedRequest.current=focusClaimId;target.scrollIntoView({block:'center'});target.focus({preventScroll:true});}
  },[ready,focusClaimId,recordBullets]);
  function showFollowup(actionId?: string) {
    if(dirty){setError("请先保存或取消当前输入。");return;}
    setFilter("all");
    requestAnimationFrame(()=>{
      const target = document.getElementById(`workflow-action-${actionId ?? snapshot.actions.find(a=>a.executionState==='open')?.id ?? snapshot.actions[0]?.id}`);
      target?.scrollIntoView({block:"center"});target?.focus({preventScroll:true});
    });
  }
  async function resumeReading() {
    if(dirty){setError("请先保存或取消当前输入。");return;}
    const savedCard=snapshot.reviewCards.find(c=>c.id===resumeCard);
    const bullet=recordBullets.find(b=>savedCard?.memberRefs.some(r=>b.claimRefs.some(x=>x.claimId===r.claimId))) ?? recordBullets.find(b=>snapshot.questions.some(q=>savedCard?.memberRefs.some(r=>r.claimId===q.id) && q.answerRefs.some(a=>b.claimRefs.some(x=>x.claimVersionId===a.claimVersionId))));
    setFilter('all');setResumed(true);
    if(onProgress)void onProgress({snapshotId:snapshot.snapshotId,lastCardId:savedCard?.id ?? null,mode:'bookmark'}).catch(()=>undefined);
    requestAnimationFrame(()=>{const target=bullet?document.getElementById(`record-bullet-${bullet.id}`):null;if(target)for(let node=target.parentElement;node;node=node.parentElement)if(node instanceof HTMLDetailsElement)node.open=true;target?.scrollIntoView({block:'center'});target?.focus({preventScroll:true});});
  }
  function openOutcome(target: OutcomeTarget) {
    if(dirty || outcomeEditor) {setError("请先保存或取消当前输入。");return;}
    setEditor(null);setOutcomeEditor(target);setError("");
  }
  const renderOutcome = (kind: OutcomeTarget['kind'], id: string) => outcomeEditor?.kind===kind && outcomeEditor.id===id && onOutcome && onCorrection && <div className={styles.actionEditor}><OutcomeEditor readOnly={!canEdit} target={outcomeEditor} snapshot={snapshot} onSaveOutcome={(targetId,body)=>trackWrite(targetId,()=>onOutcome(targetId,body))} onAnswer={(targetId,body)=>trackWrite(targetId,()=>onAnswer(targetId,body))} onCorrection={(targetId,body)=>trackWrite(targetId,()=>onCorrection(targetId,body))} onClose={()=>setOutcomeEditor(null)} onSaved={()=>{setOutcomeEditor(null);setFeedback("结果已保存，重点已更新。");}}/></div>;
  function adjustAction(actionId:string) {
    const card=snapshot.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===actionId));
    if(!card) {setError("请先打开这条行动对应的记录。");return;}
    if(card.members.length>1){setMemberTarget({cardId:card.id,editClaimId:actionId});return;}
    setBasisTarget(null);setFilter("all");
    openEditor({kind:"edit",id:card.id,value:card.members[0].statement,initial:card.members[0].statement,origin:"user_input"});
    requestAnimationFrame(()=>document.querySelector(`[data-testid="bullet-${actionId}"]`)?.scrollIntoView({block:"center",behavior:"smooth"}));
  }
  const standaloneMentions=(snapshot.reaffirmedMentions ?? []).filter(m=>m.associationState!=='confirmed' || m.targetState!=='current' || m.sourceStatus!=='ready' || m.targetText===null);
  const shownMentions=filter==='all'?standaloneMentions:[];
  const mentionLink=(targetEventId:string|null,claimId:string)=>projectId && targetEventId?<a href={`/?project=${encodeURIComponent(projectId)}&event=${encodeURIComponent(targetEventId)}&view=simple`} onClick={e=>{if(dirty){e.preventDefault();setError('请先保存或取消当前输入。');return;}if(onOpenRecord){e.preventDefault();onOpenRecord(targetEventId,claimId);}}}>查看原事项</a>:null;
  const titleFor = (claimId: string) => snapshot.bullets.find((b) => b.claimRefs.some((r) => r.claimId === claimId))?.text ?? "跟进事项";
  const renderEditor = (id: string) => queuedEditor?.id === id ? <p className={styles.notice} role="status">正在更新记录，完成后会打开修改。</p> : editor?.id === id && <form id={`workflow-editor-${id}`} className={styles.editor} onSubmit={(event) => { event.preventDefault(); void saveEditor(); }}>
    <label htmlFor={inputId}>{editor.kind === "edit" ? "修改重点" : "补充答案"}</label>
    <textarea id={inputId} readOnly={!canEdit || pending.has(id)} autoFocus value={editor.value} onChange={(event) => {setError("");setEditor({ ...editor, value: event.target.value,touched:true });}} maxLength={4000} rows={3} placeholder={editor.kind === "answer" ? "例如：供应商报价十二万元，包含安装。" : undefined} />
    {editor.kind === "edit" && <label className={styles.origin}>修改依据<select aria-label="修改依据" disabled={!canEdit} value={editor.origin} onChange={(event) => setEditor({ ...editor, origin: event.target.value as Editor["origin"] })}><option value="source_statement">按原话修正</option><option value="user_input">我补充的信息</option></select></label>}
    {editor.kind === "edit" && editor.base?.reviewCards.find(c=>c.id===editor.id)?.members[0]?.answerTargets?.length && <FactAnswerReview member={editor.base.reviewCards.find(c=>c.id===editor.id)!.members[0]} choices={editor.questionChoices} disabled={!canEdit || pending.has(id)} onChange={questionChoices=>{setError("");setEditor({...editor,questionChoices,touched:true});}}/>}
    {editor.conflict && <div className={styles.notice}><p>{recoveries.inline?"已恢复读取，请核对当前内容后保存。你的输入仍然保留。":"内容已有变化，你的输入仍然保留。"}</p><p>当前内容：{snapshot.reviewCards.find(c=>c.id===editor.id)?.title ?? snapshot.bullets.find(b=>b.claimRefs.some(r=>r.claimId===editor.id))?.text ?? "这条内容已移出当前记录"}</p><NqButton variant="secondary" onClick={()=>setEditor({...editor,base:snapshot,conflict:false,origin:snapshot.reviewCards.find(c=>c.id===editor.id)?.members[0]?.origin === "user_input" ? "user_input" : editor.origin,questionChoices:snapshot.reviewCards.find(c=>c.id===editor.id)?.members[0]?factChoicesFor(snapshot.reviewCards.find(c=>c.id===editor.id)!.members[0],editor.questionChoices):{}})}>核对后采用当前版本</NqButton></div>}
    <div className={styles.inlineActions}><NqButton type="submit" loading={pending.has(id)} disabled={!canEdit || writing || !editor.value.trim() || editor.conflict}>保存{editor.kind === "answer" ? "答案" : "修改"}</NqButton><NqButton variant="quiet" disabled={writing} onClick={() => {memory?.clear('inline');setEditor(null);}}>取消</NqButton></div>
  </form>;

  const renderBullet = (bullet: typeof shownBullets[number]) => {
        const card = snapshot.reviewCards.find((c) => c.memberRefs.some((ref) => bullet.claimRefs.some((r) => r.claimVersionId === ref.claimVersionId)));
        const member=card?.members.find(m=>bullet.claimRefs.some(r=>r.claimId===m.claimId));
        const matchedQuestion = snapshot.questions.find((q) => bullet.claimRefs.some((r) => r.claimId === q.claimRef.claimId || q.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)));
        const question = matchedQuestion && shownBullets.find(b=>b.claimRefs.some(r=>r.claimId===matchedQuestion.claimRef.claimId || matchedQuestion.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)))?.id===bullet.id ? matchedQuestion : undefined;
        const relatedQuestions=snapshot.questions.filter(q=>bullet.claimRefs.some(r=>r.claimId===q.id || q.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)));
        const editableQuestions=relatedQuestions.filter(q=>snapshot.reviewCards.some(c=>c.memberRefs.some(r=>r.claimId===q.id)) && shownBullets.find(b=>b.claimRefs.some(r=>r.claimId===q.id || q.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)))?.id===bullet.id);
        const followedAction = snapshot.actions.find(a=>bullet.claimRefs.some(r=>r.claimId===a.id));
        const resultAction = snapshot.actions.find(a=>a.latestOutcome?.resultRefs?.some(r=>bullet.claimRefs.some(b=>b.claimId===r.claimId && b.claimVersionId===r.claimVersionId)));
        const sameIntent=card?.kind!=='conflict'?card?.sameIntent:undefined;
        const actionOverlap=card?.kind==='action'?card.actionOverlap:undefined;
        const intentRecord=card?.members.find(m=>m.claimId===sameIntent?.recordRef.claimId);
        const intentAction=card?.members.find(m=>m.claimId===sameIntent?.actionRef.claimId);
        const intentFollowup=snapshot.actions.find(a=>a.id===sameIntent?.actionRef.claimId);
        const companion=card?.sameIntent || card?.actionOverlap?card.members.find(m=>m.claimId!==member?.claimId):undefined;
        const needsDecision = card?.needsDecision && card.disposition === "active";
        const id = card?.id ?? bullet.id;
        const currentEdit = editor?.id === id;
        const sourceId = `source-${bullet.id}`;
        return <article className={`${styles.bullet} ${needsDecision ? styles.needsDecision : ""}`} key={bullet.id} id={`record-bullet-${bullet.id}`} tabIndex={-1} data-review-card={card?.id} data-testid={`bullet-${bullet.id}`}>
          <div className={styles.bulletMeta}>{bullet.reviewState === "accepted" && <span className={styles.acceptedMark} title={bullet.origin==="user_input"?"用户补充":"已确认"} aria-label="已采纳"><Check size={14}/></span>}{bullet.sourceStatus !== "ready" && <NqStatus tone="pending">需要核对来源</NqStatus>}</div>
          {relatedQuestions.filter(q=>!bullet.claimRefs.some(r=>r.claimId===q.id)).map(q=><p key={q.id} className={styles.reason}>对应问题：{titleFor(q.id)}</p>)}
          {!currentEdit && <p className={styles.statement}>{bullet.text}</p>}
          {companion && <details className={styles.outcomeHistory} data-testid={`intent-related-${card!.id}`}><summary>{actionOverlap?companion.origin==='user_input'||companion.origin==='user_selection'?'我的行动':'AI 建议':companion.kind==='record'?'相关记录':'行动建议'} · {companion.reviewState==='accepted'?'已采纳':companion.reviewState==='rejected'?'已移出记录':companion.origin==='user_input'||companion.origin==='user_selection'?'用户补充':'AI 草稿'}</summary><p>{snapshot.bullets.find(b=>b.claimRefs.some(r=>r.claimId===companion.claimId && r.claimVersionId===companion.claimVersionId))?.sourceStatus==='ready'?companion.statement:'这条内容的出处需要重新核对。'}</p>{sameIntent && intentRecord?.reviewState==='draft' && userMayAcceptSupport(intentRecord.supportStatus) && card?.sourceStatus==='ready' && <NqButton variant="quiet" onClick={()=>void decision(card!,'confirm',intentRecord.claimId)} loading={pending.has(id)} disabled={decisionLocked}>确认这条记录</NqButton>}</details>}
          {(snapshot.reaffirmedMentions ?? []).filter(m=>m.associationState==='confirmed' && m.targetState==='current' && m.sourceStatus==='ready' && bullet.claimRefs.some(r=>r.claimId===m.claimRef.claimId && r.claimVersionId===m.claimRef.claimVersionId)).map(mention=><details className={styles.outcomeHistory} key={mention.id} data-testid={`mention-${mention.id}`}><summary>本次再次提及 · 沿用原事项</summary>{mention.sources.map((source,index)=><blockquote key={index}>{source.quote ?? '本次出处需要重新核对。'}</blockquote>)}{mentionLink(mention.targetEventId,mention.claimRef.claimId)}</details>)}
          {bullet.applicability && <p className={styles.reason}>适用情况：{bullet.applicability}</p>}
          {needsDecision && card.reasonCode!=="action_choice" && <p className={styles.reason}>{card.reason}</p>}
          {renderEditor(id)}
          <div className={styles.inlineActions}>
            {followedAction && <NqButton variant="quiet" onClick={()=>showFollowup(followedAction.id)}>查看跟进</NqButton>}
            {canEdit && resultAction?.latestOutcome && onCorrection && <NqButton variant="quiet" onClick={()=>{openOutcome({kind:"action",id:resultAction.id,correction:resultAction.latestOutcome!});showFollowup(resultAction.id);}}>修正结果</NqButton>}
            {canEdit && card?.kind === "conflict" && card.conflicts?.length && <NqButton id={`conflict-${card.id}`} disabled={decisionLocked} onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setConflictTarget(card.id);}}>核对新旧信息</NqButton>}
            {canEdit && card && actionOverlap && card.disposition!=='processed' && !currentEdit && <><NqButton id={`members-${card.id}`} disabled={decisionLocked} onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setMemberTarget({cardId:card.id});}}>核对两种行动</NqButton><NqButton variant="quiet" disabled={decisionLocked} onClick={()=>void decision(card,card.disposition==='deferred'?'restore':'defer')}>{card.disposition==='deferred'?'恢复处理':'稍后处理'}</NqButton></>}
            {canEdit && card && sameIntent && !currentEdit && <>
              {intentAction?.reviewState==='draft' && intentRecord?.reviewState!=='rejected' && card.sourceStatus==='ready' && <NqButton variant={needsDecision?'primary':'quiet'} onClick={()=>void decision(card,'accept_action',intentAction.claimId)} loading={pending.has(id)} disabled={decisionLocked}><Plus size={14}/>加入跟进</NqButton>}

              {intentRecord && intentRecord.reviewState!=='rejected' && <NqButton variant="quiet" onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setMemberTarget({cardId:card.id,editClaimId:intentRecord.claimId});}}>修改</NqButton>}
              {intentFollowup?.basisState==='needs_review' && <NqButton onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setBasisTarget(intentFollowup.id);}}>核对依据</NqButton>}
              <details className={styles.menu}><summary id={`members-${card.id}`}>更多 <ChevronDown size={12}/></summary><div><button onClick={event=>{if(dirty){setError("请先保存或取消当前输入。");return;}event.currentTarget.closest("details")?.removeAttribute("open");setMemberTarget({cardId:card.id});}}>同组逐条处理</button>{intentAction?.reviewState==='draft' && <button disabled={decisionLocked} onClick={()=>void decision(card,'reject',intentAction.claimId)}>不跟进</button>}{(needsDecision || card.disposition==='deferred') && <button disabled={decisionLocked} onClick={()=>void decision(card,card.disposition==='deferred'?'restore':'defer')}>{card.disposition==='deferred'?'恢复处理':'稍后处理'}</button>}</div></details>
            </>}
            {canEdit && card && !sameIntent && !actionOverlap && !currentEdit && card.disposition !== "processed" && bullet.sourceStatus === "ready" && <>
              {card.kind !== "conflict" && member?.kind === "action" ? followedAction ? <NqButton onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setBasisTarget(followedAction.id);}}>核对依据</NqButton> : <NqButton onClick={() => void decision(card, "accept_action", member?.claimId)} loading={pending.has(id)} disabled={decisionLocked}><Plus size={14} />加入跟进</NqButton> : card.kind !== "conflict" && member?.kind === "record" && bullet.reviewState === "draft" && userMayAcceptSupport(member.supportStatus) && <NqButton variant={needsDecision ? "primary" : "quiet"} onClick={() => void decision(card, "confirm", member?.claimId)} loading={pending.has(id)} disabled={decisionLocked}><Check size={14} />确认这条</NqButton>}
              {!sameIntent && card.kind !== "conflict" && member?.kind === "record" && card.members.length > 1 && <NqButton variant="quiet" onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setMemberTarget({cardId:card.id,editClaimId:member?.claimId});}}>改一下</NqButton>}
              {!sameIntent && card.kind !== "conflict" && member?.kind === "record" && card.members.length === 1 && <NqButton variant="quiet" onClick={() => openEditor({ kind: "edit", id, value: bullet.text, initial: bullet.text, origin: card.members[0].evidenceRefIds.length ? "source_statement" : "user_input" })}>改一下</NqButton>}
              <details className={styles.menu}><summary>更多 <ChevronDown size={12} /></summary><div><button disabled={decisionLocked} onClick={() => void decision(card, card.disposition === "deferred" ? "restore" : "defer")}>{card.disposition === "deferred" ? card.members.length>1?"恢复这组处理":"恢复处理" : card.members.length>1?"这组稍后处理":"稍后处理"}</button>{!followedAction && card.kind!=="conflict" && member?.reviewState==="draft" && <button disabled={decisionLocked} onClick={() => void decision(card, "reject", member?.claimId)}>不采纳</button>}</div></details>
            </>}
            {canEdit && card && !resultAction && card.disposition === "processed" && !sameIntent && card.kind !== "conflict" && member?.kind === "record" && !currentEdit && card.members.length === 1 && <NqButton variant="quiet" onClick={() => openEditor({ kind: "edit", id, value: bullet.text, initial: bullet.text, origin: card.members[0].origin === "user_input" || !card.members[0].evidenceRefIds.length ? "user_input" : "source_statement" })}>改一下</NqButton>}
            {canEdit && card?.disposition === "processed" && !resultAction && !sameIntent && card.kind !== "conflict" && member?.kind === "record" && !currentEdit && card.members.length>1 && <NqButton variant="quiet" onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setMemberTarget({cardId:card.id,editClaimId:member?.claimId});}}>改一下</NqButton>}
            {canEdit && card && !sameIntent && !actionOverlap && card.members.length>1 && ['record','action'].includes(card.kind) && shownBullets.find(b=>b.claimRefs.some(r=>card.memberRefs.some(m=>m.claimId===r.claimId)))?.id===bullet.id && <NqButton variant="secondary" disabled={decisionLocked} id={`members-${card.id}`} onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setMemberTarget({cardId:card.id});}}>同组逐条处理</NqButton>}
            {card && <NqButton variant="quiet" id={sourceId} onClick={() => void openSources(member?{...card,members:[member],memberRefs:[{claimId:member.claimId,claimVersionId:member.claimVersionId}]}:card, `#${sourceId}`)}><Link2 size={14} />原话</NqButton>}
            {canEdit && editableQuestions.map(q=><NqButton key={q.id} variant="quiet" onClick={()=>openQuestion(q.id)}>{editableQuestions.length>1?`调整问题：${titleFor(q.id)}`:'调整问题'}</NqButton>)}
            {canEdit && question && (question.resolutionState === "open" || onOutcome) && editor?.id !== question.id && outcomeEditor?.id !== question.id && <NqButton variant={needsDecision ? "primary" : "secondary"} disabled={decisionLocked} onClick={() => onOutcome ? openOutcome({kind:"question",id:question.id}) : openEditor({ kind: "answer", id: question.id, value: "", initial: "", origin: "user_input" })}>{question.resolutionState === "resolved" ? "更新答案" : "补答案"}</NqButton>}
          </div>
          {canEdit && question?.latestOutcome && onCorrection && <NqButton variant="quiet" onClick={()=>setWithdrawTarget(question.latestOutcome!.id)}>撤回答案</NqButton>}
          {question && renderEditor(question.id)}{question && renderOutcome("question",question.id)}
        </article>;
  };
  const renderAction = (action: WorkspaceSnapshot["actions"][number]) => { const card=snapshot.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===action.id)); const member=card?.members.find(m=>m.claimId===action.id); const companion=card?.sameIntent?card.members.find(m=>m.claimId===card.sameIntent!.recordRef.claimId):undefined; const answered=snapshot.questions.filter(q=>q.latestOutcome?.id===action.latestOutcome?.id && q.resolutionState==="resolved"); return <article key={action.id} id={`workflow-action-${action.id}`} tabIndex={-1} data-testid={`action-${action.id}`} className={styles.action}>
        {canEdit && action.executionState !== "cancelled" && <button className={styles.check} aria-label={`${action.executionState === "completed" ? "重开" : "完成"}：${titleFor(action.id)}`} aria-pressed={action.executionState === "completed"} disabled={!ready || decisionLocked} onClick={() => void run(action.id, () => onTransition(action.id, { expectedContextVersion: snapshot.contextVersion, expectedActionRevision: action.revision, operation: action.executionState === "completed" ? "reopen" : "complete" }), action.executionState === "completed" ? "已重新打开跟进。" : "已完成。有新答案时可以继续补充。")}>{action.executionState === "completed" && <Check size={16} />}</button>}
        <div className={styles.actionBody}><p>{titleFor(action.id)}</p><span>{action.executionState === "completed" ? "已完成" : action.executionState === "cancelled" ? "已取消" : "待跟进"}{action.basisState === "needs_review" ? " · 依据有变化" : ""}</span>{(action.ownerHint || action.dueAt) && <p className={styles.actionMeta}>{action.ownerHint && <span>负责人：{action.ownerHint}</span>}{action.dueAt && <span>期限：{new Date(action.dueAt).toLocaleDateString('zh-CN',{timeZone:'UTC'})}</span>}</p>}{action.latestOutcome && (action.latestOutcome.freshness==='stale'?<details className={styles.outcomeHistory}><summary>上次结果 · 相关答案已变化</summary><p>{action.latestOutcome.text || '当时的结果依据需要重新核对。'}</p><small>当前答案已在上方重点更新。</small></details>:<p className={styles.outcome}>{action.latestOutcome.text}</p>)}</div>
        {canEdit && !onOutcome && action.questionRefs.length === 1 && snapshot.questions.some((q) => q.id === action.questionRefs[0].claimId && q.resolutionState === "open") && <NqButton variant="quiet" onClick={() => { const questionId = action.questionRefs[0].claimId; setFilter("all"); openEditor({ kind: "answer", id: questionId, value: "", initial: "", origin: "user_input" }); }}>补结果</NqButton>}
        {canEdit && onOutcome && <div className={styles.actionControls}>
          {action.basisState==="needs_review" && <NqButton variant="secondary" onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setBasisTarget(action.id);}}>核对依据</NqButton>}
          <NqButton variant="quiet" disabled={decisionLocked} onClick={()=>openOutcome({kind:"action",id:action.id})}>补结果</NqButton>
          {action.latestOutcome && onCorrection && <details className={styles.menu}><summary>结果操作 <ChevronDown size={12}/></summary><div><button onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");openOutcome({kind:"action",id:action.id,correction:action.latestOutcome!});}}>修正结果</button><button onClick={()=>setWithdrawTarget(action.latestOutcome!.id)}>撤回这次结果</button></div></details>}
          <details className={styles.menu}><summary>行动操作 <ChevronDown size={12}/></summary><div><button onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");adjustAction(action.id);}} disabled={pending.has(action.id)}>调整行动</button><button onClick={()=>void run(action.id,()=>onTransition(action.id,{expectedContextVersion:snapshot.contextVersion,expectedActionRevision:action.revision,operation:action.executionState === "cancelled" ? "reopen" : "cancel"}),"行动状态已更新。")} disabled={decisionLocked}>{action.executionState === "cancelled" ? "重新跟进" : "取消行动"}</button></div></details>
        </div>}
        {card && <NqButton variant="quiet" id={`action-source-${action.id}`} onClick={()=>void openSources(member?{...card,members:[member],memberRefs:[action.claimRef]}:card,`#action-source-${action.id}`)}><Link2 size={14}/>原话</NqButton>}{companion && <details className={styles.outcomeHistory}><summary>原始记录</summary><p>{companion.statement}</p>{companion.reviewState==='draft' && canEdit && userMayAcceptSupport(companion.supportStatus) && <NqButton variant="quiet" disabled={decisionLocked} onClick={()=>void decision(card!,'confirm',companion.claimId)}>确认这条记录</NqButton>}</details>}{answered.map(q=><div key={q.id} id={`workflow-question-${q.id}`} tabIndex={-1} className={styles.answeredQuestion}><span>已回答：{titleFor(q.id)}</span>{canEdit && <NqButton variant="quiet" disabled={decisionLocked} onClick={()=>openOutcome({kind:'question',id:q.id})}>更新答案</NqButton>}{renderOutcome('question',q.id)}</div>)}{card && renderEditor(card.id)}{renderOutcome("action",action.id)}
</article>;
  };
  return <div ref={contentRoot} className={`${styles.workspace} ${embedded ? styles.embedded : ""}`} data-ready={ready}>
    {!embedded && <div className={styles.topbar}><Link href="/?view=simple"><ArrowLeft size={15} /> 工作空间</Link><span>Notique AI</span></div>}
    <header className={styles.header}>
      <div>{!embedded && <><p className={styles.eyebrow}>沟通记录</p><h1>{title}</h1><p className={styles.subtitle}>{subtitle}</p></>}</div>
      <div className={styles.headerActions}>{onHighlight && onHighlightSources && canEdit && <NqButton id="add-source-highlight" variant="quiet" disabled={pending.has('report')} onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}setHighlightOpen(true);}}>从原文补充</NqButton>}<NqButton onClick={() => void copy("mixed")} loading={pending.has("report")}><Copy size={15} />{pending.has('report')?'正在同步记录':'复制记录'}</NqButton><details className={styles.menu}><summary aria-label="记录的更多操作"><ChevronDown size={16} /></summary><div><button disabled={pending.has('report')} onClick={() => void copy("accepted")}>仅导出已采纳内容</button></div></details></div>
    </header>
    {analysisPanel}
    {(feedback || canEdit && onRevert && lastDecision && !lastDecision.reverted) && <div className={styles.feedback} aria-live="polite" role="status">{feedback}{canEdit && onRevert && lastDecision && !lastDecision.reverted && <NqButton variant="quiet" loading={pending.has(lastDecision.id)} disabled={decisionLocked} onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}void run(lastDecision.id,()=>onRevert(lastDecision.id,{expectedContextVersion:snapshot.contextVersion,expectedDecisionRevision:lastDecision.revision}),"已撤销这次处理，记录已恢复。");}}>撤销上次处理</NqButton>}</div>}
    {resumeCard && !resumed && <div className={styles.resumeNotice}><span>上次阅读位置已保存</span><NqButton variant="quiet" onClick={()=>void resumeReading()}>回到上次位置</NqButton></div>}
    {unrestored && retainedInputs}
    {error && <div className={styles.error} role="alert">{error}</div>}
    {!canEdit && <p className={styles.notice}>当前为只读模式，可查看记录与出处。</p>}
    {!analysisHasCoverage && !snapshot.coverage.complete && snapshot.coverage.totalSegments > 0 && <p className={styles.notice}>{processing ? "正在整理：已完成" : "当前已整理"} {snapshot.coverage.completedSegments}/{snapshot.coverage.totalSegments} 段{snapshot.bullets.length > 0 ? "，可以先看已有重点。" : "。"}</p>}
    {!analysisHasNarrative && snapshot.narrative && snapshot.narrative.freshness !== "current" && <p className={styles.notice}>{snapshot.narrative.freshness === "updating" ? "概要正在更新" : snapshot.narrative.freshness === "failed" ? "概要暂时未能更新" : "概要需要重新整理"}，下面已显示最新要点。</p>}
    {snapshot.narrative?.text && <details className={styles.narrative} data-testid="record-narrative" key={`narrative-${snapshot.narrative.basedOnContextVersion}-${snapshot.narrative.freshness}`}>
      <summary>{snapshot.narrative.freshness==='current'?'查看全文概要':'查看上一版概要'}</summary>
      {snapshot.narrative.freshness!=='current' && <p className={styles.reason}>这份概要尚未同步最近的修改，当前内容以下方重点为准。</p>}
      {snapshot.narrative.sentenceRefs.map((sentence,index)=><p key={index}>{sentence.text}</p>)}
    </details>}
    <RecordElement className={styles.record}>
      <div className={`${styles.sectionHeader} ${styles.recordNavigation}`}><div><h2>本次重点</h2><small className={styles.readingHint}>自动整理{snapshot.counts.draftCount>0?" · 含未确认内容":""}</small></div><div className={styles.recordTools}><div className={styles.filters} aria-label="重点范围"><button disabled={!ready} aria-pressed={filter === "all"} onClick={() => changeFilter("all")}>记录</button><button disabled={!ready} aria-pressed={filter === "decisions"} onClick={() => changeFilter("decisions")}>待处理 {priorities.length}</button><button disabled={!ready} aria-pressed={filter === "accepted"} onClick={() => changeFilter("accepted")}>已确认</button></div></div></div>
      {!shownBullets.length && !shownMentions.length && <p className={styles.empty}>{filter === "decisions" ? "当前没有待处理事项。" : filter === "accepted" ? "还没有已采纳内容，可以先阅读全部记录。" : "材料整理好后，重点会出现在这里。"}{filter !== "all" && <button onClick={() => setFilter("all")}>查看完整记录</button>}</p>}
      {!!shownMentions.length && <div className={styles.bullets}>{shownMentions.map(mention=><article className={styles.bullet} key={mention.id} data-testid={`mention-${mention.id}`}>
        <div className={styles.bulletMeta}><NqStatus tone={mention.sourceStatus==='ready' && mention.associationState==='proposed'?'info':'pending'}>{mention.sourceStatus!=='ready'?'本次出处待核对':mention.associationState==='proposed'?'再次提及 · 关联待核对':mention.targetState==='changed'?'原事项已更新':mention.targetState==='retired'?'原事项已移出当前跟进':'原事项需要重新核对'}</NqStatus></div>
        <p className={styles.statement}>{mention.statement ?? '本次出处已变化，请重新核对材料。'}</p>
        <details className={styles.outcomeHistory}><summary>本次原话与原事项</summary>{mention.sources.map((source,index)=><blockquote key={index}>{source.quote ?? '这段出处需要重新核对。'}</blockquote>)}<p>原事项：{mention.targetText ?? '当时的内容暂时不可读取。'}</p>{mention.targetState==='changed' && <p>当前内容：{mention.currentText ?? '当前内容的出处需要重新核对。'}</p>}{mentionLink(mention.targetEventId,mention.claimRef.claimId)}{canEdit && onMention && mention.associationState==='proposed' && <div className={styles.inlineActions}>
          <NqButton variant="secondary" disabled={decisionLocked || mention.sourceStatus!=='ready' || mention.targetState!=='current' || mention.targetText===null || mention.statement===null} loading={pending.has(mention.id)} onClick={()=>{if(dirty){setError('请先保存或取消当前输入。');return;}void run(mention.id,()=>onMention(mention.id,{expectedContextVersion:snapshot.contextVersion,targetRef:mention.claimRef,operation:'confirm'}),'已沿用原事项，原有跟进和答案继续保留。');}}>沿用原事项</NqButton>
          <NqButton variant="quiet" disabled={decisionLocked || mention.sourceStatus!=='ready' || mention.statement===null} onClick={()=>{if(dirty){setError('请先保存或取消当前输入。');return;}void run(mention.id,()=>onMention(mention.id,{expectedContextVersion:snapshot.contextVersion,targetRef:mention.claimRef,operation:'convert'}),'已作为独立草稿保留，可以继续核对。');}}>作为独立信息</NqButton>
          <NqButton variant="quiet" disabled={decisionLocked} onClick={()=>{if(dirty){setError('请先保存或取消当前输入。');return;}void run(mention.id,()=>onMention(mention.id,{expectedContextVersion:snapshot.contextVersion,targetRef:mention.claimRef,operation:'reject'}),'已忽略此次关联。');}}>忽略</NqButton>
        </div>}</details>
      </article>)}</div>}
      {filter==='decisions' ? <div className={styles.bullets}>{shownBullets.filter(b=>!snapshot.actions.some(a=>b.claimRefs.some(r=>r.claimId===a.id))).map(renderBullet)}{snapshot.actions.filter(a=>selectedPriorityIds.has(a.id)).map(renderAction)}</div> : <div className={styles.topics}>{readingTopics(snapshot,shownBullets).map(topic=>{
        const details=topic.detail.filter(b=>!topic.interactive.some(x=>x.id===b.id));
        return <section key={topic.key} className={styles.topic} aria-labelledby={`topic-${topic.key}`} data-testid={`topic-${topic.key}`}>
          <header className={styles.topicHeader}><h3 id={`topic-${topic.key}`}>{topic.title}</h3></header>
          {topic.preview.length>0 ? <ul className={styles.topicPreview}>{topic.preview.map((sentence,index)=><li key={index}>{sentence.text}</li>)}</ul> : <div className={styles.bullets}>{details.slice(0,3).map(renderBullet)}</div>}
          {details.length>(topic.preview.length?0:3) && <details className={styles.topicDetails}><summary>查看详细记录 · {details.length-(topic.preview.length?0:3)} 条</summary><div className={styles.bullets}>{(topic.preview.length?details:details.slice(3)).map(renderBullet)}</div></details>}
          {topic.interactive.length>0 && <div className={styles.bullets}>{topic.interactive.map(renderBullet)}</div>}
          {topic.actions.length>0 && <div className={styles.topicFollowups}>{topic.actions.map(renderAction)}</div>}
          {topic.relatedActionRefs.length>0 && <div className={styles.relatedFollowups}>{topic.relatedActionRefs.map(ref=>{const action=snapshot.actions.find(a=>a.claimRef.claimId===ref.claimId && a.claimRef.claimVersionId===ref.claimVersionId);return action?<button key={action.id} onClick={()=>showFollowup(action.id)}>查看相关跟进</button>:null;})}</div>}
        </section>;
      })}</div>}
      {filter==='decisions' && priorities.length>priorityLimit && <div className={styles.priorityRemainder}><span>先处理这 {prioritySelection.length} 项，还有 {priorities.length-priorityLimit} 项。</span><NqButton variant="secondary" onClick={()=>setPriorityLimit(value=>value+5)}>再看 5 项</NqButton></div>}
      {!!snapshot.actionHistory?.length && <details className={styles.decisionHistory} data-testid="action-history"><summary>已替代的跟进 <span>{snapshot.actionHistory.length}</span></summary><ul>{snapshot.actionHistory.map(action=><li key={action.id} data-testid={`historical-action-${action.id}`}><div><span>已替代 · {action.executionState==='completed'?'当时已完成':action.executionState==='cancelled'?'当时已取消':'当时待跟进'}</span><p>{action.text || '原行动的出处需要重新核对。'}</p>{action.replacementText && <small>现在跟进：{action.replacementText}</small>}{action.latestOutcome && <p className={styles.outcome}>当时结果：{action.latestOutcome.text || '当时的结果依据需要重新核对。'}</p>}</div></li>)}</ul></details>}
      {!!snapshot.recentDecisions?.length && <details className={styles.decisionHistory}><summary>最近处理</summary><ul>{snapshot.recentDecisions.map(d=><li key={d.id} data-testid={`decision-${d.id}`}><div><span>{d.operation==="confirm_mention"?"沿用原事项":d.operation==="convert_mention"?"作为独立信息":d.operation==="reject_mention"?"忽略关联":d.operation==="review_members"?"逐条处理":d.operation==="edit"?"修改":d.operation==="reject"?"不采纳":d.operation==="accept_action"?"行动决定":d.operation==="resolve_conflict"?d.choiceMode==="keep_existing"?"保留原信息":d.choiceMode==="use_candidate"?"采用新信息":d.choiceMode==="coexist"?"分别适用":"新旧信息选择":"确认"}{d.reverted?" · 已撤销":""}</span><p>{d.summary}</p></div>{canEdit && onRevert && !d.reverted && <NqButton variant="quiet" loading={pending.has(d.id)} disabled={decisionLocked} onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}void run(d.id,()=>onRevert(d.id,{expectedContextVersion:snapshot.contextVersion,expectedDecisionRevision:d.revision}),"已撤销这次处理，记录已恢复。");}}>撤销</NqButton>}</li>)}</ul></details>}
      {onContinue && <footer className={styles.footer}><span>{writing?"正在保存…":dirty?"有未保存的输入":"已自动保存"}</span><NqButton variant="secondary" onClick={()=>{if(dirty){setError("请先保存或取消当前输入。");return;}onContinue();}}><Plus size={14}/>添加下一次记录</NqButton></footer>}

    </RecordElement>
    {highlightOpen && onHighlight && onHighlightSources && <SourceHighlightEditor contextVersion={snapshot.contextVersion} canEdit={canEdit} onLoad={onHighlightSources} onSave={onHighlight} onClose={saved=>{setHighlightOpen(false);if(saved){setFilter("all");setFeedback("原话已保存为用户选录，出处已关联。");}}}/>}
    {questionTarget && <QuestionEditor questionId={questionTarget} snapshot={snapshot} canEdit={canEdit} onDecide={onDecide} onClose={saved=>{setQuestionTarget(null);if(saved){setFilter("all");setFeedback("问题已修改，答案和跟进已同步更新。");}}} onSource={member=>{const card=snapshot.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===questionTarget));if(card)void openSources({...card,members:[member],memberRefs:[{claimId:member.claimId,claimVersionId:member.claimVersionId}]},"");}}/>}
    {memberTarget && <MemberReview cardId={memberTarget.cardId} initialEditClaimId={memberTarget.editClaimId} snapshot={snapshot} canEdit={canEdit} onDecide={onDecide} onClose={()=>setMemberTarget(null)} onSource={member=>{const card=snapshot.reviewCards.find(c=>c.id===memberTarget.cardId);if(card)void openSources({...card,members:[member],memberRefs:[{claimId:member.claimId,claimVersionId:member.claimVersionId}]},"");}}/>}
    {conflictTarget && <ConflictReview cardId={conflictTarget} snapshot={snapshot} canEdit={canEdit} onDecide={onDecide} onClose={()=>setConflictTarget(null)} onSource={member=>{const card=snapshot.reviewCards.find(c=>c.id===conflictTarget);if(card)void openSources({...card,members:[member],memberRefs:[{claimId:member.claimId,claimVersionId:member.claimVersionId}]},"");}}/>}
    {basisTarget && <ActionBasisReview actionId={basisTarget} snapshot={snapshot} onDecide={onDecide} onClose={()=>setBasisTarget(null)} onAdjust={()=>adjustAction(basisTarget)}/> }
    {sourceCard && <Modal title="原话与出处" description="查看这条记录对应的材料。" onClose={() => setSourceCard(null)} returnFocusSelector={sourceTrigger}><div className={styles.sourceBody}>{sourceState === "loading" && <p role="status">正在读取原话…</p>}{sourceState === "error" && <p role="alert">原话暂时没能读取。<NqButton variant="quiet" onClick={()=>void openSources(sourceCard,sourceTrigger ?? "")}>重试</NqButton></p>}{shownSources.filter((s) => sourceCard.members.some((m) => m.evidenceRefIds.includes(s.evidenceRefId))).map((source) => <blockquote key={source.evidenceRefId}><span>{source.timestamp} · {source.speaker}</span><p>{source.quote || "这份材料没有可显示的文字片段。"}</p>{source.audioUrl && <audio controls preload="none" src={source.audioUrl} onLoadedMetadata={event=>{event.currentTarget.currentTime=source.audioStartSeconds ?? 0;}}/>}{source.viewUrl && <a href={source.viewUrl} target="_blank" rel="noreferrer">打开原始材料</a>}</blockquote>)}{sourceState === "idle" && !shownSources.some((s) => sourceCard.members.some((m) => m.evidenceRefIds.includes(s.evidenceRefId))) && <p>这条内容暂时没有可读取的出处。</p>}<NqButton variant="secondary" onClick={() => setSourceCard(null)}>返回记录</NqButton></div></Modal>}
    {withdrawTarget && onCorrection && <Modal title="撤回这次结果" description="这次补充的结果和答案将撤回，行动的完成状态保留。" onClose={()=>setWithdrawTarget(null)}>{snapshot.questions.some(q=>q.latestOutcome?.id===withdrawTarget) && <p>受影响的问题：</p>}{snapshot.questions.filter(q=>q.latestOutcome?.id===withdrawTarget).map(q=><p key={q.id}>{titleFor(q.id)}</p>)}<NqButton onClick={()=>{const outcome=[...snapshot.actions,...snapshot.questions].map(x=>x.latestOutcome).find(o=>o?.id===withdrawTarget);if(outcome) void run(outcome.id,async()=>{await onCorrection(outcome.id,{expectedContextVersion:snapshot.contextVersion,expectedOutcomeRevision:outcome.revision,operation:"withdraw"});setWithdrawTarget(null);},"结果已撤回，问题状态已更新。");}} loading={pending.has(withdrawTarget)}>确认撤回</NqButton></Modal>}
    {copyFallback !== null && <Modal title="复制记录" description="可选中下面的文字复制。" onClose={() => setCopyFallback(null)}><textarea className={styles.copyText} aria-label="可复制的记录" value={copyFallback} readOnly onFocus={(event) => event.target.select()} /><NqButton variant="secondary" onClick={() => setCopyFallback(null)}><Undo2 size={14} />返回记录</NqButton></Modal>}
  </div>;
}
