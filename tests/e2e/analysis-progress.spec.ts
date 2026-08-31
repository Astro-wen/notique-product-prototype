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

test("fact analysis stays in the background without a fake percentage", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const reader = page.getByRole("region", { name: "逐字稿阅读区" });
  await expect(reader).toBeVisible();
  await expect(reader).toContainText("正在整理，原文已可阅读");
  await expect(reader.getByRole("button", { name: /^原文/ })).toHaveAttribute("aria-pressed", "true");
  await expect(reader.getByTestId("transcript-turn").first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "本次事实分析进度" })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText(/\d+%|已完成 \d+\/\d+ 步/);

  await expect(page.getByText("处理详情", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("analysis-progress-journey")).toHaveCount(0);
  await expect(page.getByText(/xhigh|reasoning effort|复用 .*tokens|后端会保存进度/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "正在处理，请稍候", exact: true })).toHaveCount(0);
});
