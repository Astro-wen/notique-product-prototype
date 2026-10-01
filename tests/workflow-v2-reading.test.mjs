import test from 'node:test';
import assert from 'node:assert/strict';
import {readingTopics,pendingItems,overviewTopics} from '../lib/domain/record-reading.ts';
import {parseWorkflowRequest,WorkflowValidationError} from '../lib/shared/workflow-v2.ts';
const ref=id=>({claimId:id,claimVersionId:id+'_v1'});
const bullet=(id,text=id)=>({id,text,claimRefs:[ref(id)],sourceStatus:'ready',origin:'source_statement',reviewState:'draft'});
const topic={key:'showings',title:'看房安排'};
const action={id:'tour',claimRef:ref('tour'),executionState:'completed',basisState:'current',basisDetails:[],questionRefs:[],latestOutcome:{id:'out',freshness:'current',text:'15点',answerRefs:[ref('answer')],resultRefs:[ref('result')]}};
const question={id:'time',claimRef:ref('time'),resolutionState:'resolved',answerRefs:[ref('answer')],latestOutcome:{id:'out',freshness:'current'}};
const fixture=()=>({reviewCards:[],actions:[action],questions:[question],bullets:['tour','answer','result','budget'].map(id=>bullet(id)),narrative:{freshness:'current',sentenceRefs:['tour','answer','result','budget'].map(id=>({text:id,topic,claimRefs:[ref(id)]}))}});
test('one reading card owns its current result and shared answers without rewriting the ledger',()=>{
 const s=fixture(),before=structuredClone(s),groups=readingTopics(s,s.bullets);
 assert.deepEqual(groups[0].detail.map(b=>b.id),['budget']);assert.deepEqual(groups[0].actions,[action]);assert.deepEqual(s,before);
 assert.deepEqual(groups[0].preview.map(x=>x.text),['budget']);
});
test('stale summaries and historical results cannot replace current editable information',()=>{
 const s=fixture();s.narrative.freshness='stale';s.actions=[{...action,latestOutcome:{...action.latestOutcome,freshness:'stale'}}];
 const g=readingTopics(s,s.bullets)[0];assert.equal(g.preview.length,0);assert.ok(g.detail.some(b=>b.id==='result'));assert.ok(g.detail.some(b=>b.id==='answer'));
});
test('pending queue counts a grouped decision once and includes direct questions and accepted open actions',()=>{
 const cards=[{id:'pair',needsDecision:true,disposition:'active',reasonCode:'action_choice',memberRefs:[ref('record'),ref('tour')]}];
 const tasks=pendingItems({reviewCards:cards,questions:[{...question,resolutionState:'open'},{...question,id:'tour',resolutionState:'open'}],actions:[{...action,executionState:'open'},{...action,id:'other',executionState:'open'}]});
 assert.deepEqual(tasks.map(t=>t.id),['pair','time','other']);
});
test('project headings use exact current versions and preserve every underlying item',()=>{
 const s={currentBullets:[{...bullet('budget'),eventId:'e'},{...bullet('changed'),eventId:'e'}],recordSummaries:[{eventId:'e',narrative:{sentenceRefs:[{text:'预算',topic,claimRefs:[ref('budget')]},{text:'旧内容',topic,claimRefs:[{claimId:'changed',claimVersionId:'old'}]}]}}]};
 const groups=overviewTopics(s,s.currentBullets);assert.deepEqual(groups.map(g=>g.title),['看房安排','其他要点']);assert.equal(groups.flatMap(g=>g.bullets).length,2);
});
test('a link alone cannot silently resolve a question and duplicate links are rejected',()=>{
 const b={expectedContextVersion:1,expectedActionRevision:1,completeAction:false,text:'结果',evidenceRefs:[],resolveQuestions:[]};
 assert.throws(()=>parseWorkflowRequest('OutcomeRequest',{...b,linkQuestionRefs:[ref('time')]}),WorkflowValidationError);
 assert.throws(()=>parseWorkflowRequest('OutcomeRequest',{...b,resolveQuestions:[{questionId:'time',revision:1,answerText:'15点'}],linkQuestionRefs:[ref('time'),ref('time')]}),WorkflowValidationError);
});

test('saved subject order survives random claim IDs and different visible filters',()=>{
 const s=fixture();s.actions=[];s.questions=[];
 s.bullets=[bullet('background'),bullet('budget')];
 s.narrative={freshness:'current',sentenceRefs:[{text:'Current budget',topic:{key:'money',title:'预算'},claimRefs:[ref('budget')]},{text:'Context',topic:{key:'context',title:'背景'},claimRefs:[ref('background')]}]};
 assert.deepEqual(readingTopics(s,s.bullets).map(t=>t.key),['money','context']);
 assert.deepEqual(readingTopics(s,[s.bullets[0]]).map(t=>t.key),['context']);
 const overview={currentBullets:s.bullets.map(b=>({...b,eventId:'e'})),recordSummaries:[{eventId:'e',narrative:s.narrative}]};
 assert.deepEqual(overviewTopics(overview,overview.currentBullets).map(t=>t.title),['预算','背景']);
});

test('overview promotes accepted current user results without hiding original records or stale items',()=>{
 const original={...bullet('original'),eventId:'e'},result={...bullet('result'),eventId:'e',origin:'user_input',reviewState:'accepted'},stale={...bullet('stale'),eventId:'e',origin:'user_input',reviewState:'accepted',sourceStatus:'stale'};
 const s={currentBullets:[original,stale,result],recordSummaries:[{eventId:'e',narrative:{sentenceRefs:[{text:'current',topic,claimRefs:[ref('original'),ref('stale'),ref('result')]}]}}]};
 const before=structuredClone(s);
 assert.deepEqual(overviewTopics(s,s.currentBullets)[0].bullets.map(b=>b.id),['result','original','stale']);assert.deepEqual(s,before);
});
