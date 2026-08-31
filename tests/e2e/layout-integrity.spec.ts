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
      railWidth: rail?.width ?? 0,
      visibleSidebarLabels,
    };
  });

  expect(layout.sidebarWidth).toBeLessThanOrEqual(72);
  expect(layout.readerWidth).toBeGreaterThanOrEqual(560);
  expect(layout.railWidth).toBeGreaterThanOrEqual(340);
  expect(layout.railWidth).toBeLessThanOrEqual(400);
  expect(layout.visibleSidebarLabels).toEqual([]);
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
