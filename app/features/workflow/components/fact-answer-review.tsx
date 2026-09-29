"use client";

import type {DecisionMember,ReviewMember} from '@/lib/shared/workflow-v2';
import styles from './record-workspace.module.css';

export type FactChoices=Record<string,{claimVersionId:string;mode:'keep'|'reopen'}>;
export function factChoicesFor(member:ReviewMember,choices:FactChoices={}):FactChoices {
  return Object.fromEntries((member.answerTargets ?? []).flatMap(t=>choices[t.questionRef.claimId]?.claimVersionId===t.questionRef.claimVersionId?[[t.questionRef.claimId,choices[t.questionRef.claimId]]]:[]));
}
export function factChangeFor(member:ReviewMember,choices:FactChoices={}):DecisionMember['factChange'] {
  if(!member.answerTargets?.length)return undefined;
  const current=factChoicesFor(member,choices);
  if(member.answerTargets.some(t=>!current[t.questionRef.claimId]))throw new Error('请逐项选择修改后是否仍能回答这些问题。');
  return {questionChoices:member.answerTargets.map(t=>({...t.questionRef,mode:current[t.questionRef.claimId].mode}))};
}
export function FactAnswerReview({member,choices={},onChange,disabled=false,prefix=''}:{member:ReviewMember;choices?:FactChoices;onChange:(choices:FactChoices)=>void;disabled?:boolean;prefix?:string}) {
  if(!member.answerTargets?.length)return null;
  return <div className={styles.notice}><p>这条信息已回答下面的问题。修改后是否仍可回答？</p>{member.answerTargets.map((target,index)=><label key={target.questionRef.claimId} className={styles.origin}>
    <span>{target.text ?? '问题原文暂时无法读取'}</span>
    <select aria-label={`${prefix}第${index+1}个问题是否仍可回答`} value={choices[target.questionRef.claimId]?.claimVersionId===target.questionRef.claimVersionId?choices[target.questionRef.claimId].mode:''} disabled={disabled} onChange={event=>onChange({...choices,[target.questionRef.claimId]:{claimVersionId:target.questionRef.claimVersionId,mode:event.target.value as 'keep'|'reopen'}})}>
      <option value="" disabled>请选择</option><option value="keep">仍可回答，用修改后的信息</option><option value="reopen">这条不再回答，保留其他答案</option>
    </select>
  </label>)}</div>;
}
