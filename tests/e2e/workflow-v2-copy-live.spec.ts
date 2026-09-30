import {expect,test,type APIRequestContext} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

async function fixtureFor(request:APIRequestContext) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(current.data.access.workspaceId);
}
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw Error('clipboard unavailable');}},configurable:true}));
  await page.route('**/api/v1/jobs/dispatch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'复制验收使用已保存的合成结果'},request_id:'copy-qa'})}));
});

for(const timeout of [false,true])test(timeout?'a copy timeout preserves the pending save and never exports later':'one copy waits for the save and display refresh, then exports the new version',async({page,request},info)=>{
  test.setTimeout(90_000);
  const f=await fixtureFor(request);let release:()=>void=()=>{},reached:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;}),refreshing=new Promise<void>(resolve=>{reached=resolve;});
  const reports:Array<{expectedContextVersion:number}>=[];
  try {
    page.on('request',r=>{if(r.url().endsWith(`/api/v2/projects/${f.projectId}/reports`))reports.push(r.postDataJSON());});
    await page.route(`**/api/v2/events/${f.eventId}/workspace?*`,async route=>{
      if(new URL(route.request().url()).searchParams.get('minContextVersion')==='1'){reached();await gate;}
      await route.continue();
    });
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    const budget=page.getByTestId(`bullet-${f.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算三十五万元，包含安装。');
    await page.getByLabel('修改依据').selectOption('user_input');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();await refreshing;
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect(page.getByRole('button',{name:'正在同步记录',exact:true})).toBeVisible();
    expect(reports).toEqual([]);
    if(timeout){
      await expect(page.getByRole('alert')).toContainText('同步超过15秒',{timeout:20_000});
      await expect(page.getByLabel('修改重点')).toHaveValue('预算三十五万元，包含安装。');
      release();await expect(page.getByLabel('修改重点')).toHaveCount(0);
      await expect(budget).toContainText('预算三十五万元，包含安装。');
      expect(reports).toEqual([]);await expect(page.getByRole('dialog')).toHaveCount(0);
    }else{
      await page.screenshot({path:info.outputPath('copy-waits-for-save.png')});
      release();await expect(page.getByLabel('可复制的记录')).toContainText('预算三十五万元，包含安装。');
      await expect(page.getByLabel('可复制的记录')).not.toContainText('预算大约三十万');
      expect(reports).toHaveLength(1);expect(reports[0].expectedContextVersion).toBe(1);
      await page.screenshot({path:info.outputPath('copy-new-version.png')});
    }
  }finally{release();await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});

test('a failed save cancels its waiting copy and keeps the input',async({page,request})=>{
  const f=await fixtureFor(request);let release:()=>void=()=>{},reached:()=>void=()=>{},reports=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),saving=new Promise<void>(resolve=>{reached=resolve;});
  try{
    page.on('request',r=>{if(r.url().endsWith(`/api/v2/projects/${f.projectId}/reports`))reports++;});
    await page.route(`**/api/v2/review-cards/wfc_${f.budgetId}/decisions`,async route=>{reached();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'save_unavailable',message:'暂时无法保存，请重试。'},request_id:'copy-qa'})});});
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await page.getByTestId(`bullet-${f.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算三十五万元。');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();await saving;
    await page.getByRole('button',{name:'复制记录',exact:true}).click();release();
    await expect(page.getByRole('alert')).toContainText('暂时无法保存');
    await expect(page.getByLabel('修改重点')).toHaveValue('预算三十五万元。');
    expect(reports).toBe(0);await expect(page.getByRole('dialog')).toHaveCount(0);
  }finally{release();await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});

test('an external change refreshes the record and asks for a new copy',async({page,request})=>{
  const f=await fixtureFor(request);
  try{
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await expect(page.getByTestId(`bullet-${f.budgetId}`)).toBeVisible();
    const current=(await(await request.get(`/api/v2/events/${f.eventId}/workspace`)).json()).data;
    const card=current.reviewCards.find((c:{memberRefs:Array<{claimId:string}>})=>c.memberRefs.some(r=>r.claimId===f.budgetId));
    const saved=await request.post(`/api/v2/review-cards/${card.id}/decisions`,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedContextVersion:current.contextVersion,expectedCardRevision:card.revision,operation:'edit',members:[{...card.memberRefs[0],operation:'edit',newText:'外部更新：预算四十万元。',origin:'user_input',evidenceRefIds:[]}]}});
    expect(saved.ok()).toBe(true);
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('记录已有更新');
    await expect(page.getByTestId(`bullet-${f.budgetId}`)).toContainText('外部更新：预算四十万元。');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect(page.getByLabel('可复制的记录')).toContainText('外部更新：预算四十万元。');
  }finally{await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});
