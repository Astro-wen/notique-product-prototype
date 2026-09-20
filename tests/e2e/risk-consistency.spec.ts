import { expect, test } from '@playwright/test';
import { NotiqueApiFixture } from './notique-api-fixture';

for (const hasContradiction of [false,true]) {
  test(`brief and risk view agree when contradiction=${hasContradiction}`, async ({page}) => {
    const fixture = new NotiqueApiFixture();
    await fixture.install(page);
    const contradiction = {relationId:'conflict-1',sourceClaimId:'new',targetClaimId:'old',sourceClaimVersionId:'new-v1',targetClaimVersionId:'old-v1',sourceStatement:'预算为 120 万美元',targetStatement:'预算为 100 万美元',sourceEvidenceRefIds:[],targetEvidenceRefIds:[]};
    const respond = (data:unknown) => ({json:{data,request_id:'risk-consistency'}});
    await page.route('**/api/v1/projects/project-a/brief-card', route=>route.fulfill(respond({brief_card:{stateClaimId:'claim-timeline-verified',deltaItemIds:[],agendaItemIds:['question-1'],riskClaimId:null,riskRelationId:hasContradiction?'conflict-1':null,missingSlotCount:0}})));
    await page.route('**/api/v1/projects/project-a/next-meeting-agenda',route=>route.fulfill(respond({agenda:{items:[{id:'question-1',sourceKind:'open_question',claimId:'question',statement:'哪些房源有合法 ADU？'}]}})));
    await page.route('**/api/v1/projects/project-a/views/risks',route=>route.fulfill(respond({view:{claims:[],contradictions:hasContradiction?[contradiction]:[]}})));
    await page.goto('/?project=project-a&view=results&tab=brief-card');
    const riskCard=page.locator('.brief-group').filter({has:page.getByRole('heading',{name:'风险与未解决矛盾'})});
    await expect(riskCard).toBeVisible();
    await expect(riskCard).not.toContainText('哪些房源有合法 ADU');
    await expect(page.locator('.brief-group').filter({has:page.getByRole('heading',{name:'下次要问'})})).toContainText('哪些房源有合法 ADU');
    if (hasContradiction) {
      await expect(riskCard).toContainText('预算为 120 万美元');
      await expect(riskCard).toContainText('预算为 100 万美元');
      await riskCard.getByRole('button',{name:'查看矛盾与双方来源'}).click();
      await expect(page).toHaveURL(/tab=risks/);
      await expect(page.locator('.contradiction-list')).toContainText('预算为 120 万美元');
    } else {
      await expect(riskCard).toContainText('暂无已确认风险或未解决矛盾');
      await page.locator('.result-nav-secondary > summary').click();
      await page.locator('.result-nav-secondary').getByRole('button',{name:'风险与矛盾'}).click();
      await expect(page.getByText('目前没有已确认的风险或未解决矛盾',{exact:true})).toBeVisible();
    }
    expect(fixture.writes.filter(write=>!['/api/v1/jobs/dispatch','/api/v1/projects/project-a/opened'].includes(write.path))).toEqual([]);
  });
}
