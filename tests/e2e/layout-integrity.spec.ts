import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = { apiFixture: NotiqueApiFixture };

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
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

test("no control is smaller than a readable, tappable target", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await page.waitForLoadState("networkidle");

  // Type that small is unreadable, and a control that short cannot be tapped.
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

test("the desktop workspace preserves a wide reader and a bounded operation rail", async ({ page, apiFixture }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "desktop workspace assertion");

  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  await expect.poll(() => page.locator(".sidebar").evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(72);

  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
    const reader = document.querySelector(".reader-reading-pane")?.getBoundingClientRect();
    const rail = document.querySelector(".reader-action-rail")?.getBoundingClientRect();
    const visibleSidebarLabels = Array.from(document.querySelectorAll(".sidebar .sidebar-label"))
      .filter((node) => getComputedStyle(node).display !== "none")
      .map((node) => node.textContent?.trim());
    return {
      sidebarWidth: sidebar?.width ?? 0,
      readerWidth: reader?.width ?? 0,
      readerLeft: reader?.left ?? 0,
      readerRight: reader?.right ?? 0,
      railWidth: rail?.width ?? 0,
      railLeft: rail?.left ?? 0,
      railRight: rail?.right ?? 0,
      visibleSidebarLabels,
    };
  });

  expect(layout.sidebarWidth).toBeLessThanOrEqual(72);
  expect(layout.readerWidth).toBeGreaterThanOrEqual(560);
  expect(layout.railWidth).toBeGreaterThanOrEqual(340);
  expect(layout.railWidth).toBeLessThanOrEqual(400);
  expect(layout.readerLeft).toBeLessThan(layout.readerRight);
  expect(layout.railLeft).toBeLessThan(layout.railRight);
  expect(layout.readerRight, "the transcript canvas must end before the operation rail begins").toBeLessThanOrEqual(layout.railLeft + 1);
  expect(layout.visibleSidebarLabels).toEqual([]);
});

test("the compact operation bar stays aligned with the reader and leaves the transcript toolbar usable", async ({ page, apiFixture }, testInfo) => {
  test.skip(testInfo.project.name === "mobile-chromium", "intermediate desktop breakpoint assertion");

  await page.setViewportSize({ width: 806, height: 734 });
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.locator(".reader-action-rail")).toHaveAttribute("data-sheet", "peek");

  const geometry = await page.evaluate(() => {
    const reader = document.querySelector(".reader-reading-pane")?.getBoundingClientRect();
    const rail = document.querySelector(".reader-action-rail")?.getBoundingClientRect();
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
      rail: rail ? { left: rail.left, right: rail.right, top: rail.top, width: rail.width } : null,
      toolbar: toolbar ? { bottom: toolbar.bottom } : null,
      controlsUsable,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  expect(geometry.reader).not.toBeNull();
  expect(geometry.rail).not.toBeNull();
  expect(Math.abs((geometry.rail?.left ?? 0) - (geometry.reader?.left ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((geometry.rail?.right ?? 0) - (geometry.reader?.right ?? 0))).toBeLessThanOrEqual(1);
  expect(geometry.rail?.width ?? 0).toBeGreaterThanOrEqual((geometry.reader?.width ?? 0) - 2);
  expect(geometry.toolbar?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((geometry.rail?.top ?? 0) + 1);
  expect(geometry.controlsUsable).toBe(true);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
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
