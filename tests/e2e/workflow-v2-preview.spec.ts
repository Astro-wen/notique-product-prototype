import { expect, test } from "@playwright/test";

// Real components with synthetic state only. Backend integration is tested separately.
test.beforeEach(async ({ page }) => {
  await page.goto("/design-system/workflow");
  await expect(page.getByRole("heading", { name: "新居装修 · 方案沟通" })).toBeVisible();
});

test("read and copy without a single review decision", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "复制记录", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制记录");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("预算大约三十万元");
  expect(copied).toContain("希望年底前搬入");
  expect(copied).toContain("AI 草稿");
  await expect(page.getByTestId("bullet-budget")).toContainText("AI 草稿");
  const title = await page.getByRole("heading", { level: 1 }).boundingBox();
  const content = await page.locator("main").boundingBox();
  expect(Math.abs(content!.x - title!.x)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: info.outputPath("record-initial.png"), fullPage: true });
});

test("source, inline edit, failed save, retry and partial acceptance keep one complete record", async ({ page }, info) => {
  const budget = page.getByTestId("bullet-budget");
  await budget.getByRole("button", { name: "原话", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("大约三十五万");
  await page.getByRole("button", { name: "返回记录", exact: true }).click();
  await expect(budget.getByRole("button", { name: "原话", exact: true })).toBeFocused();
  await budget.getByRole("button", { name: "改一下", exact: true }).click();
  await page.getByLabel("修改重点").fill("本次装修预算大约三十五万元。");
  await page.getByRole("button", { name: "模拟下次保存失败" }).click();
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("alert")).toContainText("输入仍然保留");
  await expect(page.getByLabel("修改重点")).toHaveValue("本次装修预算大约三十五万元。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(budget).toContainText("三十五万元");
  await expect(budget).toContainText("已采纳");
  await expect(page.getByTestId("bullet-timing")).toContainText("AI 草稿");
  await page.getByRole("button", { name: "已采纳", exact: true }).click();
  await expect(page.getByTestId("bullet-timing")).toHaveCount(0);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("bullet-timing")).toBeVisible();
  await page.screenshot({ path: info.outputPath("record-corrected.png"), fullPage: true });
});

test("accept once, complete without answering, then add a real answer", async ({ page, context }, info) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "加入跟进", exact: true }).click();
  await expect(page.getByRole("heading", { name: /跟进事项/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "加入跟进", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^完成：/ }).click();
  await expect(page.getByTestId("bullet-fee")).toContainText("安装费用还没有确定");
  await page.getByRole("button", { name: "补结果", exact: true }).click();
  await expect(page.getByLabel("补充答案")).toBeFocused();
  await page.getByLabel("补充答案").fill("供应商报价十二万元，包含安装。");
  await page.getByRole("button", { name: "保存答案" }).click();
  await expect(page.getByTestId("bullet-answer-fee")).toContainText("十二万元");
  await expect(page.getByTestId("bullet-fee")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^重开：/ })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "本次重点 4", exact: true })).toBeVisible();
  const order = await page.locator('[data-testid^="bullet-"]').evaluateAll(items => items.map(item => item.getAttribute("data-testid")));
  expect(order).toEqual(["bullet-budget", "bullet-timing", "bullet-answer-fee", "bullet-quote"]);
  await page.getByRole("button", { name: "复制记录", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已复制记录");
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain("安装费用还没有确定");
  await page.screenshot({ path: info.outputPath("record-result.png"), fullPage: true });
});

test("questions can be answered directly and read-only access removes mutation controls", async ({ page }) => {
  await page.getByRole("button", { name: "补答案", exact: true }).click();
  await page.getByLabel("补充答案").fill("已收到邮件，安装报价为十二万元。");
  await page.getByRole("button", { name: "保存答案" }).click();
  await expect(page.getByRole("heading", { name: /跟进事项/ })).toHaveCount(0);
  await expect(page.getByTestId("bullet-answer-fee")).toBeVisible();
  await page.getByLabel("只读模式").check();
  await expect(page.getByRole("button", { name: "改一下", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "加入跟进", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("bullet-timing").getByRole("button", { name: "原话", exact: true })).toBeVisible();
});
