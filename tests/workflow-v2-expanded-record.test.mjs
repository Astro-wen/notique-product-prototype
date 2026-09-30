import assert from 'node:assert/strict';
import test from 'node:test';
import {workflowDatabase,seed,claim,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {createReport} from '../lib/server/workflow/report-service.ts';

test('a 64-point record remains complete across review pagination and mixed export without model work',async t=>{
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  for(let i=1;i<=61;i++)claim(f.sqlite,`expanded-${i}`,'fact',`采购验收事项 ${String(i).padStart(2,'0')} 已记录`);
  const first=await readWorkspace(f.db,SCOPE,'e',{limit:50},T);
  assert.equal(first.bullets.length,64);assert.equal(first.reviewCards.length,50);assert.ok(first.nextCursor);
  const next=await readWorkspace(f.db,SCOPE,'e',{limit:50,snapshotId:first.snapshotId,cursor:first.nextCursor},T);
  assert.equal(next.reviewCards.length,14);assert.equal(next.nextCursor,null);
  assert.equal(new Set([...first.reviewCards,...next.reviewCards].map(c=>c.id)).size,64);
  assert.deepEqual(next.bullets,first.bullets);assert.equal(first.counts.draftCount,64);
  const report=await createReport(f.db,SCOPE,{projectId:'p',key:'expanded-export',request:{expectedContextVersion:0,scope:'mixed',eventIds:['e'],format:'plain_text'}});
  for(let i=1;i<=61;i++)assert.equal(report.content.split(`采购验收事项 ${String(i).padStart(2,'0')} 已记录`).length-1,1);
  const saved=JSON.parse(f.sqlite.prepare('SELECT snapshot_json FROM workflow_reports WHERE id=?').get(report.id).snapshot_json);
  assert.equal(saved.records[0].bulletRefs.length,64);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workflow_outbox').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT context_version FROM projects').get().context_version,0);
});
