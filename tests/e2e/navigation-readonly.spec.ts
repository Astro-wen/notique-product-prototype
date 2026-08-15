import { expect, test as base } from "@playwright/test";

type Fixtures = {
  blockedWrites: string[];
};

const emptyProjects = JSON.stringify({
  data: { projects: [] },
  request_id: "playwright-readonly-fixture",
});

const missingFixture = JSON.stringify({
  error: {
    code: "NOT_FOUND",
    message: "This read-only Playwright fixture does not provide that resource.",
  },
  request_id: "playwright-readonly-fixture",
});

const test = base.extend<Fixtures>({
  blockedWrites: [async ({ page }, provide) => {
    const blockedWrites: string[] = [];

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const url = new URL(request.url());

      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        blockedWrites.push(`${method} ${url.pathname}`);
        await route.abort("blockedbyclient");
        return;
      }

      if (url.pathname === "/api/v1/projects") {
        await route.fulfill({ status: 200, contentType: "application/json", body: emptyProjects });
        return;
      }

      await route.fulfill({ status: 404, contentType: "application/json", body: missingFixture });
    });

    await provide(blockedWrites);
    expect(blockedWrites, "read-only E2E navigation must never attempt an API mutation").toEqual([]);
  }, { auto: true }],
});

test("browser back returns from the core workspace to the exact prior route", async ({ page }) => {
  await page.goto("/?view=projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  await page.locator("button.brand:visible").first().click();
  await expect(page).toHaveURL(/\?view=simple$/);
  await expect(page.getByRole("heading", { name: "把每次沟通变成可核对的项目记忆" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\?view=projects$/);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
});

test("refresh preserves a directly opened route", async ({ page }) => {
  await page.goto("/?view=projects");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  await page.reload();

  await expect(page).toHaveURL(/\?view=projects$/);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
});

test("mobile uses one compact navigation shell without horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "mobile layout assertion");

  await page.goto("/?view=simple");
  await expect(page.locator("header.mobile-header")).toBeVisible();
  await expect(page.locator("aside.sidebar")).toBeHidden();
  await expect(page.getByLabel("选择当前项目")).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
