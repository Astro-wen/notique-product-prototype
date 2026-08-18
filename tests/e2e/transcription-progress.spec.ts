import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = { apiFixture: NotiqueApiFixture };

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableTranscriptionProgress();
    fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

test("chunked transcription shows percentage, nodes, remaining work, and numbered speakers", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const journey = page.getByTestId("transcription-journey");
  await expect(journey).toBeVisible();
  await expect(journey).toContainText("正在分段并行识别说话人和时间点");
  await expect(journey).toContainText("已完成 4/10 段 · 40%");
  await expect(journey).toContainText("还差 6 段完成识别");
  await expect(journey.locator(".transcription-chunk-node.completed")).toHaveCount(4);
  await expect(journey.locator(".transcription-chunk-node.processing")).toHaveCount(3);
  await expect(journey.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");

  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^原始逐字稿/ }).click();
  await expect(page.getByText("Speaker 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Speaker 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Speaker 3", { exact: true })).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
});
