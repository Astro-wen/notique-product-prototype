import type { Action, Bullet, VersionRef, WorkspaceSnapshot } from '../shared/workflow-v2.ts';

export type RecordTopic = { key: string; title: string; bullets: Bullet[]; actions: Action[]; relatedActionRefs: VersionRef[] };
const versionKey = (r: {claimId:string;claimVersionId:string}) => JSON.stringify([r.claimId,r.claimVersionId]);

/** Topic membership affects layout only. It never establishes a ledger relation
 * or changes review, execution or resolution state. */
export function recordTopics(snapshot: Pick<WorkspaceSnapshot,'bullets'|'reviewCards'|'questions'|'actions'|'narrative'>, visible: readonly Bullet[]): RecordTopic[] {
  const currentVersions=new Set(snapshot.bullets.flatMap(b=>b.claimRefs.map(versionKey)));
  const assignment=new Map<string,{key:string;title:string}>();
  for(const sentence of snapshot.narrative?.sentenceRefs ?? []) {
    if(!sentence.topic || typeof sentence.topic.key!=='string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(sentence.topic.key) || typeof sentence.topic.title!=='string' || !sentence.topic.title.trim() || sentence.topic.title.length>80)continue;
    for(const ref of sentence.claimRefs)if(currentVersions.has(versionKey(ref)))assignment.set(versionKey(ref),sentence.topic);
  }
  const topicFor=(refs:readonly {claimId:string;claimVersionId:string}[])=>refs.map(r=>assignment.get(versionKey(r))).find(Boolean);
  // A current answer occupies its question's original subject, even while the
  // overview is refreshing. Exact answer relations come from the snapshot.
  for(const q of snapshot.questions) {
    const topic=topicFor([q.claimRef,...q.answerRefs]);
    if(topic)for(const r of [q.claimRef,...q.answerRefs])if(!assignment.has(versionKey(r)))assignment.set(versionKey(r),topic);
  }
  for(const card of snapshot.reviewCards) {
    if(!card.sameIntent && !card.actionOverlap)continue;
    const topic=topicFor(card.memberRefs);
    if(topic)for(const r of card.memberRefs)if(!assignment.has(versionKey(r)))assignment.set(versionKey(r),topic);
  }
  for(const action of snapshot.actions) {
    const topic=topicFor([action.claimRef,...action.questionRefs]);
    if(topic)for(const r of action.latestOutcome?.resultRefs ?? [])if(!assignment.has(versionKey(r)))assignment.set(versionKey(r),topic);
  }
  const groups=new Map<string,RecordTopic>();
  const ensure=(topic:{key:string;title:string})=>{
    let group=groups.get(topic.key);
    if(!group){group={...topic,bullets:[],actions:[],relatedActionRefs:[]};groups.set(topic.key,group);}
    return group;
  };
  const fallback={key:'_notique_unassigned',title:assignment.size?'其他要点':'本次讨论'};
  const bulletTopics=new Map<string,{key:string;title:string}>();
  for(const b of visible) {
    let topic=topicFor(b.claimRefs);
    if(!topic) {
      const q=snapshot.questions.find(q=>b.claimRefs.some(r=>versionKey(r)===versionKey(q.claimRef) || q.answerRefs.some(a=>versionKey(a)===versionKey(r))));
      const action=snapshot.actions.find(a=>b.claimRefs.some(r=>versionKey(r)===versionKey(a.claimRef)));
      if(q)topic=topicFor([q.claimRef,...q.answerRefs]);
      if(action)topic=topicFor(action.questionRefs) ?? topicFor(action.basisDetails.flatMap(b=>b.currentRef?[b.currentRef]:[]));
    }
    topic ??= fallback;
    ensure(topic).bullets.push(b);
    for(const r of b.claimRefs)bulletTopics.set(versionKey(r),topic);
  }
  const actionTopics=new Map<string,string>();
  for(const action of snapshot.actions) {
    const topic=topicFor([action.claimRef]) ?? bulletTopics.get(versionKey(action.claimRef)) ?? topicFor(action.questionRefs) ?? topicFor(action.basisDetails.flatMap(b=>b.currentRef?[b.currentRef]:[])) ?? fallback;
    ensure(topic).actions.push(action);
    actionTopics.set(versionKey(action.claimRef),topic.key);
  }
  // A shared follow-up has one authoritative action card. Other visible
  // matters link to its exact version through existing ledger relationships.
  // No keyword inference or duplicate execution state is introduced here.
  for(const action of snapshot.actions) {
    for(const ref of [...action.questionRefs,...action.basisDetails.flatMap(b=>b.currentRef?[b.currentRef]:[])]) {
      const topic=assignment.get(versionKey(ref));
      if(!topic || topic.key===actionTopics.get(versionKey(action.claimRef)))continue;
      const group=groups.get(topic.key);
      if(group && !group.relatedActionRefs.some(r=>versionKey(r)===versionKey(action.claimRef)))group.relatedActionRefs.push(action.claimRef);
    }
  }
  return [...groups.values()];
}
