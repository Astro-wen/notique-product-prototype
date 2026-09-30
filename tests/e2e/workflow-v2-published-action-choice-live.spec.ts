import {expect,test,type APIRequestContext} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

async function fixtureFor(request:APIRequestContext) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(current.data.access.workspaceId);
}

const snapshot=async(request:APIRequestContext,eventId:string)=>(await (await request.get(`/api/v2/events/${eventId}/workspace`)).json()).data;

test('a published AI action is visible in decisions, joins follow-up, permits partial exit and can be undone',async({page,request},info)=>{
  test.setTimeout(90_000);
  const fixture=await fixtureFor(request);
  const modelPosts:string[]=[];
  await page.route('**/api/v1/jobs/dispatch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'验收只使用当前合成项目的已保存结果'},request_id:'qa'})}));
  page.on('request',request=>{
    if(request.method()==='POST' && /\/(analysis|extraction|transcription|ai-artifacts|scenario)(\/|$)/.test(new URL(request.url()).pathname)) {
      modelPosts.push(new URL(request.url()).pathname);
    }
  });
  try {
    const stored=fixture.seedPublishedActionChoice();
    expect(stored).toMatchObject({
      card_id:`wfc_${fixture.actionId}`,kind:'action',needs_decision:0,reason_code:null,reason:'',disposition:'active',
      claim_id:fixture.actionId,claim_version_id:`${fixture.actionId}_v1`,review_status:'pending',workflow_origin:'ai_suggestion',
    });
    const before=fixture.analysisEvidence();
    const url=`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`;
    await page.goto(url);
    await expect(page.getByRole('button',{name:'复制记录',exact:true})).toBeVisible();
    const action=page.getByTestId(`bullet-${fixture.actionId}`);
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    const question=page.getByTestId(`bullet-${fixture.questionId}`);

    await test.step('the saved zero-flag card is classified and reachable through the decision filter',async()=>{
      await expect(page.getByRole('button',{name:'需要拍板 1',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'需要拍板 1',exact:true}).click();
      await expect(action).toBeVisible();
      await expect(action).toHaveAttribute('data-review-card',String(stored!.card_id));
      await expect(action).toContainText('需要你拍板');
      await expect(action.getByRole('button',{name:'加入跟进',exact:true})).toBeEnabled();
      await expect(budget).toHaveCount(0);
      await expect(question).toHaveCount(0);
      const current=await snapshot(request,fixture.eventId);
      const card=current.reviewCards.find((card:{id:string})=>card.id===stored!.card_id);
      expect(card).toMatchObject({kind:'action',needsDecision:true,reasonCode:'action_choice',sourceStatus:'ready'});
      expect(card.memberRefs).toEqual([{claimId:fixture.actionId,claimVersionId:`${fixture.actionId}_v1`}]);
      expect(card.members[0]).toMatchObject({reviewState:'draft',origin:'ai_suggestion'});
      expect(current.counts.needsDecisionCount).toBe(1);
      expect(current.actions).toHaveLength(0);
      await page.screenshot({path:info.outputPath('published-action-needs-decision.png'),fullPage:true});
    });

    await test.step('accepting only the action clears the count and keeps other information as drafts',async()=>{
      await action.getByRole('button',{name:'加入跟进',exact:true}).click();
      await expect(page.getByRole('button',{name:'需要拍板 0',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'完成：向供应商询价',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'全部',exact:true}).click();
      await expect(budget).toContainText('AI 草稿');
      await expect(question).toContainText('AI 草稿');
      const current=await snapshot(request,fixture.eventId);
      expect(current.counts.needsDecisionCount).toBe(0);
      expect(current.counts.openActionCount).toBe(1);
      expect(current.actions).toHaveLength(1);
      expect(current.actions[0]).toMatchObject({id:fixture.actionId,executionState:'open'});
      expect(current.questions[0]).toMatchObject({id:fixture.questionId,resolutionState:'open'});
      expect(current.bullets.filter((bullet:{id:string})=>[fixture.budgetId,fixture.questionId].includes(bullet.id)).map((bullet:{reviewState:string})=>bullet.reviewState)).toEqual(['draft','draft']);
      expect(current.bullets.find((bullet:{id:string})=>bullet.id===fixture.actionId).reviewState).toBe('accepted');
    });

    await test.step('ending and reopening the session preserves this partial choice',async()=>{
      await page.getByRole('button',{name:'结束本次',exact:true}).click();
      await expect(page.getByText('本次阅读已保存，还有 0 项需要拍板。',{exact:true})).toBeVisible();
      await page.reload();
      await expect(page.getByText('本次阅读已保存，还有 0 项需要拍板。',{exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'需要拍板 0',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'完成：向供应商询价',exact:true})).toBeVisible();
      await expect(budget).toContainText('AI 草稿');
      await expect(question).toContainText('AI 草稿');
      const current=await snapshot(request,fixture.eventId);
      expect(current.reviewProgress.finishedAt).not.toBeNull();
      expect(current.actions[0]).toMatchObject({id:fixture.actionId,executionState:'open'});
      expect(current.bullets.filter((bullet:{id:string})=>[fixture.budgetId,fixture.questionId].includes(bullet.id)).map((bullet:{reviewState:string})=>bullet.reviewState)).toEqual(['draft','draft']);
      await page.screenshot({path:info.outputPath('published-action-partial-exit.png'),fullPage:true});
    });

    await test.step('undo restores the pending action and filter without restarting extraction',async()=>{
      await page.getByRole('button',{name:'撤销上次处理',exact:true}).click();
      await expect(page.getByRole('button',{name:'需要拍板 1',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'完成：向供应商询价',exact:true})).toHaveCount(0);
      await page.getByRole('button',{name:'需要拍板 1',exact:true}).click();
      await expect(action.getByRole('button',{name:'加入跟进',exact:true})).toBeEnabled();
      const current=await snapshot(request,fixture.eventId);
      expect(current.counts.needsDecisionCount).toBe(1);
      expect(current.actions).toHaveLength(0);
      expect(current.bullets).toHaveLength(3);
      expect(current.bullets.every((bullet:{reviewState:string})=>bullet.reviewState==='draft')).toBe(true);
      expect(current.reviewCards.find((card:{id:string})=>card.id===stored!.card_id)).toMatchObject({needsDecision:true,reasonCode:'action_choice',disposition:'active'});
      const after=fixture.analysisEvidence();
      expect(after.runs).toEqual(before.runs);
      expect(after.modelStages).toBe(before.modelStages);
      expect(after.artifacts).toBe(before.artifacts);
      expect(after.intents).toEqual(before.intents);
      expect(modelPosts).toEqual([]);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
      await page.screenshot({path:info.outputPath('published-action-undone.png'),fullPage:true});
    });
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    fixture.cleanup();
  }
});
