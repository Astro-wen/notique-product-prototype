import {expect,test,type APIRequestContext} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

async function fixtureFor(request:APIRequestContext) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(current.data.access.workspaceId,{withActionOverlap:true});
}
const snap=async(request:APIRequestContext,eventId:string)=>(await (await request.get(`/api/v2/events/${eventId}/workspace`)).json()).data;

for(const preferred of ['manual','model'] as const)test(`similar human and model actions have one choice and ${preferred} selection can be undone`,async({page,request},info)=>{
  const f=await fixtureFor(request);
  try {
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await expect(page.getByRole('button',{name:'复制记录',exact:true})).toBeVisible();
    const rows=page.locator(`[data-review-card="${f.actionOverlapCardId}"]`);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('用户补充');
    await expect(page.getByRole('button',{name:'核对两种行动',exact:true})).toHaveCount(1);
    await expect(page.getByRole('button',{name:'加入跟进',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'核对两种行动',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog.getByTestId(`member-${f.manualActionId}`)).toContainText('我的行动');
    await expect(dialog.getByTestId(`member-${f.actionId}`)).toContainText('AI 建议');
    await dialog.getByRole('button',{name:preferred==='manual'?'保留我的行动':'采用 AI 建议',exact:true}).click();
    const save=dialog.getByRole('button',{name:'保存本次选择',exact:true});
    const box=await save.boundingBox();
    expect(box!.y+box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({path:info.outputPath(`choose-${preferred}.png`),fullPage:false});
    await save.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button',{name:/^完成：/})).toHaveCount(1);
    let current=await snap(request,f.eventId);
    expect(current.actions.map((a:{id:string})=>a.id)).toEqual([preferred==='manual'?f.manualActionId:f.actionId]);
    expect(current.counts.needsDecisionCount).toBe(0);
    const group=current.reviewCards.find((c:{id:string})=>c.id===f.actionOverlapCardId);
    expect(group.members.map((m:{reviewState:string})=>m.reviewState)).toEqual(preferred==='manual'?['accepted','rejected']:['rejected','accepted']);
    await page.reload();
    await expect(page.getByRole('button',{name:/^完成：/})).toHaveCount(1);
    await page.getByRole('button',{name:'撤销上次处理',exact:true}).click();
    await expect(page.getByRole('button',{name:'核对两种行动',exact:true})).toHaveCount(1);
    await expect(rows).toHaveCount(1);
    current=await snap(request,f.eventId);
    expect(current.actions).toHaveLength(0);
    expect(current.counts.needsDecisionCount).toBe(1);
    expect(current.reviewCards.find((c:{id:string})=>c.id===f.actionOverlapCardId).members.every((m:{reviewState:string})=>m.reviewState==='draft')).toBe(true);
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    f.cleanup();
  }
});

test('partial action selection stays reviewable and can be deferred without losing the accepted action',async({page,request})=>{
  const f=await fixtureFor(request);
  try {
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await page.getByRole('button',{name:'核对两种行动',exact:true}).click();
    await page.getByLabel('第2条处理方式',{exact:true}).selectOption('accept_action');
    await page.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await snap(request,f.eventId)).counts.needsDecisionCount).toBe(1);
    await page.getByRole('button',{name:'已采纳',exact:true}).click();
    await expect(page.getByTestId(`bullet-${f.actionId}`)).toBeVisible();
    await page.getByRole('button',{name:'全部',exact:true}).click();
    const row=page.locator(`[data-review-card="${f.actionOverlapCardId}"]`);
    await expect(row).toHaveCount(1);
    await row.getByRole('button',{name:'稍后处理',exact:true}).click();
    await expect(row.getByRole('button',{name:'恢复处理',exact:true})).toBeVisible();
    expect((await snap(request,f.eventId)).counts.needsDecisionCount).toBe(0);
    await row.getByRole('button',{name:'恢复处理',exact:true}).click();
    await expect(row.getByRole('button',{name:'稍后处理',exact:true})).toBeVisible();
    expect((await snap(request,f.eventId)).counts.needsDecisionCount).toBe(1);
    await row.getByRole('button',{name:'核对两种行动',exact:true}).click();
    await page.getByLabel('第1条处理方式',{exact:true}).selectOption('reject');
    await page.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const current=await snap(request,f.eventId);
    expect(current.actions.map((a:{id:string})=>a.id)).toEqual([f.actionId]);
    expect(current.counts.needsDecisionCount).toBe(0);
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    f.cleanup();
  }
});
