"use client";

import { useState } from 'react';
import { Modal } from '@/app/components/modal';
import { NqButton, NqStatus } from '@/app/components/notique-ui';
import { ApiClientError } from '@/app/api-client';
import type { DecisionMember, DecisionRequest, ReviewMember, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';
import {userMayAcceptSupport} from '@/lib/domain/review-support';
import {useMemoryDrafts,useDraftCheckpoint} from './memory-drafts';
import {FactAnswerReview,factChangeFor,factChoicesFor,type FactChoices} from './fact-answer-review';
import styles from './record-workspace.module.css';

type Choice = { questionChoices?:FactChoices; operation:'keep'|'confirm'|'edit'|'reject'|'accept_action'; text:string; origin:'source_statement'|'user_input' };
export function MemberReview({cardId,initialEditClaimId,snapshot,canEdit,onDecide,onSource,onClose}: {
  cardId:string;initialEditClaimId?:string;snapshot:WorkspaceSnapshot;canEdit:boolean;
  onDecide:(cardId:string,request:DecisionRequest)=>Promise<void>;
  onSource:(member:ReviewMember)=>void;onClose:()=>void;
}) {
  const memory=useMemoryDrafts();
  const [restored]=useState(()=>{const d=memory?.restored('members');return d?.targetId===cardId?d:undefined;});
  const [base,setBase]=useState(()=>snapshot);
  const [choices,setChoices]=useState<Record<string,Choice>>(()=>Object.fromEntries(snapshot.reviewCards.find(c=>c.id===cardId)!.members.map(m=>[m.claimId,{questionChoices:restored?.choices[m.claimId]?.questionChoices,operation:restored?.choices[m.claimId]?.operation ?? (m.claimId===initialEditClaimId?'edit':'keep'),text:restored?.choices[m.claimId]?.text ?? m.statement,origin:restored?.choices[m.claimId]?.origin ?? (m.origin==='user_input'||!m.evidenceRefIds.length?'user_input':'source_statement')}])));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[conflict,setConflict]=useState(Boolean(restored)),[closing,setClosing]=useState(false);
  const [touched,setTouched]=useState<Record<string,boolean>>(()=>Object.fromEntries(Object.entries(restored?.choices ?? {}).filter(([,c])=>c.text!==undefined).map(([id])=>[id,true])));
  const card=base.reviewCards.find(c=>c.id===cardId)!,current=snapshot.reviewCards.find(c=>c.id===cardId);
  const overlap=card.actionOverlap;
  const manual=overlap && card.members.find(m=>m.claimId===overlap.manualRef.claimId);
  const model=overlap && card.members.find(m=>m.claimId===overlap.modelRef.claimId);
  const overlapReady=manual?.reviewState==='draft' && model?.reviewState==='draft' && manual.supportStatus!=='does_not_support' && model.supportStatus!=='does_not_support' && Boolean(manual.evidenceRefIds.length && model.evidenceRefIds.length);
  const selected=card.members.filter(m=>choices[m.claimId]?.operation!=='keep');
  const dirty=selected.length>0 || card.members.some(m=>choices[m.claimId]?.text!==m.statement);
  useDraftCheckpoint(selected.length || Object.keys(touched).length?{kind:'members',targetId:cardId,...(initialEditClaimId?{editClaimId:initialEditClaimId}:{}),choices:Object.fromEntries(card.members.filter(m=>choices[m.claimId].operation!=='keep' || touched[m.claimId]).map(m=>[m.claimId,{operation:choices[m.claimId].operation,claimVersionId:m.claimVersionId,origin:choices[m.claimId].origin,...(touched[m.claimId]?{text:choices[m.claimId].text}:{}),...(choices[m.claimId].questionChoices?{questionChoices:choices[m.claimId].questionChoices}:{})}]))}:null);
  function finish(){memory?.clear('members');onClose();}
  function update(id:string,patch:Partial<Choice>) {if(patch.text!==undefined)setTouched(value=>({...value,[id]:true}));setChoices(value=>({...value,[id]:{...value[id],...patch}}));setError('');}
  function chooseOverlap(preferred:'manual'|'model') {
    if(!manual || !model || !overlapReady)return;
    setChoices(value=>({...value,[manual.claimId]:{...value[manual.claimId],operation:preferred==='manual'?'accept_action':'reject'},[model.claimId]:{...value[model.claimId],operation:preferred==='model'?'accept_action':'reject'}}));
    setError('');
  }
  function close() {if(busy)return;if(dirty)setClosing(true);else finish();}
  function rebase() {
    if(!current || !['record','action'].includes(current.kind)) {setError('这组内容已变化，请复制当前输入后返回记录。');return;}
    const removed=selected.filter(m=>!current.members.some(n=>n.claimId===m.claimId && n.reviewState!=='rejected'));
    if(removed.length) {setError('有内容已移出这组，请将对应选择改为保持原样，再核对当前版本。');return;}
    const processed=selected.filter(m=>{const latest=current.members.find(n=>n.claimId===m.claimId)!;return latest.reviewState==='accepted' && ['confirm','reject','accept_action'].includes(choices[m.claimId].operation);});
    if(processed.length) {setError('有内容已被处理，请选择保持原样或修改后采纳，再核对当前版本。');return;}
    setChoices(value=>Object.fromEntries(current.members.map(m=>[m.claimId,{...(value[m.claimId] ?? {operation:'keep',text:m.statement,origin:m.origin==='user_input'||!m.evidenceRefIds.length?'user_input':'source_statement'}),questionChoices:factChoicesFor(m,value[m.claimId]?.questionChoices)}])));
    setBase(snapshot);setConflict(false);setError('');
  }
  async function save() {
    if(busy || !canEdit || conflict)return;
    if(!selected.length){setError('请先选择要处理的内容。');return;}
    if(selected.length>20){setError('一次可以保存20条，请分次处理。');return;}
    if(selected.some(m=>choices[m.claimId].operation==='edit' && !choices[m.claimId].text.trim())) {setError('请填写修改后的内容。');return;}
    setBusy(true);setError('');
    try {
      const members:DecisionMember[]=selected.map(m=>{
        const c=choices[m.claimId];
        return {claimId:m.claimId,claimVersionId:m.claimVersionId,operation:c.operation as DecisionMember['operation'],...(c.operation==='edit'?{newText:c.text,origin:c.origin,evidenceRefIds:c.origin==='source_statement'?m.evidenceRefIds:[],...(m.answerTargets?.length?{factChange:factChangeFor(m,c.questionChoices)}:{})}:{})};
      });
      await onDecide(cardId,{operation:'review_members',expectedContextVersion:base.contextVersion,expectedCardRevision:card.revision,members});finish();
    } catch(e) {
      if(e instanceof ApiClientError && e.status===409)setConflict(true);
      setError(e instanceof ApiClientError && e.code==='version_conflict' ? '' : e instanceof ApiClientError && e.status===0 || e instanceof TypeError ? '暂时连接不上服务器。你的选择和文字已保留，可以重试。' : e instanceof Error?e.message:'暂时没能保存，请重试。');
    } finally {setBusy(false);}
  }
  return <Modal title={overlap?'核对两种行动':'逐条处理这组重点'} description={overlap?'你的补充与 AI 建议指向相近的行动，请选要跟进的内容。':'选择要处理的内容，再一起保存。'} onClose={close} dismissible={!busy} returnFocusSelector={`#members-${cardId}`} wide>
    <div className={styles.memberReview}>
      <p>{card.title}</p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {conflict && <div className={styles.notice}><p>{restored?"已恢复读取，请核对当前内容后保存。你的选择和文字保留在这里。":"记录有新变化。你的选择和文字保留在这里。"}</p><NqButton variant="secondary" onClick={rebase} disabled={!canEdit || !current}>核对后采用当前版本</NqButton></div>}
      {overlap && overlapReady && <div className={styles.inlineActions} role="group" aria-label="选择要跟进的行动"><NqButton variant="secondary" onClick={()=>chooseOverlap('manual')} disabled={busy||!canEdit||conflict}>保留我的行动</NqButton><NqButton variant="secondary" onClick={()=>chooseOverlap('model')} disabled={busy||!canEdit||conflict}>采用 AI 建议</NqButton></div>}
      {overlap && <p className={styles.reason}>也可以逐条选择。两条确实是不同任务时，可以分别加入跟进。</p>}
      <div className={styles.memberList}>{card.members.map((m,index)=>{
        const c=choices[m.claimId],latest=current?.members.find(n=>n.claimId===m.claimId);
        const changed=conflict && (!latest || latest.claimVersionId!==m.claimVersionId || latest.reviewState!==m.reviewState);
        const accepted=m.reviewState==='accepted',rejected=m.reviewState==='rejected';
        const sourceReady=base.bullets.some(b=>b.sourceStatus==='ready' && b.claimRefs.some(r=>r.claimId===m.claimId && r.claimVersionId===m.claimVersionId));
        return <section key={m.claimId} className={styles.memberRow} data-testid={`member-${m.claimId}`}>
          <div className={styles.bulletMeta}><span>{overlap?(m.claimId===overlap.manualRef.claimId?'我的行动':'AI 建议'):`第${index+1}条`}</span><NqStatus tone={accepted?'success':rejected?'pending':'info'}>{accepted?'已采纳':rejected?'已移出记录':m.origin==='user_input'||m.origin==='user_selection'?'用户补充':'AI 草稿'}</NqStatus><NqButton variant="quiet" onClick={()=>onSource(m)}>原话</NqButton></div>
          <p className={styles.statement}>{m.statement}</p>
          {changed && <p className={styles.notice}>当前内容：{latest?.statement ?? '已移出这组'}</p>}
          <label className={styles.memberChoice}>第{index+1}条处理方式<select aria-label={`第${index+1}条处理方式`} value={c.operation} disabled={busy||!canEdit} onChange={e=>update(m.claimId,{operation:e.target.value as Choice['operation']})}>
            <option value="keep">保持原样</option>
            {!accepted && !rejected && m.kind==='record' && <option value="confirm" disabled={!userMayAcceptSupport(m.supportStatus) || !sourceReady || !m.evidenceRefIds.length}>确认</option>}
            {!accepted && !rejected && m.kind==='action' && <option value="accept_action" disabled={m.supportStatus==='does_not_support' || !m.evidenceRefIds.length}>加入跟进</option>}
            {!rejected && m.kind==='record' && <option value="edit">修改后采纳</option>}
            {!accepted && !rejected && <option value="reject">不采纳</option>}
          </select></label>
          {c.operation==='edit' && <div className={styles.editor}><label htmlFor={`member-text-${m.claimId}`}>第{index+1}条修改内容</label><textarea id={`member-text-${m.claimId}`} autoFocus={m.claimId===initialEditClaimId} value={c.text} maxLength={4000} rows={3} disabled={busy||!canEdit} onChange={e=>update(m.claimId,{text:e.target.value})}/><label className={styles.origin}>第{index+1}条修改来源<select aria-label={`第${index+1}条修改来源`} value={c.origin} disabled={busy||!canEdit} onChange={e=>update(m.claimId,{origin:e.target.value as Choice['origin']})}><option value="source_statement" disabled={!m.evidenceRefIds.length}>按原话修正</option><option value="user_input">我的新信息</option></select></label><FactAnswerReview member={m} choices={c.questionChoices} prefix={`第${index+1}条`} disabled={busy||!canEdit} onChange={questionChoices=>update(m.claimId,{questionChoices})}/></div>}
        </section>;
      })}</div>
      {closing?<div className={styles.notice}><p>这些选择还未保存。</p><div className={styles.inlineActions}><NqButton variant="secondary" onClick={()=>setClosing(false)}>继续处理</NqButton><NqButton variant="quiet" onClick={finish}>放弃本次选择</NqButton></div></div>:<div className={styles.memberFooter}><span>{selected.length?`保存${selected.length}条选择`:'其余内容保持原样'}</span><div className={styles.inlineActions}><NqButton variant="secondary" onClick={close} disabled={busy}>返回记录</NqButton><NqButton onClick={()=>void save()} loading={busy} disabled={!canEdit||!selected.length||conflict}>保存本次选择</NqButton></div></div>}
    </div>
  </Modal>;
}
