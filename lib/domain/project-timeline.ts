import { projectSourceRefs } from './project-sources.ts';
import { comparisonOrder } from './comparison-order.ts';
import { isCompletionRecord, readJson, type ProjectionLedger } from './workflow-projection.ts';
import type { ProjectTimelineEntry, TimelineFact, VersionRef, WorkspaceSnapshot } from '../shared/workflow-v2.ts';

export const detailLabels: Record<string, string> = {
  budget: '金额', timing: '日期', person_role: '人物与职责', requirement: '需求',
  preference: '偏好', risk: '风险', concern: '顾虑', decision: '决定',
  open_question: '待解答', next_action: '下一步', measurement: '数量',
};

// A price can be extracted as a preference or measurement. Keep monetary
// details discoverable without changing the claim type or inferring relations.
export function timelineCategory(claim: {type:string;statement:string}): string {
  if (/[$€£¥￥]|\b(?:USD|CNY|RMB|HKD|TWD)\b|\d\s*(?:万元|亿元|美元|人民币)/i.test(claim.statement)) return '金额';
  if (/\b\d+\s+(?:participants?|people|attendees?)\b|participant count|人数|\d+\s*人/i.test(claim.statement)) return '数量';
  return detailLabels[claim.type] ?? '记录';
}

/** One projection of published facts and explicit relations. It makes no model
 * calls and never guesses a relation from similar numbers, words or upload order. */
export function projectTimeline(ledger: ProjectionLedger, snapshots: Map<string, WorkspaceSnapshot>): ProjectTimelineEntry[] {
  const claims = new Map(ledger.claims.map(c => [c.id, c]));
  const events = new Map(ledger.events.map(e => [e.id, e]));
  const versions = new Map((ledger.timelineVersions ?? []).map(v => [v.id, v]));
  for (const c of ledger.claims) versions.set(c.current_version_id, {id:c.current_version_id, claim_id:c.id, statement:c.statement});
  const published = new Set([...snapshots.values()].flatMap(s => s.bullets.flatMap(b => b.claimRefs.map(r => r.claimVersionId))));
  const visible = (id: string) => {
    const c = claims.get(id);
    return c && events.has(c.event_id) && c.review_status !== 'rejected' && c.lifecycle_status !== 'withdrawn'
      && (c.review_status === 'verified' || published.has(c.current_version_id));
  };
  function fact(ref: VersionRef): TimelineFact | null {
    const c = claims.get(ref.claimId), v = versions.get(ref.claimVersionId);
    if (!c || !events.has(c.event_id) || !v || v.claim_id !== c.id) return null;
    const source = projectSourceRefs(ledger, [ref])[0];
    return {ref, eventId:c.event_id, sourceStatus:source?.sourceStatus ?? 'missing', text:source?.sourceStatus === 'ready' ? v.statement : null};
  }
  const entries: ProjectTimelineEntry[] = [];
  const linked = new Set<string>();
  const linkedPairs = new Set<string>();
  for (const r of ledger.relations) {
    if (!['active','proposed'].includes(r.status) || !['supersedes','contradicts','resolves'].includes(r.type)) continue;
    const sv = versions.get(r.source_claim_version_id), tv = versions.get(r.target_claim_version_id);
    const s = sv && claims.get(sv.claim_id), t = tv && claims.get(tv.claim_id);
    if (!s || !t || s.id === t.id || s.event_id === t.event_id || !visible(s.id) || !visible(t.id)
      || s.current_version_id !== r.source_claim_version_id || t.current_version_id !== r.target_claim_version_id) continue;
    const after = fact({claimId:s.id, claimVersionId:r.source_claim_version_id});
    const before = fact({claimId:t.id, claimVersionId:r.target_claim_version_id});
    if (!after || !before) continue;
    const reason = readJson<{operation?:string; mode?:string}>(r.reason, {});
    const accepted = r.status === 'active' && s.review_status === 'verified' && after.sourceStatus === 'ready' && before.sourceStatus === 'ready';
    // An acknowledged statement is not itself an answered question or a new
    // project decision. The ledger must contain the corresponding transition.
    const resolved = accepted && r.type === 'resolves' && (t.type === 'open_question'
      ? [...snapshots.values()].some(snapshot => snapshot.questions.some(q => q.id === t.id && q.resolutionState === 'resolved' && q.answerRefs.some(ref => ref.claimVersionId === s.current_version_id)))
      : t.lifecycle_status === 'resolved');
    const replaced = accepted && ['supersedes','contradicts'].includes(r.type) && t.lifecycle_status === 'superseded'
      && (r.type === 'supersedes' || r.contradiction_status === 'resolved' && reason.operation === 'resolve_conflict' && reason.mode === 'use_candidate');
    if (!resolved && !replaced && (r.type === 'resolves' || r.contradiction_status === 'resolved')) continue;
    // For historical imports keep the two source dates visible. A relation
    // whose direction disagrees with those dates remains a comparison.
    const chronological = Date.parse(events.get(s.event_id)!.occurred_at) >= Date.parse(events.get(t.event_id)!.occurred_at);
    const kind = resolved ? 'resolved' : replaced && chronological ? 'updated' : 'conflict';
    entries.push({id:`relation-${r.id}`, eventId:s.event_id, occurredAt:events.get(s.event_id)!.occurred_at,
      kind, reviewState:kind === 'conflict' ? 'draft' : 'accepted', category:timelineCategory(t), before, after});
    linked.add(s.id);
    linkedPairs.add(`${r.source_claim_version_id}:${r.target_claim_version_id}`);
  }
  const currentDraftLinks=(ledger.draftLinks ?? []).filter(link=>{
    const s=claims.get(link.source_claim_id),t=claims.get(link.target_draft_claim_id);
    return s && t && s.event_id!==t.event_id && visible(s.id) && visible(t.id)
      && s.current_version_id===link.source_claim_version_id && t.current_version_id===link.target_draft_claim_version_id;
  });
  const changedTargets=new Set(currentDraftLinks.filter(link=>['changed','conflicting'].includes(link.type))
    .map(link=>`${claims.get(link.source_claim_id)!.event_id}:${link.target_draft_claim_version_id}`));
  for (const link of currentDraftLinks) {
    const s=claims.get(link.source_claim_id), t=claims.get(link.target_draft_claim_id);
    if(!s || !t || s.event_id===t.event_id || linkedPairs.has(`${link.source_claim_version_id}:${link.target_draft_claim_version_id}`) || !visible(s.id) || !visible(t.id)
      || s.current_version_id!==link.source_claim_version_id || t.current_version_id!==link.target_draft_claim_version_id
      || !['same','changed','conflicting','possibly_answered'].includes(link.type)) continue;
    // A partial match (e.g. the same start time) cannot reaffirm an entire
    // earlier statement that this conversation also changes (e.g. its date).
    if(link.type==='same' && changedTargets.has(`${s.event_id}:${link.target_draft_claim_version_id}`))continue;
    const after=fact({claimId:s.id,claimVersionId:link.source_claim_version_id});
    const before=fact({claimId:t.id,claimVersionId:link.target_draft_claim_version_id});
    if(!after || !before)continue;
    const sourceEvent=events.get(s.event_id)!,targetEvent=events.get(t.event_id)!;
    const order=comparisonOrder({title:targetEvent.title,occurredAt:targetEvent.occurred_at},{title:sourceEvent.title,occurredAt:sourceEvent.occurred_at});
    const displayEvent=order==='reverse'?targetEvent:sourceEvent;
    entries.push({id:`draft-link-${link.id}`,eventId:displayEvent.id,occurredAt:displayEvent.occurred_at,
      kind:link.type==='same'?'repeated':'conflict',reviewState:'draft',proposalType:link.type as ProjectTimelineEntry['proposalType'],
      category:timelineCategory(t),before,after});
    linked.add(s.id);
  }
  for (const c of ledger.claims) {
    if (!visible(c.id) || linked.has(c.id) || isCompletionRecord(c) || c.type === 'next_action') continue;
    const after = fact({claimId:c.id, claimVersionId:c.current_version_id});
    if (!after) continue;
    entries.push({id:`claim-${c.id}`, eventId:c.event_id, occurredAt:events.get(c.event_id)!.occurred_at,
      kind:'introduced', reviewState:c.review_status === 'verified' ? 'accepted' : 'draft', category:timelineCategory(c), after});
  }
  for (const [eventId,snapshot] of snapshots) for (const mention of snapshot.reaffirmedMentions ?? []) {
    if (!events.has(eventId) || !visible(mention.claimRef.claimId)) continue;
    const after = fact(mention.claimRef);
    if (!after || after.eventId === eventId) continue;
    entries.push({id:`mention-${mention.id}`, eventId, occurredAt:events.get(eventId)!.occurred_at,
      kind:'repeated', reviewState:mention.associationState === 'confirmed' ? 'accepted' : 'draft',
      category:timelineCategory(claims.get(mention.claimRef.claimId)!), after, mention});
  }
  const rank = {conflict:0, updated:1, resolved:2, repeated:3, introduced:4};
  const categoryRank:Record<string,number>={'金额':0,'日期':1,'数量':2,'决定':3,'风险':4,'顾虑':5,'待解答':6,'需求':7,'偏好':8};
  return entries.sort((a,b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.eventId.localeCompare(b.eventId)
    || rank[a.kind] - rank[b.kind] || (categoryRank[a.category] ?? 8) - (categoryRank[b.category] ?? 8) || a.id.localeCompare(b.id));
}
