import { expect, test as base } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = {
  apiFixture: NotiqueApiFixture;
};

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    // 打开项目会写一次 last_opened_at，是读取路径的一部分，不是被测行为产生的写。
    fixture.allowMutation("POST", "/api/v1/projects/project-a/opened");
    fixture.allowMutation("POST", "/api/v1/projects/project-b/opened");
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

// 工作区顶栏的「项目菜单」和回收站入口已经撤掉：换项目在侧栏，新建项目、回收站和
// 每个项目的操作都在「项目管理」页。这两条用例测的是 Radix 菜单和对话框的键盘与
// 焦点行为，跟着搬到「项目管理」页，保证同一套无障碍保证还有人守。
test("project card menu supports keyboard movement, Escape, and outside dismissal", async ({ page }) => {
  await page.goto("/?view=projects");
  const trigger = page.getByRole("button", { name: "Buyer A的操作" });

  await expect(trigger).toBeVisible();
  await trigger.press("ArrowDown");
  const renameItem = page.getByRole("menuitem", { name: "重命名" });
  const folderItem = page.getByRole("menuitem", { name: "关联文件夹" });
  await expect(renameItem).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(folderItem).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // Radix intentionally disables pointer events on background controls while
  // a modal menu is open. A real outside pointer therefore targets the page
  // layer, not the underlying control.
  //
  // 菜单可见和「点击外面」的监听挂好之间差一拍，机器忙的时候第一下会落在这个
  // 空档里。点到关掉为止，测的还是同一件事：外面来一下真实指针，菜单就该消失。
  await expect(async () => {
    await page.mouse.click(4, 4);
    await expect(menu).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 8_000 });
});

test("trash dialog traps Tab and restores the 回收站 button focus after Escape and close", async ({ page }) => {
  await page.goto("/?view=projects");
  // 侧栏每行垃圾桶的 aria-label 里也有「回收站」，按页头取才唯一。
  const trigger = page.locator(".pi-heading").getByRole("button", { name: "回收站" });

  const openTrash = async () => {
    await expect(trigger).toBeVisible();
    await trigger.click();
    return page.getByRole("dialog", { name: "回收站" });
  };

  let dialog = await openTrash();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-describedby", /\S+/);
  const description = await dialog.evaluate((element) => {
    const ids = element.getAttribute("aria-describedby")?.trim().split(/\s+/) ?? [];
    return ids.map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean);
  });
  expect(description).toEqual([
    "恢复后材料、记录和报告都会回来。回收站不会自动清空",
  ]);

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
