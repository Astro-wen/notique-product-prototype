import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = { apiFixture: NotiqueApiFixture };

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
    fixture.allowMutation("POST", "/api/v1/projects/project-a/opened");
    await fixture.install(page);
    await provide(fixture);
  }, { auto: true }],
});

const routes = [
  { name: "workspace", url: "/?project=project-a&event=event-a&view=simple" },
  { name: "project overview", url: "/?project=project-a&view=results&tab=client-progress" },
  { name: "timeline", url: "/?project=project-a&view=results&tab=timeline" },
  { name: "brief", url: "/?project=project-a&view=results&tab=brief-card" },
  { name: "project list", url: "/?view=projects" },
];

for (const route of routes) {
  test(`${route.name} never scrolls the page sideways`, async ({ page }) => {
    await page.goto(route.url);
    await page.waitForLoadState("networkidle");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      overflow.scrollWidth,
      `${overflow.scrollWidth}px of content in a ${overflow.innerWidth}px viewport`,
    ).toBeLessThanOrEqual(overflow.innerWidth + 1);
  });
}

test("workspace controls keep readable text for mouse and keyboard use", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await page.waitForLoadState("networkidle");

  const offenders = await page.evaluate(() => {
    const bad: string[] = [];
    for (const node of Array.from(document.querySelectorAll("button, a[href], summary"))) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = Number.parseFloat(getComputedStyle(node).fontSize);
      if (size < 11) bad.push(`${node.textContent?.trim().slice(0, 24) || node.nodeName} @ ${size}px`);
    }
    return bad;
  });
  expect(offenders, "controls below 11px are not readable").toEqual([]);
});

test("the desktop record uses one wide column and follows the user's sidebar preference", async ({ page, apiFixture }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "desktop workspace assertion");

  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: /^本次重点/ })).toBeVisible();
  await expect(page.getByTestId("bullet-claim-summary-pending")).toBeVisible();
  await expect(page.locator(".reader-action-rail")).toHaveCount(0);
  await expect(page.locator(".reader-reading-pane")).toHaveCount(0);

  const measure = () => page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    const record = document.querySelector('[data-testid="bullet-claim-summary-pending"]')?.closest("section")?.getBoundingClientRect();
    const bullets = Array.from(document.querySelectorAll('[data-testid^="bullet-"]')).map(node => node.getBoundingClientRect());
    const visibleSidebarLabels = Array.from(document.querySelectorAll(".sidebar .sidebar-label"))
      .filter((node) => getComputedStyle(node).display !== "none")
      .map((node) => node.textContent?.trim());
    return {
      sidebarWidth: sidebar?.width ?? 0,
      recordWidth: record?.width ?? 0,
      recordLeft: record?.left ?? 0,
      recordRight: record?.right ?? 0,
      bulletWidths: bullets.map(bullet => bullet.width),
      bulletLefts: bullets.map(bullet => bullet.left),
      viewportWidth: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      visibleSidebarLabels,
    };
  });
  const assertWorkspace = (layout: Awaited<ReturnType<typeof measure>>) => {
    expect(layout.recordWidth).toBeGreaterThanOrEqual(800);
    expect(layout.recordLeft).toBeGreaterThanOrEqual(layout.sidebarWidth);
    expect(layout.recordRight).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.bulletWidths.length).toBeGreaterThan(0);
    for (const width of layout.bulletWidths) expect(width).toBeGreaterThanOrEqual(layout.recordWidth - 70);
    for (const left of layout.bulletLefts) expect(Math.abs(left - layout.bulletLefts[0])).toBeLessThanOrEqual(1);
    expect(layout.overflow).toBeLessThanOrEqual(1);
  };

  const expanded = await measure();
  expect(expanded.sidebarWidth).toBeGreaterThanOrEqual(200);
  expect(expanded.visibleSidebarLabels.length).toBeGreaterThan(0);
  assertWorkspace(expanded);

  await page.getByRole("button", { name: "收起侧栏" }).click();
  await expect.poll(() => page.locator(".sidebar").evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(72);
  const collapsed = await measure();
  expect(collapsed.visibleSidebarLabels).toEqual([]);
  assertWorkspace(collapsed);
  expect(collapsed.recordWidth).toBeGreaterThan(expanded.recordWidth);

  await page.reload();
  await expect(page.getByRole("heading", { name: /^本次重点/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  await expect.poll(async () => (await measure()).sidebarWidth).toBeLessThanOrEqual(72);
  assertWorkspace(await measure());
  await page.screenshot({ path: testInfo.outputPath("record-column-collapsed.png") });
});

test("the PC source reader fills one column and keeps its toolbar reachable", async ({ page, apiFixture }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "intermediate desktop breakpoint assertion");

  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await page.getByRole("button", { name: "查看原文", exact: true }).click();
  await expect(page.locator(".reader-workspace-layout.is-source-only")).toBeVisible();
  await expect(page.locator(".reader-action-rail")).toHaveCount(0);
  await expect(page.locator(".reader-extra-views")).not.toHaveAttribute("open");
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  await page.locator(".transcript-document-toolbar").scrollIntoViewIfNeeded();

  const geometry = await page.evaluate(() => {
    const reader = document.querySelector(".reader-reading-pane")?.getBoundingClientRect();
    const canvas = document.querySelector(".reader-workspace-layout")?.getBoundingClientRect();
    const toolbar = document.querySelector(".transcript-document-toolbar")?.getBoundingClientRect();
    const controlsUsable = Array.from(document.querySelectorAll<HTMLElement>(".transcript-document-toolbar button, .transcript-document-toolbar summary"))
      .filter((control) => control.getBoundingClientRect().width > 0)
      .every((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === control || Boolean(hit && control.contains(hit));
      });
    return {
      reader: reader ? { left: reader.left, right: reader.right, width: reader.width } : null,
      canvas: canvas ? { left: canvas.left, right: canvas.right, width: canvas.width, bottom: canvas.bottom } : null,
      toolbar: toolbar ? { top: toolbar.top, bottom: toolbar.bottom } : null,
      viewportHeight: innerHeight,
      controlsUsable,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(geometry.reader).not.toBeNull();
  expect(geometry.canvas).not.toBeNull();
  expect(Math.abs((geometry.canvas?.left ?? 0) - (geometry.reader?.left ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((geometry.canvas?.right ?? 0) - (geometry.reader?.right ?? 0))).toBeLessThanOrEqual(1);
  expect(geometry.reader?.width ?? 0).toBeGreaterThanOrEqual(900);
  expect(geometry.canvas?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.toolbar?.top ?? -1).toBeGreaterThanOrEqual(0);
  expect(geometry.toolbar?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.controlsUsable).toBe(true);
  expect(geometry.overflow).toBeLessThanOrEqual(1);

  const tools = page.getByRole("button", { name: "搜索和筛选逐字稿", exact: true });
  await tools.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("textbox", { name: "搜索逐字稿", exact: true });
  await expect(search).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await search.fill("预算上限");
  await expect(page.getByTestId("transcript-turn-body")).toHaveCount(1);
  await expect(page.getByTestId("transcript-turn-body")).toContainText("预算上限是 120 万美元");
  expect(await page.getByTestId("transcript-turn-body").locator("span").evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
  await search.clear();
  await tools.click();
  await page.getByRole("button", { name: "导出逐字稿", exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导出逐字稿", exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("source-column-toolbar.png") });
});

test("same-page edit has readable targets and works with the keyboard", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const bullet = page.getByTestId("bullet-claim-summary-pending");
  const edit = bullet.getByRole("button", { name: "改一下", exact: true });
  await expect(edit).toBeVisible();
  const target = await edit.boundingBox();
  expect(target?.height ?? 0).toBeGreaterThanOrEqual(32);
  expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
  await edit.focus();
  await page.keyboard.press("Enter");
  const input = bullet.getByRole("textbox", { name: "修改重点", exact: true });
  await expect(input).toBeFocused();
  expect(await input.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  await page.keyboard.press("Tab");
  await expect(bullet.getByRole("combobox", { name: "修改依据" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bullet.getByRole("button", { name: "保存修改", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bullet.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(bullet).toContainText("预算上限是 120 万美元");
  expect(apiFixture.writes.filter(write => !["/api/v1/jobs/dispatch", "/api/v1/projects/project-a/opened", "/api/v2/events/event-a/review-progress"].includes(write.path))).toEqual([]);
});

test("the mobile first viewport keeps transcript controls and body visible above the operation sheet", async ({ page, apiFixture }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile overlap assertion");

  await page.setViewportSize({ width: 390, height: 844 });
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rail = document.querySelector(".reader-action-rail")?.getBoundingClientRect();
    const toolbar = document.querySelector(".transcript-document-toolbar")?.getBoundingClientRect();
    const firstTurn = document.querySelector('[data-testid="transcript-turn"]')?.getBoundingClientRect();
    const controlsUsable = Array.from(document.querySelectorAll<HTMLElement>(".transcript-document-toolbar button, .transcript-document-toolbar summary"))
      .filter((control) => control.getBoundingClientRect().width > 0)
      .every((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === control || Boolean(hit && control.contains(hit));
      });
    return {
      railTop: rail?.top ?? 0,
      toolbarBottom: toolbar?.bottom ?? Number.POSITIVE_INFINITY,
      firstTurnTop: firstTurn?.top ?? Number.POSITIVE_INFINITY,
      controlsUsable,
    };
  });

  expect(geometry.toolbarBottom).toBeLessThanOrEqual(geometry.railTop + 1);
  expect(geometry.firstTurnTop).toBeLessThanOrEqual(geometry.railTop - 44);
  expect(geometry.controlsUsable).toBe(true);
});

test("the workspace reaches its content without a screenful of chrome", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile shell assertion");

  await page.goto("/?project=project-a&event=event-a&view=simple");
  await page.waitForLoadState("networkidle");

  // The context card once stacked an identity line, two labelled selects and
  // two full-width actions, so the first tab sat 661px down a 375px screen.
  const tabsTop = await page.evaluate(() => {
    const tabs = document.querySelector(".meeting-tabs");
    return tabs ? tabs.getBoundingClientRect().top + window.scrollY : -1;
  });
  expect(tabsTop).toBeGreaterThan(0);
  expect(tabsTop, `${tabsTop}px of chrome before the first tab`).toBeLessThan(560);
});
