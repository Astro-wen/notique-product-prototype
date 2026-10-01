import type { ProjectOverview, ReviewCard, VersionRef } from '../shared/workflow-v2.ts';

const matches=(a:VersionRef,b:VersionRef)=>a.claimId===b.claimId && a.claimVersionId===b.claimVersionId;

/** Reconsume the existing ledger without another extraction or accepting drafts. */
export function projectWorkItems(snapshot:ProjectOverview,acceptedOnly=false) {
  const questionIds=new Set(snapshot.openQuestions.map(q=>q.id));
  const actionIds=new Set(snapshot.nextActions.map(a=>a.id));
  const facts=snapshot.currentBullets.filter(b=>(!acceptedOnly || b.reviewState==='accepted') && b.kind!=='action' && !b.executionState && !b.claimRefs.some(r=>questionIds.has(r.claimId) || actionIds.has(r.claimId)));
  const suggestions=snapshot.currentBullets.filter(b=>b.kind==='action' && b.reviewState==='draft' && !b.executionState);
  const completed=snapshot.currentBullets.filter(b=>b.executionState==='completed');
  const closedActions=snapshot.currentBullets.filter(b=>b.executionState==='completed' || b.executionState==='cancelled');
  return {facts,suggestions,completed,closedActions};
}

/** Multi-action conflicts require the existing review UI and an explicit choice. */
export function actionableSuggestion(cards:readonly ReviewCard[],ref:VersionRef) {
  const card=cards.find(c=>c.memberRefs.some(r=>matches(r,ref)));
  const member=card?.members.find(m=>matches(m,ref));
  return card?.kind!=='conflict' && !card?.actionOverlap && card?.disposition==='active' && card.sourceStatus==='ready' && member?.kind==='action' && member.reviewState==='draft' && member.supportStatus!=='does_not_support' ? card : null;
}
