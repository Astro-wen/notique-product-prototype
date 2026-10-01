"use client";

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Plus } from 'lucide-react';
import { NqButton, NqStatus, NqSurface } from '@/app/components/notique-ui';
import { ApiClientError } from '@/app/api-client';
import type { ProjectOverview } from '@/lib/shared/workflow-v2';
import { workflowService } from '../services/workflow-service';
import {overviewTopics} from '@/lib/domain/record-reading';
import {projectOverviewPollInterval} from '@/lib/domain/overview-refresh';
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
  const snapshot=overview.data;
  const denied=overview.error instanceof ApiClientError && [401,403,404,410].includes(overview.error.status);
  if(denied)return <section className="meeting-tab-panel"><p>当前账号已无法访问这个项目。</p></section>;
  if(!snapshot)return <section className="meeting-tab-panel"><p>正在读取项目回顾…</p></section>;
  const unfinished=snapshot.recordSummaries.filter(r=>!r.coverage.complete);
  const records=new Map(snapshot.recordSummaries.map(r=>[r.eventId,r]));
  const titleFor=(id:string)=>snapshot.currentBullets.find(b=>b.claimRefs.some(r=>r.claimId===id))?.text ?? '打开相关记录';
  const bullets=snapshot.currentBullets.filter(b=>!acceptedOnly || b.reviewState==='accepted');
  const open=(eventId:string,claimId?:string)=>onOpenRecord(eventId,claimId);
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
    <header className={styles.header}><div><h1>项目回顾</h1><p>{snapshot.recordSummaries.length} 次沟通</p></div>{snapshot.access.canEdit && <NqButton onClick={onContinue}><Plus size={15}/>添加下一次记录</NqButton>}</header>
    {(overview.isError || pageError) && <div role="alert" className={styles.notice}>{pageError || '暂时无法同步最新项目。'}<NqButton variant="quiet" onClick={()=>{setPageError('');void overview.refetch();}}>重新读取</NqButton></div>}
    {unfinished.length>0 && <p className={styles.notice} role="status">还有 {unfinished.length} 次记录尚未整理完成。<NqButton variant="quiet" onClick={()=>open(unfinished[0].eventId)}>查看记录与进度<ArrowRight size={13}/></NqButton></p>}
    {!snapshot.access.canEdit && <p className={styles.notice}>当前为只读模式，可查看重点与相关记录。</p>}
    <div className={styles.grid}>
      <NqSurface className={styles.panel} aria-label="项目当前重点"><div className={styles.sectionHeading}><h2>当前重点</h2><div className={styles.filters}><button aria-pressed={!acceptedOnly} onClick={()=>{setAcceptedOnly(false);setExpandedTopics(new Set());}}>全部</button><button aria-pressed={acceptedOnly} onClick={()=>{setAcceptedOnly(true);setExpandedTopics(new Set());}}>已确认</button></div></div>
        {!bullets.length && <p className={styles.empty}>{acceptedOnly?'还没有已采纳内容，可以先读全部重点。':'沟通整理好后，最新重点会汇总在这里。'}</p>}
        {overviewTopics(snapshot,bullets).map(topic=><section key={topic.key} className={styles.topic}><h3>{topic.title}</h3>{topic.bullets.slice(0,expandedTopics.has(topic.key)?undefined:3).map(b=><article key={b.id} className={styles.row} data-testid={`overview-bullet-${b.id}`}><div className={styles.meta}>{b.reviewState==='accepted' && <span title={b.origin==='user_input'?'用户补充':'已确认'}>✓</span>}{b.executionState && <NqStatus tone={b.executionState==='completed'?'success':'pending'}>{b.executionState==='completed'?'已完成':b.executionState==='cancelled'?'已取消':'待跟进'}</NqStatus>}{b.sourceStatus!=='ready' && <NqStatus tone="pending">需要核对依据</NqStatus>}{b.conflictWith?.length && <span>新旧信息待选择</span>}</div><p>{b.sourceStatus==='missing'?'这条内容的出处需要重新核对。':b.text}</p>{b.applicability && <small>适用情况：{b.applicability}</small>}<button className={styles.sourceLink} onClick={()=>open(b.eventId,b.claimRefs[0]?.claimId)}>{records.get(b.eventId)?.title ?? '相关沟通'}<ArrowRight size={13}/></button></article>)}{topic.bullets.length>3 && !expandedTopics.has(topic.key) && <NqButton variant="quiet" onClick={()=>setExpandedTopics(current=>new Set([...current,topic.key]))}>查看其余 {topic.bullets.length-3} 条</NqButton>}</section>)}

      </NqSurface>
      <NqSurface className={styles.panel} aria-label="项目下一步"><h2>接下来</h2>
        {snapshot.nextActions.length>0 && <><h3>正在跟进 <small>{snapshot.nextActions.length}</small></h3>{snapshot.nextActions.slice(0,followupLimit).map(a=><article className={styles.todo} key={a.id}><p>{titleFor(a.id)}</p>{(a.ownerHint || a.dueAt) && <div className={styles.meta}>{a.ownerHint && <small>负责人：{a.ownerHint}</small>}{a.dueAt && <small>期限：{new Date(a.dueAt).toLocaleDateString('zh-CN',{timeZone:'UTC'})}</small>}</div>}{a.basisState==='needs_review' && <NqStatus tone="pending">依据有变化</NqStatus>}<NqButton variant="quiet" onClick={()=>open(a.eventId,a.id)}>继续跟进<ArrowRight size={13}/></NqButton></article>)}</>}
        {snapshot.openQuestions.length>0 && <><h3>还需要答案 <small>{snapshot.openQuestions.length}</small></h3>{snapshot.openQuestions.slice(0,followupLimit).map(q=><article className={styles.todo} key={q.id}><p>{titleFor(q.id)}</p><NqButton variant="quiet" onClick={()=>open(q.eventId,q.id)}>{snapshot.access.canEdit?'去补答案':'查看问题'}<ArrowRight size={13}/></NqButton></article>)}</>}
        {!snapshot.nextActions.length && !snapshot.openQuestions.length && <p className={styles.empty}>{unfinished.length?'整理完成后，下一步会显示在这里。':'当前没有待跟进行动或未决问题。'}</p>}
        {(snapshot.nextActions.length>followupLimit || snapshot.openQuestions.length>followupLimit) && <NqButton variant="quiet" onClick={()=>setFollowupLimit(n=>n+5)}>再看 5 项</NqButton>}
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
