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
  const rail = page.locator(".reader-action-rail");
  if (await rail.getAttribute("data-sheet") === "peek") {
    await rail.getByRole("button", { name: "展开本次操作" }).click();
  }
}

test("a finished Summary opens once while facts continue without creating another Run", async ({ page, apiFixture }, testInfo) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ })).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  await expect(page.locator(".reader-action-rail")).toBeVisible();
  if (isMobile(testInfo)) await expect(page.locator(".reader-action-rail")).toHaveAttribute("data-sheet", "peek");
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
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  await page.locator(".meeting-tabs").getByRole("button", { name: /^待确认/ }).click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ })).toHaveAttribute("aria-pressed", "true");
  await expect(rail.getByRole("button", { name: "从第一条开始确认" })).toBeVisible();
  await rail.locator(".rail-pending-list").getByText("预算上限是 120 万美元", { exact: true }).click();
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();
  await expect(rail).toContainText("预算上限是 120 万美元。");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=simple(?!.*claim=)/);
  await expect(page.locator(".draft-actions")).toHaveCount(0);
  if (!isMobile(testInfo)) await expect(page.locator(".reader-reading-pane")).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  expect(apiFixture.writes, "restoring Summary must remain a navigation-only action").toEqual([]);
});

test("an explicit workspace tab choice is never replaced when Summary finishes", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");
  const projectScope = page.getByRole("button", { name: "整个项目", exact: true });
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
  await page.getByRole("button", { name: "添加材料", exact: true }).click();
  await page.locator(".simple-import-action").filter({ hasText: "直接录音" }).click();
  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();

  apiFixture.completeSummary();

  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ })).toHaveClass(/active/);
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
  const sourceScrollY = await page.evaluate((mobile) => mobile
    ? window.scrollY
    : (document.querySelector(".reader-reading-scroll")?.scrollTop ?? 0), isMobile(testInfo));
  expect(sourceScrollY).toBeGreaterThan(0);

  apiFixture.completeFacts();

  if (isMobile(testInfo)) {
    await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 60);
  }
  await openOperationsOnMobile(page, testInfo);
  await page.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ }).click();
  await expect(page.getByRole("button", { name: "从第一条开始确认" })).toBeVisible();
  if (isMobile(testInfo)) {
    await page.locator(".reader-action-rail").getByRole("button", { name: "收起本次操作" }).click();
  }
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple/);
  if (!isMobile(testInfo)) {
    await expect.poll(() => page.evaluate(() => document.querySelector(".reader-reading-scroll")?.scrollTop ?? 0)).toBeGreaterThanOrEqual(sourceScrollY - 60);
  }
});

test("a readable transcript is offered when Summary is unavailable", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  apiFixture.completeReadableTranscript();

  await expect(page.getByRole("button", { name: "先看易读稿" })).toBeVisible();
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ })).toHaveClass(/active/);
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
  await expect(page).toHaveURL(/view=simple/);
  await expect(page.locator(".reader-action-rail").getByRole("heading", { name: "客户仍需确认 120 万美元是否包含装修预算", exact: true })).toBeVisible();
});

test("the source rail stays open when another reading artifact finishes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  await page.locator(".summary-point-copy").filter({ hasText: "预算上限是 120 万美元" }).click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();

  apiFixture.completeReadableTranscript();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"), { timeout: 8_000 }).toBeGreaterThan(1);
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();
  await rail.getByRole("button", { name: "在逐字稿中定位" }).click();
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

  await page.locator(".summary-point-copy").filter({ hasText: "预算上限是 120 万美元" }).click();

  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();
  await expect(rail).toContainText("录音与原话");
  await expect(page.locator(".source-drawer-backdrop")).toHaveCount(0);
  if (isMobile(testInfo)) {
    await expect(page.locator(".reader-reading-pane")).toBeVisible();
    await expect(rail).toHaveAttribute("data-sheet", "open");
    await rail.getByRole("button", { name: "收起本次操作" }).click();
    await expect(rail).toHaveAttribute("data-sheet", "peek");
  }
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
});

test("a raw transcript paragraph can be handled in the rail without a detour", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await page.getByRole("button", { name: "逐字稿", exact: true }).click();
  await page.getByRole("button", { name: /^原始逐字稿/ }).click();
  const firstParagraph = page.locator(".raw-artifact .transcript-copy-button").first();
  const paragraphText = await firstParagraph.locator("span").innerText();
  await firstParagraph.click();

  await expect(page.locator(".reader-action-rail .selected-point-card h3")).toHaveText(paragraphText);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
});

test("the transcript is a compact continuous document instead of a stack of modules", async ({ page, apiFixture }, testInfo) => {
  apiFixture.enableLegacyRawFlow();
  apiFixture.enableCompactTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await page.getByRole("button", { name: "查看原始逐字稿" }).first().click();
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(8);
  const geometry = await turns.evaluateAll((items) => items.slice(0, 6).map((item) => {
    const body = item.querySelector<HTMLElement>(".transcript-copy-button");
    const rect = item.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const style = body ? getComputedStyle(body) : null;
    const text = body?.querySelector<HTMLElement>("span");
    const textStyle = text ? getComputedStyle(text) : null;
    return {
      top: rect.top,
      bottom: rect.bottom,
      bodyX: bodyRect?.x ?? 0,
      bodyHeight: bodyRect?.height ?? 0,
      radius: Number.parseFloat(style?.borderRadius ?? "0"),
      fontSize: Number.parseFloat(textStyle?.fontSize ?? "0"),
      lineHeight: Number.parseFloat(textStyle?.lineHeight ?? "0"),
    };
  }));

  expect(geometry[5].bottom - geometry[0].top, "six short turns should fit in a compact reading viewport").toBeLessThanOrEqual(isMobile(testInfo) ? 520 : 510);
  expect(geometry.every((turn) => turn.bodyHeight >= 44)).toBe(true);
  expect(geometry.every((turn) => turn.radius <= 8)).toBe(true);
  expect(geometry.every((turn) => turn.fontSize >= 14 && turn.lineHeight / turn.fontSize >= 1.45 && turn.lineHeight / turn.fontSize <= 1.75)).toBe(true);
  expect(Math.max(...geometry.map((turn) => turn.bodyX)) - Math.min(...geometry.map((turn) => turn.bodyX))).toBeLessThanOrEqual(1);
  for (let index = 1; index < geometry.length; index += 1) {
    expect(geometry[index].top - geometry[index - 1].bottom).toBeLessThanOrEqual(6);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));

  await page.locator("details.transcript-tools > summary").click();
  const search = page.getByPlaceholder("搜索原话");
  await expect(search).toBeVisible();
  await search.fill("Buyer detail 5");
  await expect(turns).toHaveCount(1);
  await search.fill("");
  await page.locator("details.transcript-tools > summary").click();

  const readerWidth = await page.locator(".reader-reading-pane").evaluate((element) => element.getBoundingClientRect().width);
  await turns.nth(1).getByRole("button", { name: /Agent response 2/ }).click();
  await expect(page.locator(".reader-action-rail .selected-point-card")).toContainText("Agent response 2.");
  expect(await page.locator(".reader-reading-pane").evaluate((element) => element.getBoundingClientRect().width)).toBe(readerWidth);
});

test("a visible source can be confirmed in place without leaving the reading workspace", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/claims/claim-summary-pending/verdicts");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail.getByText("预算上限是 120 万美元", { exact: true }).last()).toBeVisible();
  await expect(rail.locator(".point-trust-state.pending")).toHaveText("需确认");
  await expect(rail.locator(".rail-review-row .status-badge.warning")).toHaveText("待确认");
  await rail.getByRole("button", { name: "确认", exact: true }).click();

  await expect(rail.locator(".point-trust-state.verified")).toHaveText("已确认");
  await expect(rail.locator(".rail-review-row .status-badge.success")).toHaveText("已确认");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
  expect(apiFixture.writes.find(({ path }) => path.endsWith("/claim-summary-pending/verdicts"))?.body).toMatchObject({
    action: "confirm",
    retain_relation_ids: [],
  });
});

test("an incompletely displayed source cannot be quick-confirmed", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableIncompleteSummaryEvidence();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await page.locator(".summary-point-copy").filter({ hasText: "预算上限是 120 万美元" }).click();
  const rail = page.locator(".reader-action-rail");
  const row = rail.locator(".rail-review-row").filter({ hasText: "预算上限是 120 万美元" });
  await expect(row.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
  await expect(row).toContainText("这条还需补证据或判断与旧记录的关系");
  await expect(row.getByRole("button", { name: "打开详情核对" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple(?!.*claim=)/);
  expect(apiFixture.writes.some(({ path }) => path.includes("/verdicts"))).toBe(false);
});

test("a Summary fact seeds source context but requires a real action and stays in the workspace", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/events/event-a/manual-claims");
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  await page.locator(".reader-action-rail").getByRole("button", { name: "从这条重点建立行动" }).click();

  const composer = page.locator(".reader-action-rail .rail-action-composer");
  const actionInput = composer.getByRole("textbox", { name: "要完成什么" });
  await expect(actionInput).toHaveValue("");
  await expect(composer).toContainText("已关联 1 段原话");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await actionInput.fill("负责人周五前确认预算是否包含装修费用");
  await composer.getByRole("button", { name: "加入待确认" }).click();

  await expect(composer).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
  await expect(page.getByText("负责人周五前确认预算是否包含装修费用", { exact: true })).toBeVisible();
  await expect(page.locator(".reader-action-rail")).toContainText("本次分析完成后才可确认、修改或不采纳");
  const pendingAction = page.locator(".rail-review-row").filter({ hasText: "负责人周五前确认预算是否包含装修费用" });
  await expect(pendingAction.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
  await expect(pendingAction.getByRole("button", { name: "不采纳", exact: true })).toBeDisabled();
  await expect(pendingAction.getByRole("button", { name: "修改", exact: true })).toBeDisabled();

  await pendingAction.locator(".rail-review-item").click();
  await expect(page.getByText("分析仍在整理这次沟通", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并加入正式结果" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "修改后确认" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "不采纳这条记录" })).toBeDisabled();
  const write = apiFixture.writes.find(({ path }) => path === "/api/v1/events/event-a/manual-claims");
  expect(write?.body).toMatchObject({
    statement: "负责人周五前确认预算是否包含装修费用",
    type: "next_action",
    segment_ids: ["seg-summary-target"],
  });
  expect(apiFixture.writes.some(({ path }) => path.includes("/verdicts"))).toBe(false);
  expect(apiFixture.writes.some(({ path }) => path.includes("review-sessions"))).toBe(false);
});

test("a topic with more than eight sources stays in the rail with bounded evidence", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await page.getByRole("button", { name: "按类型", exact: true }).click();
  await page.locator(".reader-chapters article").first().getByRole("button").click();
  await page.locator(".reader-action-rail").getByRole("button", { name: "从这条重点建立行动" }).click();

  const composer = page.locator(".reader-action-rail .rail-action-composer");
  await expect(composer).toContainText("已关联最相关的 8 段原话");
  await expect(composer.getByRole("textbox", { name: "要完成什么" })).toHaveValue("");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await composer.getByRole("button", { name: "取消" }).click();
  expect(apiFixture.writes).toEqual([]);
});

test("topic and speaker views stay selected while the Summary URL is synchronized", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const topics = page.getByRole("button", { name: "按类型", exact: true });
  await topics.click();
  await expect(topics).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "按信息类型快速回到上下文" })).toBeVisible();
  await expect(page).toHaveURL(/readingTab=summary/);

  const speakers = page.getByRole("button", { name: "按发言人", exact: true });
  await speakers.click();
  await expect(speakers).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "查看每位发言人的原话摘录" })).toBeVisible();
  const avatars = page.locator(".reader-speakers .speaker-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(page.locator(".reader-speakers .speaker-avatar svg")).toHaveCount(2);
  expect(await avatars.allTextContents()).toEqual(["", ""]);
});

test("mobile operations open as a bottom sheet without replacing the reader", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("data-sheet", "open");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  await rail.getByRole("button", { name: "收起本次操作" }).click();
  await expect(rail).toHaveAttribute("data-sheet", "peek");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("tablet operations stay reachable as a sheet instead of falling below the transcript", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toHaveAttribute("data-sheet", "open");
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();
  await expect(rail).toHaveCSS("position", "fixed");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
});

test("briefly viewing sources keeps the selected point and warm transcript state", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.locator(".summary-point-copy").click();
  const transcriptReads = apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments");

  await page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ }).click();
  await page.getByRole("button", { name: /^本次重点/ }).click();

  await expect(page.locator(".selected-point-card")).toContainText("预算上限是 120 万美元");
  expect(apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments")).toBe(transcriptReads);
});

test("an old Run without reading artifacts falls back to the original transcript", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");

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
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
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
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");

  await page.getByRole("button", { name: /^本次重点/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^原始逐字稿/ })).toHaveClass(/active/);

  await page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ }).click();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ })).toHaveClass(/active/);
});

test("a new processing Summary Run never renders an older Run's Artifact", async ({ page, apiFixture }) => {
  apiFixture.enableNewSummaryRunWithStaleArtifact();
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");

  await page.getByRole("button", { name: /^本次重点/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByText("正在生成 AI 摘要", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toHaveCount(0);
  await expect(page.getByText("预算上限是 120 万美元", { exact: true })).toHaveCount(0);
});
