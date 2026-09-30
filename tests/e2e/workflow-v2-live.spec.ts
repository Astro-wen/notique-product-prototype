import {expect,test} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

test.beforeEach(async({page})=>{
  // The test exercises saved synthetic extraction, never a paid model run.
  await page.route('**/api/v1/**',async route=>{
    const req=route.request();
    if(req.method()==='POST' && /analysis|extraction|transcription|ai-artifacts|scenario|dispatch|recover/.test(new URL(req.url()).pathname)) {
      await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'验收使用已保存示例结果'},request_id:'qa'})});return;
    }
    await route.continue();
  });
});

test('actual record: copy, correct, reload, follow up, answer, correct result and withdraw',async({page,context,request},info)=>{
  test.setTimeout(90000);
  // Discover the trusted local scope through an existing read, without editing it.
  const projects=await (await request.get('/api/v1/projects')).json();
  const project=projects.data.projects[0];
  const events=await (await request.get(`/api/v1/projects/${project.id}/events`)).json();
  const event=events.data.events[0];
  const existing=await (await request.get(`/api/v2/events/${event.id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(existing.data.access.workspaceId);
  const writes:string[]=[];
  page.on('request',req=>{if(req.method()==='POST')writes.push(new URL(req.url()).pathname);});
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    const url=`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`;
    await page.goto(url);
    await expect(page.getByRole('button',{name:'复制记录',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('预算大约三十万');
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await budget.getByRole('button',{name:'原话',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('预算大约三十万');
    await page.getByRole('button',{name:'返回记录',exact:true}).click();
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算大约三十五万元，先确定硬装。');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(budget).toContainText('预算大约三十五万元');
    await expect(budget).toContainText('已采纳');
    await page.reload();
    await expect(budget).toContainText('预算大约三十五万元');
    await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toContainText('AI 草稿');
    await page.screenshot({path:info.outputPath('record-persisted.png'),fullPage:true});
    await page.getByRole('button',{name:'加入跟进',exact:true}).click();
    await page.getByRole('button',{name:/^完成：/}).click();
    await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
    await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toContainText('费用是多少');
    await page.getByRole('button',{name:'补结果',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('报价十二万元，包含安装。');
    await page.getByRole('button',{name:'保存结果',exact:true}).click();
    await expect(page.getByText('报价十二万元，包含安装。',{exact:true}).first()).toBeVisible();
    await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('报价十二万元，包含安装。',{exact:true}).first()).toBeVisible();
    await page.getByText('结果操作',{exact:true}).click();
    await page.getByRole('button',{name:'修正结果',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('报价十三万元，包含安装和运输。');
    await page.getByRole('button',{name:'保存修正',exact:true}).click();
    await expect(page.getByText('报价十三万元，包含安装和运输。',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('报价十二万元，包含安装。',{exact:true})).toHaveCount(0);
    const actionTitle=await page.getByTestId(`action-${fixture.actionId}`).getByText('向供应商询价',{exact:true}).boundingBox();
    expect(actionTitle!.width).toBeGreaterThan(180);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:info.outputPath('record-result.png'),fullPage:true});
    await page.getByRole('button',{name:'撤回答案',exact:true}).click();
    await page.getByRole('button',{name:'确认撤回',exact:true}).click();
    await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toContainText('费用是多少');
    await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('费用是多少');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    expect(writes.filter(path=>path.startsWith('/api/v2/')).length).toBeGreaterThan(5);
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('lost response, concurrent correction, direct answers and coexistence keep user input and meaning',async({page,context,request},info)=>{
  test.setTimeout(90000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId);
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算大约三十五万元。');
    await page.getByRole('button',{name:'材料',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toHaveValue('预算大约三十五万元。');
    const attempts:Array<{key:string|null;body:string|null}>=[];
    let lose=true;
    await page.route('**/api/v2/review-cards/*/decisions',async route=>{
      attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
      if(lose) {lose=false;await route.fetch();await route.abort('failed');return;}
      await route.continue();
    });
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('修改重点')).toHaveValue('预算大约三十五万元。');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    expect(attempts[0]).toEqual(attempts[1]);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('我的修改：预算大约三十六万元。');
    const current=(await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json()).data;
    const card=current.reviewCards.find((c:{id:string})=>c.id===`wfc_${fixture.budgetId}`);
    const response=await request.post(`/api/v2/review-cards/${card.id}/decisions`,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{operation:'edit',expectedContextVersion:current.contextVersion,expectedCardRevision:card.revision,members:[{...card.memberRefs[0],operation:'edit',newText:'另一处更新：预算大约三十七万元。',origin:'user_input',evidenceRefIds:[]}]}});
    expect(response.ok()).toBe(true);
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toHaveValue('我的修改：预算大约三十六万元。');
    await expect(page.getByText(/当前内容：另一处更新/)).toBeVisible();
    await page.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    await expect(budget).toContainText('我的修改：预算大约三十六万元。');
    await page.getByRole('button',{name:'补答案',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('标准方案十二万元。');
    await page.getByRole('button',{name:'保存答案',exact:true}).click();
    await page.getByRole('button',{name:'更新答案',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('加急方案十五万元。');
    await page.getByLabel('两个答案分别适用').check();
    await page.getByLabel('适用情况').fill('原答案用于标准交付，新答案用于加急交付。');
    await page.getByRole('button',{name:'保存答案',exact:true}).click();
    await expect(page.getByLabel('补充答案',{exact:true})).toHaveCount(0);
    await expect(page.getByText('标准方案十二万元。',{exact:true})).toBeVisible();
    await expect(page.getByText('加急方案十五万元。',{exact:true})).toBeVisible();
    await expect(page.getByText(/适用情况：原答案用于标准交付/)).toBeVisible();
    await expect(page.getByRole('button',{name:'更新答案',exact:true})).toHaveCount(1);
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('新答案用于加急交付');
    await page.screenshot({path:info.outputPath('record-coexisting-answers.png'),fullPage:true});
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('changed basis can be reviewed and retained while completed action edits preserve history',async({page,request},info)=>{
  test.setTimeout(90000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{withBudgetBasis:true});
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await page.getByRole('button',{name:'加入跟进',exact:true}).click();
    await page.getByRole('button',{name:/^完成：/}).click();
    await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('预算三十五万元，包含安装。');
    await page.getByLabel('修改依据').selectOption('user_input');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
    await expect(page.getByRole('button',{name:'需要拍板 1',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'核对依据',exact:true}).last().click();
    const dialog=page.getByRole('dialog');
    await expect(dialog).toContainText('预算大约三十万');
    await expect(dialog).toContainText('预算三十五万元，包含安装。');
    await page.screenshot({path:info.outputPath('action-basis-review.png'),fullPage:true});
    await dialog.getByRole('button',{name:'按当前依据保留行动',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button',{name:'核对依据',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
    await page.getByText('行动操作',{exact:true}).click();
    await page.getByRole('button',{name:'调整行动',exact:true}).click();
    await page.getByLabel('修改重点').fill('向供应商核实包含安装和运输的报价');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'重开：向供应商核实包含安装和运输的报价',exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button',{name:'重开：向供应商核实包含安装和运输的报价',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'重开：向供应商核实包含安装和运输的报价',exact:true}).click();
    await expect(page.getByRole('button',{name:'完成：向供应商核实包含安装和运输的报价',exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('action-adjusted.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('conflict choices update the record, expose source and coexistence, and undo restores the decision',async({page,context,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{withConflict:true});
 try {
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  const candidate=page.getByTestId(`bullet-${fixture.newBudgetId}`),existing=page.getByTestId(`bullet-${fixture.budgetId}`);
  const conflictTrigger=candidate.getByRole('button',{name:'核对新旧信息',exact:true});
  await conflictTrigger.focus();await conflictTrigger.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');await expect(conflictTrigger).toBeFocused();
  await conflictTrigger.press('Enter');
  await page.getByRole('button',{name:'查看原信息出处',exact:true}).click();
  await expect(page.getByRole('dialog').last()).toContainText('预算大约三十万');
  await page.getByRole('button',{name:'返回记录',exact:true}).click();
  await page.getByRole('radio',{name:/两条信息分别适用/}).check();
  await page.getByLabel('适用情况',{exact:true}).fill('原预算用于一期，新预算用于二期。');
  await page.screenshot({path:info.outputPath('conflict-choice.png'),fullPage:true});
  if(info.project.name==='desktop-chromium') {
   const viewport=page.viewportSize()!;
   await page.setViewportSize({width:1920,height:1080});
   await expect(page.getByRole('button',{name:'保存选择',exact:true})).toBeInViewport();
   await page.screenshot({path:info.outputPath('conflict-wide-1920.png')});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
   await page.setViewportSize(viewport);
  }
  await page.getByRole('button',{name:'保存选择',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(existing).toContainText('适用情况：原预算用于一期');
  await expect(candidate).toContainText('适用情况：原预算用于一期');
  await page.getByRole('button',{name:'复制记录',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('新预算用于二期');
  await page.getByText('最近处理',{exact:true}).click();
  await page.getByRole('button',{name:'撤销',exact:true}).first().click();
  await expect(candidate.getByRole('button',{name:'核对新旧信息',exact:true})).toBeVisible();
  await expect(candidate).not.toContainText('适用情况');
  await candidate.getByRole('button',{name:'核对新旧信息',exact:true}).click();
  await page.getByRole('radio',{name:/采用新信息/}).check();
  await page.getByRole('button',{name:'保存选择',exact:true}).click();
  await expect(existing).toHaveCount(0);
  await expect(candidate).toContainText('已采纳');
  await page.reload();
  await expect(existing).toHaveCount(0);
  await page.getByText('最近处理',{exact:true}).click();
  await page.getByRole('button',{name:'撤销',exact:true}).first().click();
  await expect(existing).toContainText('预算大约三十万');
  await candidate.getByRole('button',{name:'核对新旧信息',exact:true}).click();
  await page.getByRole('radio',{name:/保留原信息/}).check();
  await page.getByRole('button',{name:'保存选择',exact:true}).click();
  await expect(candidate).toHaveCount(0);
  await page.getByRole('button',{name:'撤销',exact:true}).first().click();
  await expect(candidate).toContainText('AI 草稿');
  await page.screenshot({path:info.outputPath('conflict-restored.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('chosen new information flows into an existing completed action for explicit basis review',async({page,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{withConflict:true,withBudgetBasis:true});
 try {
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  await page.getByRole('button',{name:'加入跟进',exact:true}).click();
  await page.getByRole('button',{name:/^完成：/}).click();
  await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
  await page.getByTestId(`bullet-${fixture.newBudgetId}`).getByRole('button',{name:'核对新旧信息',exact:true}).click();
  await page.getByRole('radio',{name:/采用新信息/}).check();
  await page.getByRole('button',{name:'保存选择',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button',{name:'需要拍板 1',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'核对依据',exact:true}).last().click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('预算大约三十万');
  await expect(dialog).toContainText('预算更新为三十五万');
  await expect(dialog.getByRole('button',{name:'按当前依据保留行动',exact:true})).toBeEnabled();
  await page.screenshot({path:info.outputPath('replacement-action-basis.png'),fullPage:true});
  await dialog.getByRole('button',{name:'按当前依据保留行动',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
  await expect(page.getByRole('button',{name:'核对依据',exact:true})).toHaveCount(0);
  await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toHaveCount(0);
  await expect(page.getByTestId(`bullet-${fixture.newBudgetId}`)).toContainText('已采纳');
  const current=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();
  expect(current.data.actions[0].basisDetails.some((b:{acceptedRef:{claimId:string}})=>b.acceptedRef.claimId===fixture.newBudgetId)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('raw source selection saves an omitted point once, keeps selection after lost response and remains traceable',async({page,context,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId);
 try {
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  await page.getByRole('button',{name:'从原文补充',exact:true}).click();
  const source=page.locator('[data-source-segment]').first();
  await expect(source).toHaveText('预算大约三十万。费用待定。请询价。');
  // Select only the omitted phrase using real browser range offsets.
  await source.evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild!,8);range.setEnd(node.firstChild!,13);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);});
  await source.dispatchEvent('mouseup');
  await expect(page.getByTestId('highlight-preview')).toHaveText('费用待定。');
  await page.keyboard.press('Escape');
  await expect(page.getByText('这段选录还未保存。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'继续选录',exact:true}).click();
  await page.screenshot({path:info.outputPath('source-highlight-preview.png')});
  let lose=true;const keys:Array<string|undefined>=[];
  await page.route('**/api/v2/events/*/highlights',async route=>{
    keys.push(route.request().headers()['idempotency-key']);
    if(lose){lose=false;await route.fetch();await route.abort('failed');}else await route.continue();
  });
  await page.getByRole('button',{name:'补进重点',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('highlight-preview')).toHaveText('费用待定。');
  await page.getByRole('button',{name:'补进重点',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);expect(keys[0]).toBe(keys[1]);
  await page.reload();
  const bullet=page.locator('[data-testid^="bullet-"]').filter({hasText:'用户选录'});
  await expect(bullet).toHaveCount(1);await expect(bullet).toContainText('费用待定。');
  await bullet.getByRole('button',{name:'原话',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('费用待定。');
  await page.getByRole('button',{name:'返回记录',exact:true}).click();
  await page.getByRole('button',{name:'复制记录',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('费用待定。');
  await page.getByRole('button',{name:'从原文补充',exact:true}).click();
  await expect(source).toBeVisible();
  await source.evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild!,8);range.setEnd(node.firstChild!,13);const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);});await source.dispatchEvent('mouseup');
  await page.getByRole('button',{name:'补进重点',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(bullet).toHaveCount(1);
  const current=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();
  expect(current.data.bullets.filter((b:{origin:string})=>b.origin==='user_selection')).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('keyboard source selection survives concurrent changes and resumes after explicit recheck',async({page,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId);
 try {
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  await page.getByRole('button',{name:'从原文补充',exact:true}).click();
  const pick=page.getByRole('button',{name:'选录第1段',exact:true});await pick.focus();await pick.press('Enter');
  const selected='预算大约三十万。费用待定。请询价。';await expect(page.getByTestId('highlight-preview')).toHaveText(selected);
  const current=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();
  const card=current.data.reviewCards.find((c:{memberRefs:Array<{claimId:string}>})=>c.memberRefs.some(r=>r.claimId===fixture.budgetId));
  const changed=await request.post(`/api/v2/review-cards/${card.id}/decisions`,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{expectedContextVersion:current.data.contextVersion,expectedCardRevision:card.revision,operation:'confirm',members:[{...card.memberRefs[0],operation:'confirm'}]}});expect(changed.ok()).toBe(true);
  await page.getByRole('button',{name:'补进重点',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('新变化');await expect(page.getByTestId('highlight-preview')).toHaveText(selected);
  await expect(page.getByRole('button',{name:'补进重点',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'重新核对原文',exact:true}).click();
  await expect(page.getByRole('button',{name:'补进重点',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'补进重点',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'从原文补充',exact:true})).toBeFocused();
  await expect(page.locator('[data-testid^="bullet-"]').filter({hasText:'用户选录'})).toContainText(selected);
  await page.screenshot({path:info.outputPath('source-highlight-saved.png')});
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('PC review starts with five priorities, saves reading position and permits ending with pending work',async({page,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{priorityCount:6});
 const url=`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`;
 try {
  await page.goto(url);await page.getByRole('button',{name:'需要拍板 7',exact:true}).click();
  await expect(page.locator('[data-testid^="bullet-"]')).toHaveCount(5);
  await expect(page.getByText('先处理这 5 项，还有 2 项。',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('priority-five.png'),fullPage:true});
  await page.getByRole('button',{name:'再看 5 项',exact:true}).click();await expect(page.locator('[data-testid^="bullet-"]')).toHaveCount(7);
  const last=page.getByTestId(`bullet-${fixture.priorityIds.at(-1)}`);await last.scrollIntoViewIfNeeded();await last.focus();
  await expect.poll(async()=>{
   const saved=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();return saved.data.reviewProgress.lastCardId;
  }).toBe(`wfc_${fixture.priorityIds.at(-1)}`);
  await page.reload();await page.getByRole('button',{name:'回到上次位置',exact:true}).click();
  await expect(last).toBeFocused();await expect(last).toBeInViewport();
  await page.getByRole('button',{name:'结束本次',exact:true}).click();
  await expect(page.getByText('本次阅读已保存，还有 7 项需要拍板。',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('本次阅读已保存，还有 7 项需要拍板。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'继续处理',exact:true}).click();await expect(last).toBeFocused();
  const current=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();
  expect(current.data.contextVersion).toBe(0);expect(current.data.counts.needsDecisionCount).toBe(7);expect(current.data.actions).toHaveLength(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:info.outputPath('reading-resumed.png')});
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('project review keeps current answers, exact change history and direct record navigation after reload',async({page,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId);
 try {
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
  await budget.getByRole('button',{name:'改一下',exact:true}).click();await page.getByLabel('修改重点').fill('预算三十五万元。');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(budget).toContainText('预算三十五万元。');await expect(page.getByLabel('修改重点')).toHaveCount(0);
  await page.getByRole('button',{name:'加入跟进',exact:true}).click();await page.getByRole('button',{name:/^完成：/}).click();await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
  await page.getByRole('button',{name:'补答案',exact:true}).click();await page.getByLabel('补充答案',{exact:true}).fill('报价十二万元，包含安装。');await page.getByRole('button',{name:'保存答案',exact:true}).click();await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toHaveCount(0);
  await page.getByRole('button',{name:'整个项目',exact:true}).click();
  const overview=page.getByTestId('project-overview');await expect(overview).toBeVisible();await expect(overview.getByRole('heading',{name:'项目回顾',exact:true})).toBeVisible();
  await expect(overview).toContainText('0 个问题未解决');await expect(overview.getByRole('region',{name:'项目下一步'})).toContainText('当前没有待跟进行动或未决问题。');
  await expect(page.getByTestId(`overview-bullet-${fixture.actionId}`)).toContainText('已完成');
  await expect(overview.getByRole('region',{name:'项目当前重点'})).toContainText('报价十二万元，包含安装。');await expect(page.getByTestId(`overview-bullet-${fixture.questionId}`)).toHaveCount(0);
  await page.reload();await expect(overview).toBeVisible();await expect(page).toHaveURL(/workspaceTab=overview/);
  await page.getByTestId(`overview-bullet-${fixture.budgetId}`).getByRole('button',{name:'预算与供应商报价',exact:true}).click();await expect(budget).toBeFocused();
  await budget.getByRole('button',{name:'改一下',exact:true}).click();await page.getByLabel('修改重点').fill('预算四十万元。');await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect(budget).toContainText('预算四十万元。');
  await page.getByRole('button',{name:'整个项目',exact:true}).click();await expect(page.getByTestId(`overview-bullet-${fixture.budgetId}`)).toContainText('预算四十万元。');
  const changes=overview.getByRole('region',{name:'项目最近变化'});await expect(changes).toContainText('修改了重点：预算三十五万元。');await expect(changes).toContainText('修改了重点：预算四十万元。');
  await overview.getByRole('button',{name:'继续这件事',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('新增材料');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.goto(`/?project=${fixture.projectId}&view=simple`);await expect(overview).toBeVisible();
  await expect(overview.getByRole('region',{name:'项目当前重点'})).toContainText('预算四十万元。');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:info.outputPath('project-overview.png'),fullPage:true});
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('replacing an answer keeps the completed action result clearly historical and copies the current answer',async({page,context,request},info)=>{
 test.setTimeout(90000);
 const projects=await (await request.get('/api/v1/projects')).json();
 const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
 const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
 const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId);
 try {
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  await page.getByRole('button',{name:'加入跟进',exact:true}).click();await expect(page.getByRole('button',{name:/^完成：/})).toBeVisible();
  await page.getByRole('button',{name:'补结果',exact:true}).click();await page.getByLabel('补充答案',{exact:true}).fill('报价十二万元。');await page.getByRole('button',{name:'保存结果',exact:true}).click();await expect(page.getByRole('form',{name:'补充结果',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:/^完成：/}).click();await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
  await page.getByRole('button',{name:'更新答案',exact:true}).click();await page.getByLabel('补充答案',{exact:true}).fill('报价十三万元。');await page.getByLabel('用新答案替代',{exact:true}).check();await page.getByRole('button',{name:'保存答案',exact:true}).click();await expect(page.getByRole('form',{name:'补充结果',exact:true})).toHaveCount(0);
  const followup=page.getByTestId(`action-${fixture.actionId}`);const history=followup.locator('details').filter({has:page.getByText('上次结果 · 相关答案已变化',{exact:true})});
  await expect(history.locator('summary')).toBeVisible();await expect(history.getByText('报价十二万元。',{exact:true})).toBeHidden();await history.locator('summary').click();await expect(history).toContainText('报价十二万元。');
  await page.getByRole('button',{name:'复制记录',exact:true}).click();await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('报价十三万元。');expect(await page.evaluate(()=>navigator.clipboard.readText())).not.toContain('报价十二万元。');
  await page.reload();await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();await expect(history.locator('summary')).toBeVisible();await expect(history.getByText('报价十二万元。',{exact:true})).toBeHidden();
  await history.locator('summary').click();await page.screenshot({path:info.outputPath('result-history.png'),fullPage:true});
 } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('full narrative keeps draft labels and hides outdated wording until explicitly opened',async({page,request},info)=>{
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const existing=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(existing.data.access.workspaceId);
  try {
    fixture.seedNarrative();
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const summary=page.getByTestId('record-narrative');
    await expect(summary.locator('summary')).toHaveText('查看全文概要');
    await expect(summary.locator('p').filter({hasText:'预算大约三十万'})).not.toBeVisible();
    await summary.locator('summary').click();
    await expect(summary.locator('p').filter({hasText:'预算大约三十万'})).toBeVisible();
    await expect(summary.getByText('含草稿',{exact:true})).toHaveCount(3);
    await page.getByTestId(`bullet-${fixture.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点',{exact:true}).fill('预算大约四十万，仍需评估。');
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('四十万');
    await expect(summary.locator('summary')).toHaveText('查看上一版概要');
    await expect(summary.locator('p').filter({hasText:'预算大约三十万'})).not.toBeVisible();
    await summary.locator('summary').click();
    await expect(summary).toContainText('这份概要尚未同步最近的修改');
    await page.screenshot({path:info.outputPath('narrative-history.png'),fullPage:true});
    await page.reload();
    await expect(summary.locator('p').filter({hasText:'预算大约三十万'})).not.toBeVisible();
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

async function analysisFixture(request:import('@playwright/test').APIRequestContext) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const existing=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(existing.data.access.workspaceId);
}

test('queued reorganization retains a readable and copyable prior record across reload',async({page,context,request},info)=>{
  const fixture=await analysisFixture(request),runId=fixture.queueReplacement();
  try {
    await context.grantPermissions(['clipboard-read','clipboard-write']);
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const progress=page.getByRole('region',{name:'记录整理进度'});
    await expect(progress).toContainText('正在整理，已有记录仍可阅读');
    await expect(page.locator('.workflow-reading-banner')).toHaveCount(0);
    await expect(page.getByText('正在整理：已完成',{exact:false})).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
    await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toContain('预算大约三十万');
    await page.reload();
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
    await expect(progress.getByRole('button',{name:'重新整理',exact:true})).toBeDisabled();
    await progress.getByText('查看整理进度',{exact:true}).click();
    await expect(progress).toContainText('等待处理');
    await page.screenshot({path:info.outputPath('analysis-previous-record.png'),fullPage:true});
    fixture.finishReplacement(runId);
    await expect(progress).toContainText('本次整理已停止');
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('actual retry and reorganization preserve drafts and guard unsaved input',async({page,request},info)=>{
  const fixture=await analysisFixture(request);fixture.failAnalysis();
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const progress=page.getByRole('region',{name:'记录整理进度'});
    await expect(progress.getByRole('button',{name:'重试失败部分',exact:true})).toBeVisible();
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await budget.getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点').fill('暂未保存的预算三十五万');
    let posted=0;
    page.on('request',req=>{if(req.method()==='POST'&&/\/api\/v2\/(events\/[^/]+\/analysis|analysis-runs\/[^/]+\/retry)$/.test(new URL(req.url()).pathname))posted++;});
    await progress.getByRole('button',{name:'重试失败部分',exact:true}).click();
    await expect(page.getByRole('alert').filter({hasText:'当前输入尚未保存'})).toBeVisible();
    await expect(page.getByLabel('修改重点')).toHaveValue('暂未保存的预算三十五万');
    expect(posted).toBe(0);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    const response=page.waitForResponse(r=>/\/analysis-runs\/[^/]+\/retry$/.test(r.url()));
    await progress.getByRole('button',{name:'重试失败部分',exact:true}).click();
    expect((await response).status()).toBe(202);
    await expect(progress).toContainText('正在整理，已有记录仍可阅读');
    await expect(budget).toContainText('预算大约三十万');
    await page.screenshot({path:info.outputPath('analysis-retry.png'),fullPage:true});
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('actual explicit reorganization persists a native run once and keeps prior drafts',async({page,request})=>{
  const fixture=await analysisFixture(request);
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const progress=page.getByRole('region',{name:'记录整理进度'});
    await expect(progress).toContainText('整理完成');
    const response=page.waitForResponse(r=>/\/api\/v2\/events\/[^/]+\/analysis$/.test(r.url()));
    await progress.getByRole('button',{name:'重新整理',exact:true}).click();
    const saved=await response;expect(saved.status()).toBe(202);
    const result=await saved.json();expect(result.data.id).toBeTruthy();expect(result.data.state).toBe('queued');
    await expect(progress).toContainText('正在整理，已有记录仍可阅读');
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
    await page.reload();
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
    const persisted=await (await request.get(`/api/v2/analysis-runs/${result.data.id}`)).json();expect(persisted.data.id).toBe(result.data.id);
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});


test('material finalize commissions once with the browser closed and preserves the previous record',async({page,request},info)=>{
  test.setTimeout(90000);
  const fixture=await analysisFixture(request);
  try {
    const text='Speaker 1: 这次补充的交货日期为十月十五日。\nSpeaker 2: 请先确认供应商的书面报价。';
    const init=await request.post(`/api/v1/events/${fixture.eventId}/assets/init`,{
      headers:{'Idempotency-Key':`qa-upload-${fixture.projectId}`},
      data:{kind:'transcript',filename:'synthetic-material.txt',mime_type:'text/plain',size_bytes:Buffer.byteLength(text),metadata:{synthetic:true}},
    });expect(init.status()).toBe(201);
    const assetId=(await init.json()).data.asset.id;
    const upload=await request.put(`/api/v1/assets/${assetId}/content`,{headers:{'Content-Type':'text/plain'},data:Buffer.from(text)});
    expect(upload.status()).toBe(200);
    const finalize=await request.post(`/api/v1/assets/${assetId}/finalize`,{data:{}});expect(finalize.status()).toBe(200);
    const version=(await finalize.json()).data.asset.current_version_id;
    expect(version).toBeTruthy();
    await request.post(`/api/v1/assets/${assetId}/finalize`,{data:{}});
    await request.post(`/api/v1/assets/${assetId}/finalize`,{data:{}});
    // No page has opened the communication or posted an analysis request.
    await expect.poll(()=>fixture.analysisEvidence().intents[0]?.state,{timeout:20000}).toBe('succeeded');
    const evidence=fixture.analysisEvidence();expect(evidence.intents).toHaveLength(1);expect(evidence.intents[0].input_revision).toBe(1);
    expect(evidence.runs).toHaveLength(2);expect(evidence.modelStages).toBe(0);expect(evidence.artifacts).toBe(0);
    const runId=JSON.parse(evidence.intents[0].payload_json).analysisRunId;
    expect(JSON.parse(evidence.runs.find((r:{id:string;model_params_json:string})=>r.id===runId)!.model_params_json).event_summary).toBe(false);
    const saved=await (await request.get(`/api/v1/events/${fixture.eventId}`)).json();expect(saved.data.event.source_revision).toBe(1);expect(saved.data.event.active_run_id).toBe(runId);
    let analysisPosts=0;page.on('request',req=>{if(req.method()==='POST'&&/\/analysis$/.test(new URL(req.url()).pathname))analysisPosts++;});
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await expect(page.getByRole('region',{name:'记录整理进度'})).toContainText('正在整理，已有记录仍可阅读');
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
    await page.reload();await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');expect(analysisPosts).toBe(0);
    await page.screenshot({path:info.outputPath('material-server-handoff.png'),fullPage:true});
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    const trashed=await request.delete(`/api/v1/projects/${fixture.projectId}`,{headers:{'Idempotency-Key':`qa-trash-${fixture.projectId}`},data:{}});
    if(trashed.ok()) {
      const purged=await request.delete(`/api/v1/projects/${fixture.projectId}/permanent`,{headers:{'Idempotency-Key':`qa-purge-${fixture.projectId}`},data:{confirm_name:'[SYNTHETIC] 工作流实际操作验收'}});
      expect(purged.ok()).toBe(true);
    }
    fixture.cleanup();
  }
});


test('reading failed optional summaries stays free until one view is explicitly requested',async({page,request},info)=>{
  const fixture=await analysisFixture(request);fixture.seedReadingFailures();
  const paidPosts:string[]=[];
  page.on('request',req=>{if(req.method()==='POST'&&/ai-artifacts/.test(new URL(req.url()).pathname))paidPosts.push(new URL(req.url()).pathname);});
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await page.getByRole('button',{name:'查看原文',exact:true}).click();
    await expect(page.getByRole('complementary',{name:'本次操作'})).toHaveCount(0);
    await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true}).first()).toBeVisible();
    const layout=await page.locator('.reader-workspace-layout').boundingBox();
    const reading=await page.getByRole('region',{name:'阅读内容'}).boundingBox();expect(reading!.width/layout!.width).toBeGreaterThan(0.95);
    await page.screenshot({path:info.outputPath('source-reading-first.png'),fullPage:true});
    await page.getByText('更多阅读方式',{exact:true}).click();
    await expect(page.getByRole('button',{name:'生成章节摘要',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'生成原文概要',exact:true})).toBeVisible();
    await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true}).first()).toBeVisible();
    expect(paidPosts).toHaveLength(0);
    await page.reload();await page.getByText('更多阅读方式',{exact:true}).click();await expect(page.getByRole('button',{name:'生成章节摘要',exact:true})).toBeVisible();expect(paidPosts).toHaveLength(0);
    await page.screenshot({path:info.outputPath('reading-explicit-only.png'),fullPage:true});
    await page.route('**/ai-artifacts/chapters/retry',route=>route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({data:{run:{id:'synthetic-chapter-request',event_id:fixture.eventId,kind:'chapters',status:'queued'}},request_id:'qa'})}));
    await page.getByRole('button',{name:'生成章节摘要',exact:true}).click();
    await expect.poll(()=>paidPosts.length).toBe(1);expect(paidPosts[0]).toBe(`/api/v1/events/${fixture.eventId}/ai-artifacts/chapters/retry`);
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('composite choices save atomically with one retry and restore all members through undo',async({page,request},info)=>{
  test.setTimeout(90000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{withComposite:true});
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await expect(page.getByRole('button',{name:'同组逐条处理',exact:true})).toHaveCount(1);
    await page.getByRole('button',{name:'同组逐条处理',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByTestId(`member-${fixture.budgetId}`).getByRole('combobox').selectOption('confirm');
    const time=dialog.getByTestId(`member-${fixture.timeId}`);
    await time.getByRole('combobox').selectOption('edit');
    await time.getByRole('textbox').fill('周六上午十点确认时间。');
    await time.getByRole('combobox').last().selectOption('user_input');
    await dialog.getByTestId(`member-${fixture.placeId}`).getByRole('combobox').selectOption('reject');
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await expect(dialog.getByText('这些选择还未保存。')).toBeVisible();
    await dialog.getByRole('button',{name:'继续处理',exact:true}).click();
    const attempts:Array<{key:string|null;body:string|null}>=[];let lost=true;
    await page.route('**/api/v2/review-cards/*/decisions',async route=>{
      attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
      if(lost){lost=false;await route.fetch();await route.abort('failed');return;}await route.continue();
    });
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(dialog.getByRole('alert')).toContainText('暂时连接不上服务器');
    const saveBox=await dialog.getByRole('button',{name:'保存本次选择',exact:true}).boundingBox();
    expect(saveBox!.y+saveBox!.height).toBeLessThan(page.viewportSize()!.height-18);
    await expect(time.getByRole('textbox')).toHaveValue('周六上午十点确认时间。');
    await page.screenshot({path:info.outputPath('composite-retry.png'),fullPage:true});
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(dialog).toHaveCount(0);expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('已采纳');
    await expect(page.getByTestId(`bullet-${fixture.timeId}`)).toContainText('周六上午十点');
    await expect(page.getByTestId(`bullet-${fixture.placeId}`)).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.remainingId}`)).toContainText('AI 草稿');
    await page.reload();
    await expect(page.getByTestId(`bullet-${fixture.timeId}`)).toContainText('周六上午十点');
    await expect(page.getByRole('button',{name:'同组逐条处理',exact:true})).toHaveCount(1);
    await page.getByText('最近处理',{exact:true}).click();
    await expect(page.getByText('逐条处理',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'撤销',exact:true}).click();
    await expect(page.getByTestId(`bullet-${fixture.placeId}`)).toContainText('在门店讨论');
    await expect(page.getByTestId(`bullet-${fixture.timeId}`)).toContainText('周末确认时间');
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('AI 草稿');
    await page.screenshot({path:info.outputPath('composite-restored.png'),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('a concurrent group correction retains all local choices and requires current-version review',async({page,request},info)=>{
  test.setTimeout(90000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{withComposite:true});
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await page.getByRole('button',{name:'同组逐条处理',exact:true}).click();
    const dialog=page.getByRole('dialog'),budget=dialog.getByTestId(`member-${fixture.budgetId}`);
    await budget.getByRole('combobox').selectOption('edit');
    await budget.getByRole('textbox').fill('我的方案：预算三十八万元。');
    await budget.getByRole('combobox').last().selectOption('user_input');
    await dialog.getByTestId(`member-${fixture.timeId}`).getByRole('combobox').selectOption('confirm');
    const current=(await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json()).data;
    const card=current.reviewCards.find((c:{id:string})=>c.id===fixture.groupId);
    const ref=card.memberRefs.find((r:{claimId:string})=>r.claimId===fixture.budgetId);
    const response=await request.post(`/api/v2/review-cards/${card.id}/decisions`,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{operation:'edit',expectedContextVersion:current.contextVersion,expectedCardRevision:card.revision,members:[{...ref,operation:'edit',newText:'另一处方案：预算四十万元。',origin:'user_input',evidenceRefIds:[]}]}});
    expect(response.ok()).toBe(true);
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(budget.getByRole('textbox')).toHaveValue('我的方案：预算三十八万元。');
    await expect(dialog.getByText('当前内容：另一处方案：预算四十万元。')).toBeVisible();
    await expect(dialog.getByRole('button',{name:'保存本次选择',exact:true})).toBeDisabled();
    const saveBox=await dialog.getByRole('button',{name:'保存本次选择',exact:true}).boundingBox();
    expect(saveBox!.y+saveBox!.height).toBeLessThan(page.viewportSize()!.height-18);
    await page.screenshot({path:info.outputPath('composite-concurrent.png'),fullPage:true});
    await dialog.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('我的方案：预算三十八万元。');
    await expect(page.getByTestId(`bullet-${fixture.timeId}`)).toContainText('已采纳');
    await expect(page.getByTestId(`bullet-${fixture.remainingId}`)).toContainText('AI 草稿');
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('a single confirm inside a group keeps other drafts and edit opens the chosen member',async({page,request})=>{
  test.setTimeout(60000);
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const original=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  const fixture=await createLocalWorkflowFixture(original.data.access.workspaceId,{withComposite:true});
  try {
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    await page.getByTestId(`bullet-${fixture.budgetId}`).getByRole('button',{name:'确认这条',exact:true}).click();
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('已采纳');
    for(const id of [fixture.timeId,fixture.placeId,fixture.remainingId]) await expect(page.getByTestId(`bullet-${id}`)).toContainText('AI 草稿');
    await page.getByTestId(`bullet-${fixture.timeId}`).getByRole('button',{name:'改一下',exact:true}).click();
    const row=page.getByRole('dialog').getByTestId(`member-${fixture.timeId}`);
    await expect(row.getByRole('textbox')).toBeFocused();
    await expect(row.getByRole('combobox').first()).toHaveValue('edit');
    await row.getByRole('textbox').fill('周日上午确认时间。');
    await page.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.timeId}`)).toContainText('周日上午确认时间');
    await expect(page.getByTestId(`bullet-${fixture.placeId}`)).toContainText('AI 草稿');
  } finally {await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});
