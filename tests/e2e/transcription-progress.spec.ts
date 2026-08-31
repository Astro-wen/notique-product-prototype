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

test("chunked transcription shows one calm progress bar and keeps numbered speakers", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const journey = page.getByTestId("transcription-journey");
  await expect(journey).toBeVisible();
  await expect(journey).toContainText("正在生成逐字稿 · 4/10 段");
  await expect(journey).toContainText("已完成 4/10 段；可以离开此页，结果会自动更新");
  await expect(journey).not.toContainText(/并行|等待空位|后端|浏览器最多|已用/);
  await expect(journey.locator(".transcription-chunk-node, .transcription-milestones")).toHaveCount(0);
  await expect(journey.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  await expect(page.getByRole("button", { name: "开始处理全部沟通", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^本次重点/ }).click();
  const transcriptMeta = page.getByTestId("transcript-turn-meta");
  await expect(transcriptMeta.getByText("Speaker 1", { exact: true })).toBeVisible();
  await expect(transcriptMeta.getByText("Speaker 2", { exact: true })).toBeVisible();
  await expect(transcriptMeta.getByText("Speaker 3", { exact: true })).toBeVisible();
  await expect(page.getByText("逐字稿已经可以开始阅读", { exact: true })).toBeVisible();
  await expect(page.getByText("(interrupt)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新启动分析", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("transcript-turn-body").first()).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("Raw readiness never overrides an explicit return to sources", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByTestId("transcription-journey")).toBeVisible();

  await page.getByRole("button", { name: /^本次重点/ }).click();
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  const sourcesTab = page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ });
  await sourcesTab.click();
  await expect(sourcesTab).toHaveClass(/active/);

  apiFixture.completeTranscriptionProgress();
  await expect.poll(
    () => apiFixture.completedReadCount("/api/v1/transcription-runs/transcription-a"),
    { timeout: 12_000 },
  ).toBeGreaterThan(1);
  await expect(page.locator(".simple-material-list .status-badge").filter({ hasText: "处理完成" })).toBeVisible();
  await expect(sourcesTab).toHaveClass(/active/);
  await expect(page.locator(".reading-tab-panel")).toBeHidden();
  await expect(page).not.toHaveURL(/readingTab=raw/);
});

test("terminal Run segments stay readable when both follow-up reading requests fail", async ({ page, apiFixture }) => {
  apiFixture.completeTranscriptionProgress({ failReadingRequests: true });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/, { timeout: 12_000 });
  await expect(page.getByTestId("transcript-turn")).toHaveCount(3);
  await expect(page.getByText("Opening.", { exact: true })).toBeVisible();
  await expect(page.locator(".reader-partial-error")).toContainText("已显示的内容仍可继续使用");
  await expect(page.getByText("Artifact reading is temporarily unavailable.", { exact: true })).toHaveCount(0);
});
