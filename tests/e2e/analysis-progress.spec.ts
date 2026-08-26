import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = { apiFixture: NotiqueApiFixture };

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableAnalysisProgress();
    fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

test("fact analysis shows honest stage percentage and distance to review", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const card = page.getByRole("region", { name: "整组沟通处理" });
  await expect(card.getByRole("progressbar", { name: "本次事实分析进度" })).toHaveAttribute("value", "25");
  await expect(card).toContainText("已完成 1/4 步");

  const journey = page.getByTestId("analysis-progress-journey");
  await expect(journey).toBeHidden();
  await card.getByText("处理详情", { exact: true }).click();
  await expect(journey).toBeVisible();
  await expect(journey.locator(".analysis-progress-node.completed")).toHaveCount(1);
  await expect(journey.locator(".analysis-progress-node.processing")).toHaveCount(1);
  await expect(journey.locator(".analysis-progress-node.waiting")).toHaveCount(2);
  await expect(journey).toContainText("xhigh 处理中");
  await expect(journey).toContainText("还差 3 步即可开始核对");
  await expect(journey).toContainText("系统会自动继续，不需要手动启动后台任务");
  await expect(page.getByRole("button", { name: "正在处理，请稍候", exact: true })).toHaveCount(0);
});
