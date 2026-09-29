import { expect, test } from '@playwright/test';
import { createLocalWorkflowFixture } from '../helpers/local-workflow-fixture.mjs';

test('a quick edit waits for the preceding action save and opens on the new version', async ({page,request},info) => {
  test.setTimeout(90_000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const existing=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(existing.data.access.workspaceId,{withBudgetBasis:true});
  let releaseRefresh:()=>void=()=>{};
  let refreshStarted:()=>void=()=>{};
  const holdRefresh=new Promise<void>((resolve)=>{releaseRefresh=resolve;});
  const refreshing=new Promise<void>((resolve)=>{refreshStarted=resolve;});
  const conflicts:string[]=[];
  page.on('response',(response)=>{if(response.status()===409 && response.url().includes('/api/v2/')) conflicts.push(response.url());});
  try {
    await page.route(`**/api/v2/events/${fixture.eventId}/workspace?*`,async(route)=>{
      if(new URL(route.request().url()).searchParams.get('minContextVersion')==='2') {
        refreshStarted();await holdRefresh;
      }
      await route.continue();
    });
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await page.getByRole('button',{name:'加入跟进',exact:true}).click();
    await expect(page.getByRole('button',{name:/^完成：/})).toBeVisible();
    await page.getByRole('button',{name:/^完成：/}).click();
    await refreshing;
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await expect(budget.getByRole('status')).toHaveText('正在更新记录，完成后会打开修改。');
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('edit-waits-for-save.png')});
    releaseRefresh();
    await expect(page.getByLabel('修改重点')).toBeVisible();
    await page.getByLabel('修改重点').fill('预算三十五万元，包含安装。');
    await page.getByLabel('修改依据').selectOption('user_input');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(budget).toContainText('预算三十五万元，包含安装。');
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    expect(conflicts).toEqual([]);
  } finally {
    releaseRefresh();
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    fixture.cleanup();
  }
});

test('a failed preceding save releases the queued edit with a visible error', async ({page,request}) => {
  test.setTimeout(90_000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const existing=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(existing.data.access.workspaceId,{withBudgetBasis:true});
  let releaseSave:()=>void=()=>{};
  let saveStarted:()=>void=()=>{};
  const holdSave=new Promise<void>((resolve)=>{releaseSave=resolve;});
  const saving=new Promise<void>((resolve)=>{saveStarted=resolve;});
  try {
    await page.route(`**/api/v2/actions/${fixture.actionId}/transitions`,async(route)=>{
      saveStarted();await holdSave;
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'save_unavailable',message:'暂时无法保存行动，请重试。'},request_id:'synthetic-race'})});
    });
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await page.getByRole('button',{name:'加入跟进',exact:true}).click();
    await expect(page.getByRole('button',{name:/^完成：/})).toBeVisible();
    await page.getByRole('button',{name:/^完成：/}).click();
    await saving;
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await expect(budget.getByRole('status')).toHaveText('正在更新记录，完成后会打开修改。');
    releaseSave();
    await expect(page.getByRole('alert')).toContainText('暂时无法保存行动');
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toBeVisible();
  } finally {
    releaseSave();
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    fixture.cleanup();
  }
});
