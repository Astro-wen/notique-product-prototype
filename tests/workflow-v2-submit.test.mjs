import assert from 'node:assert/strict';
import test from 'node:test';
import {SubmitSession} from '../app/features/workflow/services/submit-session.ts';
import {workflowDatabase,seed,insert,SCOPE,T} from './helpers/workflow-database.mjs';
import {readWorkspace} from '../lib/server/workflow/snapshot-store.ts';
import {dispatchWorkflowCommand} from '../lib/server/workflow/commands.ts';

test('lost responses preserve exact idempotency key and frozen payload while edits get a new attempt',async()=>{
  const session=new SubmitSession(),seen=[];
  const body={text:'original',expectedContextVersion:1};
  await assert.rejects(session.run('save',body,async(key,payload)=>{seen.push({key,payload});throw Error('timeout');}));
  body.text='edited';
  await session.run('save',{text:'original',expectedContextVersion:1},async(key,payload)=>{seen.push({key,payload});return 'ok';});
  assert.deepEqual(seen[0],seen[1]);assert.equal(seen[0].payload.text,'original');
  await session.run('save',body,async(key,payload)=>{seen.push({key,payload});});
  assert.notEqual(seen[2].key,seen[0].key);
});

test('serial writes never overlap and the queue continues after rejection',async()=>{
  const session=new SubmitSession(),order=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=session.run('a',{},async()=>{order.push('first');await gate;throw Error('offline');});
  const second=session.run('b',{},async()=>{order.push('second');});
  const rejected=assert.rejects(first);
  await Promise.resolve();assert.deepEqual(order,['first']);
  release();await Promise.all([rejected,second]);assert.deepEqual(order,['first','second']);
});

test('copy prepares its version after the save and its display refresh',async()=>{
  const session=new SubmitSession(),sent=[];
  let release,version=1;
  const gate=new Promise(resolve=>{release=resolve;});
  const save=session.run('save',{expectedContextVersion:1},async()=>{await gate;version=2;});
  const report=session.runLatest('report',()=>({expectedContextVersion:version}),async(key,payload)=>{sent.push(payload);return 'new record';});
  await Promise.resolve();assert.equal(sent.length,0);
  release();await save;assert.equal(await report,'new record');
  assert.deepEqual(sent,[{expectedContextVersion:2}]);
});

test('a failed pending save stops copying while the writer remains usable',async()=>{
  const session=new SubmitSession();let release,sent=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const save=session.run('save',{},async()=>{await gate;throw Error('save failed');});
  const report=session.runLatest('report',()=>({}),async()=>{sent=true;});
  const failedSave=assert.rejects(save,/save failed/),failedCopy=assert.rejects(report,/save failed/);
  release();await Promise.all([failedSave,failedCopy]);assert.equal(sent,false);
  assert.equal(await session.run('retry',{},async()=>true),true);
});

test('aborting a queued copy does not cancel saving or later submit a report',async()=>{
  const session=new SubmitSession(),controller=new AbortController();let release,saved=false,sent=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const save=session.run('save',{},async()=>{await gate;saved=true;});
  const report=session.runLatest('report',()=>({}),async()=>{sent=true;},controller.signal);
  const cancelled=assert.rejects(report,/changed record/);
  controller.abort(Error('changed record'));await cancelled;
  assert.equal(saved,false);release();await save;
  await session.run('next',{},async()=>true);assert.equal(saved,true);assert.equal(sent,false);
});

test('copy retries a lost report with the same key and the refreshed payload',async()=>{
  const session=new SubmitSession(),seen=[];
  await assert.rejects(session.runLatest('report',()=>({version:2}),async(key,payload)=>{seen.push({key,payload});throw Error('lost');}));
  await session.runLatest('report',()=>({version:2}),async(key,payload)=>{seen.push({key,payload});});
  assert.deepEqual(seen[0],seen[1]);
});

test('defer and restore preserve acceptance, are personal, and do not generate new narratives',async t=>{
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  insert(f.sqlite,'workspace_members',{id:'other-member',workspace_id:'ws',actor_id:'other',role:'editor'});
  const request={operation:'defer',expectedCardRevision:1,expectedContextVersion:0,deferUntil:null,members:[{claimId:'action',claimVersionId:'action_v1',operation:'defer'}]};
  const saved=await dispatchWorkflowCommand(f.db,SCOPE,['review-cards','wfc_action','decisions'],request,'defer');
  assert.equal(saved.contextVersion,0);assert.equal(saved.refreshState,'current');
  let own=await readWorkspace(f.db,SCOPE,'e',{},T);
  assert.equal(own.reviewCards.find(c=>c.id==='wfc_action').disposition,'deferred');
  assert.equal(own.counts.needsDecisionCount,0);assert.equal(own.counts.draftCount,3);
  const other=await readWorkspace(f.db,{...SCOPE,actorId:'other'},'e',{},T);
  assert.equal(other.reviewCards.find(c=>c.id==='wfc_action').disposition,'active');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_outbox').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM verdicts').get().n,0);
  await dispatchWorkflowCommand(f.db,SCOPE,['review-cards','wfc_action','decisions'],{...request,operation:'restore',expectedCardRevision:2,deferUntil:undefined,members:[{...request.members[0],operation:'restore'}]},'restore');
  own=await readWorkspace(f.db,SCOPE,'e',{},T);
  assert.equal(own.counts.needsDecisionCount,1);
  assert.deepEqual(await dispatchWorkflowCommand(f.db,SCOPE,['review-cards','wfc_action','decisions'],request,'defer'),saved);
});

test('snapshot capabilities reflect trusted membership and downgrade independently of business versions',async t=>{
  const f=await workflowDatabase();t.after(f.close);seed(f.sqlite);
  const first=await readWorkspace(f.db,SCOPE,'e',{},T);assert.equal(first.access.canEdit,true);
  f.sqlite.prepare("UPDATE workspace_members SET role='viewer'").run();
  const second=await readWorkspace(f.db,SCOPE,'e',{},T);assert.equal(second.access.canEdit,false);
  assert.equal(second.contextVersion,first.contextVersion);assert.notEqual(second.snapshotId,first.snapshotId);
});
