import type { Bullet, ProjectOverview, WorkspaceSnapshot } from '../shared/workflow-v2.ts';
import { priorityCards, sameVersion } from './workflow-v2.ts';
import { recordTopics, type RecordTopic } from './record-topics.ts';

/** Group explicit, current question comparisons without deciding equivalence. */
export function questionComparisons(snapshot: Pick<WorkspaceSnapshot,'reviewCards'|'questions'|'bullets'>) {
  return snapshot.questions.flatMap(question => {
    if (!snapshot.bullets.some(b => b.sourceStatus==='ready' && b.claimRefs.some(r=>sameVersion(r,question.claimRef)))) return [];
    const candidates=snapshot.reviewCards.filter(c=>c.kind==='conflict' && c.disposition!=='processed').flatMap(card =>
      (card.conflicts ?? []).filter(c=>c.existing.kind==='question' && sameVersion(c.existing,question.claimRef) && card.members.some(m=>m.kind==='question' && sameVersion(m,c.candidateRef))).flatMap(c=> {
        const bullet=snapshot.bullets.find(b=>b.sourceStatus==='ready' && b.claimRefs.some(r=>sameVersion(r,c.candidateRef)));
        return bullet ? [{cardId:card.id,bullet}] : [];
      }));
    return candidates.length ? [{question,candidates:[...new Map(candidates.map(c=>[c.bullet.id,c])).values()]}] : [];
  });
}

/** Presentation only: it neither accepts information nor infers ledger links. */
export function readingTopics(snapshot: WorkspaceSnapshot, visible: readonly Bullet[]) {
  const followed = new Set(snapshot.actions.map(a => a.id));
  const paired = snapshot.reviewCards.flatMap(c=>c.sameIntent && c.kind!=='conflict' && followed.has(c.sameIntent.actionRef.claimId)?[c.sameIntent.recordRef.claimId]:[]);
  const ownAnswers=snapshot.questions.filter(q=>q.latestOutcome?.freshness!=='stale' && snapshot.actions.some(a=>a.latestOutcome?.freshness!=='stale' && a.latestOutcome && q.latestOutcome?.id===a.latestOutcome.id)).flatMap(q=>q.answerRefs);
  const results = snapshot.actions.flatMap(a => a.latestOutcome?.freshness !== 'stale' ? a.latestOutcome?.resultRefs ?? [] : []);
  return recordTopics(snapshot, visible).map(topic => {
    const detail = topic.bullets.filter(b => !b.claimRefs.some(r => followed.has(r.claimId) || paired.includes(r.claimId) || [...results,...ownAnswers].some(x => sameVersion(x, r))));
    const interactive = detail.filter(b => snapshot.questions.some(q => b.claimRefs.some(r => sameVersion(q.claimRef, r) || q.answerRefs.some(a => sameVersion(a,r)))) || snapshot.reviewCards.some(c => c.needsDecision && c.disposition==='active' && c.memberRefs.some(r => b.claimRefs.some(x => sameVersion(x,r)))));
    const current = new Set(topic.bullets.filter(b=>b.sourceStatus==='ready').flatMap(b=>b.claimRefs.map(r=>JSON.stringify(r))));
    // Older wording never becomes a current preview after a correction.
    const preview = (snapshot.narrative?.freshness==='current' ? snapshot.narrative.sentenceRefs : []).filter(s => s.topic?.key===topic.key && s.claimRefs.length>0 && s.claimRefs.every(r=>current.has(JSON.stringify(r))) && !s.claimRefs.some(r=>interactive.some(b=>b.claimRefs.some(x=>sameVersion(x,r))) || followed.has(r.claimId) || [...results,...ownAnswers].some(x=>sameVersion(x,r))) ).slice(0,3);
    return {...topic, detail, interactive, preview};
  }).filter(topic=>topic.detail.length || topic.preview.length || topic.actions.length || topic.relatedActionRefs.length);
}

export function pendingItems(snapshot: Pick<WorkspaceSnapshot,'reviewCards'|'questions'|'actions'>) {
  const covered=new Set<string>();
  const items: Array<{id:string;claimIds:string[]}>=[];
  for(const c of priorityCards(snapshot.reviewCards)) {
    const relatedQuestions=(c.conflicts ?? []).flatMap(comparison=>comparison.existing.kind==='question' && c.members?.some(m=>m.kind==='question' && sameVersion(m,comparison.candidateRef)) ? snapshot.questions.filter(q=>sameVersion(q.claimRef,comparison.existing)).map(q=>q.id):[]);
    const claimIds=[...new Set([...c.memberRefs.map(r=>r.claimId),...relatedQuestions])];claimIds.forEach(id=>covered.add(id));
    const overlaps=items.filter(item=>item.claimIds.some(id=>claimIds.includes(id)));
    if(overlaps.length) {
      const owner=overlaps[0];owner.claimIds=[...new Set([...owner.claimIds,...claimIds,...overlaps.flatMap(item=>item.claimIds)])];
      for(const other of overlaps.slice(1))items.splice(items.indexOf(other),1);
    } else items.push({id:c.id,claimIds});
  }
  for(const q of snapshot.questions) if(q.resolutionState==='open' && !covered.has(q.id)) {covered.add(q.id);items.push({id:q.id,claimIds:[q.id]});}
  for(const a of snapshot.actions) if((a.executionState==='open' || a.basisState==='needs_review') && !covered.has(a.id)) {covered.add(a.id);items.push({id:a.id,claimIds:[a.id]});}
  return items;
}

/** Same headings as the record, with exact-version membership from saved summaries. */
export function overviewTopics(snapshot: ProjectOverview, visible: ProjectOverview['currentBullets']) {
  const topics=new Map<string, {key:string;title:string;bullets:ProjectOverview['currentBullets']}>();
  const order=new Map<string,number>();
  const byVersion=new Map<string,RecordTopic>();
  for(const record of snapshot.recordSummaries) {
    const bullets=snapshot.currentBullets.filter(b=>b.eventId===record.eventId);
    const groups=recordTopics({bullets,reviewCards:[],questions:[],actions:[],narrative:record.narrative},bullets);
    for(const group of groups) {const key=JSON.stringify([group.key,group.title]);if(!order.has(key))order.set(key,order.size);}
    for(const group of groups) for(const b of group.bullets) for(const r of b.claimRefs)byVersion.set(JSON.stringify(r),group);
  }
  for(const b of visible) {
    const topic=b.claimRefs.map(r=>byVersion.get(JSON.stringify(r))).find(Boolean);
    const title=topic?.title ?? '其他要点',key=JSON.stringify([topic?.key ?? '_unassigned',title]);
    if(!topics.has(key))topics.set(key,{key,title,bullets:[]});
    topics.get(key)!.bullets.push(b);
  }
  for(const topic of topics.values())topic.bullets.sort((a,b)=>Number(!(a.reviewState==='accepted'&&a.origin==='user_input'&&a.sourceStatus==='ready'))-Number(!(b.reviewState==='accepted'&&b.origin==='user_input'&&b.sourceStatus==='ready')));
  return [...topics.values()].sort((a,b)=>(order.get(a.key) ?? Number.MAX_SAFE_INTEGER)-(order.get(b.key) ?? Number.MAX_SAFE_INTEGER));
}
