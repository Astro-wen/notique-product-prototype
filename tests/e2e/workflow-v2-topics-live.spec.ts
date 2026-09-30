import {expect,test} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

test('one subject keeps its record, question, action and returned answer together',async({page,request},info)=>{
  test.setTimeout(90_000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const initial=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const f=await createLocalWorkflowFixture(initial.data.access.workspaceId,{withSameIntent:true,actionAttributes:{owner:'小陈',due_at:'2026-10-08'}});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/v1/jobs/dispatch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'主题验收使用隔离示例'},request_id:'qa'})}));
  try {
    f.seedNarrative({topics:{[f.budgetId]:{key:'budget',title:'改造预算'},[f.questionId]:{key:'quotes',title:'供应商报价'},[f.actionId]:{key:'quotes',title:'供应商报价'},[f.agreementId!]:{key:'quotes',title:'供应商报价'}}});
    const before=f.analysisEvidence();
    await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
    const quotes=page.getByTestId('topic-quotes');
    await expect(quotes.getByRole('heading',{name:'供应商报价',exact:true})).toBeVisible();
    await expect(quotes.getByTestId(`bullet-${f.questionId}`)).toBeVisible();
    await expect(quotes.getByRole('button',{name:'加入跟进',exact:true})).toBeVisible();
    await quotes.screenshot({path:info.outputPath('theme-before-review.png')});
    await quotes.getByRole('button',{name:'加入跟进',exact:true}).click();
    const action=quotes.getByTestId(`action-${f.actionId}`);
    await expect(action).toBeVisible();
    await action.getByRole('button',{name:/完成：/}).click();
    await expect(action).toContainText('已完成');
    await expect(quotes.getByRole('button',{name:'补答案',exact:true})).toBeVisible();
    await quotes.scrollIntoViewIfNeeded();
    await quotes.screenshot({path:info.outputPath('theme-followup.png')});
    await quotes.getByRole('button',{name:'补答案',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('供应商报价十二万元，含安装。');
    const form=page.getByRole('form',{name:'补充结果',exact:true});
    await expect(form.getByRole('textbox')).toHaveCount(1);
    await form.screenshot({path:info.outputPath('theme-direct-answer.png')});
    await form.getByRole('button',{name:'保存答案',exact:true}).click();
    await expect(quotes).toContainText('供应商报价十二万元，含安装。');
    await expect(action).toContainText('已完成');
    await expect(quotes.getByRole('button',{name:'更新答案',exact:true})).toBeVisible();
    await quotes.screenshot({path:info.outputPath('theme-returned-answer.png')});
    await page.getByTestId(`bullet-${f.budgetId}`).getByRole('button',{name:'原话',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'原话与出处',exact:true})).toContainText('预算大约三十万');
    await page.getByRole('button',{name:'返回记录',exact:true}).click();
    await page.setViewportSize({width:1920,height:1080});
    await page.getByTestId('topic-quotes').screenshot({path:info.outputPath('theme-wide-desktop.png')});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    expect(errors).toEqual([]);
    expect(f.analysisEvidence().runs).toEqual(before.runs);
    expect(f.analysisEvidence().modelStages).toBe(before.modelStages);
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});
