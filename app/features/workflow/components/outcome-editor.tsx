"use client";

import { useId, useState } from 'react';
import { ApiClientError } from '@/app/api-client';
import { NqButton } from '@/app/components/notique-ui';
import type { LatestOutcome, OutcomeContent, OutcomeCorrectionRequest, OutcomeRequest, QuestionAnswerRequest, VersionRef, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';
import {useMemoryDrafts,useDraftCheckpoint} from './memory-drafts';
import {recordTopics} from '@/lib/domain/record-topics';
import styles from './record-workspace.module.css';

type Choice = { mode:''|'replace'|'coexist'; applicability:string;priorAnswerRefs?:VersionRef[] };
export type OutcomeTarget = {kind:'action'|'question';id:string;correction?:LatestOutcome};
export function OutcomeEditor({readOnly=false,target,snapshot,onSaveOutcome,onAnswer,onCorrection,onClose,onSaved}: {
  readOnly?:boolean;target:OutcomeTarget;snapshot:WorkspaceSnapshot;
  onSaveOutcome:(id:string,request:OutcomeRequest)=>Promise<void>;
  onAnswer:(id:string,request:QuestionAnswerRequest)=>Promise<void>;
  onCorrection:(id:string,request:OutcomeCorrectionRequest)=>Promise<void>;
  onClose:()=>void;onSaved:()=>void;
}) {
  const memory=useMemoryDrafts();
  const [restored]=useState(()=>{const d=memory?.restored('outcome');return d?.targetId===target.id && d.targetKind===target.kind?d:undefined;});
  const [base,setBase]=useState(snapshot);
  const [correction,setCorrection]=useState(target.correction);
  const action=base.actions.find(a=>a.id===target.id);
  const actionCard=base.reviewCards.find(c=>c.memberRefs.some(r=>r.claimId===target.id));
  const questions=base.questions.filter(q=>target.kind==='question'?q.id===target.id:action?.questionRefs.some(r=>r.claimId===q.id) || !correction && base.reviewCards.some(c=>c.sourceStatus==='ready' && c.eventId===actionCard?.eventId && c.memberRefs.some(r=>r.claimId===q.id)));
  const shared=target.kind==='action' && !correction;
  const topic=recordTopics(base,base.bullets).find(t=>t.actions.some(a=>a.id===target.id));
  const suggested=new Set(questions.filter(q=>action?.questionRefs.some(r=>r.claimId===q.id) || topic?.bullets.some(b=>b.claimRefs.some(r=>r.claimId===q.id || q.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)))).map(q=>q.id));
  const [selectedIds,setSelectedIds]=useState<string[]>(()=>Object.keys(restored?.answers ?? {}));
  const textFor=(versionId:string,data=base)=>data.bullets.find(b=>b.claimRefs.some(r=>r.claimVersionId===versionId))?.text ?? '原答案';
  const [answers,setAnswers]=useState<Record<string,string>>(()=>Object.fromEntries(questions.map(q=>[q.id,restored?.answers[q.id] ?? (correction?correction.answerRefs.filter(r=>q.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)).map(r=>textFor(r.claimVersionId)).join('\n'):'')])));
  const [note,setNote]=useState(()=>{if(restored?.note!==undefined)return restored.note;const original=correction?.text ?? '';const derived=questions.flatMap(q=>correction?.answerRefs.filter(r=>q.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)).map(r=>textFor(r.claimVersionId)) ?? []).join('\n');return original.trim()===derived.trim()?'':original;});
  const [choices,setChoices]=useState<Record<string,Choice>>(restored?.choices ?? {});
  const [touched,setTouched]=useState<Record<string,boolean>>(()=>Object.fromEntries(Object.keys(restored?.answers ?? {}).map(id=>[id,true])));
  const [noteTouched,setNoteTouched]=useState(restored?.note!==undefined);
  const [noteOpen,setNoteOpen]=useState(Boolean(restored?.note || note));
  const [complete,setComplete]=useState(restored?.complete ?? false);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [conflict,setConflict]=useState(Boolean(restored));
  const prefix=useId();
  const externalRefs=(q:typeof questions[number])=>q.answerRefs.filter(r=>!correction?.answerRefs.some(a=>a.claimVersionId===r.claimVersionId));
  const updateChoice=(id:string,change:Partial<Choice>)=>setChoices(current=>({...current,[id]:{...(current[id] ?? {mode:'',applicability:''}),...change}}));
  useDraftCheckpoint(selectedIds.length || Object.keys(touched).length || noteTouched || Object.keys(choices).length || complete?{kind:'outcome',targetId:target.id,targetKind:target.kind,...(correction?{correctionId:correction.id}:{}),answers:shared?Object.fromEntries(selectedIds.map(id=>[id,note])):Object.fromEntries(Object.keys(touched).map(id=>[id,answers[id] ?? ''])),...(noteTouched?{note}:{}),choices:Object.fromEntries(Object.entries(choices).map(([id,c])=>[id,{...c,priorAnswerRefs:restored?.choices[id]?.priorAnswerRefs ?? (questions.find(q=>q.id===id)?externalRefs(questions.find(q=>q.id===id)!):[])}])),complete}:null);
  async function save() {
    if(readOnly){setError('当前账号只能读取，输入仍然保留。');return;}
    setPending(true);setError('');
    try {
      const selected=questions.filter(q=>shared?selectedIds.includes(q.id):answers[q.id]?.trim());
      const answerFor=(id:string)=>shared?note.trim():answers[id]?.trim();
      if(shared && selected.length && !note.trim())throw new Error('请填写结果，再选择要回答的问题。');
      if(target.kind==='question' && selected.length!==1) throw new Error('请填写这个问题的答案。');
      for(const q of selected) {
        if(externalRefs(q).length && !choices[q.id]?.mode) throw new Error('请选择新答案替代旧答案，还是在不同条件下并存。');
        if(choices[q.id]?.mode==='coexist' && !choices[q.id].applicability.trim()) throw new Error('请说明新旧答案各自适用的情况。');
      }
      const answerDecisions=selected.flatMap(q=>{
        const priorAnswerRefs=externalRefs(q),choice=choices[q.id];
        return priorAnswerRefs.length && choice?.mode ? [{questionId:q.id,mode:choice.mode,priorAnswerRefs,...(choice.mode==='coexist'?{applicability:choice.applicability}:{})}] : [];
      });
      const content:OutcomeContent={text:note.trim() || selected.map(q=>answerFor(q.id)).join('\n'),evidenceRefs:[],
        resolveQuestions:selected.map(q=>({questionId:q.id,revision:q.revision,answerText:answerFor(q.id)})),...(answerDecisions.length?{answerDecisions}:{}),...(shared && selected.some(q=>!action?.questionRefs.some(r=>r.claimId===q.id))?{linkQuestionRefs:selected.filter(q=>!action?.questionRefs.some(r=>r.claimId===q.id)).map(q=>q.claimRef)}:{})};
      if(!content.text) throw new Error('请填写结果或问题答案。');
      if(correction) await onCorrection(correction.id,{expectedContextVersion:base.contextVersion,expectedOutcomeRevision:correction.revision,operation:'replace',replacement:content});
      else if(target.kind==='question') {
        const q=selected[0],choice=answerDecisions[0];
        await onAnswer(q.id,{expectedContextVersion:base.contextVersion,expectedQuestionRevision:q.revision,answerText:answerFor(q.id),evidenceRefs:[],...(choice?{answerDecision:{mode:choice.mode,priorAnswerRefs:choice.priorAnswerRefs,...(choice.applicability?{applicability:choice.applicability}:{})}}:{})});
      } else {
        if(!action) throw new Error('这条行动已变化，请重新打开。');
        await onSaveOutcome(action.id,{...content,expectedContextVersion:base.contextVersion,expectedActionRevision:action.revision,completeAction:complete});
      }
      memory?.clear('outcome');onSaved();
    } catch(cause) {
      setError(cause instanceof Error?cause.message:'保存失败，请重试。');
      if(cause instanceof ApiClientError && cause.status===409) setConflict(true);
    } finally {setPending(false);}
  }
  const renderQuestion=(q:typeof questions[number])=><div key={q.id} className={styles.answerField}>
      {shared?<label className={styles.answerSelection}><input type="checkbox" disabled={readOnly || pending || !selectedIds.includes(q.id) && selectedIds.length>=20} checked={selectedIds.includes(q.id)} onChange={e=>setSelectedIds(ids=>e.target.checked?[...ids,q.id]:ids.filter(id=>id!==q.id))}/>同时用于回答：{textFor(q.claimRef.claimVersionId)}</label>:<label htmlFor={`${prefix}-${q.id}`}>{textFor(q.claimRef.claimVersionId)}</label>}
      {!shared && <textarea disabled={pending} readOnly={readOnly} autoFocus={questions[0]?.id===q.id} id={`${prefix}-${q.id}`} aria-label={questions.length===1?'补充答案':`回答：${textFor(q.claimRef.claimVersionId)}`} value={answers[q.id]??''} onChange={e=>{setAnswers({...answers,[q.id]:e.target.value});setTouched({...touched,[q.id]:true});}} rows={3} maxLength={4000}/>}
      {(!shared || selectedIds.includes(q.id)) && externalRefs(q).length>0 && <fieldset className={styles.answerChoice} disabled={readOnly || pending}><legend>这个问题已有答案</legend>
        {externalRefs(q).map(ref=><p key={ref.claimVersionId}>{textFor(ref.claimVersionId)}</p>)}
        <label><input type="radio" name={`${prefix}-${q.id}-choice`} checked={choices[q.id]?.mode==='replace'} onChange={()=>updateChoice(q.id,{mode:'replace'})}/> 用新答案替代</label>
        <label><input type="radio" name={`${prefix}-${q.id}-choice`} checked={choices[q.id]?.mode==='coexist'} onChange={()=>updateChoice(q.id,{mode:'coexist'})}/> 两个答案分别适用</label>
        {choices[q.id]?.mode==='coexist' && <input aria-label="适用情况" placeholder="例如：十二万是标准方案，十五万是加急方案" value={choices[q.id].applicability} onChange={e=>updateChoice(q.id,{applicability:e.target.value})} maxLength={4000}/>}
      </fieldset>}
    </div>;
  return <form className={styles.editor} aria-label={correction?'修正结果':'补充结果'} onSubmit={e=>{e.preventDefault();void save();}}>
    {correction?.freshness==='stale' && <p className={styles.notice}>这次结果里的答案已有变化。请按下方当前答案核对后保存。</p>}
    {shared && <><label htmlFor={`${prefix}-shared`}>跟进结果</label><textarea disabled={pending} readOnly={readOnly} id={`${prefix}-shared`} autoFocus value={note} onChange={e=>{setNote(e.target.value);setNoteTouched(true);}} rows={3} maxLength={4000}/></>}
    {shared ? <>{questions.filter(q=>suggested.has(q.id)).map(renderQuestion)}{questions.some(q=>!suggested.has(q.id)) && <details className={styles.topicDetails} open={restored && questions.some(q=>!suggested.has(q.id) && selectedIds.includes(q.id)) || undefined}><summary>回答其他问题 · {questions.filter(q=>!suggested.has(q.id)).length}</summary>{questions.filter(q=>!suggested.has(q.id)).map(renderQuestion)}</details>}</> : questions.map(renderQuestion)}
    {target.kind==='action' && <>
      {!shared && questions.length>0 && !noteOpen && <NqButton className={styles.addNote} variant="quiet" onClick={()=>setNoteOpen(true)}>添加补充说明</NqButton>}
      {!shared && (!questions.length || noteOpen) && <><label htmlFor={`${prefix}-note`}>{questions.length?'补充说明，可留空':'跟进结果'}</label><textarea disabled={pending} readOnly={readOnly} id={`${prefix}-note`} autoFocus={!questions.length} value={note} onChange={e=>{setNote(e.target.value);setNoteTouched(true);}} rows={2} maxLength={10000}/></>}
      {!correction && action?.executionState==='open' && <label className={styles.origin}><input type="checkbox" disabled={readOnly || pending} checked={complete} onChange={e=>setComplete(e.target.checked)}/> 同时标记行动完成</label>}
    </>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {conflict && <div className={styles.notice}><p>{restored?"已恢复读取，请核对当前问题和答案后保存。你的输入仍然保留。":"记录已有变化，你的输入仍然保留。当前问题和答案："}</p>{snapshot.questions.filter(q=>questions.some(old=>old.id===q.id)).map(q=><p key={q.id}>{textFor(q.claimRef.claimVersionId,snapshot)} · {q.answerRefs.map(r=>textFor(r.claimVersionId,snapshot)).join(' / ')||'尚无答案'}</p>)}
      <NqButton variant="secondary" onClick={()=>{if(correction){const latest=[...snapshot.actions,...snapshot.questions].map(x=>x.latestOutcome).find(o=>o?.id===correction.id);if(!latest){setError('这次结果已不再是当前结果，请关闭后重新打开。');return;}setCorrection(latest);}setChoices(value=>Object.fromEntries(Object.entries(value).map(([id,c])=>{const before=c.priorAnswerRefs ?? questions.find(q=>q.id===id)?.answerRefs ?? [];const after=snapshot.questions.find(q=>q.id===id)?.answerRefs.filter(r=>!correction?.answerRefs.some(a=>a.claimVersionId===r.claimVersionId)) ?? [];const sorted=(refs:VersionRef[])=>refs.map(r=>r.claimVersionId).sort().join('|');return [id,sorted(before)===sorted(after)?c:{...c,mode:'',priorAnswerRefs:after}];})));setBase(snapshot);setConflict(false);setError('');}}>核对后采用当前版本</NqButton>
    </div>}
    <div className={styles.inlineActions}><NqButton type="submit" loading={pending} disabled={readOnly || conflict}>保存{correction?'修正':target.kind==='question'?'答案':'结果'}</NqButton><NqButton variant="quiet" disabled={pending} onClick={()=>{memory?.clear('outcome');onClose();}}>取消</NqButton></div>
  </form>;
}
