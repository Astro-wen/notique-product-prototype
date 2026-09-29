"use client";

import { useState } from 'react';
import { Modal } from '@/app/components/modal';
import { NqButton } from '@/app/components/notique-ui';
import { ApiClientError } from '@/app/api-client';
import type { DecisionRequest, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';
import styles from './record-workspace.module.css';

export function ActionBasisReview({actionId,snapshot,onDecide,onClose,onAdjust}: {
  actionId:string;snapshot:WorkspaceSnapshot;onDecide:(id:string,body:DecisionRequest)=>Promise<void>;onClose:()=>void;onAdjust:()=>void;
}) {
  const [base,setBase]=useState(snapshot);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [conflict,setConflict]=useState(false);
  const action=base.actions.find(a=>a.id===actionId);
  const card=base.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===actionId));
  const changed=action?.basisDetails.filter(b=>b.acceptedRef.claimVersionId!==b.currentRef?.claimVersionId || b.sourceStatus!=='ready') ?? [];
  const unchanged=action?.basisDetails.filter(b=>!changed.includes(b)) ?? [];
  const blocked=!action || !card || action.basisDetails.some(b=>!b.currentRef || b.sourceStatus!=='ready') || card.sourceStatus!=='ready';
  async function keep() {
    if(!action || !card || blocked) return;
    setPending(true);setError('');
    try {
      await onDecide(card.id,{operation:'accept_action',expectedContextVersion:base.contextVersion,expectedCardRevision:card.revision,members:[{...action.claimRef,operation:'accept_action'}]});
      onClose();
    } catch(e) {setError(e instanceof Error?e.message:'保存失败，请重试。');if(e instanceof ApiClientError && e.status===409)setConflict(true);}
    finally {setPending(false);}
  }
  return <Modal title="核对行动依据" description="对照变化，决定是否继续跟进。已完成的记录会保留。" onClose={()=>{if(!pending)onClose();}}>
    <div className={styles.basisReview}>
      <p className={styles.statement}>{base.bullets.find(b=>b.claimRefs.some(r=>r.claimId===actionId))?.text}</p>
      {changed.map((b,index)=><div className={styles.basisChange} key={`${b.acceptedRef.claimId}-${index}`}>
        <div><span>采纳时的依据</span><p>{b.acceptedText ?? '原依据已不可用'}</p></div>
        <div><span>当前依据</span><p>{b.currentText ?? '这条信息已撤回或不可用'}</p>{b.sourceStatus!=='ready' && <p>请先补齐这条信息的出处。</p>}</div>
      </div>)}
      {unchanged.length>0 && <details><summary>其他 {unchanged.length} 条依据未变化</summary>{unchanged.map(b=><p key={b.acceptedRef.claimId}>{b.currentText}</p>)}</details>}
      {action?.basisState==='current' && <p>这条行动的依据已经核对。</p>}
      {blocked && <p className={styles.notice}>依据尚未齐全，可以先调整行动，补齐信息后再核对。</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {conflict && <NqButton variant="secondary" onClick={()=>{setBase(snapshot);setConflict(false);setError('');}}>重新查看最新依据</NqButton>}
      <div className={styles.inlineActions}><NqButton loading={pending} disabled={blocked || conflict || action?.basisState==='current' || !snapshot.access.canEdit} onClick={()=>void keep()}>按当前依据保留行动</NqButton><NqButton variant="secondary" disabled={pending || !snapshot.access.canEdit} onClick={onAdjust}>调整行动</NqButton><NqButton variant="quiet" disabled={pending} onClick={onClose}>稍后再看</NqButton></div>
    </div>
  </Modal>;
}
