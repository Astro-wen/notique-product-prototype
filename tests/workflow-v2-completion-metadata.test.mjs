import test from 'node:test';
import assert from 'node:assert/strict';
import {repairVerificationOutput} from '../lib/domain/two-stage-extraction.ts';
import {validateExtractClaimsOutput,CLAIM_EXTRACTION_SCHEMA_VERSION} from '../lib/domain/model-contract.ts';
const normalized={status:'completed',completed_action_claim_id:'action',workflow_kind:'completion'};
const target={claimId:'completed',claimVersionId:'current',type:'next_action',statement:'已完成：联系贷款方。',normalizedValue:normalized};
const context={verified_context:{active_claims:[target],open_questions:[],active_risks:[],recent_history:[]}};
const claim={client_claim_key:'done',disposition:'reaffirmed',reaffirmed_target_claim_id:'completed',reaffirmed_target_version_id:'current',type:'next_action',statement:target.statement,normalized_value:{...normalized,workflow_kind:'answer'},materiality:'high',confidence:.99,needs_additional_evidence:false,uncertainty:null,evidence:[{kind:'text',asset_version_id:'av',segment_ids:['seg'],quote_hint:'联系贷款方。',evidence_role:'direct'}],relations:[]};
const value=c=>({schema_version:CLAIM_EXTRACTION_SCHEMA_VERSION,event_id:'event',scenario_assessment:null,claims:[c]});
test('only the answer/completion discriminator is restored and recorded against an exact frozen target',()=>{
 const original=value(claim),fixed=repairVerificationOutput(original,context);
 assert.equal(validateExtractClaimsOutput(original,context).valid,false);
 assert.equal(validateExtractClaimsOutput(fixed.value,context).valid,true);
 assert.deepEqual(fixed.value.claims[0].normalized_value,normalized);
 assert.deepEqual(fixed.repairs,['restored completion workflow kind for done']);
 assert.equal(original.claims[0].normalized_value.workflow_kind,'answer');
});
test('real field, statement, type, version and additional fact mismatches stay invalid',()=>{
 for(const patch of [{statement:'已完成：联系另一贷款方。'},{type:'decision'},{reaffirmed_target_version_id:'obsolete'},{normalized_value:{...claim.normalized_value,status:'pending'}},{normalized_value:{...claim.normalized_value,completed_action_claim_id:'other'}},{normalized_value:{...claim.normalized_value,amount:220000}}]){
  const fixed=repairVerificationOutput(value({...claim,...patch}),context);assert.deepEqual(fixed.repairs,[]);assert.equal(validateExtractClaimsOutput(fixed.value,context).valid,false);
 }
});
