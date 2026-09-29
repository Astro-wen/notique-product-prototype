"use client";

import {useId,useState} from 'react';
import {Modal} from '@/app/components/modal';
import {NqButton} from '@/app/components/notique-ui';
import {ApiClientError} from '@/app/api-client';
import type {DecisionRequest,ReviewMember,WorkspaceSnapshot} from '@/lib/shared/workflow-v2';
import {useMemoryDrafts,useDraftCheckpoint} from './memory-drafts';
import styles from './record-workspace.module.css';

type Choice={claimVersionId:string;mode:''|'keep'|'reopen'};
export function QuestionEditor({questionId,snapshot,canEdit,onDecide,onSource,onClose}:{questionId:string;snapshot:WorkspaceSnapshot;canEdit:boolean;onDecide:(id:string,body:DecisionRequest)=>Promise<void>;onSource:(member:ReviewMember)=>void;onClose:(saved?:boolean)=>void}) {
  const memory=useMemoryDrafts(),inputId=useId();
  const [restored]=useState(()=>{const d=memory?.restored('question');return d?.targetId===questionId?d:undefined;});
  const [base,setBase]=useState(snapshot);
  const question=base.questions.find(q=>q.id===questionId)!;
  const card=base.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===questionId))!;
  const member=card.members.find(m=>m.claimId===questionId)!;
  const [text,setText]=useState(restored?.text ?? member.statement),[touched,setTouched]=useState(restored?.text!==undefined);
  const initialOrigin=member.origin==='user_input'||!member.evidenceRefIds.length?'user_input':'source_statement';
  const [origin,setOrigin]=useState<'source_statement'|'user_input'>(restored?.origin ?? initialOrigin);
  const [choices,setChoices]=useState<Record<string,Choice>>(()=>Object.fromEntries(question.answerRefs.map(r=>[r.claimId,{claimVersionId:r.claimVersionId,mode:restored?.choices[r.claimId]?.claimVersionId===r.claimVersionId?restored.choices[r.claimId].mode:''}])));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(Boolean(restored)),[closing,setClosing]=useState(false);
  const latest=snapshot.questions.find(q=>q.id===questionId),latestCard=snapshot.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===questionId)),latestMember=latestCard?.members.find(m=>m.claimId===questionId);
  const needsReview=conflict || snapshot.contextVersion!==base.contextVersion;
  const dirty=touched || origin!==initialOrigin || Object.values(choices).some(c=>c.mode);
  const picked=Object.fromEntries(Object.entries(choices).flatMap(([id,c])=>c.mode?[[id,{claimVersionId:c.claimVersionId,mode:c.mode}]]:[]));
  useDraftCheckpoint(dirty?{kind:'question',targetId:questionId,...(touched?{text}:{}),origin,choices:picked}:null);
  function finish(saved=false){memory?.clear('question');onClose(saved);}
  function close(){if(busy)return;if(dirty)setClosing(true);else finish();}
  function rebase() {
    if(!latest || !latestMember){setError('这个问题已移出当前记录，请复制你的输入后返回。');return;}
    setChoices(value=>Object.fromEntries(latest.answerRefs.map(r=>[r.claimId,{claimVersionId:r.claimVersionId,mode:value[r.claimId]?.claimVersionId===r.claimVersionId?value[r.claimId].mode:''}])));
    if(!touched)setText(latestMember.statement);
    setBase(snapshot);setConflict(false);setError('');
  }
  async function save() {
    if(busy || !canEdit || needsReview)return;
    if(!text.trim()){setError('请填写问题。');return;}
    if(question.answerRefs.some(r=>!choices[r.claimId]?.mode)){setError('请逐条选择原答案是否仍然适用。');return;}
    setBusy(true);setError('');
    try {
      await onDecide(card.id,{expectedContextVersion:base.contextVersion,expectedCardRevision:card.revision,operation:'edit',members:[{claimId:questionId,claimVersionId:question.claimRef.claimVersionId,operation:'edit',newText:text,origin,evidenceRefIds:origin==='source_statement'?member.evidenceRefIds:[],questionChange:{answerChoices:question.answerRefs.map(r=>({...r,mode:choices[r.claimId].mode as 'keep'|'reopen'}))}}]});
      finish(true);
    }catch(e){if(e instanceof ApiClientError && e.status===409)setConflict(true);setError(e instanceof ApiClientError && e.code==='version_conflict'?'':e instanceof ApiClientError && e.status===0 || e instanceof TypeError?'暂时连接不上服务器，文字和选择已保留。':e instanceof Error?e.message:'暂时没能保存，请重试。');}
    finally{setBusy(false);}
  }
  const actions=base.actions.filter(a=>a.questionRefs.some(r=>r.claimId===questionId));
  return <Modal title="调整问题" description="改清楚问题，再核对原答案。" onClose={close} dismissible={!busy} wide>
    <div className={`${styles.memberReview} ${styles.questionReview} ${question.answerRefs.length?"":styles.questionSimple}`}>
      <div className={styles.questionContent} role="region" aria-label="问题与答案" tabIndex={0}>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {needsReview && <div className={styles.notice}><p>{restored?'已恢复读取，请核对当前问题和答案后保存。':'记录有新变化，你的文字和选择保留在这里。'}</p>{latestMember && latestMember.statement!==member.statement && <p>当前问题：{latestMember.statement}</p>}<NqButton variant="secondary" onClick={rebase} disabled={!canEdit || !latest}>核对后采用当前版本</NqButton></div>}
      <div className={styles.editor}><label htmlFor={inputId}>修改问题</label><textarea id={inputId} value={text} onChange={e=>{setText(e.target.value);setTouched(true);}} rows={3} maxLength={4000} disabled={busy||!canEdit} autoFocus/><label className={styles.origin}>问题修改依据<select aria-label="问题修改依据" value={origin} disabled={busy||!canEdit} onChange={e=>setOrigin(e.target.value as typeof origin)}><option value="source_statement" disabled={!member.evidenceRefIds.length}>按原话修正</option><option value="user_input">我的新信息</option></select></label><NqButton variant="quiet" onClick={()=>onSource(member)}>查看问题原话</NqButton></div>
      {!!question.answerRefs.length && <div className={styles.memberList}><h3>原答案还适用吗？</h3>{question.answerRefs.map((r,index)=>{
        const answer=base.bullets.find(b=>b.claimRefs.some(ref=>ref.claimVersionId===r.claimVersionId));
        return <section key={r.claimVersionId} className={styles.memberRow} data-testid={`question-answer-${r.claimId}`}><p className={styles.statement}>{answer?.text ?? '这条答案需要重新核对出处。'}</p>{answer?.applicability && <p className={styles.reason}>适用情况：{answer.applicability}</p>}<label className={styles.memberChoice}>第{index+1}条答案<select aria-label={`第${index+1}条答案是否适用`} value={choices[r.claimId]?.mode ?? ''} disabled={busy||!canEdit} onChange={e=>setChoices(value=>({...value,[r.claimId]:{claimVersionId:r.claimVersionId,mode:e.target.value as Choice['mode']}}))}><option value="">请选择</option><option value="keep">仍然回答这个问题</option><option value="reopen">需要重新确认</option></select></label></section>;
      })}</div>}
      {!!actions.length && <p className={styles.notice}>关联的{actions.length}项行动会提示核对新问题，完成状态保留。</p>}
      {question.answerRefs.some(r=>choices[r.claimId]?.mode==='reopen') && <p className={styles.reason}>需重新确认的答案会移出这个问题。全部答案都需重新确认时，问题重新待回答。</p>}
      </div>
      {closing?<div className={styles.notice}><p>问题修改尚未保存。</p><div className={styles.inlineActions}><NqButton variant="secondary" onClick={()=>setClosing(false)}>继续修改</NqButton><NqButton variant="quiet" onClick={()=>finish()}>放弃本次修改</NqButton></div></div>:<div className={styles.memberFooter}><NqButton variant="secondary" onClick={close} disabled={busy}>返回记录</NqButton><NqButton onClick={()=>void save()} loading={busy} disabled={!canEdit||needsReview||!text.trim()}>保存问题修改</NqButton></div>}
    </div>
  </Modal>;
}
