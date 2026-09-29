"use client";
import {useState} from 'react';
import {Modal} from '@/app/components/modal';
import {NqButton} from '@/app/components/notique-ui';
import {ApiClientError} from '@/app/api-client';
import type {ConflictChoice,DecisionRequest,ReviewMember,WorkspaceSnapshot} from '@/lib/shared/workflow-v2';
import {useMemoryDrafts,useDraftCheckpoint} from './memory-drafts';
import styles from './record-workspace.module.css';

export function ConflictReview({cardId,snapshot,canEdit,onDecide,onSource,onClose}: {
 cardId:string;snapshot:WorkspaceSnapshot;canEdit:boolean;onDecide:(id:string,request:DecisionRequest)=>Promise<void>;onSource:(member:ReviewMember)=>void;onClose:()=>void;
}) {
 const memory=useMemoryDrafts();
 const [restored]=useState(()=>{const d=memory?.restored('conflict');return d?.targetId===cardId?d:undefined;});
 const [base,setBase]=useState(snapshot);
 const [mode,setMode]=useState<ConflictChoice['mode']|null>(restored?.mode ?? null);
 const [applicability,setApplicability]=useState(restored?.applicability ?? '');
 const [index,setIndex]=useState(()=>{const conflicts=snapshot.reviewCards.find(c=>c.id===cardId)?.conflicts ?? [];return Math.max(0,conflicts.findIndex(c=>c.existing.claimId===restored?.existingRef.claimId && c.candidateRef.claimId===restored?.candidateRef.claimId));});
 const [closing,setClosing]=useState(false);
 const [pending,setPending]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(Boolean(restored));
 const card=base.reviewCards.find(c=>c.id===cardId),conflict=card?.conflicts?.[index];
 const candidate=card?.members.find(m=>m.claimId===conflict?.candidateRef.claimId);
 const actionConflict=conflict?.existingActionState!==undefined;
 const canAdopt=candidate?.supportStatus==='fully_supports' && card?.sourceStatus==='ready';
 useDraftCheckpoint(mode && conflict?{kind:'conflict',targetId:cardId,existingRef:{claimId:conflict.existing.claimId,claimVersionId:conflict.existing.claimVersionId},candidateRef:conflict.candidateRef,mode,applicability}:null);
 const finish=()=>{memory?.clear('conflict');onClose();};
 const close=()=>{if(mode || applicability.trim())setClosing(true);else finish();};
 async function save() {
  if(!card || !conflict || !candidate || !mode) return;
  setPending(true);setError('');
  try {
   await onDecide(card.id,{expectedContextVersion:base.contextVersion,expectedCardRevision:card.revision,operation:'resolve_conflict',members:[{claimId:candidate.claimId,claimVersionId:candidate.claimVersionId,operation:'resolve_conflict',conflictChoice:{mode,existingRef:{claimId:conflict.existing.claimId,claimVersionId:conflict.existing.claimVersionId},candidateRef:conflict.candidateRef,...(mode==='coexist'?{applicability}:{} )}}]});
   finish();
  } catch(e) {setError(e instanceof Error?e.message:'保存失败，请重试。');if(e instanceof ApiClientError && e.status===409)setStale(true);}
  finally {setPending(false);}
 }
 return <Modal returnFocusSelector={`#conflict-${cardId}`} title={actionConflict?"决定接下来跟进哪项":"决定采用哪条信息"} description={actionConflict?"对照原行动与新建议，选择接下来跟进的事项。":"对照新旧内容，选择这份记录接下来使用的信息。"} dismissible={!pending} onClose={close}>
  <div className={`${styles.memberReview} ${styles.questionReview} ${styles.questionSimple}`}>
   <div className={styles.questionContent} role="region" aria-label="新旧内容与选择" tabIndex={0}>
   {!conflict || !candidate?<p>这条差异已处理或发生变化，请返回记录查看。</p>:<>
    {(card?.conflicts?.length ?? 0)>1 && <label>需要核对的原信息<select value={index} onChange={e=>{setIndex(Number(e.target.value));setMode(null);}}>{card!.conflicts!.map((c,i)=><option key={c.relationId} value={i}>{c.existing.statement}</option>)}</select></label>}
    <div className={styles.basisChange}><div><span>原来已采纳</span><p>{conflict.existing.statement}</p>{actionConflict && <small>{conflict.existingActionState==='completed'?'当时已完成':conflict.existingActionState==='cancelled'?'当时已取消':'待跟进'}</small>}<NqButton variant="quiet" onClick={()=>onSource(conflict.existing)}>查看原信息出处</NqButton></div><div><span>这次的新信息</span><p>{candidate.statement}</p><NqButton variant="quiet" onClick={()=>onSource(candidate)}>查看新信息出处</NqButton></div></div>
    <fieldset className={styles.conflictChoices} disabled={pending || !canEdit}><legend>这次采用哪种方式</legend>
     <label><input type="radio" name="conflict-choice" checked={mode==='use_candidate'} disabled={!canAdopt} onChange={()=>setMode('use_candidate')}/><span>{actionConflict?'改为跟进新行动':'采用新信息'}<small>{actionConflict?'原行动和完成记录保留在历史，新行动单独跟进。':'原信息保留在历史中，相关答案随之更新。'}</small></span></label>
     <label><input type="radio" name="conflict-choice" checked={mode==='keep_existing'} onChange={()=>setMode('keep_existing')}/><span>{actionConflict?'继续原行动':'保留原信息'}<small>{actionConflict?'原行动的状态和结果保持，这次的新建议收起。':'这次的新信息移出当前记录。'}</small></span></label>
     <label><input type="radio" name="conflict-choice" checked={mode==='coexist'} disabled={!canAdopt} onChange={()=>setMode('coexist')}/><span>{actionConflict?'两项都跟进':'两条信息分别适用'}<small>写明各自的适用情况，一起保留。</small></span></label>
    </fieldset>
    {!canAdopt && <p className={styles.notice}>新信息的出处或支持情况需要补齐，当前可以保留原信息。</p>}
    {mode==='coexist' && <label className={styles.conflictScope}>适用情况<textarea value={applicability} onChange={e=>setApplicability(e.target.value)} maxLength={4000} rows={3} readOnly={!canEdit || pending} placeholder={actionConflict?"例如：原行动负责询价，新行动负责确认交期。":"例如：原预算用于一期，新预算用于二期。"}/></label>}
   </>}
   {error && <p role="alert" className={styles.error}>{error}</p>}
   {stale && <NqButton variant="secondary" onClick={()=>{const next=snapshot.reviewCards.find(c=>c.id===cardId)?.conflicts ?? [];const index=next.findIndex(c=>c.existing.claimId===conflict?.existing.claimId && c.candidateRef.claimId===candidate?.claimId);const chosen=next[Math.max(index,0)];const prior=restored ?? (conflict?{existingRef:conflict.existing,candidateRef:conflict.candidateRef}:null);if(chosen?.existing.claimVersionId!==prior?.existingRef.claimVersionId || chosen?.candidateRef.claimVersionId!==prior?.candidateRef.claimVersionId)setMode(null);setBase(snapshot);setIndex(Math.max(index,0));setStale(false);setError('');}}>重新核对最新内容</NqButton>}
   </div>
   {closing?<div className={styles.notice}><p>这次选择还未保存。</p><div className={styles.inlineActions}><NqButton variant="secondary" onClick={()=>setClosing(false)}>继续核对</NqButton><NqButton variant="quiet" onClick={finish}>放弃本次选择</NqButton></div></div>:<div className={styles.inlineActions}><NqButton loading={pending} disabled={!canEdit || !mode || !conflict || stale || (mode!=='keep_existing'&&!canAdopt) || (mode==='coexist'&&!applicability.trim())} onClick={()=>void save()}>保存选择</NqButton><NqButton variant="quiet" disabled={pending} onClick={close}>先不处理</NqButton></div>}
  </div>
 </Modal>;
}
