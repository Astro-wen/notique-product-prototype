import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = {
  apiFixture: NotiqueApiFixture;
};

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

test("project menu supports keyboard movement, Escape, and outside dismissal", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const trigger = page.getByRole("button", { name: "项目菜单 ···" });

  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await trigger.press("ArrowDown");
  const createItem = page.getByRole("menuitem", { name: "新建项目" });
  const trashItem = page.getByRole("menuitem", { name: "回收站", exact: true });
  await expect(createItem).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(trashItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  // Radix intentionally disables pointer events on background controls while
  // a modal menu is open. A real outside pointer therefore targets the page
  // layer, not the underlying control.
  await page.mouse.click(4, 4);
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("trash dialog traps Tab and restores project-menu focus after Escape and close", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const trigger = page.getByRole("button", { name: "项目菜单 ···" });

  const openTrash = async () => {
    await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
    await trigger.press("ArrowDown");
    await page.getByRole("menuitem", { name: "回收站", exact: true }).click();
    return page.getByRole("dialog", { name: "回收站" });
  };

  let dialog = await openTrash();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-describedby", /radix/);
  await expect(dialog.getByText("恢复会带回项目的全部材料、核对记录、Evidence 和报告。这里不会自动按天清理。", { exact: true })).toBeVisible();

  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  dialog = await openTrash();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
