import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,SCOPE,T} from './helpers/workflow-database.mjs';
import {sameIntentGroupStatements} from '../lib/server/jobs/same-intent-groups.ts';
import {selectSameIntentGroups} from '../lib/domain/same-intent-groups.ts';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {decideRecord} from '../lib/server/workflow/record-decision.ts';
import {verificationContractForRun,validateVerificationOutput,VERIFICATION_SCHEMA_VERSION,LEGACY_VERIFICATION_SCHEMA_VERSION,INVENTORY_SCHEMA_VERSION,TWO_STAGE_EXTRACTION_PROMPT_VERSION} from '../lib/domain/two-stage-extraction.ts';
import {canResumeProcessingModelStage,canReuseSucceededModelStage} from '../lib/server/jobs/model-stage-contract.ts';
const proposal=(extra={})=>({group_key:'quote',record_claim_key:'agreement',action_claim_key:'action',reason:'One explicitly stated agreement.',confidence:0.98,...extra});
const members=()=>[{claimId:'agreement',versionId:'agreement_v1',model:{client_claim_key:'agreement',type:'decision',disposition:'new',statement:'约定向供应商询价'}},{claimId:'action',versionId:'action_v1',model:{client_claim_key:'action',type:'next_action',disposition:'new',statement:'向供应商询价'}}];
const scope={workspaceId:'ws',projectId:'p',eventId:'e',runId:'run',contextVersion:0,timestamp:T};
async function setup(t){const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);claim(f.sqlite,'agreement','decision','约定向供应商询价');return f;}

test('model pair publication keeps independent drafts and one actual record/action choice',async t=>{
 const {db,sqlite}=await setup(t),warnings=[];
 await db.batch(sameIntentGroupStatements(db,scope,[proposal()],members(),warnings));
 assert.equal(warnings.length,0);const w=await readWorkspace(db,SCOPE,'e',{},T),c=w.reviewCards.find(c=>c.id==='wfc_action');
 assert.deepEqual(c.sameIntent,{recordRef:{claimId:'agreement',claimVersionId:'agreement_v1'},actionRef:{claimId:'action',claimVersionId:'action_v1'}});assert.equal(w.counts.needsDecisionCount,1);assert.equal(w.actions.length,0);assert.equal(c.members.every(m=>m.reviewState==='draft'),true);
 await decideRecord(db,SCOPE,{projectId:'p',eventId:'e',cardId:c.id,key:'join-model-pair',request:{expectedContextVersion:0,expectedCardRevision:1,operation:'accept_action',members:[{claimId:'action',claimVersionId:'action_v1',operation:'accept_action'}]}});
 const after=await readWorkspace(db,SCOPE,'e',{},T);assert.equal(after.actions.length,1);assert.equal(after.actions[0].id,'action');assert.equal(after.bullets.find(b=>b.id==='agreement').reviewState,'draft');assert.equal(sqlite.prepare("SELECT count(*) n FROM action_metadata WHERE claim_id='action'").get().n,1);
});
test('missing or reclassified published member preserves individual readable claims and audited warning',async t=>{
 for(const list of [members().slice(1),members().map(m=>m.claimId==='action'?{...m,model:{...m.model,type:'property_fact'}}:m)]){
  const {db,sqlite}=await setup(t),warnings=[];await db.batch(sameIntentGroupStatements(db,scope,[proposal()],list,warnings));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_cards').get().n,0);assert.equal(warnings[0].code,'SAME_INTENT_GROUP_NOT_PERSISTED');const w=await readWorkspace(db,SCOPE,'e',{},T);assert.ok(w.bullets.some(b=>b.id==='agreement'));assert.ok(w.bullets.some(b=>b.id==='action'));
 }
});
test('overlapping and duplicate groups all fall back without arbitrary first-pair selection',()=>{
 const groups=[proposal(),proposal({group_key:'second'})];assert.equal(selectSameIntentGroups(groups,members().map(m=>m.model)).groups.length,0);
 const m=[...members().map(m=>m.model),{client_claim_key:'record2',type:'decision',disposition:'new'},{client_claim_key:'action2',type:'next_action',disposition:'new'}];
 assert.equal(selectSameIntentGroups([proposal(),proposal({record_claim_key:'record2',action_claim_key:'action2'})],m).groups.length,0);
 assert.equal(selectSameIntentGroups([proposal(),proposal({group_key:'second',record_claim_key:'record2',action_claim_key:'action2'})],m).groups.length,2);
});
test('low-confidence, reaffirmed, duplicate, same-member and oversized proposals cannot create a group',()=>{
 const m=members().map(m=>m.model);
 for(const p of [proposal({confidence:0.8}),proposal({action_claim_key:'agreement'}),proposal({extra:'unknown'})])assert.equal(selectSameIntentGroups([p],m).groups.length,0);
 for(const disposition of ['reaffirmed','duplicate'])assert.equal(selectSameIntentGroups([proposal()],m.map(x=>x.type==='next_action'?{...x,disposition}:x)).groups.length,0);
 assert.equal(selectSameIntentGroups(Array.from({length:13},(_,i)=>proposal({group_key:`g${i}`})),m).groups.length,0);
});
test('later SQL failure rolls back group, members and proposed relation together',async t=>{
 const {db,sqlite}=await setup(t),before=sqlite.prepare('SELECT count(*) n FROM claim_relations').get().n;
 await assert.rejects(db.batch([...sameIntentGroupStatements(db,scope,[proposal()],members(),[]),db.prepare("INSERT INTO mutation_guards (id,guard_value) VALUES ('failed-group',0)")]));
 assert.equal(sqlite.prepare('SELECT count(*) n FROM workflow_cards').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM card_members').get().n,0);assert.equal(sqlite.prepare('SELECT count(*) n FROM claim_relations').get().n,before);
});
test('legacy paid stage stays exactly reusable and resumable after grouping protocol upgrade',()=>{
 const c=verificationContractForRun({});assert.deepEqual(c,{schemaVersion:LEGACY_VERIFICATION_SCHEMA_VERSION,promptVersion:TWO_STAGE_EXTRACTION_PROMPT_VERSION});
 const frozen={provider:'openai',model:'test',reasoningEffort:'high',promptVersion:`${c.promptVersion}:verify`,schemaVersion:c.schemaVersion,inputHash:'old-unchanged-hash'};
 const persisted={provider:'openai',model:'test',reasoning_effort:'high',prompt_version:frozen.promptVersion,schema_version:frozen.schemaVersion,input_hash:frozen.inputHash};
 assert.equal(canReuseSucceededModelStage({...persisted,status:'succeeded'},frozen),true);assert.equal(canResumeProcessingModelStage({...persisted,status:'processing'},frozen),true);
 const upgraded=verificationContractForRun({verification_schema_version:VERIFICATION_SCHEMA_VERSION});assert.equal(upgraded.schemaVersion,VERIFICATION_SCHEMA_VERSION);assert.notEqual(upgraded.promptVersion,c.promptVersion);assert.throws(()=>verificationContractForRun({verification_schema_version:'invented'}));
});
test('legacy verification remains valid with no fabricated groups; new version requires the explicit array',()=>{
 const inventory={schema_version:INVENTORY_SCHEMA_VERSION,event_id:'e',candidates:[]},v={schema_version:LEGACY_VERIFICATION_SCHEMA_VERSION,event_id:'e',scenario_assessment:null,claims:[],candidate_dispositions:[],draft_link_candidates:[],quality_review:{unresolved_conflict_keys:[],compound_claim_keys:[],reaffirmed_issue_claim_keys:[]}};
 assert.equal(validateVerificationOutput(v,inventory).valid,true);assert.equal(validateVerificationOutput({...v,schema_version:VERIFICATION_SCHEMA_VERSION},inventory).valid,false);assert.equal(validateVerificationOutput({...v,schema_version:VERIFICATION_SCHEMA_VERSION,same_intent_groups:[]},inventory).valid,true);
});
