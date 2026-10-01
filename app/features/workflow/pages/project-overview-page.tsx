"use client";

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, Plus } from 'lucide-react';
import { NqButton, NqStatus, NqSurface } from '@/app/components/notique-ui';
import { Modal } from '@/app/components/modal';
import { ApiClientError } from '@/app/api-client';
import type { MutationReceipt, ProjectOverview, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';
import { OutcomeEditor, type OutcomeTarget } from '../components/outcome-editor';
import { WORKFLOW_LEAVE_EVENT } from '../state-navigation';
import { workflowService } from '../services/workflow-service';
import {overviewTopics} from '@/lib/domain/record-reading';
import {projectOverviewPollInterval} from '@/lib/domain/overview-refresh';
import { actionableSuggestion, projectWorkItems } from '@/lib/domain/project-workbench';
import styles from './project-overview.module.css';

type Props={processing?:boolean;refreshToken?:string;projectId:string;onOpenRecord:(eventId:string,claimId?:string)=>void;onContinue:()=>void};
export function ProjectOverviewPage(props:Props) {
  const entry=useQuery({queryKey:['notique','workflow-v2-overview-entry',props.projectId],queryFn:({signal})=>workflowService.getOverview(props.projectId,{},signal),gcTime:0,staleTime:0,refetchOnWindowFocus:false,retry:false});
  if(!entry.data)return <section className="meeting-tab-panel" aria-live="polite"><p>{entry.isError?'暂时无法读取项目回顾。':'正在读取项目回顾…'}</p>{entry.isError && <NqButton variant="secondary" onClick={()=>void entry.refetch()}>重新读取</NqButton>}</section>;
  return <LoadedOverview key={`${entry.data.access.workspaceId}:${entry.data.access.actorId}:${props.projectId}`} {...props} initial={entry.data}/>;
}
function LoadedOverview({projectId,onOpenRecord,onContinue,processing=false,refreshToken,initial}:Props & {initial:ProjectOverview}) {
  const client=useQueryClient();
  const key=['notique','workflow-v2-overview',initial.access.workspaceId,initial.access.actorId,projectId];
  const overview=useQuery({queryKey:key,initialData:initial,queryFn:({signal})=>workflowService.getOverview(projectId,{},signal),gcTime:0,staleTime:1000,refetchOnWindowFocus:'always',retry:false,refetchInterval:q=>projectOverviewPollInterval(q.state.data,processing,q.state.error instanceof ApiClientError && [401,403,404,410].includes(q.state.error.status)),
    structuralSharing:(old:unknown,next:unknown)=>{const a=old as ProjectOverview|undefined,b=next as ProjectOverview;return a && a.contextVersion>b.contextVersion?a:b;}});
  useEffect(()=>{
    if(!processing)void client.invalidateQueries({queryKey:['notique','workflow-v2-overview',initial.access.workspaceId,initial.access.actorId,projectId],exact:true});
  },[client,initial.access.workspaceId,initial.access.actorId,projectId,processing,refreshToken]);
  const [acceptedOnly,setAcceptedOnly]=useState(false),[expandedTopics,setExpandedTopics]=useState<Set<string>>(()=>new Set()),[followupLimit,setFollowupLimit]=useState(5),[loadingMore,setLoadingMore]=useState(false),[pageError,setPageError]=useState('');
  const [busy,setBusy]=useState(''),[feedback,setFeedback]=useState(''),[copyText,setCopyText]=useState('');
  const writeLock=useRef(false);
  const [outcome,setOutcome]=useState<{target:OutcomeTarget;snapshot:WorkspaceSnapshot;eventId:string}|null>(null);
  useEffect(()=>{
    if(!outcome)return;
    const leave=(event:Event)=>event.preventDefault();
    window.addEventListener('beforeunload',leave);window.addEventListener(WORKFLOW_LEAVE_EVENT,leave);
    return ()=>{window.removeEventListener('beforeunload',leave);window.removeEventListener(WORKFLOW_LEAVE_EVENT,leave);};
  },[outcome]);
  const snapshot=overview.data;
  const denied=overview.error instanceof ApiClientError && [401,403,404,410].includes(overview.error.status);
  if(denied)return <section className="meeting-tab-panel"><p>当前账号已无法访问这个项目。</p></section>;
  if(!snapshot)return <section className="meeting-tab-panel"><p>正在读取项目回顾…</p></section>;
  const unfinished=snapshot.recordSummaries.filter(r=>!r.coverage.complete);
  const records=new Map(snapshot.recordSummaries.map(r=>[r.eventId,r]));
  const titleFor=(id:string)=>{const b=snapshot.currentBullets.find(b=>b.claimRefs.some(r=>r.claimId===id));return b?.sourceStatus==='ready'?b.text:'这条内容的出处需要重新核对。';};
  const {facts:bullets,suggestions,completed,closedActions}=projectWorkItems(snapshot,acceptedOnly);
  const open=(eventId:string,claimId?:string)=>onOpenRecord(eventId,claimId);
  async function sync(receipt:MutationReceipt) {
    try {
      const fresh=await workflowService.getOverview(projectId,{minContextVersion:receipt.contextVersion});
      client.setQueryData(key,fresh);
      await client.invalidateQueries({predicate:q=>q.queryKey[0]==='notique' && String(q.queryKey[1]).startsWith('workflow-v2'),refetchType:'inactive'});
    }catch {setPageError('已保存，暂时无法同步页面，请重新读取。');void overview.refetch();}
  }
  async function openOutcome(eventId:string,target:OutcomeTarget) {
    if(writeLock.current || !snapshot.access.canEdit)return;
    writeLock.current=true;setBusy(target.id);setPageError('');setFeedback('');
    try {const current=await workflowService.getFullWorkspace(eventId);setOutcome({eventId,target,snapshot:current});}
    catch(error){setPageError(error instanceof Error?error.message:'暂时无法读取相关记录。');}
    finally{writeLock.current=false;setBusy('');}
  }
  async function saveOutcome(write:()=>Promise<MutationReceipt>) {
    if(writeLock.current)throw new Error('上一项仍在保存，请稍后。');
    writeLock.current=true;setBusy(outcome?.target.id ?? 'outcome');
    try {await sync(await write());}
    catch(error){
      if(error instanceof ApiClientError && error.status===409 && outcome) {
        const current=await workflowService.getFullWorkspace(outcome.eventId);
        setOutcome(previous=>previous?{...previous,snapshot:current}:null);
      }
      throw error;
    }finally{writeLock.current=false;setBusy('');}
  }
  async function addTodo(b:ProjectOverview['currentBullets'][number]) {
    if(writeLock.current || !snapshot.access.canEdit)return;
    writeLock.current=true;setBusy(b.id);setPageError('');setFeedback('');
    try {
      const current=await workflowService.getFullWorkspace(b.eventId);
      const ref=b.claimRefs[0],card=ref && actionableSuggestion(current.reviewCards,ref);
      if(!card || b.sourceStatus!=='ready') {setFeedback('请在相关记录中核对这条建议，再加入跟进。');open(b.eventId,ref?.claimId);return;}
      const receipt=await workflowService.decide(card.id,{expectedContextVersion:current.contextVersion,expectedCardRevision:card.revision,operation:'accept_action',members:[{...ref,operation:'accept_action'}]},crypto.randomUUID());
      setFeedback('已加入待办。');await sync(receipt);
    }catch(error){setPageError(error instanceof Error?error.message:'暂时未能加入待办。');void overview.refetch();}
    finally{writeLock.current=false;setBusy('');}
  }
  async function completeTodo(a:ProjectOverview['nextActions'][number]) {
    if(writeLock.current || !snapshot.access.canEdit)return;
    writeLock.current=true;setBusy(a.id);setPageError('');setFeedback('');
    try {
      const receipt=await workflowService.transition(a.id,{expectedContextVersion:snapshot.contextVersion,expectedActionRevision:a.revision,operation:'complete'},crypto.randomUUID());
      setFeedback('已完成待办。有新答案时可继续补充。');await sync(receipt);
    }catch(error){setPageError(error instanceof Error?error.message:'暂时未能更新待办。');void overview.refetch();}
    finally{writeLock.current=false;setBusy('');}
  }
  async function copyProject() {
    if(writeLock.current)return;
    writeLock.current=true;setBusy('copy');setPageError('');setFeedback('');setCopyText('');
    try {
      const current=await workflowService.getOverview(projectId);
      const report=await workflowService.report(projectId,{expectedContextVersion:current.contextVersion,eventIds:[],scope:acceptedOnly?'accepted':'mixed',format:'plain_text'},crypto.randomUUID());
      try {await navigator.clipboard.writeText(report.content);setFeedback('已复制项目记录。');}
      catch {setCopyText(report.content);setFeedback('项目记录已准备好，可在下方选中复制。');}
    }catch(error){setPageError(error instanceof Error?error.message:'暂时未能复制项目记录。');}
    finally{writeLock.current=false;setBusy('');}
  }
  async function moreChanges() {
    if(!snapshot.nextCursor || loadingMore)return;
    setLoadingMore(true);setPageError('');
    try {
      const next=await workflowService.getOverview(projectId,{snapshotId:snapshot.snapshotId,cursor:snapshot.nextCursor,limit:20});
      client.setQueryData(key,(previous:ProjectOverview|undefined)=>previous?.snapshotId===next.snapshotId?{...next,recentChanges:[...previous.recentChanges,...next.recentChanges]}:previous);
    }catch(error){setPageError(error instanceof Error?error.message:'暂时无法读取更多变化。');if(error instanceof ApiClientError && error.status===409)void overview.refetch();}
    finally{setLoadingMore(false);}
  }
  return <div className={styles.overview} data-testid="project-overview">
    <header className={styles.header}><div><h1>项目回顾</h1><p>{snapshot.recordSummaries.length} 次沟通 · {bullets.length} 条当前要点 · {snapshot.nextActions.length} 项待办</p></div><div className={styles.headerActions}><NqButton variant="secondary" disabled={Boolean(busy)} loading={busy==='copy'} onClick={()=>void copyProject()}><Copy size={14}/>{acceptedOnly?'复制已确认':'复制项目记录'}</NqButton>{snapshot.access.canEdit && <NqButton disabled={Boolean(busy)} onClick={onContinue}><Plus size={15}/>添加下一次记录</NqButton>}</div></header>
    {feedback && <p className={styles.feedback} role="status">{feedback}</p>}
    {copyText && <div className={styles.copyFallback}><label htmlFor="project-copy">项目记录</label><textarea id="project-copy" readOnly value={copyText} onFocus={event=>event.currentTarget.select()}/><NqButton variant="quiet" onClick={()=>setCopyText('')}>收起</NqButton></div>}
    {outcome && <Modal wide title={outcome.target.kind==='question'?'补答案':'补结果'} description={outcome.target.kind==='question'?'保存后更新问题答案和当前要点。':'记录进展，有答案时可一并补充。'} returnFocusSelector={"#project-outcome-"+outcome.target.id} dismissible={!busy} onClose={()=>setOutcome(null)}><OutcomeEditor key={outcome.target.id} target={outcome.target} snapshot={outcome.snapshot} readOnly={!snapshot.access.canEdit || !outcome.snapshot.access.canEdit} onSaveOutcome={(id,body)=>saveOutcome(()=>workflowService.outcome(id,body,crypto.randomUUID()))} onAnswer={(id,body)=>saveOutcome(()=>workflowService.answer(id,body,crypto.randomUUID()))} onCorrection={(id,body)=>saveOutcome(()=>workflowService.correction(id,body,crypto.randomUUID()))} onClose={()=>setOutcome(null)} onSaved={()=>{setOutcome(null);setFeedback('已保存，当前要点已更新。');}}/></Modal>}
    {(overview.isError || pageError) && <div role="alert" className={styles.notice}>{pageError || '暂时无法同步最新项目。'}<NqButton variant="quiet" onClick={()=>{setPageError('');void overview.refetch();}}>重新读取</NqButton></div>}
    {unfinished.length>0 && <p className={styles.notice} role="status">还有 {unfinished.length} 次记录尚未整理完成。<NqButton variant="quiet" onClick={()=>open(unfinished[0].eventId)}>查看记录与进度<ArrowRight size={13}/></NqButton></p>}
    {!snapshot.access.canEdit && <p className={styles.notice}>当前为只读模式，可查看重点与相关记录。</p>}
    <div className={styles.grid}>
      <NqSurface className={styles.panel} aria-label="项目当前重点"><div className={styles.sectionHeading}><h2>当前重点</h2><div className={styles.filters}><button aria-pressed={!acceptedOnly} onClick={()=>{setAcceptedOnly(false);setExpandedTopics(new Set());}}>全部</button><button aria-pressed={acceptedOnly} onClick={()=>{setAcceptedOnly(true);setExpandedTopics(new Set());}}>已确认</button></div></div>
        {!bullets.length && <p className={styles.empty}>{acceptedOnly?'还没有已采纳内容，可以先读全部重点。':'沟通整理好后，最新重点会汇总在这里。'}</p>}
        {overviewTopics(snapshot,bullets).map((topic,index)=><section key={topic.key} className={styles.topic}><h3><span className={styles.moduleNumber}>{index+1}</span>{topic.title}</h3><ul className={styles.points}>{topic.bullets.slice(0,expandedTopics.has(topic.key)?undefined:3).map(b=><li key={b.id} className={styles.row} data-testid={`overview-bullet-${b.id}`}><div className={styles.meta}>{b.kind==='result' && <NqStatus tone="success">最新结果</NqStatus>}{b.reviewState==='accepted' && <span title={b.origin==='user_input'?'用户补充':'已确认'} aria-label="已确认">✓</span>}{b.sourceStatus!=='ready' && <NqStatus tone="pending">需要核对依据</NqStatus>}{b.conflictWith?.length && <span>新旧信息待选择</span>}</div><p>{b.sourceStatus==='missing'?'这条内容的出处需要重新核对。':b.text}</p>{b.applicability && <small>适用情况：{b.applicability}</small>}<button className={styles.sourceLink} onClick={()=>open(b.eventId,b.claimRefs[0]?.claimId)}>{records.get(b.eventId)?.title ?? '相关沟通'}<ArrowRight size={13}/></button></li>)}</ul>{topic.bullets.length>3 && <NqButton variant="quiet" aria-expanded={expandedTopics.has(topic.key)} onClick={()=>setExpandedTopics(current=>{const next=new Set(current);if(next.has(topic.key))next.delete(topic.key);else next.add(topic.key);return next;})}>{expandedTopics.has(topic.key)?'收起':`查看其余 ${topic.bullets.length-3} 条`}</NqButton>}</section>)}

      </NqSurface>
      <NqSurface className={styles.panel} aria-label="项目下一步"><h2>接下来</h2>
        {snapshot.nextActions.length>0 && <section aria-label="项目待办"><h3>待办 <small>{snapshot.nextActions.length}</small></h3>{snapshot.nextActions.slice(0,followupLimit).map(a=><article className={styles.todo} key={a.id}><p>{titleFor(a.id)}</p>{(a.ownerHint || a.dueAt) && <div className={styles.meta}>{a.ownerHint && <small>负责人：{a.ownerHint}</small>}{a.dueAt && <small>期限：{new Date(a.dueAt).toLocaleDateString('zh-CN',{timeZone:'UTC'})}</small>}</div>}{a.basisState==='needs_review' && <NqStatus tone="pending">依据有变化</NqStatus>}{a.latestOutcome?.freshness==='current' && <p className={styles.result}>{a.latestOutcome.text}</p>}<div className={styles.todoActions}>{snapshot.access.canEdit && a.basisState==='current' && <NqButton variant="secondary" disabled={Boolean(busy)} loading={busy===a.id} onClick={()=>void completeTodo(a)}><Check size={13}/>完成</NqButton>}<NqButton id={`project-outcome-${a.id}`} variant="quiet" disabled={Boolean(busy)} onClick={()=>snapshot.access.canEdit && a.basisState==='current'?void openOutcome(a.eventId,{kind:'action',id:a.id}):open(a.eventId,a.id)}>{snapshot.access.canEdit?a.basisState==='needs_review'?'核对依据':'补结果':'查看跟进'}<ArrowRight size={13}/></NqButton></div></article>)}</section>}
        {suggestions.length>0 && <section aria-label="项目行动建议"><h3>建议下一步 <small>{suggestions.length}</small></h3>{suggestions.slice(0,followupLimit).map(b=><article className={styles.todo} key={b.id} data-testid={`suggestion-${b.id}`}>{b.sourceStatus!=='ready' && <NqStatus tone="pending">依据待核对</NqStatus>}<p>{b.sourceStatus==='missing'?'这条建议的出处需要重新核对。':b.text}</p><div className={styles.todoActions}>{snapshot.access.canEdit && b.sourceStatus==='ready' && !b.conflictWith?.length && <NqButton variant="secondary" disabled={Boolean(busy)} loading={busy===b.id} onClick={()=>void addTodo(b)}><Plus size={13}/>加入待办</NqButton>}<NqButton variant="quiet" onClick={()=>open(b.eventId,b.claimRefs[0]?.claimId)}>查看建议<ArrowRight size={13}/></NqButton></div></article>)}</section>}
        {snapshot.openQuestions.length>0 && <section aria-label="项目待解答"><h3>待解答 <small>{snapshot.openQuestions.length}</small></h3>{snapshot.openQuestions.slice(0,followupLimit).map(q=><article className={`${styles.todo} ${styles.awaitingAnswer}`} key={q.id}><NqStatus tone="pending">待解答</NqStatus><p>{titleFor(q.id)}</p><NqButton id={`project-outcome-${q.id}`} variant="quiet" disabled={Boolean(busy)} onClick={()=>snapshot.access.canEdit?void openOutcome(q.eventId,{kind:'question',id:q.id}):open(q.eventId,q.id)}>{snapshot.access.canEdit?'补答案':'查看问题'}<ArrowRight size={13}/></NqButton></article>)}</section>}
        {!snapshot.nextActions.length && !snapshot.openQuestions.length && !suggestions.length && <p className={styles.empty}>{unfinished.length?'整理完成后，下一步会显示在这里。':'当前没有待办或待解答的问题。'}</p>}
        {(snapshot.nextActions.length>followupLimit || snapshot.openQuestions.length>followupLimit || suggestions.length>followupLimit) && <NqButton variant="quiet" onClick={()=>setFollowupLimit(n=>n+5)}>再看 5 项</NqButton>}
        {closedActions.length>0 && <details className={styles.completed}><summary>{closedActions.length===completed.length?'已完成':'已结束'} {closedActions.length}</summary>{closedActions.map(b=><article className={styles.todo} key={b.id}>{b.executionState==='cancelled' && <NqStatus>已取消</NqStatus>}<p>{b.sourceStatus==='missing'?'这条待办的出处需要重新核对。':b.text}</p><NqButton id={`project-outcome-${b.claimRefs[0]?.claimId}`} variant="quiet" disabled={Boolean(busy)} onClick={()=>snapshot.access.canEdit && b.executionState!=='cancelled' && b.claimRefs[0]?void openOutcome(b.eventId,{kind:'action',id:b.claimRefs[0].claimId}):open(b.eventId,b.claimRefs[0]?.claimId)}>{snapshot.access.canEdit && b.executionState!=='cancelled'?'补结果':'查看结果'}<ArrowRight size={13}/></NqButton></article>)}</details>}
      </NqSurface>
    </div>
    <NqSurface className={styles.panel} aria-label="项目最近变化"><h2>最近变化</h2>
      {!snapshot.recentChanges.length && <p className={styles.empty}>确认、修改或补入结果后，变化会记在这里。</p>}
      {snapshot.recentChanges.map(change=><article className={styles.change} key={change.id}><div><p>{change.text}</p><small>{new Date(change.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} · {records.get(change.eventId)?.title}</small></div><NqButton variant="quiet" onClick={()=>open(change.eventId,change.claimRefs[0]?.claimId)}>查看记录<ArrowRight size={13}/></NqButton></article>)}
      {snapshot.nextCursor && <NqButton variant="secondary" loading={loadingMore} onClick={()=>void moreChanges()}>更早的变化</NqButton>}
    </NqSurface>
    <details className={styles.records}><summary>沟通记录 <small>{snapshot.recordSummaries.length}</small></summary>{snapshot.recordSummaries.map(r=><article className={styles.change} key={r.eventId}><div><p>{r.title}</p><small>{new Date(r.occurredAt).toLocaleDateString('zh-CN')} · {r.coverage.complete?'已整理':`已整理 ${r.coverage.completedSegments}/${r.coverage.totalSegments} 段`}{r.reviewProgress.lastCardId?' · 有阅读进度':''}</small></div><NqButton variant="quiet" onClick={()=>open(r.eventId)}>{r.reviewProgress.lastCardId?'继续阅读':'打开记录'}<ArrowRight size={13}/></NqButton></article>)}</details>
  </div>;
}
