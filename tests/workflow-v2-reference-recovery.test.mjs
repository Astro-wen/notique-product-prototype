import test from 'node:test';
import assert from 'node:assert/strict';
import {canRecoverFailedReferenceDecoding} from '../lib/server/jobs/model-stage-contract.ts';
const expected={provider:'test',model:'test',reasoningEffort:'high',promptVersion:'claim-extraction-prompt.v9.9:verify',schemaVersion:'claim-verification.v6',inputHash:'frozen'};
const stage={status:'failed',provider:'test',model:'test',reasoning_effort:'high',prompt_version:expected.promptVersion,schema_version:expected.schemaVersion,input_hash:'frozen',provider_request_id:'paid',error_code:'MODEL_OUTPUT_INVALID',error_details:{issues:[{path:'$.claims[1].reaffirmed_target_version_id',message:'Reaffirmed target must be the current active claim version in this Context Pack.'}]}};
test('paid decoder recovery requires exact frozen inputs and the specific reference error',()=>{
 assert.equal(canRecoverFailedReferenceDecoding(stage,expected),true);
 for(const patch of [{provider_request_id:null},{input_hash:'changed'},{prompt_version:'claim-extraction-prompt.v9.8:verify'},{error_code:'MODEL_OUTPUT_TOKEN_LIMIT'},{status:'processing'},{error_details:{issues:[{path:'$.claims[1].statement',message:'Changed fact'}]}},{error_details:{issues:{length:1}}},{error_details:null}])assert.equal(canRecoverFailedReferenceDecoding({...stage,...patch},expected),false);
});
