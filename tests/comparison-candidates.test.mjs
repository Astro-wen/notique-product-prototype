import test from 'node:test';
import assert from 'node:assert/strict';
import {comparisonCandidates} from '../lib/domain/comparison-candidates.ts';
const entry=(id,statement,eventId='old',normalizedValue=null)=>({claimId:id,claimVersionId:id+'v',statement,eventId,normalizedValue});
test('retrieval returns bounded exact historical versions and ignores current or unverified sources',()=>{
 const ctx={new_event:{event_id:'new'},draft_context:{claims:[entry('fee','Competition may keep appraisal fees stable.'),entry('current','Appraisal fees may rise.','new'),entry('bad','Appraisal fees may rise.','old',{source_match_status:'unverified'}),entry('unrelated','The meeting begins tomorrow.')]},verified_context:{active_claims:[],open_questions:[]}};
 const result=comparisonCandidates({candidates:[{inventory_key:'k',statement:'Early demand may increase appraisal fees.'}]},ctx);
 assert.deepEqual(result,[{inventory_key:'k',targets:[{claim_id:'fee',claim_version_id:'feev'}]}]);
 // Retrieval never asserts changed/conflicting/same; the verifier decides.
 assert.equal('type' in result[0],false);
});

test('attribute retrieval catches opposing forecasts even when only the fee attribute overlaps',()=>{
 const ctx={new_event:{event_id:'new'},draft_context:{claims:[entry('fee','John guessed fees would remain stable given sufficient metropolitan competition.'),entry('amc','Lori confirmed the bank predominantly uses AMCs.')]},verified_context:{active_claims:[],open_questions:[]}};
 const inv={candidates:[{inventory_key:'k',statement:'Early adopter demand may increase appraisal fees and squeeze AMCs.'}]};
 assert.equal(comparisonCandidates(inv,ctx).flatMap(p=>p.targets).some(x=>x.claim_id==='fee'),false);
 assert.equal(comparisonCandidates(inv,ctx,true)[0].targets[0].claim_id,'fee');
});
