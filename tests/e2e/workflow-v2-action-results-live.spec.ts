import {expect,test} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

test('an independent followup result returns to its theme, copy and project, with correction and withdrawal',async({page,context,request},info)=>{
 test.setTimeout(90_000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const initial=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const f=await createLocalWorkflowFixture(initial.data.access.workspaceId,{withIndependentAction:true});
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/v1/jobs/dispatch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'验收使用隔离示例'},request_id:'qa'})}));
 try {
  f.seedNarrative({topics:{[f.budgetId]:{key:'budget',title:'预算'},[f.questionId]:{key:'cost',title:'费用确认'},[f.actionId]:{key:'quotes',title:'供应商询价'}}});
  const before=f.analysisEvidence();await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto(`/?project=${f.projectId}&event=${f.eventId}&view=simple`);
  await page.route('**/api/v1/evidence-refs/*',async route=>{
   const response=await route.fetch(),body=await response.json();
   if(body.data?.evidence_ref?.quote_raw?.includes('预算大约三十万'))body.data.evidence_ref.start_ms=67_250;
   await route.fulfill({response,json:body});
  });
  await page.getByTestId(`bullet-${f.budgetId}`).getByRole('button',{name:'原话',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('1:07');await page.getByRole('button',{name:'返回记录',exact:true}).click();
  const topic=page.getByTestId('topic-quotes'),action=page.getByTestId(`action-${f.actionId}`);
  await topic.getByRole('button',{name:'加入跟进',exact:true}).click();
  await action.getByRole('button',{name:'补结果',exact:true}).click();
  const form=page.getByRole('form',{name:'补充结果',exact:true});await expect(form.getByRole('textbox')).toHaveCount(1);
  await form.getByRole('textbox').fill('两家供应商的报价单已收到。');
  await form.getByRole('button',{name:'保存结果',exact:true}).click();await expect(form).toHaveCount(0);
  const snapshot=(await (await request.get(`/api/v2/events/${f.eventId}/workspace`)).json()).data;
  const resultId=snapshot.actions[0].latestOutcome.resultRefs[0].claimId,result=topic.getByTestId(`bullet-${resultId}`);
  await expect(result).toContainText('两家供应商的报价单已收到。');await expect(result).toContainText('用户补充');
  await expect(page.getByTestId(`bullet-${f.questionId}`).getByRole('button',{name:'补答案',exact:true})).toBeVisible();
  await result.getByRole('button',{name:'原话',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('两家供应商的报价单已收到。');await page.getByRole('button',{name:'返回记录',exact:true}).click();
  await page.getByRole('button',{name:'复制记录',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('两家供应商的报价单已收到。');
  await topic.screenshot({path:info.outputPath('independent-result-topic.png')});
  await result.getByRole('button',{name:'修正结果',exact:true}).click();
  const correction=page.getByRole('form',{name:'修正结果',exact:true});await correction.getByRole('textbox').fill('三家供应商的报价单已收到。');await correction.getByRole('button',{name:'保存修正',exact:true}).click();await expect(correction).toHaveCount(0);
  await expect(result).toHaveCount(0);await expect(topic).toContainText('三家供应商的报价单已收到。');
  await action.getByRole('button',{name:/^完成：/}).click();await expect(action).toContainText('已完成');
  await page.getByRole('button',{name:'整个项目',exact:true}).click();const overview=page.getByTestId('project-overview');await expect(overview.getByRole('region',{name:'项目当前重点'})).toContainText('三家供应商的报价单已收到。');await expect(overview).toContainText('1 个问题未解决');
  await page.getByRole('button',{name:'本次重点',exact:true}).click();await expect(topic).toContainText('三家供应商的报价单已收到。');await page.reload();await expect(topic).toContainText('三家供应商的报价单已收到。');
  await action.getByText('更多',{exact:true}).click();await action.getByRole('button',{name:'撤回这次结果',exact:true}).click();await page.getByRole('button',{name:'确认撤回',exact:true}).click();
  await expect(topic).not.toContainText('三家供应商的报价单已收到。');await expect(action).toContainText('已完成');await expect(page.getByTestId(`bullet-${f.questionId}`)).toContainText('费用是多少');
  await page.getByRole('button',{name:'复制记录',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).not.toContain('供应商的报价单已收到');
  expect(f.analysisEvidence().runs).toEqual(before.runs);expect(f.analysisEvidence().modelStages).toBe(before.modelStages);expect(errors).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);f.cleanup();}
});
