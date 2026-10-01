import test from 'node:test';
import assert from 'node:assert/strict';
import {extractionTransport} from '../lib/domain/extraction-transport.ts';
import {canonicalizeTranscriptEvidence} from '../lib/domain/evidence.ts';
import {validateExtractClaimsOutput,CLAIM_EXTRACTION_SCHEMA_VERSION} from '../lib/domain/model-contract.ts';

const event='evt_00000000000000000000000000000001',asset='av_00000000000000000000000000000001';
const segment=i=>({id:`seg_${asset}_${String(i).padStart(5,'0')}`,assetVersionId:asset,eventId:event,ordinal:i,speaker:'Speaker 1',startMs:i*1000,endMs:(i+1)*1000,textRaw:`Source ${i}: amount is approximately $12,000.`,textNormalized:`Source ${i}: amount is approximately $12,000.`,parserVersion:'v1'});
const input={schema_version:'context-pack.v3',project:{id:'p',scenario:'meeting',locale:'en',context_version:0},verified_context:{glossary:[],active_claims:[],recent_history:[],open_questions:[],active_risks:[]},draft_context:{enabled:false,claims:[]},new_event:{event_id:event,transcript_segments:Array.from({length:422},(_,i)=>segment(i)),readable_transcript_segments:[],photos:[],documents:[]}};
test('all transcript IDs round-trip with smaller input and intact text, timestamps, and checkpoints',()=>{
 const frozen=structuredClone(input),t=extractionTransport(input);
 assert.ok(JSON.stringify(t.input).length<JSON.stringify(input).length*.72);
 assert.deepEqual(input,frozen);
 for(let i=0;i<422;i++) {
  const s=t.input.new_event.transcript_segments[i],raw=input.new_event.transcript_segments[i];
  assert.equal(s.textRaw,raw.textRaw);assert.equal(s.textNormalized,raw.textNormalized);
  assert.equal(s.startMs,raw.startMs);assert.equal(s.endMs,raw.endMs);
  const decoded=t.decode({asset_version_id:s.assetVersionId,event_id:t.input.new_event.event_id,segment_ids:[s.id],quote_hint:s.textRaw});
  assert.deepEqual(decoded,{asset_version_id:asset,event_id:event,segment_ids:[raw.id],quote_hint:raw.textRaw});
 }
});
test('unregistered or crossed source IDs still fail canonical evidence validation',()=>{
 const t=extractionTransport(input),byId=new Map(input.new_event.transcript_segments.map(s=>[s.id,s]));
 const options={allowedSegmentIds:new Set(byId.keys()),expectedEventId:event,expectedAssetVersionId:asset};
 const wrong=t.decode({segment_ids:['s1'],quote_hint:input.new_event.transcript_segments[0].textRaw});
 assert.equal(canonicalizeTranscriptEvidence(wrong.segment_ids,wrong.quote_hint,byId,options).valid,false);
 const unknown=t.decode({segment_ids:['s9999'],quote_hint:input.new_event.transcript_segments[0].textRaw});
 assert.equal(canonicalizeTranscriptEvidence(unknown.segment_ids,unknown.quote_hint,byId,options).valid,false);
 const correct=t.decode({segment_ids:['s0'],quote_hint:input.new_event.transcript_segments[0].textRaw});
 assert.equal(canonicalizeTranscriptEvidence(correct.segment_ids,correct.quote_hint,byId,options).valid,true);
});
test('reference-looking source text and normalized values remain literal; alias collisions are avoided',()=>{
 const x=structuredClone(input);x.new_event.transcript_segments[0].id='s0';
 x.new_event.transcript_segments[0].textRaw=`The identifier is ${asset}.`;
 x.verified_context.active_claims=[{claimId:'c0',claimVersionId:'cv_long_reference',eventId:event,statement:`Keep ${asset} verbatim.`,normalizedValue:{assetVersionId:asset,id:'c0'}}];
 const t=extractionTransport(x);
 assert.notEqual(t.input.new_event.transcript_segments[0].id,'s0');
 const c=t.input.verified_context.active_claims[0];assert.notEqual(c.claimId,'c0');
 assert.equal(c.statement,x.verified_context.active_claims[0].statement);
 assert.deepEqual(c.normalizedValue,x.verified_context.active_claims[0].normalizedValue);
 const encoded=t.encode({target_claim_id:'c0',target_claim_version_id:'cv_long_reference',quote_hint:x.new_event.transcript_segments[0].textRaw});
 assert.deepEqual(t.decode(encoded),{target_claim_id:'c0',target_claim_version_id:'cv_long_reference',quote_hint:x.new_event.transcript_segments[0].textRaw});
});
test('inventory references and repair feedback use stable mappings on a resumed frozen input',()=>{
 const a=extractionTransport(input),b=extractionTransport(structuredClone(input));
 const inventory={event_id:event,candidates:[{statement:'Amount is approximate.',evidence:[{asset_version_id:asset,segment_ids:[segment(0).id],quote_hint:segment(0).textRaw}]}]};
 assert.deepEqual(a.encode(inventory),b.encode(inventory));
 assert.deepEqual(a.decode(a.encode(inventory)),inventory);
 assert.deepEqual(a.feedback([JSON.stringify({asset_version_id:asset,segment_ids:[segment(0).id]})]),[JSON.stringify({asset_version_id:'a0',segment_ids:['s0']})]);
});

test('reaffirmed accepted claims restore both target IDs and keep exact-version validation',()=>{
 const x=structuredClone(input);
 const original={claimId:'cl_confirmed_bedroom',claimVersionId:'cv_confirmed_bedroom',type:'requirement',statement:'Four bedrooms.',normalizedValue:null};
 x.verified_context.active_claims=[original];
 const t=extractionTransport(x),short=t.input.verified_context.active_claims[0];
 const claim={client_claim_key:'bed',disposition:'reaffirmed',reaffirmed_target_claim_id:short.claimId,reaffirmed_target_version_id:short.claimVersionId,type:'requirement',statement:original.statement,normalized_value:null,materiality:'high',confidence:.99,needs_additional_evidence:false,uncertainty:null,evidence:[{kind:'text',asset_version_id:'a0',segment_ids:['s0'],quote_hint:x.new_event.transcript_segments[0].textRaw,evidence_role:'direct'}],relations:[]};
 const output={schema_version:CLAIM_EXTRACTION_SCHEMA_VERSION,event_id:t.input.new_event.event_id,scenario_assessment:null,claims:[claim]};
 const decoded=t.decode(output);
 assert.equal(decoded.claims[0].reaffirmed_target_claim_id,original.claimId);
 assert.equal(decoded.claims[0].reaffirmed_target_version_id,original.claimVersionId);
 assert.equal(validateExtractClaimsOutput(decoded,x).valid,true);
 const wrong=t.decode({...output,claims:[{...claim,reaffirmed_target_version_id:'v9999'}]});
 assert.equal(validateExtractClaimsOutput(wrong,x).valid,false);
 assert.deepEqual(t.decode(t.encode({reaffirmed_target_claim_id:original.claimId,reaffirmed_target_version_id:original.claimVersionId})),{reaffirmed_target_claim_id:original.claimId,reaffirmed_target_version_id:original.claimVersionId});
});
