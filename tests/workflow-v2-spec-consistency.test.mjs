import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const contract=JSON.parse(await readFile(new URL('../docs/WORKFLOW_V2_CONTRACT.json',import.meta.url),'utf8'));
const cells=line=>line.slice(1,-1).split('|').map(cell=>cell.trim());
for(const name of ['FRONTEND_TECHNICAL_PLAN','BACKEND_TECHNICAL_PLAN']){
 test(`${name} preserves the reference chapters and exact shared contract tables`,async()=>{
  const text=await readFile(new URL(`../docs/${name}.md`,import.meta.url),'utf8');
  assert.equal(text.split('\n').filter(line=>line.startsWith('## ')).length,10);
  const lines=text.split('\n'),start=lines.indexOf('| 类型 | 关键字段 | 规则 |');
  assert.ok(start>=0);
  const rows=[];for(let i=start+2;lines[i]?.startsWith('|');i++)rows.push(cells(lines[i]));
  assert.deepEqual(rows,contract.types.map(type=>[type.name,type.fields,type.rules]));
  const section=text.slice(text.indexOf('### 6.2'),text.indexOf('#### 共同数据类型'));
  const endpoints=section.split('\n').filter(line=>line.startsWith('| ') && !line.startsWith('| 用户操作') && !line.startsWith('| ---')).map(cells);
  assert.deepEqual(endpoints,contract.endpoints.map(endpoint=>['operation','service','method','path','requestType','responseType'].map(key=>endpoint[key])));
 });
}
