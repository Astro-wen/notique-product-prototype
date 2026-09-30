import assert from 'node:assert/strict';
import test from 'node:test';
import {recordTopics} from '../lib/domain/record-topics.ts';
import {validateWorkflowNarrative,workflowNarrativeSchema,workflowNarrativePrompt,WORKFLOW_NARRATIVE_PREVIOUS_PROMPT_VERSION} from '../lib/domain/workflow-narrative.ts';
const ref=id=>({claimId:id,claimVersionId:`${id}_v1`});
const bullet=id=>({id,text:id,claimRefs:[ref(id)],reviewState:'draft',origin:'source_statement',sourceStatus:'ready'});
const topic={key:'quotes',title:'供应商报价'};
const sentence=(id,t=topic)=>({text:id,claimRefs:[ref(id)],reviewState:'draft',topic:t});
const snapshot=()=>({bullets:['budget','quote','question','action'].map(bullet),reviewCards:[],actions:[],questions:[],narrative:{sentenceRefs:[sentence('budget',{key:'budget',title:'改造预算'}),sentence('quote'),sentence('question'),sentence('action')]}});

test('a topic contains its facts, questions and actions exactly once without changing their state',()=>{
 const s=snapshot(),before=structuredClone(s),groups=recordTopics(s,s.bullets);
 assert.deepEqual(groups.map(g=>[g.title,g.bullets.map(b=>b.id)]),[['改造预算',['budget']],['供应商报价',['quote','question','action']]]);
 assert.deepEqual(s,before);
});
test('an answer stays with its question while the derived overview is stale, and completion does not answer a question',()=>{
 const s=snapshot();s.bullets.push(bullet('answer'));s.questions=[{id:'question',claimRef:ref('question'),resolutionState:'resolved',answerRefs:[ref('answer')]}];
 s.actions=[{id:'action',claimRef:ref('action'),executionState:'completed',questionRefs:[ref('question')],basisDetails:[]}];
 s.narrative.freshness='stale';
 const groups=recordTopics(s,s.bullets.filter(b=>b.id!=='question'));
 assert.deepEqual(groups.find(g=>g.key==='quotes').bullets.map(b=>b.id),['quote','action','answer']);
 assert.deepEqual(groups.find(g=>g.key==='quotes').actions.map(a=>a.id),['action']);
 s.questions[0].resolutionState='open';recordTopics(s,s.bullets);assert.equal(s.questions[0].resolutionState,'open');
});
test('a changed version cannot inherit old model membership, and filtering never resurrects hidden content',()=>{
 const s=snapshot();s.bullets[1].claimRefs=[{claimId:'quote',claimVersionId:'quote_v2'}];
 const groups=recordTopics(s,[s.bullets[1]]);
 assert.deepEqual(groups.flatMap(g=>g.bullets).map(b=>b.id),['quote']);
 assert.equal(groups[0].title,'其他要点');
});
test('partial and legacy outputs preserve every visible entry, malformed topic metadata falls back safely',()=>{
 const s=snapshot();s.narrative.sentenceRefs[1].topic={key:'bad key',title:{}};
 assert.equal(recordTopics(s,s.bullets).flatMap(g=>g.bullets).length,4);
 s.narrative=null;assert.deepEqual(recordTopics(s,s.bullets).map(g=>g.title),['本次讨论']);
});
test('topic validation uses exact frozen versions and consistent titles, with legacy paid schemas preserved',()=>{
 const input={eventId:'e',bullets:['quote','question'].map(bullet)};
 const output={schema_version:'workflow-narrative.v1',event_id:'e',sentences:[{text:'报价待确认',claim_refs:[ref('quote'),ref('question')],topic}]};
 assert.deepEqual(validateWorkflowNarrative(output,input),output);
 assert.throws(()=>validateWorkflowNarrative({...output,sentences:[...output.sentences,{text:'重复',claim_refs:[ref('quote')],topic:{key:'other',title:'其他'}}]},input),/校验/);
 assert.throws(()=>validateWorkflowNarrative({...output,sentences:[...output.sentences,{text:'标题不一致',claim_refs:[ref('quote')],topic:{key:'quotes',title:'新的标题'}}]},input),/校验/);
 const required=workflowNarrativeSchema().properties.sentences.items.required;
 assert.ok(required.includes('topic'));
 assert.equal(workflowNarrativeSchema(WORKFLOW_NARRATIVE_PREVIOUS_PROMPT_VERSION).properties.sentences.items.required.includes('topic'),false);
 assert.match(workflowNarrativePrompt(input),/concrete subject, not by item type/);
 assert.doesNotMatch(workflowNarrativePrompt(input,[],WORKFLOW_NARRATIVE_PREVIOUS_PROMPT_VERSION),/Every sentence has topic/);
});
