import type { ReviewMember } from '../shared/workflow-v2.ts';

const labels: Record<string,string> = {budget:'金额',timing:'日期',person_role:'人物与职责',requirement:'需求',risk:'风险',concern:'顾虑',measurement:'数量'};
export function keyDetailReview(claim: {type:string;uncertainty_json?:string|null}): ReviewMember['keyDetail'] {
  const label=labels[claim.type];
  if(!label)return undefined;
  let value:unknown=null;
  try {value=claim.uncertainty_json?JSON.parse(claim.uncertainty_json):null;} catch { /* Older records may have no structured uncertainty. */ }
  const v=value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
  const alternatives=Array.isArray(v.alternatives)?[...new Set(v.alternatives.filter((x):x is string=>typeof x==='string' && Boolean(x.trim())).map(x=>x.trim()))].slice(0,5):[];
  return {label,question:typeof v.question==='string' && v.question.trim()?v.question.trim():null,alternatives};
}
