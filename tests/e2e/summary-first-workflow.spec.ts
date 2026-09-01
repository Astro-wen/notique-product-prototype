import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = {
  apiFixture: NotiqueApiFixture;
};

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
    // These are cheap wakes for Runs already persisted in the fixture, not
    // creation/retry mutations. Keep every other mutation blocked.
    fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
    await fixture.install(page);
    await provide(fixture);
    for (const wake of fixture.writes.filter(({ path }) => path === "/api/v1/jobs/dispatch")) {
      expect(wake.body).toMatchObject({ kind: expect.stringMatching(/^(artifact|extraction)$/) });
      expect(wake.body).toMatchObject({ run_id: expect.stringMatching(/^(artifact-run-|run-a$)/) });
    }
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

function nonWakeWrites(apiFixture: NotiqueApiFixture) {
  return apiFixture.writes.filter(({ path }) => path !== "/api/v1/jobs/dispatch");
}

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

async function expandSummaryIfCollapsed(page: Page): Promise<void> {
  await page.locator(".summary-overview-card.ready").waitFor({ state: "visible" });
  const expander = page.locator(".summary-expand-button");
  if (await expander.count() > 0 && await expander.getAttribute("aria-expanded") === "false") {
    await expander.click();
  }
}

test("Raw opens first and a finished Summary appears above it without stealing focus", async ({ page, apiFixture }, testInfo) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /^原文/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);

  apiFixture.completeSummary();

  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /^原文/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.locator(".reader-action-rail")).toBeVisible();
  if (isMobile(testInfo)) await expect(page.locator(".reader-action-rail")).toHaveAttribute("data-sheet", "peek");
  await expect(page.getByRole("button", { name: /连续核对/ })).toHaveCount(0);
  await expect(page.locator(".summary-trust-note")).toBeVisible();
  await expect(page.locator(".summary-trust-note")).toContainText("原文定位不代表语义已经核对");

  expect(nonWakeWrites(apiFixture), "Raw-first navigation must not create or retry any paid Run").toEqual([]);
  for (const wake of apiFixture.writes) {
    expect(wake.path).toBe("/api/v1/jobs/dispatch");
    expect(wake.body).toMatchObject({
      kind: expect.stringMatching(/^(?:artifact|extraction)$/),
      run_id: expect.stringMatching(/^(?:artifact-run-|run-)/),
    });
  }
});

test("the first completed snapshot opens Raw and a refresh restores it without another paid Run", async ({ page, apiFixture }, testInfo) => {
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
  expect(nonWakeWrites(apiFixture), "restoring Raw must remain a navigation-only action").toEqual([]);
});

test("an explicit workspace tab choice is never replaced when Summary finishes", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");
  const projectScope = page.getByRole("button", { name: "整个项目", exact: true });
  await projectScope.click();
  await expect(projectScope).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(projectScope).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toHaveCount(0);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a completed Summary never closes an open direct-recording material interaction", async ({ page, apiFixture }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("notique.ui.public-workspace-acknowledged", "1");
  });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");
  const materialsTab = page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ });
  await materialsTab.click();
  await expect(materialsTab).toHaveClass(/active/);
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

  const expandSummary = page.locator(".summary-expand-button");
  await expect(expandSummary).toHaveText("展开全部");
  await expandSummary.click();
  await expect(expandSummary).toHaveText("收起概要");
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

test("a readable transcript can be chosen when Summary is unavailable without replacing Raw", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  apiFixture.completeReadableTranscript();

  await expect(page.getByRole("button", { name: /^原文/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await page.getByRole("button", { name: /^易读版/ }).click();
  await expect(page.getByText("预算上限是 120 万美元。", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^易读版/ })).toHaveClass(/active/);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a Summary sentence with two overlapping Claims requires an explicit choice", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded" });
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableSharedSummaryClaims();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expandSummaryIfCollapsed(page);

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
  await expandSummaryIfCollapsed(page);

  await page.locator(".summary-point-copy").filter({ hasText: "预算上限是 120 万美元" }).click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();

  apiFixture.completeReadableTranscript();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"), { timeout: 8_000 }).toBeGreaterThan(1);
  await expect(rail.getByRole("heading", { name: "预算上限是 120 万美元" })).toBeVisible();
  await rail.getByRole("button", { name: "在逐字稿中定位" }).click();
  await expect(page.getByRole("button", { name: /^原文/ })).toHaveClass(/active/);
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  const selectedSource = page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元。" });
  await expect(selectedSource).toContainText("预算上限是 120 万美元。");
  await expect(selectedSource.getByTestId("transcript-turn-body")).toHaveAttribute("aria-pressed", "true");
  await expect(selectedSource).toBeFocused();
});

test("a Summary point opens a persistent operation rail without covering the reader", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

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
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments")).toBeGreaterThan(0);
  const targetParagraph = page.getByTestId("transcript-turn-body").filter({ hasText: "预算上限是 120 万美元" }).first();
  await expect(targetParagraph).toBeVisible();
  const paragraphText = await targetParagraph.locator("span").innerText();
  await targetParagraph.click();

  await expect(page.locator(".reader-action-rail .selected-point-card h3")).toHaveText(paragraphText);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
});

test("the summary and transcript are one continuous left-hand document without an extra transcript click", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableCompactTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");

  const readingDocument = page.locator(".reader-reading-scroll");
  const intelligence = page.locator(".reader-intelligence-heading");
  const summary = page.getByLabel("AI 摘要卡片");
  const transcriptToolbar = page.locator("#transcript-document");
  const turns = page.getByTestId("transcript-turn");

  await expect(intelligence).toContainText("智能速览");
  await expect(summary).toBeVisible();
  await expect(transcriptToolbar).toContainText("逐字稿");
  await expect(turns).toHaveCount(8);
  await expect(page.getByRole("navigation", { name: "逐字稿版本" }).getByRole("button", { name: /^原文/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "查看完整逐字稿", exact: true })).toHaveCount(0);

  const oneDocument = await readingDocument.evaluate((documentNode) => {
    const summaryNode = documentNode.querySelector('[aria-label="AI 摘要卡片"]');
    const transcriptNode = documentNode.querySelector("#transcript-document");
    const firstTurn = documentNode.querySelector('[data-testid="transcript-turn"]');
    if (!summaryNode || !transcriptNode || !firstTurn) return null;
    const summaryRect = summaryNode.getBoundingClientRect();
    const transcriptRect = transcriptNode.getBoundingClientRect();
    const firstTurnRect = firstTurn.getBoundingClientRect();
    return {
      summaryBeforeTranscript: summaryRect.top < transcriptRect.top,
      transcriptBeforeTurn: transcriptRect.top < firstTurnRect.top,
      transcriptOffset: transcriptRect.top - documentNode.getBoundingClientRect().top,
      containsAll: documentNode.contains(summaryNode) && documentNode.contains(transcriptNode) && documentNode.contains(firstTurn),
    };
  });
  expect(oneDocument).toMatchObject({ summaryBeforeTranscript: true, transcriptBeforeTurn: true, containsAll: true });
  expect(oneDocument?.transcriptOffset, "the collapsed intelligence section must leave the transcript body in the first reading viewport").toBeLessThanOrEqual(440);
});

test("the transcript is a compact continuous document with stable speaker identity", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableCompactTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");

  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(8);
  const geometry = await turns.evaluateAll((items) => items.slice(0, 6).map((item) => {
    const body = item.querySelector<HTMLElement>('[data-testid="transcript-turn-body"]');
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
      shadow: style?.boxShadow ?? "none",
      fontSize: Number.parseFloat(textStyle?.fontSize ?? "0"),
      lineHeight: Number.parseFloat(textStyle?.lineHeight ?? "0"),
    };
  }));

  expect(geometry[5].bottom - geometry[0].top, "six short turns should fit in a compact reading viewport").toBeLessThanOrEqual(isMobile(testInfo) ? 480 : 450);
  expect(geometry.every((turn) => turn.bodyHeight >= 44)).toBe(true);
  expect(geometry.every((turn) => turn.radius <= 2)).toBe(true);
  expect(geometry.every((turn) => turn.shadow === "none")).toBe(true);
  expect(geometry.every((turn) => turn.fontSize >= 14 && turn.lineHeight / turn.fontSize >= 1.45 && turn.lineHeight / turn.fontSize <= 1.75)).toBe(true);
  expect(Math.max(...geometry.map((turn) => turn.bodyX)) - Math.min(...geometry.map((turn) => turn.bodyX))).toBeLessThanOrEqual(1);
  for (let index = 1; index < geometry.length; index += 1) {
    expect(geometry[index].top - geometry[index - 1].bottom).toBeLessThanOrEqual(6);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));

  const speakerTones = await turns.evaluateAll((items) => items.map((item) => {
    const speaker = item.querySelector('[data-testid="transcript-turn-meta"] strong')?.textContent?.trim() ?? "";
    const mark = item.querySelector<HTMLElement>(".transcript-speaker-mark");
    const style = mark ? getComputedStyle(mark) : null;
    return { speaker, background: style?.backgroundColor ?? "", color: style?.color ?? "" };
  }));
  for (const speaker of new Set(speakerTones.map((tone) => tone.speaker))) {
    const tones = speakerTones.filter((tone) => tone.speaker === speaker).map((tone) => `${tone.background}|${tone.color}`);
    expect(new Set(tones).size, `${speaker} should keep one stable visual identity`).toBe(1);
  }
  expect(new Set(speakerTones.map((tone) => `${tone.background}|${tone.color}`)).size).toBeGreaterThan(1);

  await page.getByRole("button", { name: "搜索和筛选逐字稿" }).click();
  const search = page.getByPlaceholder("搜索原话");
  await expect(search).toBeVisible();
  await search.fill("Buyer detail 5");
  await expect(turns).toHaveCount(1);
  await search.fill("");
  await page.getByRole("button", { name: "搜索和筛选逐字稿" }).click();

  const readerWidth = await page.locator(".reader-reading-pane").evaluate((element) => element.getBoundingClientRect().width);
  await turns.nth(1).getByRole("button", { name: /Agent response 2/ }).click();
  await expect(page.locator(".reader-action-rail .selected-point-card")).toContainText("Agent response 2.");
  expect(await page.locator(".reader-reading-pane").evaluate((element) => element.getBoundingClientRect().width)).toBe(readerWidth);
});

test("390px keeps the continuous document usable and every primary transcript control touchable", async ({ page, apiFixture }, testInfo) => {
  test.skip(!isMobile(testInfo), "390px touch target assertion");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableCompactTranscript();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");

  const firstTurn = page.getByTestId("transcript-turn").first();
  const body = firstTurn.getByTestId("transcript-turn-body");
  const tools = page.getByRole("button", { name: "搜索和筛选逐字稿" });
  await expect(firstTurn).toBeVisible();

  // This import carries no recording, so its timestamp is a label. Offering a
  // permanently disabled play control instead only looks like a broken button.
  await expect(firstTurn.getByRole("button", { name: /前三秒播放/ })).toHaveCount(0);
  await expect(firstTurn.locator("time.transcript-turn-time").first()).toBeVisible();

  for (const [name, target] of [["原话", body], ["搜索与筛选", tools]] as const) {
    const box = await target.boundingBox();
    expect(box, `${name} control should have layout`).not.toBeNull();
    expect(box?.height ?? 0, `${name} control should be at least 40px high`).toBeGreaterThanOrEqual(40);
  }

  await body.click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toHaveAttribute("data-sheet", "open");
  const sheetToggle = rail.getByRole("button", { name: "收起本次操作" });
  const toggleBox = await sheetToggle.boundingBox();
  expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(40);
  expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(40);
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a chapter takes the reader to that moment in the transcript", async ({ page, apiFixture }, testInfo) => {
  test.skip(isMobile(testInfo), "desktop reading column");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");
  await page.getByRole("button", { name: "章节速览" }).first().click();
  await expect(page.getByRole("heading", { name: "按时间顺序回到原文" })).toBeVisible();

  // A chapter list is a table of contents: selecting an entry has to move the
  // document, not only fill the side panel.
  const before = await page.evaluate(() => window.scrollY);
  await page.locator(".reader-chapters article button").first().click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).toMatch(/^raw-group-/);
});

test("390px keeps every Summary point inside the visible reading column", async ({ page, apiFixture }, testInfo) => {
  test.skip(!isMobile(testInfo), "390px internal overflow assertion");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "succeeded" });
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");
  await expect(page.locator(".summary-overview-card.ready")).toBeVisible();
  await expandSummaryIfCollapsed(page);

  const summaryGeometry = await page.locator(".summary-card-content").evaluate((content) => {
    const contentRect = content.getBoundingClientRect();
    const pointRects = [...content.querySelectorAll<HTMLElement>(".summary-point-copy")]
      .map((point) => point.getBoundingClientRect());
    return {
      clientWidth: content.clientWidth,
      scrollWidth: content.scrollWidth,
      contentRight: contentRect.right,
      pointCount: pointRects.length,
      furthestPointRight: Math.max(contentRect.right, ...pointRects.map((rect) => rect.right)),
    };
  });
  expect(summaryGeometry.pointCount).toBeGreaterThan(1);
  expect(summaryGeometry.scrollWidth, "mobile Summary must not hide horizontally overflowing content").toBeLessThanOrEqual(summaryGeometry.clientWidth + 1);
  expect(summaryGeometry.furthestPointRight, "every Summary point must stay inside the visible Summary column").toBeLessThanOrEqual(summaryGeometry.contentRight + 1);

  await page.locator(".summary-point-copy").first().click();
  const selectedInset = await page.locator(".summary-reveal-line.selected").evaluate((selected) => {
    const point = selected.querySelector<HTMLElement>(".summary-point-copy");
    return point ? point.getBoundingClientRect().left - selected.getBoundingClientRect().left : 0;
  });
  expect(selectedInset, "the selection marker must not cover the first Summary character").toBeGreaterThanOrEqual(7);
});

test("a visible source can be confirmed in place without leaving the reading workspace", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/claims/claim-summary-pending/verdicts");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

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
  await expandSummaryIfCollapsed(page);

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
  await expandSummaryIfCollapsed(page);

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

  await page.getByRole("button", { name: "章节速览", exact: true }).click();
  await page.locator(".reader-chapters article").first().getByRole("button").click();
  await page.locator(".reader-action-rail").getByRole("button", { name: "从这条重点建立行动" }).click();

  const composer = page.locator(".reader-action-rail .rail-action-composer");
  await expect(composer).toContainText("已关联最相关的 8 段原话");
  await expect(composer.getByRole("textbox", { name: "要完成什么" })).toHaveValue("");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await composer.getByRole("button", { name: "取消" }).click();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("chapter and speaker insights stay selected above the same transcript document", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const topics = page.getByRole("button", { name: "章节速览", exact: true });
  await topics.click();
  await expect(topics).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "按时间顺序回到原文" })).toBeVisible();
  await expect(page).toHaveURL(/readingTab=summary/);

  await expect(page.locator("#transcript-document")).toBeVisible();

  const speakers = page.getByRole("button", { name: "发言总结", exact: true });
  await speakers.click();
  await expect(speakers).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "查看每位发言人的原话摘录" })).toBeVisible();
  const avatars = page.locator(".reader-speakers .speaker-avatar");
  await expect(avatars).toHaveCount(2);
  await expect(page.locator(".reader-speakers .speaker-avatar svg")).toHaveCount(2);
  expect(await avatars.allTextContents()).toEqual(["", ""]);
  await expect(page.locator("#transcript-document")).toBeVisible();
});

test("mobile operations open as a bottom sheet without replacing the reader", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

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
  await expandSummaryIfCollapsed(page);

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
  await expandSummaryIfCollapsed(page);
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

  await expect(page.getByRole("button", { name: /^原文/ })).toHaveClass(/active/);
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: false })).toBeVisible();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("failed Summary and readable transcript fall back to Raw without exposing model error codes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "failed" });
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");

  await expect(page.getByRole("button", { name: /^原文/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: false })).toBeVisible();
  await expect(page.getByText("MODEL_OUTPUT_INVALID", { exact: true })).toHaveCount(0);

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

  await page.getByRole("button", { name: /^原文/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^原文/ })).toHaveClass(/active/);

  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /^原文/ })).toHaveClass(/active/);
  await expect(page.locator(".raw-artifact").getByText("预算上限是 120 万美元。", { exact: false })).toBeVisible();
});

test("a Summary deep link restores the pinned intelligence and transcript in one document", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("button", { name: "AI 摘要 · 全文概要" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.locator("#transcript-document")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("button", { name: "AI 摘要 · 全文概要" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.locator("#transcript-document")).toBeVisible();
});

test("workspace Transcript selection is routed and leaving Transcript clears the reading tab", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");

  await page.getByRole("button", { name: /^本次重点/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);
  await expect(page.getByRole("button", { name: /^原文/ })).toHaveClass(/active/);

  await page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ }).click();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^来源/ })).toHaveClass(/active/);
});

test("a new processing Summary Run never renders an older Run's Artifact", async ({ page, apiFixture }) => {
  apiFixture.enableNewSummaryRunWithStaleArtifact();
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.getByRole("combobox", { name: "选择当前沟通" })).toHaveValue("event-a");

  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByText("正在整理全文概要", { exact: true })).toBeVisible();
  await expect(page.locator("#transcript-document")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toHaveCount(0);
  await expect(page.getByText("预算上限是 120 万美元", { exact: true })).toHaveCount(0);
});
