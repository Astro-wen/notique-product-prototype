import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = { apiFixture: NotiqueApiFixture };

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableAnalysisProgress();
    fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
    // 打开项目会写一次 last_opened_at，是读取路径的一部分，不是被测行为产生的写。
    fixture.allowMutation("POST", "/api/v1/projects/project-a/opened");
    fixture.allowMutation("POST", "/api/v1/projects/project-b/opened");
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

test("fact analysis stays in the background without a fake percentage", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const progress = page.getByRole("region", { name: "记录整理进度" });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("正在整理这份记录");
  await expect(page.getByRole("button", { name: "重新整理", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "查看原文", exact: true })).toBeEnabled();
  await expect(progress.getByRole("progressbar")).toHaveCount(0);
  await expect(progress).not.toContainText(/\d+%|已完成 \d+\/\d+ 步/);

  // V2 starts with the useful record. Raw remains one explicit click away while analysis runs.
  await page.getByRole("button", { name: "查看原文", exact: true }).click();

  const reader = page.getByRole("region", { name: "逐字稿阅读区" });
  await expect(reader).toBeVisible();
  // 阅读视图还没写完时显示转圈和「内容生成中」，原文照样能读。
  await expect(reader).toContainText("内容生成中…");
  await expect(reader.getByTestId("transcript-turn").first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "本次事实分析进度" })).toHaveCount(0);
  await expect(reader).not.toContainText(/\d+%|已完成 \d+\/\d+ 步/);

  await expect(page.getByText("处理详情", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("analysis-progress-journey")).toHaveCount(0);
  await expect(page.getByText(/xhigh|reasoning effort|复用 .*tokens|后端会保存进度/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "正在处理，请稍候", exact: true })).toHaveCount(0);
});
