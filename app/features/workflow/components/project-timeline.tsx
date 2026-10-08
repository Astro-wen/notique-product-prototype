"use client";

import { useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { NqSurface } from '@/app/components/notique-ui';
import { SmoothResize } from '@/app/components/smooth-resize';
import { StatementDiff } from './statement-diff';
import type { ProjectOverview, ProjectTimelineEntry, VersionRef } from '@/lib/shared/workflow-v2';
import { conversationLabels, conversationUploadTime } from '@/lib/domain/conversation-navigation';
import { comparisonOrder } from '@/lib/domain/comparison-order';
import { timelineLabel, timelineValues } from '@/lib/domain/timeline-card';
import styles from '../pages/project-overview.module.css';

const filters:Record<string,readonly string[]>={变化:[],全部记录:[],金额与日期:['金额','日期','数量'],决定:['决定'],需求与偏好:['需求','偏好'],待解答:['待解答'],风险与顾虑:['风险','顾虑']};

type TimelineSource = (eventId:string,refs:VersionRef[],identity:string,quote?:string)=>ReactNode;

function TimelineCard({entry,number,snapshot,names,source}:{entry:ProjectTimelineEntry;number:number;snapshot:ProjectOverview;names:Map<string,string>;source:TimelineSource}) {
  const [open,setOpen]=useState(false);
  const label=timelineLabel(entry);
  const answer=label==='有了回答';
  const records=new Map(snapshot.recordSummaries.map(record=>[record.eventId,record]));
  const order=entry.before?comparisonOrder(records.get(entry.before.eventId),records.get(entry.after.eventId)):null;
  const pair=entry.before && entry.before.eventId!==entry.after.eventId?(order==='reverse' && !answer?[entry.after,entry.before]:[entry.before,entry.after]):[];
  const ordered=Boolean(order) && entry.proposalType !== 'conflicting';
  const values=entry.proposalType !== 'conflicting' && !answer && pair.length===2 && pair.every(f=>f.text)?timelineValues(pair[0].text!,pair[1].text!,entry.category):null;
  const detailId=`comparison-${entry.id}`;
  const compact=entry.after.text ?? '来源需要重新核对。';
  const context=pair.length===2
    ? `${names.get(pair[0].eventId) ?? '相关对话'} ${ordered?'→':'·'} ${names.get(pair[1].eventId) ?? '相关对话'}`
    : names.get(entry.after.eventId);
  return <article className={styles.comparisonCard}>
    <div className={styles.timelineItemHeading}><span className={styles.changeNumber}>{String(number).padStart(2,'0')}</span><strong data-kind={label}>{label}</strong><span>{entry.category}</span></div>
    <p className={`${styles.changePreview} ${pair.length===2 && !values?styles.textPreview:''}`}>{values?<><span className={styles.valueCaption}>{entry.category==='金额' && pair.every(f=>/total budget|总预算|预算总额/i.test(f.text ?? ''))?'总预算':`${entry.category}对比`}</span><span className={styles.beforeValue}>{values.before}</span><span className={styles.changeArrow} aria-label={ordered?'变为':'对照'}>{ordered?'→':'↔'}</span><span className={styles.afterValue}>{values.after}</span></>:compact}</p>
    {pair.length===2 ? <>
      <div className={styles.changeFooter}><span title={context}>{context}</span><button className={styles.compareToggle} aria-expanded={open} aria-controls={detailId} onClick={()=>setOpen(value=>!value)}>{open?'收起对比':'查看对比'}<ChevronDown size={13}/></button></div>
      <SmoothResize><div id={detailId}>{open && <div className={styles.comparisonBody}>{pair.map((fact,index)=><div key={`${fact.ref.claimVersionId}-${index}`} className={index===0?styles.previousFact:styles.timelineFact}>
        <small>{answer?index===0?entry.category==='下一步'?'原待办':entry.category==='待解答'?'原问题':'原记录':entry.category==='待解答'?'相关回答':'相关结果':ordered?index===0?'此前提到':'后续提到':index===0?'表述一':'表述二'}</small>
        <p>{fact.text?answer?fact.text:<StatementDiff before={pair[0].text ?? ''} after={pair[1].text ?? ''} side={index===0?'before':'after'}/>:'来源需要重新核对。'}</p>
        {source(fact.eventId,[fact.ref],`${entry.id}-${index}`)}
      </div>)}</div>}</div></SmoothResize>
    </>:source(entry.after.eventId,[entry.after.ref],`${entry.id}-after`)}
  </article>;
}

export function ProjectTimeline({snapshot,source,onOpenRecord}:{snapshot:ProjectOverview;source:TimelineSource;onOpenRecord:(eventId:string,claimId?:string)=>void}) {
  const [selectedFilter,setFilter]=useState<string|null>(null);
  const filter=selectedFilter ?? (snapshot.recordSummaries.length>1?'变化':'全部记录');
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const names=conversationLabels(snapshot.recordSummaries.map(r=>({...r,id:r.eventId})));
  const records=new Map(snapshot.recordSummaries.map(record=>[record.eventId,record]));
  const entries=(snapshot.timeline ?? []).filter(entry=>filter==='变化'
    ? !['introduced','repeated'].includes(entry.kind)
    : !filters[filter].length || filters[filter].includes(entry.category)).filter((entry,index,items)=>filter!=='变化' || !items.slice(0,index).some(previous=>previous.after.ref.claimVersionId===entry.after.ref.claimVersionId && previous.proposalType===entry.proposalType));
  const groups=[...new Map(entries.map(entry=>[entry.eventId,entry.occurredAt])).entries()].sort(([a,aDate],[b,bDate])=>(conversationUploadTime(records.get(b) ?? {occurredAt:bDate}) ?? 0)-(conversationUploadTime(records.get(a) ?? {occurredAt:aDate}) ?? 0) || a.localeCompare(b));
  return <NqSurface className={`${styles.panel} ${styles.historyPanel}`} aria-label="跨对话变化">
    <div className={styles.sectionHeading}><h2>变化记录</h2><select aria-label="变化记录范围" className={styles.timelineFilter} value={filter} onChange={event=>setFilter(event.target.value)}>{Object.keys(filters).map(label=><option key={label}>{label}</option>)}</select></div>
    {!entries.length && <p className={styles.empty}>{filter==='变化'?'暂未记录到跨对话变化。':filter==='全部记录'?'对话整理后，会在这里按时间串起要点。':'这个范围还没有记录。'}{filter==='变化' && Boolean(snapshot.timeline?.length) && <button className={styles.expand} onClick={()=>setFilter('全部记录')}>查看全部记录</button>}</p>}
    <div className={styles.semanticTimeline}>{groups.map(([eventId,occurredAt])=>{
      const items=entries.filter(entry=>entry.eventId===eventId);
      const uploaded=conversationUploadTime(records.get(eventId) ?? {occurredAt});
      return <section key={eventId} className={styles.timelineGroup}>
        <div className={styles.timelineDate}><time title="上传日期">{uploaded!==null?new Date(uploaded).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}):'—'}</time><button onClick={()=>onOpenRecord(eventId)}>{names.get(eventId)}<ArrowRight size={12}/></button></div>
        <SmoothResize><ol className={styles.timelineItems}>{items.slice(0,expanded.has(eventId)?undefined:3).map((entry,index)=><li key={entry.id} data-testid={`timeline-${entry.id}`}>
          <TimelineCard entry={entry} number={index+1} snapshot={snapshot} names={names} source={source}/>
          {entry.mention && <details className={styles.repeatSource}><summary>本次原话</summary>{entry.mention.sources.map((item,i)=><blockquote key={i}>{item.sourceStatus==='ready'?item.quote : '本次来源需要重新核对。'}</blockquote>)}<button className={styles.expand} onClick={()=>onOpenRecord(eventId,entry.after.ref.claimId)}>查看本次对话<ArrowRight size={12}/></button></details>}
        </li>)}</ol></SmoothResize>
        {items.length>3 && <button className={styles.expand} aria-expanded={expanded.has(eventId)} onClick={()=>setExpanded(previous=>{const next=new Set(previous);if(next.has(eventId))next.delete(eventId);else next.add(eventId);return next;})}>{expanded.has(eventId)?'收起':`其余 ${items.length-3} 项`}<ChevronDown size={13}/></button>}
      </section>;
    })}</div>
  </NqSurface>;
}
