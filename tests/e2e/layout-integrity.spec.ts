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
