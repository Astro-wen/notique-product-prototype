import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {recordTopics} from '../lib/domain/record-topics.ts';
import {validateWorkflowNarrative,workflowNarrativePrompt,workflowNarrativeSchema,workflowNarrativeSentences} from '../lib/domain/workflow-narrative.ts';

const ref=id=>({claimId:id,claimVersionId:`${id}_v1`});
const bullet=(id,text=id,reviewState='draft')=>({id,text,claimRefs:[ref(id)],reviewState,origin:'source_statement',sourceStatus:'ready'});
const procurement={key:'procurement',title:'设备采购'};
const training={key:'training',title:'行政培训'};
const sentence=(id,topic)=>({text:id,claimRefs:[ref(id)],reviewState:'draft',topic});
const action=(id,questionRefs=[],basisDetails=[])=>({id,claimRef:ref(id),revision:1,executionState:'open',questionRefs:questionRefs.map(r=>({...r,revision:1})),basisState:'current',basisDetails,latestOutcome:null});
const question=id=>({id,claimRef:ref(id),revision:1,resolutionState:'open',answerRefs:[],latestOutcome:null});

test('frozen v1-v3 request prompts and JSON schemas retain their exact pre-upgrade bytes',()=>{
  const input={eventId:'frozen',contextVersion:0,sourceRevision:0,coverage:{complete:true,totalSegments:1,completedSegments:1,unprocessedRanges:[]},bullets:[{text:'采购报价待确认',claimRefs:[ref('quote')],origin:'source_statement',reviewState:'draft'}]};
  const frozen=[
    ['workflow-narrative-prompt.v1','635d113ae66704e88e00cd362ab113d5af44dbf47df5422f17f84b0941f25209','db9827ca270380b7aa0a62fe84a5210738b532cba5c483b8f20690f2cb762bfe'],
    ['workflow-narrative-prompt.v2','1555c268cbe7609605efc771b491339a01885c4512abb353976dfea7c2875dee','db9827ca270380b7aa0a62fe84a5210738b532cba5c483b8f20690f2cb762bfe'],
    ['workflow-narrative-prompt.v3','1f291c1a454da0a95c81b5701e53a4904eac786b2604d21016f51171255a460a','3c33297654a72a6c1709e6173262f652a299838c16d9bd0963f810ceadef6e08'],
  ];
  const sha=value=>createHash('sha256').update(value).digest('hex');
  for(const [version,promptHash,schemaHash] of frozen){
    assert.equal(sha(workflowNarrativePrompt(input,['exact version'],version)),promptHash,version);
    assert.equal(sha(JSON.stringify(workflowNarrativeSchema(version))),schemaHash,version);
  }
  assert.deepEqual(workflowNarrativeSchema('workflow-narrative-prompt.v4'),workflowNarrativeSchema('workflow-narrative-prompt.v3'));
});

test('one supported purchase contains its supplier, costs, approval, question, action and result without losing exact versions or state',()=>{
  // The provider response is hand-labelled synthetic input. This exercises
  // validation and projection, rather than claiming real model grouping quality.
  const ids=['purchase','budget','supplier','installation','approval','quote_action','quote_result'];
  const bullets=ids.map(id=>bullet(id,id,id==='quote_result'?'accepted':'draft')).concat([bullet('course')]);
  const input={eventId:'e',bullets};
  const output={schema_version:'workflow-narrative.v1',event_id:'e',sentences:ids.map(id=>({text:id,claim_refs:[ref(id)],topic:procurement})).concat([{text:'course',claim_refs:[ref('course')],topic:training}])};
  const validated=validateWorkflowNarrative(output,input);
  const quoteAction=action('quote_action',[ref('installation')]);quoteAction.executionState='completed';quoteAction.latestOutcome={id:'outcome',revision:1,text:'已完成询价',answerRefs:[],resultRefs:[ref('quote_result')],updatedAt:'2026-09-30T00:00:00Z'};
  const s={bullets,reviewCards:[],questions:[question('installation')],actions:[quoteAction],narrative:{sentenceRefs:workflowNarrativeSentences(validated,input)}};
  const before=structuredClone(s),groups=recordTopics(s,bullets);
  assert.deepEqual(groups.map(g=>[g.title,g.bullets.map(b=>b.id)]),[['设备采购',ids],['行政培训',['course']]]);
  assert.deepEqual(groups[0].actions,[quoteAction]);
  assert.equal(groups[0].bullets.find(b=>b.id==='quote_result').reviewState,'accepted');
  assert.equal(s.questions[0].resolutionState,'open');
  assert.deepEqual(s,before);
});

test('a follow-up spanning two matters keeps one action and links its exact version from the other visible matter',()=>{
  const shared=action('recap',[ref('approval'),ref('date')],[{currentRef:ref('date')},{currentRef:ref('budget')}]);
  const s={bullets:['budget','approval','date','recap'].map(id=>bullet(id)),reviewCards:[],questions:[question('approval'),question('date')],actions:[shared],narrative:{sentenceRefs:[sentence('budget',procurement),sentence('approval',procurement),sentence('recap',procurement),sentence('date',training)]}};
  const before=structuredClone(s),groups=recordTopics(s,s.bullets);
  assert.deepEqual(groups.map(g=>g.title),['设备采购','行政培训']);
  assert.deepEqual(groups.flatMap(g=>g.actions),[shared]);
  assert.deepEqual(groups.find(g=>g.key==='training').relatedActionRefs,[ref('recap')]);
  assert.deepEqual(groups.find(g=>g.key==='procurement').relatedActionRefs,[]);
  assert.deepEqual(s,before);
});

test('independent purchases remain separate even when their text names the same supplier',()=>{
  const east={key:'east',title:'东区设备采购'},west={key:'west',title:'西区设备采购'};
  const s={bullets:[bullet('east_quote','供应商甲报价两万元'),bullet('west_quote','供应商甲报价两万元')],reviewCards:[],questions:[],actions:[],narrative:{sentenceRefs:[sentence('east_quote',east),sentence('west_quote',west)]}};
  assert.deepEqual(recordTopics(s,s.bullets).map(g=>g.bullets.map(b=>b.id)),[['east_quote'],['west_quote']]);
});

test('old question and basis versions cannot create an association to a replacement version',()=>{
  const s={bullets:[bullet('recap'),bullet('date'),bullet('course')],reviewCards:[],questions:[],actions:[action('recap',[ref('date')],[{currentRef:ref('date')},{currentRef:null}])],narrative:{sentenceRefs:[sentence('recap',procurement),sentence('date',training),sentence('course',training)]}};
  s.bullets[1].claimRefs=[{claimId:'date',claimVersionId:'date_v2'}];
  const groups=recordTopics(s,s.bullets);
  assert.deepEqual(groups.find(g=>g.key==='training').relatedActionRefs,[]);
  assert.deepEqual(groups.flatMap(g=>g.actions).map(a=>a.id),['recap']);
});

test('a cross-matter link does not resurrect a group hidden by the current content filter',()=>{
  const s={bullets:[bullet('recap'),bullet('date')],reviewCards:[],questions:[question('date')],actions:[action('recap',[ref('date')])],narrative:{sentenceRefs:[sentence('recap',procurement),sentence('date',training)]}};
  const groups=recordTopics(s,[s.bullets[0]]);
  assert.deepEqual(groups.map(g=>g.key),['procurement']);
  assert.deepEqual(groups.flatMap(g=>g.relatedActionRefs),[]);
  assert.deepEqual(groups.flatMap(g=>g.bullets).map(b=>b.id),['recap']);
});
