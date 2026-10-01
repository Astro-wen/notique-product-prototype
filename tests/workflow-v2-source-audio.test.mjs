import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function service(api) {
 const source=readFileSync(new URL('../app/features/workflow/services/workflow-service.ts',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const cjsModule={exports:{}};
 new Function('module','exports','require',compiled)(cjsModule,cjsModule.exports,name=>{
  assert.equal(name,'@/app/api-client');return {api};
 });
 return cjsModule.exports.workflowService;
}
function context(audio=null) {
 return {target:{quote_raw:'Original words'},context:{target:[{speaker:'Speaker 2'}]},asset_view_url:'/transcript-source',audio};
}
test('derived transcript source resolves its exact original audio and converts milliseconds to seconds',async()=>{
 const calls=[];
 const s=service({getEvidence:async id=>{calls.push(['ref',id]);return {quote:'Previous quote',timestampStart:86,filename:'derived.json'};},getEvidenceContext:async id=>{calls.push(['context',id]);return context({view_url:'/original-recording',start_ms:86500});}});
 const [source]=await s.sources(['evidence-budget']);
 assert.deepEqual(calls,[['ref','evidence-budget'],['context','evidence-budget']]);
 assert.equal(source.quote,'Original words');assert.equal(source.speaker,'Speaker 2');
 assert.equal(source.audioUrl,'/original-recording');assert.equal(source.audioStartSeconds,86.5);assert.equal(source.timestamp,'1:26');
});
test('independent text has no guessed audio or recording association',async()=>{
 const s=service({getEvidence:async()=>({quote:'Document text',filename:'notes.txt'}),getEvidenceContext:async()=>context()});
 const [source]=await s.sources(['independent-text']);
 assert.equal(source.audioUrl,undefined);assert.equal(source.audioStartSeconds,undefined);assert.equal(source.timestamp,'');
});
test('quote timestamp stays at the words while playback includes the preceding context',async()=>{
 const c=context({view_url:'/original-recording',start_ms:83230});c.target.start_ms=86230;
 const s=service({getEvidence:async()=>({timestampStart:86.23}),getEvidenceContext:async()=>c});
 const [source]=await s.sources(['budget']);
 assert.equal(source.timestamp,'1:26');assert.equal(source.audioStartSeconds,83.23);
});
test('source context failure reaches the drawer retry path instead of guessing another recording',async()=>{
 const denied=new Error('Source unavailable');
 const s=service({getEvidence:async()=>({quote:'Budget'}),getEvidenceContext:async()=>{throw denied;}});
 await assert.rejects(s.sources(['budget']),error=>error===denied);
});
