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

// Inventory quote_hint is a locator hint, not the saved original quotation.
// Tolerate ASR fillers and repeated articles/pronouns only at this boundary.
// Negations, quantities and other repeated words retain their original order.
function quoteHintMatches(raw:string,hint:string):boolean {
  const normalize=(s:string)=>s.toLowerCase().replace(/[’‘]/g,"'").replace(/\b(?:uh|um)\b/g,' ').replace(/[^\p{L}\p{N}']/gu,' ').replace(/\b(a|i|we|you|the)\s+\1\b/g,'$1').replace(/\s+/g,' ').trim();
  const text=normalize(raw),parts=hint.split(/\.{3}|…/).map(normalize);
  if(parts.some(part=>!part))return false;
  let offset=0;
  return parts.every(part=>{const at=text.indexOf(part,offset);if(at<0)return false;offset=at+part.length;return true;});
}

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
  const segmentById=new Map(context.new_event.transcript_segments.map(s=>[s.id,s]));
  let directCount=0;
  const valid=candidate.evidence.every(raw=>{
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return false;
    const e=raw as {kind:string;asset_version_id:string;segment_ids:string[];quote_hint:string;evidence_role:string};
    if(!['transcript','text'].includes(e.kind) || !['direct','corroborating'].includes(e.evidence_role) || !Array.isArray(e.segment_ids) || !e.segment_ids.length || typeof e.quote_hint!=='string' || !e.quote_hint.trim())return false;
    const sources=target.sourceEvidence.filter(source=>source.assetVersionId===e.asset_version_id);
    if(!sources.length)return false;
    const segments=e.segment_ids.map(id=>segmentById.get(id));
    if(segments.some(s=>!s || s.assetVersionId!==e.asset_version_id || s.eventId!==context.new_event.event_id))return false;
    if(e.evidence_role==='corroborating')return true;
    directCount++;
    const covered=new Set(sources.flatMap(source=>source.segmentIds));
    if(!e.segment_ids.every(id=>covered.has(id)))return false;
    return quoteHintMatches(segments.map(s=>s!.textRaw).join(' '),e.quote_hint);
  });
  return valid && directCount>0;
}
