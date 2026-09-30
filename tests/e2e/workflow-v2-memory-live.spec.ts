import {expect,test,type APIRequestContext,type Page} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

async function fixtureFor(request:APIRequestContext,options={}) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(current.data.access.workspaceId,options);
}
async function open(page:Page,fixture:Awaited<ReturnType<typeof fixtureFor>>) {
  await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
  await expect(page.getByRole('button',{name:'复制记录',exact:true})).toBeVisible();
}
function accessFailure(status=403) {return {status,contentType:'application/json',body:JSON.stringify({error:{code:status===401?'AUTH_REQUIRED':'FORBIDDEN',message:'当前访问已失效'},request_id:'qa-access'})};}
async function focusRead(page:Page) {await page.evaluate(()=>window.dispatchEvent(new Event('visibilitychange')));}

// Authorization failures are injected only into this browser. Real local
// writes, latest versions, receipts and results still use the isolated fixture.
test('permission recovery preserves an inline input, removes hidden source, and reviews the actual newest version',async({page,request},info)=>{
  test.setTimeout(60000);const fixture=await fixtureFor(request);
  try {
    await open(page,fixture);
    await page.getByRole('button',{name:'查看原文',exact:true}).click();
    await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true}).first()).toBeVisible();
    await page.getByRole('button',{name:'本次重点',exact:true}).click();
    await page.getByTestId(`bullet-${fixture.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点',{exact:true}).fill('我补充的预算：三十六万元。');
    await page.getByLabel('修改依据').selectOption('user_input');
    const route='**/api/v2/review-cards/*/decisions';
    await page.route(route,r=>r.fulfill(accessFailure()));
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByRole('button',{name:'恢复读取',exact:true})).toBeVisible();
    await expect(page.getByLabel('保留的修改重点1')).toHaveValue('我补充的预算：三十六万元。');
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toHaveCount(0);
    await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true})).toHaveCount(0);
    await page.screenshot({path:info.outputPath('access-own-input.png'),fullPage:true});
    const current=(await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json()).data;
    const card=current.reviewCards.find((c:{id:string})=>c.id===`wfc_${fixture.budgetId}`);
    const updated=await request.post(`/api/v2/review-cards/${card.id}/decisions`,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{operation:'edit',expectedContextVersion:current.contextVersion,expectedCardRevision:card.revision,members:[{...card.memberRefs[0],operation:'edit',newText:'另一位更新预算：四十万元。',origin:'user_input',evidenceRefIds:[]}]}});
    expect(updated.ok()).toBe(true);
    await page.unroute(route);
    await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveValue('我补充的预算：三十六万元。');
    await expect(page.getByText('当前内容：另一位更新预算：四十万元。',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'保存修改',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();
    await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('我补充的预算：三十六万元。');
    await page.screenshot({path:info.outputPath('access-current-review.png'),fullPage:true});
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('permission recovery retains separate composite choices and only the changed member text',async({page,request},info)=>{
  const fixture=await fixtureFor(request,{withComposite:true});
  try {
    await open(page,fixture);await page.getByRole('button',{name:'同组逐条处理',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await dialog.getByTestId(`member-${fixture.budgetId}`).getByRole('combobox').selectOption('confirm');
    const time=dialog.getByTestId(`member-${fixture.timeId}`);
    await time.getByRole('combobox').selectOption('edit');await time.getByRole('textbox').fill('我的安排：周六十点。');
    await dialog.getByTestId(`member-${fixture.placeId}`).getByRole('combobox').selectOption('reject');
    const route='**/api/v2/review-cards/*/decisions';await page.route(route,r=>r.fulfill(accessFailure()));
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    const retained=page.getByRole('region',{name:'保留的输入'});await expect(retained.getByRole('textbox')).toHaveCount(1);
    await expect(retained.getByRole('textbox')).toHaveValue('我的安排：周六十点。');
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('在门店讨论',{exact:true})).toHaveCount(0);
    await page.unroute(route);await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(dialog.getByTestId(`member-${fixture.budgetId}`).getByRole('combobox')).toHaveValue('confirm');
    await expect(time.getByRole('textbox')).toHaveValue('我的安排：周六十点。');
    await expect(dialog.getByTestId(`member-${fixture.placeId}`).getByRole('combobox')).toHaveValue('reject');
    await expect(dialog.getByRole('button',{name:'保存本次选择',exact:true})).toBeDisabled();
    await dialog.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();
    await page.screenshot({path:info.outputPath('access-composite-restored.png'),fullPage:true});
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(dialog).toHaveCount(0);await expect(page.getByTestId(`bullet-${fixture.placeId}`)).toHaveCount(0);
    await expect(page.getByTestId(`bullet-${fixture.remainingId}`)).toContainText('AI 草稿');
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('permission recovery preserves action answers, a personal note, and the independent completion choice',async({page,request},info)=>{
  const fixture=await fixtureFor(request);
  try {
    await open(page,fixture);await page.getByRole('button',{name:'加入跟进',exact:true}).click();
    await page.getByRole('button',{name:'补结果',exact:true}).click();
    await page.getByLabel('补充答案',{exact:true}).fill('我问到的价格：十二万元。');
    await page.getByRole('button',{name:'添加补充说明',exact:true}).click();
    await page.getByLabel('补充说明，可留空',{exact:true}).fill('我已收到书面报价。');
    await page.getByLabel('同时标记行动完成',{exact:true}).check();
    const route='**/api/v2/actions/*/outcomes';await page.route(route,r=>r.fulfill(accessFailure()));
    await page.getByRole('button',{name:'保存结果',exact:true}).click();
    const retained=page.getByRole('region',{name:'保留的输入'});await expect(retained.getByRole('textbox')).toHaveCount(2);
    await expect(page.getByLabel('保留的问题答案1')).toHaveValue('我问到的价格：十二万元。');
    await expect(page.getByLabel('保留的补充说明2')).toHaveValue('我已收到书面报价。');
    await page.unroute(route);await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByLabel('补充答案',{exact:true})).toHaveValue('我问到的价格：十二万元。');
    await expect(page.getByLabel('同时标记行动完成',{exact:true})).toBeChecked();
    await expect(page.getByRole('button',{name:'保存结果',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();
    await page.getByRole('button',{name:'保存结果',exact:true}).click();
    await expect(page.getByRole('button',{name:/^重开：/})).toBeVisible();
    await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toHaveCount(0);
    await page.screenshot({path:info.outputPath('access-outcome-saved.png'),fullPage:true});
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('permission recovery restores conflict applicability and source ranges after authorized rereading',async({page,request},info)=>{
  const fixture=await fixtureFor(request,{withConflict:true});
  try {
    await open(page,fixture);await page.getByRole('button',{name:'核对新旧信息',exact:true}).click();
    await page.getByRole('radio',{name:/两条信息分别适用/}).check();await page.getByLabel('适用情况',{exact:true}).fill('我确定原预算用于一期，新预算用于二期。');
    const route='**/api/v2/review-cards/*/decisions';await page.route(route,r=>r.fulfill(accessFailure()));
    await page.getByRole('button',{name:'保存选择',exact:true}).click();
    await expect(page.getByLabel('保留的适用情况1')).toHaveValue('我确定原预算用于一期，新预算用于二期。');
    await expect(page.getByText('预算更新为三十五万',{exact:true})).toHaveCount(0);
    await page.unroute(route);await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByRole('radio',{name:/两条信息分别适用/})).toBeChecked();
    await expect(page.getByRole('button',{name:'保存选择',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'重新核对最新内容',exact:true}).click();await page.getByRole('button',{name:'保存选择',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button',{name:'从原文补充',exact:true}).click();await page.getByRole('button',{name:'选录第1段',exact:true}).click();
    const highlightRoute='**/api/v2/events/*/highlights';await page.route(highlightRoute,r=>r.fulfill(accessFailure()));
    await page.getByRole('button',{name:'补进重点',exact:true}).click();
    const retained=page.getByRole('region',{name:'保留的输入'});await expect(retained).toContainText('处理选择与选录范围已保留');await expect(retained.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true})).toHaveCount(0);
    await page.unroute(highlightRoute);await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByTestId('highlight-preview')).toContainText('预算大约三十万');
    await expect(page.getByRole('button',{name:'补进重点',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'重新核对原文',exact:true}).click();await page.getByRole('button',{name:'补进重点',exact:true}).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('用户选录',{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('access-source-restored.png'),fullPage:true});
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('access loss on background read keeps a direct answer, supports read only, and rechecks restored edit permission',async({page,request},info)=>{
  const fixture=await fixtureFor(request);
  try {
    await open(page,fixture);await page.getByRole('button',{name:'补答案',exact:true}).click();await page.getByLabel('补充答案',{exact:true}).fill('我确认标准方案十二万元。');
    const route=`**/api/v2/events/${fixture.eventId}/workspace*`;
    await page.route(route,r=>r.fulfill(accessFailure(401)));await focusRead(page);
    await expect(page.getByRole('link',{name:'重新登录',exact:true})).toHaveAttribute('target','_blank');
    await expect(page.getByLabel('保留的问题答案1')).toHaveValue('我确认标准方案十二万元。');
    await page.unroute(route);
    const readonlyBody=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();readonlyBody.data.access.canEdit=false;
    await page.route(route,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(readonlyBody)}));
    await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByLabel('补充答案',{exact:true})).toHaveValue('我确认标准方案十二万元。');
    await expect(page.getByLabel('补充答案',{exact:true})).toHaveAttribute('readonly','');
    await expect(page.getByRole('button',{name:'保存答案',exact:true})).toBeDisabled();
    await page.unrouteAll({behavior:'wait'});await page.getByRole('button',{name:'重新检查权限',exact:true}).click();
    await expect(page.getByLabel('补充答案',{exact:true})).not.toHaveAttribute('readonly','');
    await page.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();await page.getByRole('button',{name:'保存答案',exact:true}).click();
    await expect(page.getByLabel('补充答案',{exact:true})).toHaveCount(0);await expect(page.getByTestId(`bullet-${fixture.questionId}`)).toHaveCount(0);
    await expect(page.getByRole('button',{name:/^完成：/})).toHaveCount(0);
    await page.screenshot({path:info.outputPath('access-answer-restored.png'),fullPage:true});
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('an account change removes prior own input and forces a fresh identity read',async({page,request})=>{
  const fixture=await fixtureFor(request);
  try {
    await open(page,fixture);await page.getByTestId(`bullet-${fixture.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();
    await page.getByLabel('修改重点',{exact:true}).fill('上一账号的私人修改。');
    const route=`**/api/v2/events/${fixture.eventId}/workspace*`;
    const changedActor=await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json();changedActor.data.access.actorId='qa-other-actor';
    await page.route(route,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(changedActor)}));
    await focusRead(page);await expect(page.getByText('账号已变化，请重新读取。',{exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'保留的输入'})).toHaveCount(0);await expect(page.getByLabel('修改重点',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'恢复读取',exact:true}).click();await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('预算大约三十万');
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveCount(0);expect(await page.locator('body').textContent()).not.toContain('上一账号的私人修改。');
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('a removed edit target retains copyable input until an explicit discard',async({page,request})=>{
  const fixture=await fixtureFor(request);
  try {
    await open(page,fixture);await page.getByTestId(`bullet-${fixture.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();await page.getByLabel('修改重点',{exact:true}).fill('希望保留以供复制的新预算。');
    const route='**/api/v2/review-cards/*/decisions';await page.route(route,r=>r.fulfill(accessFailure()));await page.getByRole('button',{name:'保存修改',exact:true}).click();
    await expect(page.getByRole('region',{name:'保留的输入'})).toBeVisible();
    const current=(await (await request.get(`/api/v2/events/${fixture.eventId}/workspace`)).json()).data;const card=current.reviewCards.find((c:{id:string})=>c.id===`wfc_${fixture.budgetId}`);
    const reject=await request.post(`/api/v2/review-cards/${card.id}/decisions`,{headers:{'Idempotency-Key':crypto.randomUUID()},data:{operation:'reject',expectedContextVersion:current.contextVersion,expectedCardRevision:card.revision,members:[{...card.memberRefs[0],operation:'reject'}]}});expect(reject.ok()).toBe(true);
    await page.unroute(route);await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByLabel('保留的修改重点1')).toHaveValue('希望保留以供复制的新预算。');await expect(page.getByLabel('修改重点',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'从原文补充',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'请先保存或取消'})).toBeVisible();
    await page.getByRole('button',{name:'放弃保留的输入',exact:true}).click();await page.getByRole('button',{name:'继续保留',exact:true}).click();await expect(page.getByLabel('保留的修改重点1')).toBeVisible();
    await page.getByRole('button',{name:'放弃保留的输入',exact:true}).click();await page.getByRole('button',{name:'确认放弃',exact:true}).click();await expect(page.getByRole('region',{name:'保留的输入'})).toHaveCount(0);
    await page.getByRole('button',{name:'从原文补充',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('a late saved receipt cannot clear input restored in a newer access session',async({page,request})=>{
  test.setTimeout(60000);const fixture=await fixtureFor(request);
  let release=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});let serverSaved=false,returned=false;
  try {
    await open(page,fixture);await page.getByTestId(`bullet-${fixture.budgetId}`).getByRole('button',{name:'改一下',exact:true}).click();await page.getByLabel('修改重点',{exact:true}).fill('我已写好的三十五万预算。');
    const saveRoute='**/api/v2/review-cards/*/decisions';
    await page.route(saveRoute,async r=>{const response=await r.fetch();expect(response.ok()).toBe(true);serverSaved=true;await held;try{await r.fulfill({response});}catch{}returned=true;});
    await page.getByRole('button',{name:'保存修改',exact:true}).click();await expect.poll(()=>serverSaved).toBe(true);
    const readRoute=`**/api/v2/events/${fixture.eventId}/workspace*`;await page.route(readRoute,r=>r.fulfill(accessFailure(401)));await focusRead(page);
    await expect(page.getByRole('button',{name:'恢复读取',exact:true})).toBeVisible();await expect(page.getByLabel('保留的修改重点1')).toHaveValue('我已写好的三十五万预算。');
    await page.unroute(readRoute);await page.getByRole('button',{name:'恢复读取',exact:true}).click();
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveValue('我已写好的三十五万预算。');
    release();await expect.poll(()=>returned).toBe(true);
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveValue('我已写好的三十五万预算。');await expect(page.getByRole('button',{name:'保存修改',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'核对后采用当前版本',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
    await expect(page.getByLabel('修改重点',{exact:true})).toHaveCount(0);await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('我已写好的三十五万预算。');
  } finally {release();await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});

test('access loss without a draft blocks old source and material tabs until a verified recovery',async({page,request})=>{
  const fixture=await fixtureFor(request);
  try {
    await open(page,fixture);await page.getByRole('button',{name:'查看原文',exact:true}).click();await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true}).first()).toBeVisible();
    await page.getByRole('button',{name:'本次重点',exact:true}).click();
    const route='**/api/v2/projects/*/reports';await page.route(route,r=>r.fulfill(accessFailure()));await page.getByRole('button',{name:'复制记录',exact:true}).click();
    await expect(page.getByRole('button',{name:'恢复读取',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'保留的输入'})).toHaveCount(0);
    for(const name of ['原文','材料','整个项目']) {
      await page.getByRole('button',{name,exact:true}).click();await expect(page.getByRole('button',{name:'恢复读取',exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'阅读内容'})).toHaveCount(0);await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true})).toHaveCount(0);
    }
    await page.unroute(route);await page.getByRole('button',{name:'恢复读取',exact:true}).click();await expect(page.getByRole('button',{name:'复制记录',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'查看原文',exact:true}).click();await expect(page.getByText('预算大约三十万。费用待定。请询价。',{exact:true}).first()).toBeVisible();
  } finally {await page.unrouteAll({behavior:'wait'}).catch(()=>undefined);await page.close({runBeforeUnload:false}).catch(()=>undefined);fixture.cleanup();}
});
