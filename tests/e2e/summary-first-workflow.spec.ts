import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = {
  apiFixture: NotiqueApiFixture;
};

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile-chromium";
}

async function openOperationsOnMobile(page: Page, testInfo: TestInfo): Promise<void> {
  if (!isMobile(testInfo)) return;
  await page.locator(".reader-mobile-switch").getByRole("button", { name: /^处理/ }).click();
}

test("a finished Summary opens once while facts continue without creating another Run", async ({ page, apiFixture }, testInfo) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^材料/ })).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  if (isMobile(testInfo)) await expect(page.locator(".reader-action-rail")).toBeHidden();
  else await expect(page.locator(".reader-action-rail")).toBeVisible();
  await expect(page.getByRole("button", { name: /连续核对/ })).toHaveCount(0);
  await expect(page.locator(".summary-trust-note")).toContainText("原文定位不代表语义已经核对");

  const nonWakeWrites = apiFixture.writes.filter(({ path }) => path !== "/api/v1/jobs/dispatch");
  expect(nonWakeWrites, "Summary-first navigation must not create or retry any paid Run").toEqual([]);
  for (const wake of apiFixture.writes) {
    expect(wake.path).toBe("/api/v1/jobs/dispatch");
    expect(wake.body).toMatchObject({ kind: "artifact" });
  }
});

test("the first completed snapshot opens Summary and a refresh restores it without another paid Run", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();

  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  await openOperationsOnMobile(page, testInfo);
  await page.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ }).click();
  await expect(page.getByRole("button", { name: /连续核对 .* 条/ })).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  expect(apiFixture.writes, "restoring Summary must remain a navigation-only action").toEqual([]);
});

test("an explicit workspace tab choice is never replaced when Summary finishes", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  const projectScope = page.getByRole("button", { name: "结果", exact: true });
  await projectScope.click();
  await expect(projectScope).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(page.getByRole("button", { name: "先看 AI 摘要" })).toBeVisible();
  await expect(projectScope).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toHaveCount(0);
  expect(apiFixture.writes).toEqual([]);
});

test("a completed Summary never closes an open direct-recording material interaction", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.addInitScript(() => {
    window.sessionStorage.setItem("notique.ui.public-workspace-acknowledged", "1");
  });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await page.getByRole("button", { name: "＋ 添加材料", exact: true }).click();
  await page.locator(".simple-import-action").filter({ hasText: "直接录音" }).click();
  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();

  apiFixture.completeSummary();

  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^材料/ })).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toHaveCount(0);
  expect(apiFixture.writes.filter(({ path }) => path !== "/api/v1/jobs/dispatch")).toEqual([]);
});

test("facts finishing preserves the open Summary and its scroll position", async ({ page, apiFixture }, testInfo) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  apiFixture.completeSummary();
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const lastSummaryItem = page.getByText("A 摘要背景 24", { exact: true });
  await lastSummaryItem.scrollIntoViewIfNeeded();
  const sourceScrollY = await page.evaluate(() => window.scrollY);
  expect(sourceScrollY).toBeGreaterThan(0);

  apiFixture.completeFacts();

  if (isMobile(testInfo)) {
    await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 60);
  }
  await openOperationsOnMobile(page, testInfo);
  await page.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ }).click();
  await expect(page.getByRole("button", { name: /连续核对 .* 条/ })).toBeVisible();
  if (isMobile(testInfo)) {
    await page.locator(".reader-mobile-switch").getByRole("button", { name: "阅读" }).click();
  }
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple/);
  if (!isMobile(testInfo)) {
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 60);
  }
});

test("a readable transcript is offered when Summary is unavailable", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  apiFixture.completeReadableTranscript();

  await expect(page.getByRole("button", { name: "先看易读稿" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^材料/ })).toHaveClass(/active/);
  await page.getByRole("button", { name: "先看易读稿" }).click();
  await expect(page.getByText("预算上限是 120 万美元。", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^易读逐字稿/ })).toHaveClass(/active/);
  expect(apiFixture.writes).toEqual([]);
});

test("a Summary sentence with two overlapping Claims requires an explicit choice", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded" });
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableSharedSummaryClaims();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await expect(target.getByRole("button", { name: "核对这条意思" })).toHaveCount(0);
  await target.getByText("查看相关待核对内容（2）", { exact: true }).click();
  await expect(target.getByRole("button", { name: /客户仍需确认 120 万美元是否包含装修预算/ })).toBeVisible();

  await target.getByRole("button", { name: /客户仍需确认 120 万美元是否包含装修预算/ }).click();
  await expect(page).toHaveURL(/view=claim.*claim=claim-summary-shared/);
  await expect(page.getByRole("heading", { name: "客户仍需确认 120 万美元是否包含装修预算", exact: true })).toBeVisible();
});

test("a Summary source drawer stays open when another reading artifact finishes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.getByRole("button", { name: /查看 1 段原文/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();

  apiFixture.completeReadableTranscript();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"), { timeout: 8_000 }).toBeGreaterThan(1);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "在完整原稿中打开" }).click();
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  const selectedSource = page.locator(".raw-artifact article.selected");
  await expect(selectedSource).toContainText("预算上限是 120 万美元。");
  await expect(selectedSource).toBeFocused();
});

test("a Summary point opens a persistent operation rail without covering the reader", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();

  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();
  await expect(rail).toContainText("录音与原话");
  await expect(page.locator(".source-drawer-backdrop")).toHaveCount(0);
  if (isMobile(testInfo)) {
    await expect(page.locator(".reader-reading-pane")).toBeHidden();
    await page.locator(".reader-mobile-switch").getByRole("button", { name: "阅读" }).click();
  }
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
});

test("chapter and speaker views stay selected while the Summary URL is synchronized", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const chapters = page.getByRole("button", { name: "章节", exact: true });
  await chapters.click();
  await expect(chapters).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "按主题快速回到上下文" })).toBeVisible();
  await expect(page).toHaveURL(/readingTab=summary/);

  const speakers = page.getByRole("button", { name: "发言人", exact: true });
  await speakers.click();
  await expect(speakers).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "先找到谁说了什么" })).toBeVisible();
});

test("mobile reading and operations use one pane at a time without horizontal overflow", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  await expect(page.locator(".reader-action-rail")).toBeVisible();
  await expect(page.locator(".reader-reading-pane")).toBeHidden();
  await page.locator(".reader-mobile-switch").getByRole("button", { name: "阅读" }).click();
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("briefly viewing sources keeps the selected point and warm transcript state", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  const transcriptReads = apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments");

  await page.getByRole("button", { name: /^材料/ }).click();
  await page.getByRole("button", { name: /^Transcript/ }).click();

  await expect(page.locator(".selected-point-card")).toContainText("预算上限是 120 万美元");
  expect(apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments")).toBe(transcriptReads);
});

test("an old Run without reading artifacts falls back to the original transcript", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "查看原始逐字稿" }).first()).toBeVisible();
  await page.getByRole("button", { name: "查看原始逐字稿" }).first().click();

  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: false })).toBeVisible();
  expect(apiFixture.writes).toEqual([]);
});

test("failed Summary and readable transcript fall back to Raw without exposing model error codes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "failed" });
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");

  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: false })).toBeVisible();
  await expect(page.getByText("MODEL_OUTPUT_INVALID", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /^AI 摘要/ }).click();
  await expect(page.getByRole("heading", { name: "AI 摘要未通过安全检查" })).toBeVisible();
  await expect(page.getByText("事实识别和原始逐字稿都已保留。", { exact: false })).toBeVisible();
  await expect(page.getByText("MODEL_OUTPUT_INVALID", { exact: true })).toHaveCount(0);
  expect(apiFixture.writes.filter(({ path }) => path !== "/api/v1/jobs/dispatch")).toEqual([]);
});

test("manual Raw selection replaces the route and survives reload from a Summary URL", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  await page.getByRole("button", { name: "查看完整逐字稿", exact: true }).click();
  await page.getByRole("button", { name: /^原始逐字稿/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: false })).toBeVisible();
});

test("manual Summary selection replaces the route and survives reload", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  await page.getByRole("button", { name: /^AI 摘要/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("button", { name: /^AI 摘要/ })).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
});

test("workspace Transcript selection is routed and leaving Transcript clears the reading tab", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Transcript/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  await page.getByRole("button", { name: /^材料/ }).click();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await expect(page.getByRole("button", { name: /^材料/ })).toHaveClass(/active/);
});

test("a new processing Summary Run never renders an older Run's Artifact", async ({ page, apiFixture }) => {
  apiFixture.enableNewSummaryRunWithStaleArtifact();
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByText("正在生成 AI 摘要", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toHaveCount(0);
  await expect(page.getByText("预算上限是 120 万美元", { exact: true })).toHaveCount(0);
});
