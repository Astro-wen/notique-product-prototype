import {expect,test,type APIRequestContext} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

async function fixtureFor(request:APIRequestContext) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(current.data.access.workspaceId,{priorityCount:2,actionAttributes:{owner:'小陈',due_at:'2026-10-02'}});
}
const workspace=async(request:APIRequestContext,eventId:string)=>(await (await request.get(`/api/v2/events/${eventId}/workspace`)).json()).data;

test.beforeEach(async({page})=>{
  await page.route('**/api/v1/jobs/dispatch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'易用性验收只使用隔离示例的已保存结果'},request_id:'qa'})}));
});

test('follow-up stays reachable from a long record and a project, with one answer field and independent completion',async({page,request},info)=>{
  test.setTimeout(90_000);
  const f=await fixtureFor(request);
  try {
    const before=f.analysisEvidence();
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await expect(page.getByRole('navigation',{name:'项目列表',exact:true}).getByLabel(/条待确认/)).toHaveCount(0);
    const bullet=page.getByTestId(`bullet-${f.actionId}`);
    await bullet.getByRole('button',{name:'加入跟进',exact:true}).click();
    const followup=page.getByTestId(`action-${f.actionId}`);
    await expect(bullet.getByRole('button',{name:'查看跟进',exact:true})).toBeVisible();
    await bullet.getByRole('button',{name:'查看跟进',exact:true}).click();
    await expect(followup).toBeFocused();
    await expect(followup).toContainText('负责人：小陈');
    await expect(followup).toContainText('期限：2026/10/2');
    const top=await page.getByRole('button',{name:'查看跟进事项',exact:true}).boundingBox();
    expect(top!.y).toBeGreaterThanOrEqual(0);expect(top!.y+top!.height).toBeLessThan(page.viewportSize()!.height);
    await followup.getByRole('button',{name:'补结果',exact:true}).click();
    const form=page.getByRole('form',{name:'补充结果',exact:true});
    await expect(form.getByRole('textbox')).toHaveCount(1);
    await page.getByLabel('补充答案',{exact:true}).fill('报价十二万元，含安装。');
    await expect(page.getByLabel('同时标记行动完成',{exact:true})).not.toBeChecked();
    await form.screenshot({path:info.outputPath('one-field-result.png')});
    await form.getByRole('button',{name:'保存结果',exact:true}).click();
    const saved=await workspace(request,f.eventId);
    expect(saved.actions[0].executionState).toBe('open');
    expect(saved.questions[0].resolutionState).toBe('resolved');
    expect(saved.bullets.some((b:{text:string})=>b.text==='报价十二万元，含安装。')).toBe(true);
    await page.getByRole('button',{name:/整个项目/}).click();
    const overview=page.getByTestId('project-overview');
    await expect(overview).toContainText('报价十二万元，含安装。');
    await expect(overview).toContainText('负责人：小陈');
    await overview.getByRole('button',{name:/继续跟进/}).click();
    await expect(followup).toBeFocused();
    await expect(followup.getByRole('button',{name:'补结果',exact:true})).toBeInViewport();
    await followup.screenshot({path:info.outputPath('project-returns-to-followup.png')});
    await page.getByRole('button',{name:'查看跟进事项',exact:true}).click();
    await expect(followup).toBeFocused();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    expect(f.analysisEvidence().runs).toEqual(before.runs);
    expect(f.analysisEvidence().modelStages).toBe(before.modelStages);
  }finally{await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});

test('filtering cannot hide unsaved input and an optional personal note reappears when correcting the result',async({page,request},info)=>{
  test.setTimeout(90_000);
  const f=await fixtureFor(request);
  try {
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    const budget=page.getByTestId(`bullet-${f.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算大约三十五万。');
    await page.getByRole('button',{name:'需要拍板 3',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toBeVisible();
    await expect(page.getByLabel('修改重点')).toHaveValue('预算大约三十五万。');
    await expect(page.getByRole('alert')).toContainText('先保存或取消');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await page.getByTestId(`bullet-${f.actionId}`).getByRole('button',{name:'加入跟进',exact:true}).click();
    const followup=page.getByTestId(`action-${f.actionId}`);
    await followup.getByRole('button',{name:'补结果',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('报价十二万元。');
    await page.getByRole('button',{name:'添加补充说明',exact:true}).click();
    await page.getByLabel('补充说明，可留空',{exact:true}).fill('已收到书面报价。');
    await page.getByLabel('同时标记行动完成',{exact:true}).check();
    await page.getByRole('button',{name:'保存结果',exact:true}).click();
    const saved=await workspace(request,f.eventId);
    expect(saved.actions[0].executionState).toBe('completed');
    expect(saved.actions[0].latestOutcome.text).toBe('已收到书面报价。');
    expect(saved.questions[0].resolutionState).toBe('resolved');
    await followup.getByText('结果操作',{exact:true}).click();
    await followup.getByRole('button',{name:'修正结果',exact:true}).click();
    await expect(page.getByLabel('补充说明，可留空',{exact:true})).toHaveValue('已收到书面报价。');
    await page.getByRole('form',{name:'修正结果',exact:true}).screenshot({path:info.outputPath('optional-note-preserved.png')});
    await page.getByRole('button',{name:'取消',exact:true}).click();
  }finally{await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});

test('a blocked clipboard offers the usable draft instead of reporting a successful copy',async({page,request})=>{
  const f=await fixtureFor(request);
  try {
    await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('clipboard unavailable');}},configurable:true}));
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'复制记录',exact:true})).toBeVisible();
    await expect(page.getByLabel('可复制的记录')).toContainText('预算大约三十万');
    await expect(page.getByRole('status').filter({hasText:'请在窗口中复制'})).toBeVisible();
    await expect(page.getByText('已复制记录，草稿与已采纳内容均带标识。',{exact:true})).toHaveCount(0);
    const saved=await workspace(request,f.eventId);
    expect(saved.bullets.every((b:{reviewState:string})=>b.reviewState==='draft')).toBe(true);
    expect(saved.actions).toHaveLength(0);
  }finally{await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});

test('a slow saved response holds the next decision while source reading stays available',async({page,request})=>{
  const f=await fixtureFor(request);
  let release:()=>void=()=>undefined,received:()=>void=()=>undefined;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const reached=new Promise<void>(resolve=>{received=resolve;});
  try {
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    const budget=page.getByTestId(`bullet-${f.budgetId}`),action=page.getByTestId(`bullet-${f.actionId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算大约三十五万元。');
    let captured=false;
    await page.route('**/api/v2/review-cards/*/decisions',async route=>{
      if(!captured && route.request().postDataJSON()?.operation==='edit') {
        captured=true;const saved=await route.fetch();received();await held;await route.fulfill({response:saved});
      }else await route.continue();
    });
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await reached;
    await expect(action.getByRole('button',{name:'加入跟进',exact:true})).toBeDisabled();
    await expect(action.getByRole('button',{name:'原话',exact:true})).toBeEnabled();
    await action.getByRole('button',{name:'原话',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('向供应商询价');
    await page.getByRole('button',{name:'返回记录',exact:true}).click();
    release();
    await expect(action.getByRole('button',{name:'加入跟进',exact:true})).toBeEnabled();
    await expect(budget).toContainText('预算大约三十五万元。');
    await action.getByRole('button',{name:'加入跟进',exact:true}).click();
    await expect(page.getByTestId(`action-${f.actionId}`)).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const saved=await workspace(request,f.eventId);
    expect(saved.actions).toHaveLength(1);
    expect(saved.recentDecisions.filter((d:{operation:string})=>d.operation==='edit')).toHaveLength(1);
  }finally{release();await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});
