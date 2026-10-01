import type {ClosedFollowupContext,ContextPack} from './context-pack.ts';
import type {ProjectLedger,TranscriptSegment} from './types.ts';
import {claimSourceStatus,projectWorkspace,type ProjectionLedger} from './workflow-projection.ts';
import type {VersionRef} from '../shared/workflow-v2.ts';

/** Reprocessing a source can cover an old item, but cannot close new material. */
export function closedFollowupContext(ledger:ProjectionLedger,source:ProjectLedger,eventId:string,segments:readonly TranscriptSegment[]):ClosedFollowupContext[] {
  const snapshot=projectWorkspace(ledger,eventId,'1970-01-01T00:00:00.000Z','');
  const byVersion=new Map(ledger.claims.map(c=>[c.current_version_id,c]));
  const segmentById=new Map(segments.map(s=>[s.id,s]));
  const closures=(refs:VersionRef[])=>refs.flatMap(ref=>{
    const claim=byVersion.get(ref.claimVersionId);
    return claim && claim.id===ref.claimId && claim.review_status==='verified' && !['withdrawn','superseded'].includes(claim.lifecycle_status) && claimSourceStatus(claim,ledger.evidence)==='ready'
      ? [{...ref,statement:claim.statement}] : [];
  }).sort((a,b)=>a.claimVersionId.localeCompare(b.claimVersionId));
  const build=(ref:VersionRef,type:ClosedFollowupContext['type'],state:ClosedFollowupContext['state'],refs:VersionRef[]):ClosedFollowupContext[]=>{
    const claim=byVersion.get(ref.claimVersionId),closureRefs=closures(refs);
    if(!claim || claim.id!==ref.claimId || claim.event_id!==eventId || claim.type!==type || !(claim.review_status==='verified'||type==='open_question'&&claim.review_status==='pending') || ['withdrawn','superseded'].includes(claim.lifecycle_status) || claimSourceStatus(claim,ledger.evidence)!=='ready' || !closureRefs.length || closureRefs.length!==refs.length)return [];
    const sourceEvidence=(source.evidenceRefs??[]).filter(e=>e.claimVersionId===ref.claimVersionId && e.eventId===eventId && e.evidenceRole==='direct' && (e.kind==='transcript'||e.kind==='text') && e.assetVersionId && e.quoteRaw && e.segmentIds.length && e.segmentIds.every(id=>{
      const s=segmentById.get(id);return s && s.eventId===eventId && s.assetVersionId===e.assetVersionId;
    })).map(e=>({assetVersionId:e.assetVersionId!,segmentIds:[...e.segmentIds],quoteRaw:e.quoteRaw!})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if(!sourceEvidence.length)return [];
    return [{...ref,eventId,type,statement:claim.statement,state,closureRefs,sourceEvidence}];
  };
  return [
    ...snapshot.questions.filter(q=>q.resolutionState==='resolved' && (!q.latestOutcome||q.latestOutcome.freshness==='current')).flatMap(q=>build(q.claimRef,'open_question','answered',q.answerRefs)),
    ...snapshot.actions.filter(a=>a.executionState==='completed' && a.basisState==='current' && (!a.latestOutcome||a.latestOutcome.freshness==='current')).flatMap(a=>{
      const refs=ledger.relations.filter(r=>r.type==='resolves' && r.status==='active' && r.target_claim_version_id===a.claimRef.claimVersionId).flatMap(r=>{
        const c=byVersion.get(r.source_claim_version_id);return c?[{claimId:c.id,claimVersionId:c.current_version_id}]:[];
      });
      return build(a.claimRef,'next_action','completed',refs);
    }),
  ].sort((a,b)=>a.claimId.localeCompare(b.claimId));
}

export type HandledFollowupRef = {
  claim_id:string;claim_version_id:string;
  closure_version_ids:string[];
  confidence:number;
};

/** Exact IDs, current closure and source provenance gate a model identity proposal. */
export function validHandledFollowup(candidate:{type:string;evidence:unknown[]},proof:unknown,context?:ContextPack):boolean {
  if(!proof || typeof proof!=='object' || Array.isArray(proof) || !context)return false;
  const p=proof as HandledFollowupRef;
  if(Object.keys(p).sort().join(',')!=='claim_id,claim_version_id,closure_version_ids,confidence' || !Number.isFinite(p.confidence) || p.confidence<0.9 || p.confidence>1 || !Array.isArray(p.closure_version_ids) || !p.closure_version_ids.length || new Set(p.closure_version_ids).size!==p.closure_version_ids.length)return false;
  const target=context.verified_context.closed_followups?.find(c=>c.claimId===p.claim_id && c.claimVersionId===p.claim_version_id && c.eventId===context.new_event.event_id && c.type===candidate.type);
  if(!target || (target.type==='open_question'?target.state!=='answered':target.state!=='completed'))return false;
  const versions=target.closureRefs.map(r=>r.claimVersionId).sort();
  if(JSON.stringify([...p.closure_version_ids].sort())!==JSON.stringify(versions))return false;
  if(!candidate.evidence.length)return false;
  return candidate.evidence.every(raw=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return false;
    const e=raw as {kind:string;asset_version_id:string;segment_ids:string[];quote_hint:string;evidence_role:string};
    if(!['transcript','text'].includes(e.kind) || e.evidence_role!=='direct' || !Array.isArray(e.segment_ids) || !e.segment_ids.length || typeof e.quote_hint!=='string' || !e.quote_hint.trim())return false;
    return target.sourceEvidence.some(source=>source.assetVersionId===e.asset_version_id && e.segment_ids.every(id=>source.segmentIds.includes(id)) && source.quoteRaw.includes(e.quote_hint));
  });
}
