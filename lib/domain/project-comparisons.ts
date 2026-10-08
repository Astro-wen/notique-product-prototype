import {comparisonOrder} from './comparison-order.ts';
import type { ProjectOverview, ProjectTimelineEntry, VersionRef } from '../shared/workflow-v2.ts';
const key=(r:VersionRef)=>`${r.claimId}:${r.claimVersionId}`;
export function pendingComparisons(snapshot:ProjectOverview) {
  return (snapshot.timeline ?? []).filter(e=>e.before && e.reviewState==='draft' && e.kind==='conflict' && ['changed','conflicting','possibly_answered'].includes(e.proposalType ?? ''));
}
function displaySide(snapshot:ProjectOverview,entry:ProjectTimelineEntry):'before'|'after' {
  const records=snapshot.recordSummaries ?? [];
  const before=records.find(r=>r.eventId===entry.before?.eventId),after=records.find(r=>r.eventId===entry.after.eventId);
  return comparisonOrder(before,after)==='reverse'?'before':'after';
}
export function comparisonFor(snapshot:ProjectOverview,refs:VersionRef[],side:'before'|'after'|'display'='display') {
  return pendingComparisons(snapshot).find(e=>refs.some(r=>key(r)===key(e[side==='display'?displaySide(snapshot,e):side]!.ref)));
}
/** Display compared versions together without treating a proposal as accepted. */
export function comparisonFacts(snapshot:ProjectOverview,facts:ProjectOverview['currentBullets']) {
  const pending=[...pendingComparisons(snapshot),...(snapshot.timeline ?? []).filter(e=>e.before && e.proposalType==='same')];
  const displayed=new Set(facts.flatMap(b=>b.claimRefs.map(key)));
  const grouped=new Set(pending.filter(e=>e.proposalType!=='possibly_answered' && displayed.has(key(e[displaySide(snapshot,e)]!.ref))).map(e=>key(e[displaySide(snapshot,e)==='after'?'before':'after']!.ref)));
  const answers=new Set(pending.filter(e=>e.proposalType==='possibly_answered' && snapshot.openQuestions.some(q=>key(q.claimRef)===key(e.before!.ref))).map(e=>key(e.after.ref)));
  return facts.filter(b=>!b.claimRefs.some(r=>grouped.has(key(r)) || answers.has(key(r))))
    .sort((a,b)=>Number(Boolean(comparisonFor(snapshot,b.claimRefs)))-Number(Boolean(comparisonFor(snapshot,a.claimRefs))));
}
export function keyInformation(snapshot:ProjectOverview,facts:ProjectOverview['currentBullets']) {
  const entries=snapshot.timeline ?? [];
  const items=facts.flatMap(b=>{
    const quantity=/\b\d+\s+(?:participants?|people|attendees?)\b|participant count|人数|\d+\s*人/i.test(b.text);
    const dated=/(?<![A-Za-z])(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d|\d{4}-\d{2}-\d{2}|\d{1,2}\s*月/i.test(b.text);
    const matched=entries.find(e=>b.claimRefs.some(r=>key(r)===key(e.after.ref)) && (quantity || dated || ['金额','日期','数量'].includes(e.category)));
    const entry=matched?{...matched,category:quantity?'数量':dated?'日期':matched.category}:undefined;
    if(!entry)return [];
    const text=b.text;
    const label=entry.category==='金额'?/total.{0,25}budget|总预算|预算总额/i.test(text)?'总预算':/rent|rental|场地费|租金/i.test(text)?'租用费用':/insurance|保险/i.test(text)?'保险费用':/per |单价|每[份次月]/i.test(text)?'单价与费用':'金额':entry.category==='数量'?/participant|attend|人数/i.test(text)?'人数':'数量':/deadline|due |截止/i.test(text)?'截止日期':'日期与时间';
    return [{bullet:b,entry,label,category:entry.category,changed:Boolean(comparisonFor(snapshot,b.claimRefs))}];
  }).sort((a,b)=>Number(b.changed)-Number(a.changed) || Number(b.label==='总预算')-Number(a.label==='总预算'));
  // Give amounts, dates and quantities a slot before filling further amounts.
  const selected:typeof items=[];
  for(const category of ['金额','日期','数量']) {const item=items.find(i=>i.category===category);if(item)selected.push(item);}
  for(const item of items)if(selected.length<3 && !selected.some(existing=>existing.label===item.label))selected.push(item);
  return selected;
}
