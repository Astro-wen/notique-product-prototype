"use client";

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronDown, Copy, Link2, MessageSquare, Plus } from 'lucide-react';
import { NqButton, NqStatus, NqSurface } from '@/app/components/notique-ui';
import { Modal } from '@/app/components/modal';
import { ApiClientError } from '@/app/api-client';
import type { MutationReceipt, ProjectOverview, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';
import { OutcomeEditor, type OutcomeTarget } from '../components/outcome-editor';
import { ProjectSourcePreview, type ProjectSourceTarget } from '../components/project-source-preview';
import { SmoothResize } from '@/app/components/smooth-resize';
import { WORKFLOW_LEAVE_EVENT } from '../state-navigation';
import { workflowService } from '../services/workflow-service';
import {overviewTopics} from '@/lib/domain/record-reading';
import {projectOverviewPollInterval} from '@/lib/domain/overview-refresh';
import { actionableSuggestion, projectWorkItems } from '@/lib/domain/project-workbench';
import styles from './project-overview.module.css';

type Props={processing?:boolean;refreshToken?:string;projectId:string;onOpenRecord:(eventId:string,claimId?:string)=>void;onContinue:()=>void};
export function ProjectOverviewPage(props:Props) {
  const entry=useQuery({queryKey:['notique','workflow-v2-overview-entry',props.projectId],queryFn:({signal})=>workflowService.getOverview(props.projectId,{},signal),gcTime:0,staleTime:0,refetchOnWindowFocus:false,retry:false});
  if(!entry.data)return <section className="meeting-tab-panel" aria-live="polite"><p>{entry.isError?'暂时无法读取项目总览。':'正在读取项目总览…'}</p>{entry.isError && <NqButton variant="secondary" onClick={()=>void entry.refetch()}>重新读取</NqButton>}</section>;
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
  const [sourceTarget,setSourceTarget]=useState<ProjectSourceTarget|null>(null);
  const [allRecords,setAllRecords]=useState(false);
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
  if(!snapshot)return <section className="meeting-tab-panel"><p>正在读取项目总览…</p></section>;
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
      setFeedback('已完成待办。');await sync(receipt);
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
  function source(eventId:string,claimRefs:ProjectSourceTarget['claimRefs'],identity:string) {
    const record=records.get(eventId);
    const sourceId=`project-source-${identity}`;
    const fromUser=claimRefs.length>0 && claimRefs.every(ref=>snapshot.sourceRefs?.some(s=>s.claimId===ref.claimId && s.claimVersionId===ref.claimVersionId && s.origin==='user_input'));
    return <button id={sourceId} className={styles.sourceLink} aria-label={`查看来源 · ${record?.title ?? '相关对话'}`} aria-haspopup="dialog" onClick={()=>setSourceTarget({eventId,claimRefs,trigger:`#${sourceId}`})} title={`查看来源 · ${record?.title ?? '相关对话'}`}><Link2 size={12}/><span>{record ? new Date(record.occurredAt).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}) : ''} · {record?.title ?? '相关对话'}</span>{fromUser && <small>用户补充</small>}</button>;
  }
  function references(id:string) {return snapshot.currentBullets.find(b=>b.claimRefs.some(r=>r.claimId===id))?.claimRefs ?? [];}
  return <div className={styles.overview} data-testid="project-overview">
    <header className={styles.header}>
      <div><h1>项目总览</h1><p>{snapshot.recordSummaries.length} 段对话<span>·</span>{bullets.length} 条要点</p></div>
      <NqButton variant="secondary" disabled={Boolean(busy)} loading={busy==='copy'} onClick={()=>void copyProject()}><Copy size={14}/>{acceptedOnly?'复制已确认':'复制项目要点'}</NqButton>
    </header>
    {feedback && <p className={styles.feedback} role="status"><Check size={14}/>{feedback}</p>}
    {copyText && <div className={styles.copyFallback}><label htmlFor="project-copy">项目记录</label><textarea id="project-copy" readOnly value={copyText} onFocus={event=>event.currentTarget.select()}/><NqButton variant="quiet" onClick={()=>setCopyText('')}>收起</NqButton></div>}
    {outcome && <Modal wide title={outcome.target.kind==='question'?'补答案':'补结果'} returnFocusSelector={"#project-outcome-"+outcome.target.id} dismissible={!busy} onClose={()=>setOutcome(null)}><OutcomeEditor key={outcome.target.id} target={outcome.target} snapshot={outcome.snapshot} readOnly={!snapshot.access.canEdit || !outcome.snapshot.access.canEdit} onSaveOutcome={(id,body)=>saveOutcome(()=>workflowService.outcome(id,body,crypto.randomUUID()))} onAnswer={(id,body)=>saveOutcome(()=>workflowService.answer(id,body,crypto.randomUUID()))} onCorrection={(id,body)=>saveOutcome(()=>workflowService.correction(id,body,crypto.randomUUID()))} onClose={()=>setOutcome(null)} onSaved={()=>{setOutcome(null);setFeedback('已保存，要点已更新。');}}/></Modal>}
    {sourceTarget && <ProjectSourcePreview key={`${sourceTarget.trigger}:${snapshot.contextVersion}`} target={sourceTarget} snapshot={snapshot} onClose={()=>setSourceTarget(null)} onOpenRecord={(eventId,claimId)=>{setSourceTarget(null);open(eventId,claimId);}}/>}
    {(overview.isError || pageError) && <div role="alert" className={styles.notice}>{pageError || '暂时无法同步最新项目。'}<NqButton variant="quiet" onClick={()=>{setPageError('');void overview.refetch();}}>重新读取</NqButton></div>}
    {unfinished.length>0 && <div className={styles.notice} role="status">{unfinished.length} 段对话整理中<NqButton variant="quiet" onClick={()=>open(unfinished[0].eventId)}>查看进度<ArrowRight size={13}/></NqButton></div>}
    {!snapshot.access.canEdit && <p className={styles.notice}>只读</p>}
    {snapshot.recordSummaries.length>1 && <section className={styles.conversations} aria-label="项目对话">
      <div className={styles.sectionHeading}><h2>对话<span>{snapshot.recordSummaries.length}</span></h2>{snapshot.recordSummaries.length>3 && <button className={styles.expand} aria-expanded={allRecords} onClick={()=>setAllRecords(value=>!value)}>{allRecords?'收起':'查看全部'}<ChevronDown size={13}/></button>}</div>
      <SmoothResize><div className={styles.conversationList}>{snapshot.recordSummaries.slice(0,allRecords?undefined:3).map(r=><button className={styles.conversation} key={r.eventId} onClick={()=>open(r.eventId)}><MessageSquare size={16}/><div><time>{new Date(r.occurredAt).toLocaleDateString('zh-CN',{month:'long',day:'numeric'})}</time><strong>{r.title}</strong></div>{!r.coverage.complete && <span className={styles.inProgress}>整理中</span>}<ArrowRight size={14}/></button>)}{!snapshot.recordSummaries.length && <button className={styles.conversation} onClick={onContinue}><Plus size={16}/>添加第一段对话</button>}</div></SmoothResize>
    </section>}
    <div className={styles.grid}>
      <NqSurface className={styles.panel} aria-label="项目当前重点">
        <div className={styles.sectionHeading}><h2>当前要点</h2><div className={styles.filters}><button aria-pressed={!acceptedOnly} onClick={()=>{setAcceptedOnly(false);setExpandedTopics(new Set());}}>全部</button><button aria-pressed={acceptedOnly} onClick={()=>{setAcceptedOnly(true);setExpandedTopics(new Set());}}>已确认</button></div></div>
        {!bullets.length && <p className={styles.empty}>{acceptedOnly?'还没有已确认的要点。':'对话整理后，要点会汇总到这里。'}</p>}
        {overviewTopics(snapshot,bullets).map((topic,index)=><section key={topic.key} className={styles.topic}>
          <h3><span className={styles.moduleNumber}>{index+1}</span>{topic.title}<small>{topic.bullets.length}</small></h3>
          <SmoothResize><ul className={styles.points}>{topic.bullets.slice(0,expandedTopics.has(topic.key)?undefined:3).map(b=><li key={b.id} className={styles.row} data-testid={`overview-bullet-${b.id}`}>
            <div className={styles.meta}>{b.kind==='result' && <NqStatus tone="success">最新结果</NqStatus>}{b.reviewState==='accepted' && <span title="已确认" aria-label="已确认"><Check size={12}/></span>}{b.sourceStatus!=='ready' && <NqStatus tone="pending">来源待核对</NqStatus>}{Boolean(b.conflictWith?.length) && <span>新旧信息待选择</span>}</div>
            <p>{b.sourceStatus==='missing'?'来源待核对':b.text}</p>{b.applicability && <small>{b.applicability}</small>}
            {source(b.eventId,b.claimRefs,b.id)}
          </li>)}</ul></SmoothResize>
          {topic.bullets.length>3 && <button className={styles.expand} aria-expanded={expandedTopics.has(topic.key)} onClick={()=>setExpandedTopics(current=>{const next=new Set(current);if(next.has(topic.key))next.delete(topic.key);else next.add(topic.key);return next;})}>{expandedTopics.has(topic.key)?'收起':`其余 ${topic.bullets.length-3} 条`}<ChevronDown size={13}/></button>}
        </section>)}
      </NqSurface>
      <aside className={styles.followupColumn} aria-label="项目下一步">
        <NqSurface className={`${styles.panel} ${styles.questionPanel}`} aria-label="项目待解答">
          <div className={styles.sectionHeading}><h2><span className={styles.questionDot}/>待解答<span>{snapshot.openQuestions.length}</span></h2></div>
          {!snapshot.openQuestions.length && <p className={styles.empty}>暂时没有待解答的问题。</p>}
          {snapshot.openQuestions.slice(0,followupLimit).map((q,index)=><article className={styles.todo} key={q.id}>
            <div className={styles.numbered}><span className={styles.itemNumber}>{String(index+1).padStart(2,'0')}</span><p>{titleFor(q.id)}</p></div>
            {source(q.eventId,[q.claimRef],`question-${q.id}`)}
            <div className={styles.todoActions}><NqButton id={`project-outcome-${q.id}`} variant="secondary" disabled={Boolean(busy)} onClick={()=>snapshot.access.canEdit?void openOutcome(q.eventId,{kind:'question',id:q.id}):open(q.eventId,q.id)}>{snapshot.access.canEdit?'补答案':'查看问题'}<ArrowRight size={13}/></NqButton><NqButton variant="quiet" onClick={()=>open(q.eventId,q.id)}>查看详情</NqButton></div>
          </article>)}
        </NqSurface>
        <NqSurface className={styles.panel} aria-label="项目待办">
          <div className={styles.sectionHeading}><h2>待办<span>{snapshot.nextActions.length}</span></h2></div>
          {!snapshot.nextActions.length && !suggestions.length && <p className={styles.empty}>暂时没有待办。</p>}
          {snapshot.nextActions.slice(0,followupLimit).map((a,index)=><article className={styles.todo} key={a.id}>
            <div className={styles.numbered}><span className={styles.itemNumber}>{String(index+1).padStart(2,'0')}</span><p>{titleFor(a.id)}</p></div>
            {(a.ownerHint || a.dueAt) && <div className={styles.meta}>{a.ownerHint && <small>{a.ownerHint}</small>}{a.dueAt && <small>{new Date(a.dueAt).toLocaleDateString('zh-CN',{timeZone:'UTC'})} 截止</small>}</div>}
            {a.basisState==='needs_review' && <NqStatus tone="pending">依据有变化</NqStatus>}
            {a.latestOutcome?.freshness==='current' && <p className={styles.result}>{a.latestOutcome.text}</p>}
            {source(a.eventId,[a.claimRef],`action-${a.id}`)}
            <div className={styles.todoActions}>{snapshot.access.canEdit && a.basisState==='current' && <NqButton variant="secondary" disabled={Boolean(busy)} loading={busy===a.id} onClick={()=>void completeTodo(a)}><Check size={13}/>完成</NqButton>}<NqButton id={`project-outcome-${a.id}`} variant="quiet" disabled={Boolean(busy)} onClick={()=>snapshot.access.canEdit && a.basisState==='current'?void openOutcome(a.eventId,{kind:'action',id:a.id}):open(a.eventId,a.id)}>{snapshot.access.canEdit?a.basisState==='needs_review'?'核对依据':'补结果':'查看待办'}</NqButton></div>
          </article>)}
          {suggestions.length>0 && <section className={styles.suggestions} aria-label="项目行动建议"><h3>建议下一步<small>{suggestions.length}</small></h3>{suggestions.slice(0,followupLimit).map((b,index)=><article className={styles.todo} key={b.id} data-testid={`suggestion-${b.id}`}>
            {b.sourceStatus!=='ready' && <NqStatus tone="pending">来源待核对</NqStatus>}<div className={styles.numbered}><span className={styles.itemNumber}>{String(index+1).padStart(2,'0')}</span><p>{b.sourceStatus==='missing'?'来源待核对':b.text}</p></div>
            {source(b.eventId,b.claimRefs,`suggestion-${b.id}`)}
            <div className={styles.todoActions}>{snapshot.access.canEdit && b.sourceStatus==='ready' && !b.conflictWith?.length && <NqButton variant="secondary" disabled={Boolean(busy)} loading={busy===b.id} onClick={()=>void addTodo(b)}><Plus size={13}/>加入待办</NqButton>}<NqButton variant="quiet" onClick={()=>open(b.eventId,b.claimRefs[0]?.claimId)}>查看详情</NqButton></div>
          </article>)}</section>}
          {closedActions.length>0 && <details className={styles.completed}><summary>{closedActions.length===completed.length?'已完成':'已结束'} · {closedActions.length}</summary>{closedActions.map(b=><article className={styles.todo} key={b.id}>{b.executionState==='cancelled' && <NqStatus>已取消</NqStatus>}<p>{b.sourceStatus==='missing'?'来源待核对':b.text}</p>{source(b.eventId,b.claimRefs,`closed-${b.id}`)}<NqButton id={`project-outcome-${b.claimRefs[0]?.claimId}`} variant="quiet" disabled={Boolean(busy)} onClick={()=>snapshot.access.canEdit && b.executionState!=='cancelled' && b.claimRefs[0]?void openOutcome(b.eventId,{kind:'action',id:b.claimRefs[0].claimId}):open(b.eventId,b.claimRefs[0]?.claimId)}>{snapshot.access.canEdit && b.executionState!=='cancelled'?'补结果':'查看结果'}<ArrowRight size={13}/></NqButton></article>)}</details>}
        </NqSurface>
        {(snapshot.nextActions.length>followupLimit || snapshot.openQuestions.length>followupLimit || suggestions.length>followupLimit) && <NqButton variant="quiet" onClick={()=>setFollowupLimit(n=>n+5)}>再看 5 项<ChevronDown size={13}/></NqButton>}
      </aside>
    </div>
    <NqSurface className={`${styles.panel} ${styles.historyPanel}`} aria-label="项目最近变化">
      <div className={styles.sectionHeading}><h2>变化记录</h2></div>
      {!snapshot.recentChanges.length && <p className={styles.empty}>暂无变化记录。</p>}
      <div className={styles.timeline}>{snapshot.recentChanges.map(change=><article className={styles.change} key={change.id}>
        <time>{new Date(change.createdAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time>
        <div><p>{change.text}</p>{source(change.eventId,change.claimRefs.length?change.claimRefs:references(change.id),`change-${change.id}`)}</div>
      </article>)}</div>
      {snapshot.nextCursor && <NqButton variant="quiet" loading={loadingMore} onClick={()=>void moreChanges()}>更早的变化<ChevronDown size={13}/></NqButton>}
    </NqSurface>
  </div>;
}
