import {insert,T} from './workflow-database.mjs';
export const REPEAT_QUOTE='预算仍然大约三十万。我们还是向供应商询价。费用还要继续核对。';
export function seedReaffirmedRecord(sqlite,{targets=['budget'],confirmed=false}={}) {
 insert(sqlite,'events',{id:'e2',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'下一次沟通',occurred_at:'2026-09-29T10:00:00.000Z',sequence_no:2,active_run_id:'run2'});
 insert(sqlite,'assets',{id:'asset2',workspace_id:'ws',project_id:'p',event_id:'e2',kind:'text',filename:'synthetic-repeat.txt',current_version_id:'av2',processing_status:'ready'});
 insert(sqlite,'asset_versions',{id:'av2',asset_id:'asset2',version_no:1,content_sha256:'synthetic-repeat',mime_type:'text/plain',size_bytes:100,r2_original_key:'synthetic/repeat',finalized_at:T});
 insert(sqlite,'text_segments',{id:'seg2',workspace_id:'ws',project_id:'p',event_id:'e2',asset_id:'asset2',asset_version_id:'av2',ordinal:0,parser_version:'test',text_raw:REPEAT_QUOTE,text_normalized:REPEAT_QUOTE});
 insert(sqlite,'extraction_runs',{id:'run2',workspace_id:'ws',project_id:'p',event_id:'e2',status:'succeeded',idempotency_key:'repeat',input_hash:'repeat',input_snapshot_hash:'repeat',input_manifest_json:JSON.stringify([{asset_version_id:'av2'}]),context_version:0,context_snapshot_hash:'repeat',prompt_version:'synthetic',schema_version:'synthetic',parser_version:'test',created_at:T});
 for(const target of targets) {
  const old=sqlite.prepare('SELECT c.type,c.current_version_id,v.statement FROM claims c JOIN claim_versions v ON v.id=c.current_version_id WHERE c.id=?').get(target),id=`repeat-${target}`;
  insert(sqlite,'claim_occurrence_candidates',{id,workspace_id:'ws',project_id:'p',target_claim_id:target,target_claim_version_id:old.current_version_id,event_id:'e2',extraction_run_id:'run2',evidence_ref_json:JSON.stringify({schema_version:'occurrence-evidence.v1',statement:old.statement,type:old.type,evidence:[{kind:'text',assetVersionId:'av2',segmentIdsJson:'["seg2"]',quoteRaw:REPEAT_QUOTE,startMs:null,endMs:null,pageNumber:null,bboxJson:null,observation:null,evidenceRole:'corroborating'}]}),status:confirmed?'confirmed':'pending',base_version_id:old.current_version_id,created_at:T,updated_at:T});
  if(confirmed)confirmReaffirmed(sqlite,target);
 }
}
export function confirmReaffirmed(sqlite,target) {
 const id=`repeat-${target}`,c=sqlite.prepare('SELECT * FROM claim_occurrence_candidates WHERE id=?').get(id);
 sqlite.prepare("UPDATE claim_occurrence_candidates SET status='confirmed' WHERE id=?").run(id);
 insert(sqlite,'evidence_refs',{id:`${id}-evidence`,workspace_id:'ws',project_id:'p',event_id:'e2',claim_version_id:c.target_claim_version_id,kind:'text',asset_version_id:'av2',segment_ids_json:'["seg2"]',quote_raw:REPEAT_QUOTE,evidence_role:'corroborating',provenance_grade:'primary',structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
 insert(sqlite,'occurrence_verdicts',{id:`${id}-verdict`,candidate_id:id,action:'confirm',target_base_version_id:c.target_claim_version_id,user_id:'owner',created_at:T});
 insert(sqlite,'claim_occurrences',{id:`${id}-occurrence`,claim_id:c.target_claim_id,claim_version_id:c.target_claim_version_id,event_id:'e2',evidence_ref_id:`${id}-evidence`,occurrence_verdict_id:`${id}-verdict`,confirmed_at:T,created_at:T});
}
