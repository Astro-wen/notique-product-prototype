import { expect, test as base } from "@playwright/test";

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

test("a finished Summary opens once while facts continue without creating another Run", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^材料/ })).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  await expect(page.getByText("事实识别仍在后台", { exact: false })).toBeVisible();
  await expect(page.locator(".summary-trust-note")).toContainText("原文定位不代表语义已经核对");

  const nonWakeWrites = apiFixture.writes.filter(({ path }) => path !== "/api/v1/jobs/dispatch");
  expect(nonWakeWrites, "Summary-first navigation must not create or retry any paid Run").toEqual([]);
  for (const wake of apiFixture.writes) {
    expect(wake.path).toBe("/api/v1/jobs/dispatch");
    expect(wake.body).toMatchObject({ kind: "artifact" });
  }
});

test("the first completed snapshot opens Summary and a refresh restores it without another paid Run", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();

  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  await expect(page.getByText("事实识别已经完成", { exact: true })).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  expect(apiFixture.writes, "restoring Summary must remain a navigation-only action").toEqual([]);
});

test("an explicit workspace tab choice is never replaced when Summary finishes", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "结果", exact: true }).click();
  await expect(page.getByRole("button", { name: "结果", exact: true })).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(page.getByRole("button", { name: "先看 AI 摘要" })).toBeVisible();
  await expect(page.getByRole("button", { name: "结果", exact: true })).toHaveClass(/active/);
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

test("facts finishing preserves the open Summary and its scroll position", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  apiFixture.completeSummary();
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const lastSummaryItem = page.getByText("A 摘要背景 24", { exact: true });
  await lastSummaryItem.scrollIntoViewIfNeeded();
  const sourceScrollY = await page.evaluate(() => window.scrollY);
  expect(sourceScrollY).toBeGreaterThan(0);

  apiFixture.completeFacts();

  await expect(page.getByText("事实识别已经完成", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 60);
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

test("opening Raw from a Summary sentence stays on Raw when another reading artifact finishes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.getByRole("button", { name: /查看 1 段原文/ }).click();
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  apiFixture.completeReadableTranscript();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"), { timeout: 8_000 }).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  await expect(page.getByText("预算上限是 120 万美元。", { exact: true }).last()).toBeVisible();
});

test("an old Run without reading artifacts falls back to the original transcript", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "查看原始逐字稿" }).first()).toBeVisible();
  await page.getByRole("button", { name: "查看原始逐字稿" }).first().click();

  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: true })).toBeVisible();
  expect(apiFixture.writes).toEqual([]);
});

test("manual Raw selection replaces the route and survives reload from a Summary URL", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  await page.getByRole("button", { name: /^原始逐字稿/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^Transcript/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: true })).toBeVisible();
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
