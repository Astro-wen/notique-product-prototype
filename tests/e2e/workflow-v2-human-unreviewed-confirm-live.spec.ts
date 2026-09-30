import {expect,test,type APIRequestContext,type Page} from '@playwright/test';
import {createLocalWorkflowFixture} from '../helpers/local-workflow-fixture.mjs';

type DbRow=Record<string,unknown>;

async function fixtureFor(request:APIRequestContext,options:{withComposite?:boolean;withConflict?:boolean}) {
  const projects=await (await request.get('/api/v1/projects')).json();
  const events=await (await request.get(`/api/v1/projects/${projects.data.projects[0].id}/events`)).json();
  const current=await (await request.get(`/api/v2/events/${events.data.events[0].id}/workspace`)).json();
  return createLocalWorkflowFixture(current.data.access.workspaceId,options);
}

const snapshot=async(request:APIRequestContext,eventId:string)=>(await (await request.get(`/api/v2/events/${eventId}/workspace`)).json()).data;

async function isolateHeartbeat(page:Page) {
  await page.route('**/api/v1/jobs/dispatch',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_MODEL_DISABLED',message:'验收只使用当前合成项目的已保存结果'},request_id:'qa'})}));
}

function expectExtractionUnchanged(fixture:Awaited<ReturnType<typeof createLocalWorkflowFixture>>,before:ReturnType<Awaited<ReturnType<typeof createLocalWorkflowFixture>>['analysisEvidence']>) {
  const after=fixture.analysisEvidence();
  expect(after.runs).toEqual(before.runs);
  expect(after.modelStages).toBe(before.modelStages);
  expect(after.artifacts).toBe(before.artifacts);
  expect(after.intents).toEqual(before.intents);
}

test('a user confirms an unreviewed fact without rewriting it, and can also confirm it from member review',async({page,request},info)=>{
  test.setTimeout(90_000);
  const fixture=await fixtureFor(request,{withComposite:true});
  try {
    fixture.setUnreviewedFactEvidence();
    const before=fixture.factReviewEvidence();
    const extractionBefore=fixture.analysisEvidence();
    const original=before.claims.find((claim:DbRow)=>claim.id===fixture.budgetId)!;
    expect(before.evidence.find((evidence:DbRow)=>evidence.claim_version_id===original.current_version_id)?.semantic_support_verdict).toBe('unreviewed');
    await isolateHeartbeat(page);
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const budget=page.getByTestId(`bullet-${fixture.budgetId}`);
    await expect(budget).toContainText('预算大约三十万');
    const unreviewed=await snapshot(request,fixture.eventId);
    const card=unreviewed.reviewCards.find((card:{id:string})=>card.id===fixture.groupId);
    expect(card.sourceStatus).toBe('ready');
    expect(card.members.find((member:{claimId:string})=>member.claimId===fixture.budgetId)).toMatchObject({supportStatus:'unreviewed',reviewState:'draft'});

    await budget.getByRole('button',{name:'确认这条',exact:true}).click();
    await expect(budget).toContainText('已采纳');
    await expect(page.getByLabel('修改重点')).toHaveCount(0);
    let evidence=fixture.factReviewEvidence();
    expect(evidence.claims.find((claim:DbRow)=>claim.id===fixture.budgetId)).toMatchObject({review_status:'verified',current_version_id:original.current_version_id,statement:original.statement});
    expect(evidence.versions).toEqual(before.versions);
    expect(evidence.evidence).toEqual(before.evidence);
    const verdict=evidence.verdicts.find((verdict:DbRow)=>verdict.claim_id===fixture.budgetId && verdict.action==='confirm')!;
    const accepted=await snapshot(request,fixture.eventId);
    expect(verdict).toMatchObject({base_version_id:original.current_version_id,user_id:accepted.access.actorId,workflow_decision_id:accepted.recentDecisions[0].id});
    expect(evidence.members.find((member:DbRow)=>member.id===verdict.workflow_member_id)).toMatchObject({claim_id:fixture.budgetId,before_version_id:original.current_version_id,after_version_id:original.current_version_id,verdict_id:verdict.id,decision_id:verdict.workflow_decision_id});
    await page.screenshot({path:info.outputPath('unreviewed-fact-user-confirmed.png'),fullPage:true});

    await page.getByRole('button',{name:'撤销上次处理',exact:true}).click();
    await expect(budget).toContainText('AI 草稿');
    evidence=fixture.factReviewEvidence();
    expect(evidence.claims.find((claim:DbRow)=>claim.id===fixture.budgetId)).toMatchObject({review_status:'pending',current_version_id:original.current_version_id,statement:original.statement});
    expect(evidence.evidence).toEqual(before.evidence);
    await page.getByRole('button',{name:'同组逐条处理',exact:true}).click();
    const dialog=page.getByRole('dialog');
    const member=dialog.getByTestId(`member-${fixture.budgetId}`);
    await expect(member.getByRole('option',{name:'确认',exact:true})).toBeEnabled();
    await member.getByRole('combobox').selectOption('confirm');
    await dialog.getByRole('button',{name:'保存本次选择',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(budget).toContainText('已采纳');
    const grouped=await snapshot(request,fixture.eventId);
    expect(grouped.reviewCards.find((card:{id:string})=>card.id===fixture.groupId).members.filter((member:{claimId:string})=>member.claimId!==fixture.budgetId).every((member:{reviewState:string})=>member.reviewState==='draft')).toBe(true);
    evidence=fixture.factReviewEvidence();
    expect(evidence.versions).toEqual(before.versions);
    expect(evidence.evidence).toEqual(before.evidence);
    expect(evidence.verdicts.filter((verdict:DbRow)=>verdict.claim_id===fixture.budgetId && verdict.action==='confirm')).toHaveLength(2);
    await page.getByRole('button',{name:'撤销上次处理',exact:true}).click();
    await expect(budget).toContainText('AI 草稿');
    expect(fixture.factReviewEvidence().claims.find((claim:DbRow)=>claim.id===fixture.budgetId)).toMatchObject({review_status:'pending',current_version_id:original.current_version_id});
    expectExtractionUnchanged(fixture,extractionBefore);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath('unreviewed-fact-member-confirm-undone.png'),fullPage:true});
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    fixture.cleanup();
  }
});

test('a user adopts an unreviewed candidate through the existing conflict choice and undo restores the original',async({page,request},info)=>{
  test.setTimeout(90_000);
  const fixture=await fixtureFor(request,{withConflict:true});
  try {
    fixture.setUnreviewedFactEvidence({includeCandidate:true});
    const before=fixture.factReviewEvidence();
    const extractionBefore=fixture.analysisEvidence();
    const original=before.claims.find((claim:DbRow)=>claim.id===fixture.budgetId)!;
    const candidate=before.claims.find((claim:DbRow)=>claim.id===fixture.newBudgetId)!;
    await isolateHeartbeat(page);
    await page.goto(`/?project=${fixture.projectId}&event=${fixture.eventId}&view=simple`);
    const row=page.getByTestId(`bullet-${fixture.newBudgetId}`);
    await row.getByRole('button',{name:'核对新旧信息',exact:true}).click();
    const dialog=page.getByRole('dialog');
    await expect(dialog).toContainText('预算更新为三十五万');
    await expect(dialog.getByRole('radio',{name:/^采用新信息/})).toBeEnabled();
    await dialog.getByRole('radio',{name:/^采用新信息/}).check();
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await dialog.getByRole('button',{name:'保存选择',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('已采纳');
    let evidence=fixture.factReviewEvidence();
    expect(evidence.claims.find((claim:DbRow)=>claim.id===fixture.newBudgetId)).toMatchObject({review_status:'verified',current_version_id:candidate.current_version_id,statement:candidate.statement});
    expect(evidence.claims.find((claim:DbRow)=>claim.id===fixture.budgetId)).toMatchObject({review_status:original.review_status,lifecycle_status:'superseded',current_version_id:original.current_version_id});
    expect(evidence.versions).toEqual(before.versions);
    expect(evidence.evidence).toEqual(before.evidence);
    const adopted=await snapshot(request,fixture.eventId);
    const verdict=evidence.verdicts.find((verdict:DbRow)=>verdict.claim_id===fixture.newBudgetId && verdict.action==='confirm')!;
    expect(verdict).toMatchObject({base_version_id:candidate.current_version_id,user_id:adopted.access.actorId,workflow_decision_id:adopted.recentDecisions[0].id});
    expect(evidence.members.find((member:DbRow)=>member.id===verdict.workflow_member_id)).toMatchObject({claim_id:fixture.newBudgetId,before_version_id:candidate.current_version_id,after_version_id:candidate.current_version_id,verdict_id:verdict.id});
    await page.screenshot({path:info.outputPath('unreviewed-candidate-user-adopted.png'),fullPage:true});

    await page.getByRole('button',{name:'撤销上次处理',exact:true}).click();
    await expect(row.getByRole('button',{name:'核对新旧信息',exact:true})).toBeVisible();
    await expect(page.getByTestId(`bullet-${fixture.budgetId}`)).toContainText('已采纳');
    evidence=fixture.factReviewEvidence();
    expect(evidence.claims.find((claim:DbRow)=>claim.id===fixture.budgetId)).toMatchObject({review_status:original.review_status,lifecycle_status:original.lifecycle_status,current_version_id:original.current_version_id});
    expect(evidence.claims.find((claim:DbRow)=>claim.id===fixture.newBudgetId)).toMatchObject({review_status:'pending',lifecycle_status:candidate.lifecycle_status,current_version_id:candidate.current_version_id});
    expect(evidence.versions).toEqual(before.versions);
    expect(evidence.evidence).toEqual(before.evidence);
    expectExtractionUnchanged(fixture,extractionBefore);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    await page.screenshot({path:info.outputPath('unreviewed-candidate-adoption-undone.png'),fullPage:true});
  } finally {
    await page.close({runBeforeUnload:false}).catch(()=>undefined);
    fixture.cleanup();
  }
});
