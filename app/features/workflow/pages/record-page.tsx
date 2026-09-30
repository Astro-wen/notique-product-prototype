"use client";

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiClientError } from '@/app/api-client';
import { NqButton } from '@/app/components/notique-ui';
import { MemoryDraftSession } from '../services/memory-drafts';
import { MemoryDraftContext,RetainedInputs } from '../components/memory-drafts';
import { AnalysisProgress } from '../components/analysis-progress';
import { WORKFLOW_LEAVE_EVENT } from '../state-navigation';
import { RecordWorkspace } from '../components/record-workspace';
import { workflowService } from '../services/workflow-service';
import { SubmitSession } from '../services/submit-session';
import type { AnalysisRun, ReviewProgress, ReviewProgressRequest, MutationReceipt, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';

const accessError=(e:unknown):e is ApiClientError=>e instanceof ApiClientError && [401,403,404,410].includes(e.status);
export function RecordPage({ focusClaimId, projectId, eventId, title, subtitle, onContinue, onOpenTranscript, onOpenRecord, refreshToken, processing, onAccessLost, onAccessRestored }: {
  focusClaimId?:string; projectId:string; eventId:string; title:string; subtitle:string; refreshToken:string; processing:boolean; onContinue:()=>void; onOpenTranscript:()=>void;onOpenRecord?:(eventId:string,claimId?:string)=>void;onAccessLost?:()=>void;onAccessRestored?:()=>void;
}) {
  const client=useQueryClient();
  const [drafts]=useState(()=>new MemoryDraftSession());
  const [verified,setVerified]=useState<WorkspaceSnapshot|null>(null);
  const [blocked,setBlocked]=useState<ApiClientError|null>(null);
  const [recovering,setRecovering]=useState(false);
  const [recoveryError,setRecoveryError]=useState('');
  const deny=useCallback((error:ApiClientError,epoch:number,next?:WorkspaceSnapshot['access'])=>{
    if(epoch!==drafts.epoch)return;
    if(next)drafts.bind({...next,eventId});
    drafts.suspend();setVerified(null);setBlocked(error);onAccessLost?.();
    const protectedQuery=(q:{queryKey:readonly unknown[]})=>q.queryKey[0]==='notique' && typeof q.queryKey[1]==='string' && q.queryKey[1].startsWith('workflow-v2');
    void client.cancelQueries({predicate:protectedQuery});client.removeQueries({predicate:protectedQuery});
  },[client,drafts,eventId,onAccessLost]);
  const bootstrap=useQuery({queryKey:['notique','workflow-v2-entry',projectId,eventId],enabled:!blocked,
    queryFn:async({signal})=>{
      const epoch=drafts.epoch;
      try {
        const data=await workflowService.getFullWorkspace(eventId,undefined,signal);
        if(signal.aborted || epoch!==drafts.epoch)throw new DOMException('已停止旧请求','AbortError');
        if(!blocked && drafts.hasOwner() && !drafts.matches({...data.access,eventId})) {
          const error=new ApiClientError({status:401,code:'identity_changed',message:'账号已变化，请重新读取。'});deny(error,epoch,data.access);throw error;
        }
        drafts.bind({...data.access,eventId});setVerified(data);onAccessRestored?.();return data;
      } catch(e) {if(accessError(e) && !signal.aborted)deny(e,epoch);throw e;}
    },gcTime:0,staleTime:0,refetchOnWindowFocus:false,retry:false});
  async function recover() {
    if(recovering)return;
    setRecovering(true);setRecoveryError('');
    try {const result=await bootstrap.refetch();if(result.error)throw result.error;if(!result.data)throw new Error('暂时无法恢复读取，请重试。');setBlocked(null);}
    catch(e){setRecoveryError(accessError(e)?e.status===401?'请重新登录，再恢复读取。':e.status===403?'当前账号仍没有读取权限。':'这份记录仍不可访问。':'暂时无法连接，请重试。');}
    finally {setRecovering(false);}
  }
  if(blocked)return <section className="meeting-tab-panel" aria-live="polite">
    <p>{blocked.code==='identity_changed'?'账号已变化，请重新读取。':blocked.status===401?'登录已失效，请重新登录。':blocked.status===403?'当前账号已无法访问这份记录。':'这份记录已删除、归档或移出当前工作空间。'}</p>
    <RetainedInputs session={drafts} onDiscard={()=>drafts.discard()}/>
    {recoveryError && <p role="alert">{recoveryError}</p>}
    <NqButton variant="secondary" loading={recovering} onClick={()=>void recover()}>恢复读取</NqButton>
    {blocked.status===401 && blocked.code!=='identity_changed' && <a className="button secondary" href={`/signin-with-chatgpt?return_to=${encodeURIComponent('/?view=simple')}`} target="_blank" rel="noreferrer">重新登录</a>}
    {[404,410].includes(blocked.status) && <Link className="button quiet" href="/?view=simple" onClick={e=>{if(drafts.getSnapshot().length){e.preventDefault();setRecoveryError("请先复制并放弃保留的输入，再返回项目列表。");}}}>返回项目列表</Link>}
  </section>;
  if (!verified) return <section className="meeting-tab-panel" aria-live="polite"><p>{bootstrap.isError?'暂时无法读取这份记录。':'正在读取这份记录…'}</p>{bootstrap.isError && <NqButton variant="secondary" onClick={()=>void bootstrap.refetch()}>重新读取</NqButton>}</section>;
  return <LoadedRecordPage key={`${verified.access.workspaceId}:${verified.access.actorId}:${eventId}`} {...{focusClaimId,projectId,eventId,title,subtitle,onContinue,onOpenTranscript,onOpenRecord,refreshToken,processing}} initial={verified} drafts={drafts} onDenied={deny}/>;
}

function LoadedRecordPage({focusClaimId,projectId,eventId,title,subtitle,onContinue,onOpenTranscript,onOpenRecord,refreshToken,processing,initial,drafts,onDenied}: {
  focusClaimId?:string;projectId:string;eventId:string;title:string;subtitle:string;onContinue:()=>void;onOpenTranscript:()=>void;onOpenRecord?:(eventId:string,claimId?:string)=>void;initial:WorkspaceSnapshot;refreshToken:string;processing:boolean;drafts:MemoryDraftSession;onDenied:(e:ApiClientError,epoch:number,next?:WorkspaceSnapshot['access'])=>void;
}) {
  const client=useQueryClient();
  const [binding]=useState(()=>drafts.bindEditor({...initial.access,eventId}));
  const epoch=useRef(drafts.epoch).current;
  const assertActive=useCallback(()=>{if(!drafts.isCurrent(epoch))throw new DOMException('已停止旧请求','AbortError');},[drafts,epoch]);
  const verifyIdentity=useCallback((data:WorkspaceSnapshot)=>{
    assertActive();
    if(data.access.workspaceId!==initial.access.workspaceId || data.access.actorId!==initial.access.actorId) {
      const error=new ApiClientError({status:401,code:'identity_changed',message:'账号已变化，请重新读取。'});
      onDenied(error,epoch,data.access);throw error;
    }
    return data;
  },[assertActive,initial.access.workspaceId,initial.access.actorId,onDenied,epoch]);
  const loadHighlightSources=useCallback(async()=>{
    if(!drafts.isCurrent(epoch))throw new DOMException('已停止旧请求','AbortError');
    try {const rows=await workflowService.highlightSources(eventId);if(!drafts.isCurrent(epoch))throw new DOMException('已停止旧请求','AbortError');return rows;}
    catch(e){if(accessError(e))onDenied(e,epoch);throw e;}
  },[drafts,epoch,eventId,onDenied]);
  const [submissions]=useState(()=>new SubmitSession());
  const [analysisBusy,setAnalysisBusy]=useState(false);
  const [analysisError,setAnalysisError]=useState('');
  const minimum=useRef<number|undefined>(undefined);
  const queryKey=['notique','workflow-v2',initial.access.workspaceId,initial.access.actorId,projectId,eventId];
  const workspace=useQuery({queryKey,initialData:initial,queryFn:async({signal})=>{try{return verifyIdentity(await workflowService.getFullWorkspace(eventId,minimum.current,signal));}catch(e){if(accessError(e) && !signal.aborted)onDenied(e,epoch);throw e;}},
    staleTime:1000,gcTime:0,refetchInterval:query=>{const run=client.getQueryData<AnalysisRun>(['notique','workflow-v2-analysis',initial.access.workspaceId,initial.access.actorId,eventId,query.state.data?.analysisRunId]);return processing||run?.state==='queued'||run?.state==='running'||run?.stages.some(s=>s.state==='queued'||s.state==='running')||query.state.data?.narrative?.freshness==='updating'?3000:false;},structuralSharing:(old:unknown,next:unknown)=>{const previous=old as WorkspaceSnapshot|undefined;const incoming=next as WorkspaceSnapshot;return previous && previous.contextVersion>incoming.contextVersion?previous:incoming;},refetchOnWindowFocus:'always',retry:(count,error)=>count<2 && (!(error instanceof ApiClientError)||error.status===0||error.status===503)});
  const analysisId=workspace.data?.analysisRunId??null;
  const analysisKey=['notique','workflow-v2-analysis',initial.access.workspaceId,initial.access.actorId,eventId,analysisId];
  const analysis=useQuery({queryKey:analysisKey,enabled:Boolean(analysisId),queryFn:async({signal})=>{assertActive();try{const run=await workflowService.getAnalysisRun(analysisId!,signal);assertActive();return run;}catch(e){if(accessError(e) && !signal.aborted)onDenied(e,epoch);throw e;}},staleTime:1000,gcTime:0,refetchOnWindowFocus:'always',retry:false,
    refetchInterval:q=>q.state.data && (q.state.data.state==='queued'||q.state.data.state==='running'||q.state.data.stages.some(s=>s.state==='queued'||s.state==='running'))?3000:false});
  const analysisPending=analysis.data?.state==='queued'||analysis.data?.state==='running'||Boolean(analysis.data?.stages.some(s=>s.state==='queued'||s.state==='running'));

  useEffect(()=>{void client.invalidateQueries({queryKey:['notique','workflow-v2',initial.access.workspaceId,initial.access.actorId,projectId,eventId]});},[client,eventId,projectId,initial.access.workspaceId,initial.access.actorId,refreshToken]);
  async function refresh(version?:number) {
    assertActive();await client.cancelQueries({queryKey});
    if(version!==undefined) minimum.current=Math.max(minimum.current??0,version);
    let snapshot:WorkspaceSnapshot;
    try {snapshot=verifyIdentity(await workflowService.getFullWorkspace(eventId,minimum.current));}
    catch(e){if(accessError(e))onDenied(e,epoch);throw e;}
    client.setQueryData(queryKey,(previous:WorkspaceSnapshot|undefined)=>previous && previous.contextVersion>snapshot.contextVersion?previous:snapshot);
    void client.invalidateQueries({predicate:q=>q.queryKey[0]==='notique' && q.queryKey[1]!=='workflow-v2'});
  }
  async function mutate<T>(endpoint:string,body:T,send:(key:string,request:T)=>Promise<MutationReceipt>) {
    return submissions.run(endpoint,body,async(key,frozen)=>{
      try {
        assertActive();const receipt=await send(key,frozen as T);
        minimum.current=Math.max(minimum.current??0,receipt.contextVersion);
        try { await refresh(receipt.contextVersion); }
        catch(e) { if(accessError(e))throw e;throw new Error('内容已保存，正在同步显示。请重试，系统会读取同一次保存结果。'); }
      } catch(error) {
        if(accessError(error))onDenied(error,epoch);
        if(error instanceof ApiClientError && error.status===409) await refresh().catch(()=>undefined);
        throw error;
      }
    });
  }
  async function operateAnalysis(retry=false) {
    if(!window.dispatchEvent(new Event(WORKFLOW_LEAVE_EVENT,{cancelable:true})))return;
    assertActive();setAnalysisBusy(true);setAnalysisError('');
    try {
      const run=await submissions.run(retry?`retry-analysis/${analysisId}`:`start-analysis/${eventId}`,
        retry?{expectedRunRevision:analysis.data!.revision,stageIds:analysis.data!.stages.filter(s=>s.retryable).map(s=>s.id)}:{sourceRevision:workspace.data!.sourceRevision,mode:analysisId?'reorganize':'initial'},
        (key,body)=>{assertActive();return retry?workflowService.retryAnalysis(analysisId!,body as Parameters<typeof workflowService.retryAnalysis>[1],key):workflowService.startAnalysis(eventId,body as Parameters<typeof workflowService.startAnalysis>[1],key);});
      assertActive();client.setQueryData(['notique','workflow-v2-analysis',initial.access.workspaceId,initial.access.actorId,eventId,run.id],run);
      await refresh();
    } catch(error) {
      setAnalysisError(error instanceof Error?error.message:'暂时无法整理，请重试。');
      if(accessError(error))onDenied(error,epoch);
      if(drafts.isCurrent(epoch)){await analysis.refetch();await refresh().catch(()=>undefined);}
    } finally {setAnalysisBusy(false);}
  }
  const saveProgress=useCallback(async(body:ReviewProgressRequest):Promise<ReviewProgress>=>submissions.run(`progress/${eventId}`,body,async(key,frozen)=>{
    const cacheKey=['notique','workflow-v2',initial.access.workspaceId,initial.access.actorId,projectId,eventId];
    try {
      if(!drafts.isCurrent(epoch))throw new DOMException('已停止旧请求','AbortError');
      const progress=await workflowService.progress(eventId,frozen as ReviewProgressRequest,key);
      if(!drafts.isCurrent(epoch))throw new DOMException('已停止旧请求','AbortError');
      client.setQueryData(cacheKey,(previous:WorkspaceSnapshot|undefined)=>previous?{...previous,reviewProgress:{...progress,remainingCount:previous.counts.needsDecisionCount}}:previous);
      return progress;
    } catch(error) {
      if(accessError(error))onDenied(error,epoch);
      if(error instanceof ApiClientError && error.status===409) {
        let latest:WorkspaceSnapshot;
        try {latest=verifyIdentity(await workflowService.getFullWorkspace(eventId,minimum.current));}
        catch(e){if(accessError(e))onDenied(e,epoch);throw e;}
        client.setQueryData(cacheKey,(previous:WorkspaceSnapshot|undefined)=>previous && previous.contextVersion>latest.contextVersion?previous:latest);
      }
      throw error;
    }
  }),[client,eventId,projectId,submissions,initial.access.workspaceId,initial.access.actorId,drafts,epoch,onDenied,verifyIdentity]);
  if (!workspace.data) return <section className="meeting-tab-panel" aria-live="polite">
    <p>{workspace.isError?'暂时无法读取这份记录。':'正在读取这份记录…'}</p>
    {workspace.isError && <NqButton variant="secondary" onClick={()=>void workspace.refetch()}>重新读取</NqButton>}
  </section>;
  const snapshot=workspace.data;
  const accessDenied=workspace.error instanceof ApiClientError && [401,403,404,410].includes(workspace.error.status);
  if(accessDenied) return <section className="meeting-tab-panel"><p>当前账号已无法访问这份记录。</p></section>;
  return <MemoryDraftContext.Provider value={binding}>
    {!snapshot.access.canEdit && drafts.getSnapshot().length>0 && <p role="status">当前只能读取，输入仍然保留。<NqButton variant="quiet" onClick={()=>void refresh().catch(()=>undefined)}>重新检查权限</NqButton></p>}
    {workspace.isError && <p role="alert">暂时无法同步最新记录。<NqButton variant="quiet" onClick={()=>void workspace.refetch()}>重新读取</NqButton></p>}
    <RecordWorkspace retainedInputs={<RetainedInputs session={drafts} onDiscard={()=>drafts.discard()}/>} focusClaimId={focusClaimId} embedded processing={processing||analysisPending} eventId={eventId} projectId={projectId} title={title} subtitle={subtitle} snapshot={snapshot} sources={[]} canEdit={snapshot.access.canEdit && !workspace.isError}
      analysisHasCoverage={Boolean(analysis.data)} analysisHasNarrative={Boolean(analysis.data?.stages.some(s=>s.name==='更新全文概要'))}
      analysisPanel={<AnalysisProgress run={analysis.data??null} hasRecord={snapshot.bullets.length>0 || Boolean(snapshot.reaffirmedMentions?.length)} busy={analysisBusy} error={analysisError||(analysis.error instanceof Error?analysis.error.message:'')} canEdit={snapshot.access.canEdit && !workspace.isError} onStart={()=>void operateAnalysis()} onRetry={()=>void operateAnalysis(true)} onReload={()=>void refresh().then(()=>{if(analysisId)void analysis.refetch();}).catch(()=>undefined)}/>}
      onMention={(id,body)=>mutate(`mention/${id}`,body,(key,request)=>workflowService.mention(id,request,key))}
      onProgress={saveProgress}
      onSources={async ids=>{assertActive();try{const sources=await workflowService.sources(ids);assertActive();return sources;}catch(e){if(accessError(e))onDenied(e,epoch);throw e;}}} onOpenTranscript={onOpenTranscript} onOpenRecord={onOpenRecord}
      onDecide={(id,body)=>mutate(`decide/${id}`,body,(key,request)=>workflowService.decide(id,request,key))}
      onHighlightSources={loadHighlightSources}
      onHighlight={body=>mutate(`highlight/${eventId}`,body,(key,request)=>workflowService.highlight(eventId,request,key))}
      onRevert={(id,body)=>mutate(`revert/${id}`,body,(key,request)=>workflowService.revert(id,request,key))}
      onTransition={(id,body)=>mutate(`transition/${id}`,body,(key,request)=>workflowService.transition(id,request,key))}
      onAnswer={(id,body)=>mutate(`answer/${id}`,body,(key,request)=>workflowService.answer(id,request,key))}
      onOutcome={(id,body)=>mutate(`outcome/${id}`,body,(key,request)=>workflowService.outcome(id,request,key))}
      onCorrection={(id,body)=>mutate(`correction/${id}`,body,(key,request)=>workflowService.correction(id,request,key))}
      onReport={(body,signal)=>submissions.runLatest(`report/${projectId}`,()=>{
        assertActive();
        const latest=client.getQueryData<WorkspaceSnapshot>(queryKey);
        if(!latest || latest.contextVersion<(minimum.current??0))throw new Error('记录还在同步，请稍后重新复制。');
        verifyIdentity(latest);
        return {...body,expectedContextVersion:latest.contextVersion};
      },async(key,frozen)=>{
        assertActive();
        try {const report=await workflowService.report(projectId,frozen as typeof body,key,signal);assertActive();return report.content;}
        catch(e){
          if(accessError(e))onDenied(e,epoch);
          if(e instanceof ApiClientError && e.status===409){await refresh().catch(()=>undefined);throw new Error('记录已有更新，请核对最新内容后重新复制。');}
          throw e;
        }
      },signal)}
      onContinue={onContinue}/>
  </MemoryDraftContext.Provider>;
}
