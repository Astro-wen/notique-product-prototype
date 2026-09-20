import assert from 'node:assert/strict';
import test from 'node:test';
import { sortProjects } from '../lib/domain/project-index.ts';
import { documentBytes, zipFiles, transcriptParagraphs } from '../lib/domain/project-export.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

test('sort all four fields in both directions; unknown recency stays last and input is unchanged',()=>{
 const rows=[{id:'a',name:'项目2',createdAt:'2026-01-01',updatedAt:'2026-03-01',lastOpenedAt:'2026-02-01'},{id:'b',name:'项目10',createdAt:'2026-02-01',updatedAt:'2026-01-01',lastOpenedAt:'2026-03-01'},{id:'c',name:'项目1',createdAt:'2026-03-01',updatedAt:'2026-02-01'}];
 const asc={name:['c','a','b'],createdAt:['a','b','c'],updatedAt:['b','c','a'],lastOpenedAt:['a','b','c']};
 for(const field of Object.keys(asc)){
  assert.deepEqual(sortProjects(rows,field,'asc').map(p=>p.id),asc[field]);
  assert.deepEqual(sortProjects(rows,field,'desc').map(p=>p.id),field==='lastOpenedAt'?['b','a','c']:[...asc[field]].reverse());
 }
 assert.deepEqual(rows.map(p=>p.id),['a','b','c']);
});
test('speaker/time export options preserve text and do not invent missing metadata',()=>{
 const segments=[{speaker:'买家',start_ms:60000,text:'Budget < $200,000 & fees.'},{speaker:null,start_ms:null,text:'原文保持。'}];
 assert.deepEqual(transcriptParagraphs(segments,false,false),segments.map(s=>s.text));
 assert.deepEqual(transcriptParagraphs(segments,true,true),['[0:01:00] 买家 Budget < $200,000 & fees.','说话人待确认 原文保持。']);
});
test('Word export is a valid UTF-8 ZIP package with escaped XML and complete text',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'notique-word-'));
 try {
 const path=join(dir,'export.docx');const bytes=documentBytes({title:'项目 & 客户',paragraphs:['金额 < 200000','第二段原文']},'docx');await writeFile(path,bytes);
 execFileSync('unzip',['-t',path]);
 const document=execFileSync('unzip',['-p',path,'word/document.xml'],{encoding:'utf8'});
 assert.match(document,/项目 &amp; 客户/);assert.match(document,/金额 &lt; 200000/);assert.match(document,/第二段原文/);
 const bundle=join(dir,'bundle.zip');await writeFile(bundle,zipFiles([{name:'1-中文项目/1-沟通.docx',data:bytes}]));execFileSync('unzip',['-t',bundle]);
 assert.match(execFileSync('python3',['-c','import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).namelist()[0])',bundle],{encoding:'utf8'}),/中文项目/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
