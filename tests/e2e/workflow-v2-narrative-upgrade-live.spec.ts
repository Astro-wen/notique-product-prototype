import {expect,test} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

test('updating a prior summary keeps the record and commissions only a narrative',async({page,request},info)=>{
  test.setTimeout(90000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const existing=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(existing.data.access.workspaceId);
  fixture.seedNarrative({promptVersion:'workflow-narrative-prompt.v1'});
  await page.route('**/api/v1/**',async route=>{
    const req=route.request();
    if(req.method()==='POST'&&/analysis|extraction|transcription|ai-artifacts|scenario|dispatch|recover/.test(new URL(req.url()).pathname)) {
      await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'验收使用已保存示例结果'},request_id:'qa'})});
    } else await route.continue();
  });
  const posted:Array<{path:string;body:{stageIds:string[]}}>=[];
  page.on('request',req=>{
    if(req.method()==='POST'&&/\/api\/v2\/.*\/(analysis|retry)$/.test(new URL(req.url()).pathname))posted.push({path:new URL(req.url()).pathname,body:req.postDataJSON()});
  });
  try {
    const before=fixture.analysisEvidence();
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const progress=page.getByRole('region',{name:'记录整理进度'});
    await expect(progress).toContainText('重点可用，可以更新全文概要');
    const refresh=progress.getByRole('button',{name:'更新全文概要',exact:true});
    await expect(refresh).toBeEnabled();
    await progress.getByText('查看整理进度',{exact:true}).click();
    await expect(progress).toContainText('可更新');
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await expect(budget).toContainText('预算大约三十万');
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('尚未保存的预算三十五万');
    await refresh.click();
    await expect(page.getByRole('alert').filter({hasText:'当前输入尚未保存'})).toBeVisible();
    await expect(page.getByLabel('修改重点')).toHaveValue('尚未保存的预算三十五万');
    expect(posted).toHaveLength(0);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    const saved=page.waitForResponse(r=>/\/api\/v2\/analysis-runs\/[^/]+\/retry$/.test(r.url()));
    await refresh.click();
    expect((await saved).status()).toBe(202);
    expect(posted).toHaveLength(1);
    expect(posted[0].path).toMatch(/\/analysis-runs\/[^/]+\/retry$/);
    expect(posted[0].body.stageIds).toHaveLength(1);
    expect(posted[0].body.stageIds[0]).toContain('narrative');
    const after=fixture.analysisEvidence();
    expect(after.runs).toEqual(before.runs);
    expect(after.modelStages).toBe(before.modelStages);
    expect(after.artifacts).toBe(before.artifacts);
    const newNarratives=after.narratives.filter((n:{id:string;payload_json:string})=>!before.narratives.some((old:{id:string})=>old.id===n.id));
    expect(newNarratives).toHaveLength(1);
    expect(JSON.parse(newNarratives[0].payload_json)).not.toHaveProperty('checkpoint');
    await expect(budget).toContainText('预算大约三十万');
    // The isolated fixture cancels paid work. Seed its saved current result
    // to exercise the terminal reading state without invoking a model.
    fixture.seedNarrative();
    await page.reload();
    await expect(progress).toContainText('整理完成');
    await expect(progress.getByRole('button',{name:'更新全文概要',exact:true})).toHaveCount(0);
    await expect(budget).toContainText('预算大约三十万');
    await page.screenshot({path:info.outputPath('narrative-upgrade.png'),fullPage:true});
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    fixture.cleanup();
  }
});
