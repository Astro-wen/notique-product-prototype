import test from 'node:test';
import assert from 'node:assert/strict';
import {narrativeTransport} from '../lib/domain/narrative-transport.ts';
import {validateWorkflowNarrative,workflowNarrativePrompt} from '../lib/domain/workflow-narrative.ts';
import {inventoryContractForRun,verificationContractForRun} from '../lib/domain/two-stage-extraction.ts';
const ref=i=>({claimId:`clm_00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,claimVersionId:`cv_00000000-0000-4000-8000-${String(i).padStart(12,'0')}`});
const input={eventId:'e',contextVersion:0,sourceRevision:0,coverage:{complete:true,totalSegments:437,completedSegments:437,unprocessedRanges:[]},bullets:Array.from({length:64},(_,i)=>({text:`Point ${i}`,claimRefs:[ref(i)],reviewState:'draft',origin:'source_statement'}))};
const output=refs=>({schema_version:'workflow-narrative.v1',event_id:'e',sentences:refs.map(r=>({text:'A supported point',claim_refs:[r],topic:{key:'specific',title:'具体事项'}}))});
test('all 64 exact references round-trip with shorter model payload and no mutation',()=>{
 const before=structuredClone(input),transport=narrativeTransport(input,[]),encoded=output(transport.input.bullets.flatMap(b=>b.claimRefs));
 assert.ok(JSON.stringify(encoded).length<JSON.stringify(output(input.bullets.flatMap(b=>b.claimRefs))).length*.65);
 const restored=validateWorkflowNarrative(transport.decode(encoded),input);
 assert.deepEqual(restored.sentences.flatMap(s=>s.claim_refs),input.bullets.flatMap(b=>b.claimRefs));assert.deepEqual(input,before);
});
test('unknown and crossed aliases cannot pass exact-version validation',()=>{
 const t=narrativeTransport(input,[]),out=output(t.input.bullets.flatMap(b=>b.claimRefs));
 out.sentences[0].claim_refs[0].claimVersionId='v63';
 assert.throws(()=>validateWorkflowNarrative(t.decode(out),input),/校验/);
 out.sentences[0].claim_refs[0].claimId='unknown';assert.throws(()=>validateWorkflowNarrative(t.decode(out),input),/校验/);
});
test('repair guidance uses the same frozen aliases and supports multiple versions of one claim',()=>{
 const same={...input,bullets:[input.bullets[0],{...input.bullets[0],claimRefs:[{...ref(0),claimVersionId:ref(1).claimVersionId}]}]};
 const feedback='Missing '+JSON.stringify(same.bullets[1].claimRefs);
 const t=narrativeTransport(same,[feedback]);
 assert.deepEqual(t.input.bullets.map(b=>b.claimRefs[0]),[{claimId:'c0',claimVersionId:'v0'},{claimId:'c0',claimVersionId:'v1'}]);
 assert.equal(t.feedback[0],'Missing [{"claimId":"c0","claimVersionId":"v1"}]');
 assert.deepEqual(validateWorkflowNarrative(t.decode(output(t.input.bullets.flatMap(b=>b.claimRefs))),same).sentences.flatMap(s=>s.claim_refs),same.bullets.flatMap(b=>b.claimRefs));
});
test('frozen v9.6 and current v9.7 extraction retain the same coverage schema',()=>{
 for(const v of ['claim-extraction-prompt.v9.6','claim-extraction-prompt.v9.7','claim-extraction-prompt.v9.8','claim-extraction-prompt.v9.9']){
  assert.equal(inventoryContractForRun({inventory_prompt_version:v}).candidateLimit,64);
  assert.equal(verificationContractForRun({verification_schema_version:'claim-verification.v6',verification_prompt_version:v}).claimLimit,64);
 }
 assert.match(workflowNarrativePrompt(input),/large project or overall outcome is too broad/);
 assert.match(workflowNarrativePrompt(input,[],'workflow-narrative-prompt.v5'),/smallest set of independent user outcomes/);
});
