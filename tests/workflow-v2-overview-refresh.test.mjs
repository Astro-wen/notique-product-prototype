import test from 'node:test';
import assert from 'node:assert/strict';
import {projectOverviewPollInterval} from '../lib/domain/overview-refresh.ts';
test('overview discovers another tab task and completion without relying on an old shell Run',()=>{
 const snapshot=complete=>({recordSummaries:[{coverage:{complete},narrative:{freshness:'current'}}]});
 assert.equal(projectOverviewPollInterval(snapshot(false),false,false),3000);
 assert.equal(projectOverviewPollInterval(snapshot(true),false,false),30_000);
 assert.equal(projectOverviewPollInterval(snapshot(true),true,false),3000);
 assert.equal(projectOverviewPollInterval({recordSummaries:[{coverage:{complete:true},narrative:{freshness:'updating'}}]},false,false),3000);
 assert.equal(projectOverviewPollInterval(snapshot(false),true,true),false);
});
