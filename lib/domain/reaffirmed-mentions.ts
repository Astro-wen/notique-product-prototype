import type { ProjectionLedger } from './workflow-projection.ts';
import type { ReaffirmedMention, SourceStatus } from '../shared/workflow-v2.ts';

export type LedgerMention = {
  id:string; event_id:string; extraction_run_id:string; target_claim_id:string;
  target_claim_version_id:string; base_version_id:string; status:string;
  evidence_ref_json:string; evidence_sources_json:unknown; target_statement:string|null;
  confirmed:number; created_at:string;
};
type SourceRow={ordinal:number;asset_version_id:string|null;availability:SourceStatus;segments_json:unknown};
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object' && value!==null && !Array.isArray(value);
function json(value:unknown):unknown {try{return typeof value==='string'?JSON.parse(value):object(value) || Array.isArray(value)?value:null;}catch{return null;}}

/** A repeat refers to a frozen old version. It does not create or approve a new
 * claim, and a pending model association never becomes an accepted action. */
export function projectReaffirmedMentions(ledger:ProjectionLedger,eventId:string,readableRunId:string|null):ReaffirmedMention[] {
  return (ledger.mentions ?? []).filter(m=>m.event_id===eventId && ['pending','confirmed'].includes(m.status)
    && (m.status==='confirmed' || m.extraction_run_id===readableRunId)).toSorted((a,b)=>a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).map(m=>{
    const payload=json(m.evidence_ref_json),rows=json(m.evidence_sources_json);
    const canonical=object(payload) && payload.schema_version==='occurrence-evidence.v1' && Array.isArray(payload.evidence);
    const evidence=canonical?payload.evidence as unknown[]:[];
    const sources=evidence.map((value,index)=>{
      const row=Array.isArray(rows)?rows.find(r=>object(r) && r.ordinal===index) as SourceRow|undefined:undefined;
      let availability:SourceStatus=row?.availability ?? 'missing',quote:string|null=null;
      if(!object(value) || !['transcript','text','photo','document'].includes(String(value.kind)) || typeof value.assetVersionId!=='string' || value.assetVersionId!==row?.asset_version_id || !['direct','corroborating','contextual'].includes(String(value.evidenceRole)))availability='missing';
      else if(['transcript','text'].includes(String(value.kind))) {
        const ids=json(value.segmentIdsJson),segments=json(row.segments_json);
        if(!Array.isArray(ids) || !ids.length || ids.some(id=>typeof id!=='string' || !id) || new Set(ids).size!==ids.length || !Array.isArray(segments) || segments.length!==ids.length || segments.some((s,i)=>!object(s) || s.id!==ids[i] || typeof s.text!=='string'))availability='missing';
        else {const original=segments.map(s=>s.text).join('\n');if(typeof value.quoteRaw!=='string' || !value.quoteRaw.trim() || !original.includes(value.quoteRaw))availability='missing';else if(availability==='ready')quote=value.quoteRaw;}
      } else if(availability==='ready')quote=typeof value.observation==='string'?value.observation:typeof value.quoteRaw==='string'?value.quoteRaw:null;
      return {assetVersionId:availability!=='missing' && object(value) && typeof value.assetVersionId==='string'?value.assetVersionId:null,quote,sourceStatus:availability};
    });
    const sourceStatus:SourceStatus=!sources.length || !evidence.some(e=>object(e) && ['direct','corroborating'].includes(String(e.evidenceRole))) || sources.some(s=>s.sourceStatus==='missing')?'missing':sources.some(s=>s.sourceStatus==='stale')?'stale':'ready';
    const target=ledger.claims.find(c=>c.id===m.target_claim_id && ledger.events.some(e=>e.id===c.event_id));
    const targetEvidence=ledger.evidence.filter(e=>e.claim_version_id===m.target_claim_version_id && e.evidence_role!=='contextual');
    const targetReadable=Boolean(target && targetEvidence.length && targetEvidence.every(e=>e.availability==='ready' && e.structural_validation_status==='valid'));
    const currentEvidence=target?ledger.evidence.filter(e=>e.claim_version_id===target.current_version_id && e.evidence_role!=='contextual'):[];
    const currentReadable=Boolean(target && currentEvidence.length && currentEvidence.every(e=>e.availability==='ready' && e.structural_validation_status==='valid'));
    const targetState:ReaffirmedMention['targetState']=!target?'unavailable':target.review_status!=='verified' || ['withdrawn','superseded'].includes(target.lifecycle_status)?'retired':target.current_version_id!==m.target_claim_version_id || m.base_version_id!==m.target_claim_version_id || canonical && payload.type!==target.type?'changed':'current';
    return {id:m.id,claimRef:{claimId:m.target_claim_id,claimVersionId:m.target_claim_version_id},currentRef:target?{claimId:target.id,claimVersionId:target.current_version_id}:null,
      targetEventId:target?.event_id ?? null,kind:target?.type==='next_action'?'action':target?.type==='open_question'?'question':'record',
      statement:sourceStatus==='ready' && canonical && typeof payload.statement==='string'?payload.statement:null,targetText:targetReadable?m.target_statement:null,currentText:currentReadable?target!.statement:null,
      associationState:m.status==='confirmed' && m.confirmed===1?'confirmed':'proposed',targetState,sourceStatus,sources};
  });
}
