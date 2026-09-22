import { expect, test } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

/*
 * 单条记录的删除。服务端的规则在 tests/record-trash.test.mjs 里拿真实表结构测过，
 * 这里只看界面：按钮在哪、弹窗说什么、在跑的任务不拦、跨记录引用才拦、撤销管用。
 */

async function openProjectA(page: import("@playwright/test").Page, fixture: NotiqueApiFixture) {
  fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  fixture.allowMutation("POST", "/api/v1/projects/project-a/opened");
  await fixture.install(page);
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("button", { name: "删除这条记录" })).toBeVisible();
}

test("a record with a running job deletes without any blocking notice, and undo brings it back", async ({ page }) => {
  const fixture = new NotiqueApiFixture();
  fixture.allowMutation("DELETE", "/api/v1/events/event-a");
  fixture.allowMutation("POST", "/api/v1/events/event-a/restore");
  await openProjectA(page, fixture);

  await page.getByRole("button", { name: "删除这条记录" }).click();
  const dialog = page.getByRole("dialog", { name: "把这条记录移到回收站？" });
  await expect(dialog).toContainText("A 初次沟通");
  // 预览里有一个任务在跑，界面一个字都不该提，按钮也不该灰。
  await expect(dialog.locator(".danger-note")).toHaveCount(0);
  await expect(dialog).not.toContainText("不能删除");
  await expect(dialog).toContainText("这 2 条会从报告里拿掉，恢复后回来。");
  await dialog.getByRole("button", { name: "移到回收站" }).click();

  const toast = page.locator(".toast");
  await expect(toast).toContainText("记录已移到回收站");
  const deletes = fixture.writes.filter((write) => write.method === "DELETE");
  expect(deletes.map((write) => write.path)).toEqual(["/api/v1/events/event-a"]);
  expect(deletes[0].idempotencyKey).toBeTruthy();

  await toast.getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(".toast")).toContainText("已恢复");
  expect(fixture.writes.map((write) => `${write.method} ${write.path}`)).toContain("POST /api/v1/events/event-a/restore");
  await expect(page.getByRole("button", { name: "删除这条记录" })).toBeVisible();
});

test("a record linked to another record cannot be deleted and says why", async ({ page }) => {
  const fixture = new NotiqueApiFixture();
  fixture.blockEventTrash(["这条记录的结论和别的记录有 1 条关系，删掉之后关系的另一头会落空。"]);
  await openProjectA(page, fixture);

  await page.getByRole("button", { name: "删除这条记录" }).click();
  const dialog = page.getByRole("dialog", { name: "把这条记录移到回收站？" });
  await expect(dialog.locator(".danger-note")).toContainText("关系的另一头会落空");
  await expect(dialog.getByRole("button", { name: "移到回收站" })).toBeDisabled();
  expect(fixture.writes.filter((write) => write.method === "DELETE")).toEqual([]);
});
