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

test("a delayed Project A snapshot and Claims response cannot overwrite Project B", async ({ page, apiFixture }) => {
  apiFixture.holdProjectAClaims = true;
  apiFixture.holdProjectASnapshot = true;

  await page.goto("/?project=project-a&event=event-a&view=simple");
  await Promise.all([
    apiFixture.waitForProjectAClaimsRequest(),
    apiFixture.waitForProjectASnapshotRequest(),
  ]);
  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-a");

  await page.getByLabel("选择当前项目").selectOption("project-b");
  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-b");
  await expect(page.getByRole("heading", { name: "B 初次沟通", exact: true })).toBeVisible();

  apiFixture.releaseProjectAClaims();
  apiFixture.releaseProjectASnapshot();

  await expect(page.locator(".current-event-status")).toHaveText("已完成");
  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();
  await expect(page.getByRole("heading", { name: "B 项目会议重点" })).toBeVisible();
  await expect(page.getByText("B 项目只确认学区范围", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /核对这条意思|查看核对结果/ })).toHaveCount(0);
  await expect(page.getByText("预算上限是 120 万美元", { exact: true })).toHaveCount(0);
});

test("a completed old Run cannot refresh Project A over a newer Project B selection", async ({ page, apiFixture }) => {
  apiFixture.simulateProjectARunCompletionRefresh = true;

  await page.goto("/?project=project-a&event=event-a&view=simple");
  await Promise.all([
    apiFixture.waitForProjectACompletionProjectRefresh(),
    apiFixture.waitForProjectACompletionEventRefresh(),
  ]);

  await page.getByLabel("选择当前项目").selectOption("project-b");
  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-b");
  await expect(page.getByRole("heading", { name: "B 初次沟通", exact: true })).toBeVisible();

  apiFixture.releaseProjectACompletionRefresh();
  await page.waitForTimeout(500);

  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-b");
  await expect(page.getByRole("heading", { name: "B 初次沟通", exact: true })).toBeVisible();
  await expect(page.getByText("A 初次沟通", { exact: true })).toHaveCount(0);
});

test("Run completion commits Project, Event, and terminal Run only after staggered refreshes finish", async ({ page, apiFixture }) => {
  apiFixture.simulateProjectARunCompletionRefresh = true;

  await page.goto("/?project=project-a&event=event-a&view=simple");
  await Promise.all([
    apiFixture.waitForProjectACompletionProjectRefresh(),
    apiFixture.waitForProjectACompletionEventRefresh(),
  ]);

  apiFixture.releaseProjectACompletionProjectRefresh();
  await page.waitForTimeout(400);
  // The Project response must not commit a partial terminal snapshot while
  // the Event response is still outstanding.
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await expect(page.getByText("A 完成刷新后的沟通", { exact: true })).toHaveCount(0);

  apiFixture.releaseProjectACompletionEventRefresh();
  await expect(page.getByRole("heading", { name: "A 完成刷新后的沟通", exact: true })).toBeVisible();
  await expect(page.locator(".current-event-status")).toHaveText("等待人工核对");
});

test("Summary opens its Claim and returns to the same Summary URL and scroll source", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.scrollIntoViewIfNeeded();
  const sourceScrollY = await page.evaluate(() => window.scrollY);
  expect(sourceScrollY).toBeGreaterThan(0);

  await target.getByRole("button", { name: "核对这条意思" }).click();
  await expect(page).toHaveURL(/view=claim.*claim=claim-summary-pending.*origin=simple.*originReadingTab=summary/);
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元", exact: true })).toBeVisible();
  await expect(page.getByLabel("返回 AI 摘要")).toBeVisible();
  await expect(page.getByRole("heading", { name: "原始证据" })).toBeVisible();
  await expect(page.getByLabel("连续审核队列")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并加入正式结果" })).toBeVisible();

  await page.getByLabel("返回 AI 摘要").click();
  await expect(page).toHaveURL(/project=project-a.*event=event-a.*view=simple/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 2);
  await page.waitForTimeout(750);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 2);
});

test("a reviewed Summary item opens read-only while another pending item remains", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const reviewed = page.locator(".summary-sentences article").filter({
    hasText: "经纪人周五前发送三套房源",
  });
  await reviewed.getByRole("button", { name: "查看核对结果" }).click();

  await expect(page).toHaveURL(/view=claim.*claim=claim-timeline-verified.*origin=simple.*originReadingTab=summary/);
  await expect(page.getByText("只读证据模式", { exact: true })).toBeVisible();
  await expect(page.getByLabel("连续审核队列")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认并加入正式结果" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "修改已确认记录" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "撤回已确认记录" })).toHaveCount(0);
  await expect(page.getByLabel("返回 AI 摘要")).toBeVisible();

  await page.getByLabel("返回 AI 摘要").click();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  const pending = page.locator(".summary-sentences article").filter({
    hasText: "预算上限是 120 万美元",
  });
  await pending.getByRole("button", { name: "核对这条意思" }).click();
  await expect(page.getByText("只读证据模式", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("连续审核队列")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认并加入正式结果" })).toBeVisible();
  await expect(page.getByLabel("返回 AI 摘要")).toBeVisible();
});

test("Summary source survives a Claim reload and the page arrow returns to Summary", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.getByRole("button", { name: "核对这条意思" }).click();
  await expect(page).toHaveURL(/view=claim.*origin=simple.*originReadingTab=summary/);

  await page.reload();
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元", exact: true })).toBeVisible();
  await expect(page.getByLabel("返回 AI 摘要")).toBeVisible();
  await page.getByLabel("返回 AI 摘要").click();

  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^AI 摘要/ })).toHaveClass(/active/);
});

test("browser Back and Forward preserve the Summary-to-Claim route", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("heading", { name: "A 初次沟通", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();

  const target = page.locator(".summary-sentences article").filter({ hasText: "预算上限是 120 万美元" });
  await target.getByRole("button", { name: "核对这条意思" }).click();
  await expect(page).toHaveURL(/view=claim.*originReadingTab=summary/);

  await page.goBack();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("heading", { name: "A 项目会议重点" })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/view=claim.*originReadingTab=summary/);
  await expect(page.getByLabel("返回 AI 摘要")).toBeVisible();
});

test("a direct Claim deep link falls back to its communication without a false Summary label", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=claim&claim=claim-summary-pending");
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元", exact: true })).toBeVisible();
  await expect(page.getByLabel("返回本次沟通")).toBeVisible();
  await expect(page.getByLabel("返回 AI 摘要")).toHaveCount(0);

  await page.getByLabel("返回本次沟通").click();
  await expect(page).toHaveURL(/project=project-a.*event=event-a.*view=event/);
});

test("Timeline opens a verified Claim in read-only mode and returns to Timeline", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=results&tab=timeline&origin=simple");
  await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人承诺周五前发送三套房源", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "查看记录与原始证据" }).click();
  await expect(page).toHaveURL(/view=claim.*claim=claim-timeline-verified.*origin=results.*originTab=timeline/);
  await expect(page.getByText("只读证据模式", { exact: true })).toBeVisible();
  await expect(page.getByLabel("返回时间线")).toBeVisible();

  await page.getByLabel("返回时间线").click();
  await expect(page).toHaveURL(/view=results.*tab=timeline/);
  await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人承诺周五前发送三套房源", { exact: true })).toBeVisible();
});

test("formal Next returns and renders verified Actions only", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=results&tab=actions&origin=simple");
  await expect(page.getByRole("heading", { name: "下一步", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人周五前发送三套符合预算的房源", { exact: true })).toBeVisible();
  await expect(page.getByText("PENDING MUST NOT LEAK INTO FORMAL NEXT", { exact: true })).toHaveCount(0);
  await expect(page.getByText("REJECTED MUST NOT LEAK INTO FORMAL NEXT", { exact: true })).toHaveCount(0);
  expect(apiFixture.returnedActionClaimIds.at(-1)).toEqual(["claim-action-confirmed"]);

  const response = await page.evaluate(async () => {
    const result = await fetch("/api/v1/projects/project-a/actions");
    return result.json();
  });
  expect(JSON.stringify(response)).not.toContain("PENDING MUST NOT LEAK");
  expect(JSON.stringify(response)).not.toContain("REJECTED MUST NOT LEAK");
});

test("local-only allowlist covers Action completion and trash restore without touching production", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/actions/claim-action-confirmed/complete");
  apiFixture.allowMutation("POST", "/api/v1/projects/project-trash/restore");

  await page.goto("/?project=project-a&event=event-a&view=results&tab=actions&origin=simple");
  await page.getByRole("button", { name: "标记完成" }).click();
  await expect(page.getByText("经纪人周五前发送三套符合预算的房源", { exact: true })).toBeVisible();
  await expect(page.locator(".action-card.completed")).toContainText("已完成");

  await page.locator("button.brand:visible").first().click();
  await expect(page).toHaveURL(/view=simple/);
  await page.getByRole("button", { name: "项目菜单 ···" }).click();
  await page.getByRole("menuitem", { name: "回收站", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "回收站" })).toBeVisible();
  await expect(page.getByText("Recovered Buyer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复并打开" }).click();

  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-trash");
  await expect(page.getByText("Recovered Buyer", { exact: true }).first()).toBeVisible();

  expect(apiFixture.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/v1/actions/claim-action-confirmed/complete",
    "POST /api/v1/projects/project-trash/restore",
  ]);
  for (const write of apiFixture.writes) {
    expect(write.idempotencyKey).toBeTruthy();
    expect(write.body).toEqual({});
  }
});

test("the review queue can be worked from the keyboard", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/projects/project-a/review-sessions");
  apiFixture.allowMutation("POST", "/api/v1/claims/claim-summary-pending/verdicts");

  await page.goto("/?project=project-a&event=event-a&view=review&origin=simple");
  await page.getByRole("button", { name: /预算上限是 120 万美元/ }).first().click();
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元", exact: true })).toBeVisible();

  // The hints are shown rather than hidden, so the shortcuts are discoverable.
  await expect(page.locator(".review-shortcut-hints")).toBeVisible();
  await expect(page.locator(".review-shortcut-hints kbd").first()).toHaveText("Enter");

  // E opens the edit form without deciding anything.
  await page.locator("body").press("e");
  const statement = page.locator(".edit-form textarea").first();
  await expect(statement).toBeVisible();
  expect(apiFixture.writes.filter(({ path }) => path.includes("verdicts"))).toEqual([]);

  // A decision key typed into a field is text, never a verdict.
  await statement.click();
  await statement.press("x");
  await statement.press("Enter");
  await expect(statement).toBeVisible();
  expect(apiFixture.writes.filter(({ path }) => path.includes("verdicts"))).toEqual([]);

  await page.reload();
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元", exact: true })).toBeVisible();
  await page.locator("body").press("Enter");
  await expect
    .poll(() => apiFixture.writes.filter(({ path }) => path.includes("verdicts")).length)
    .toBe(1);
  const verdict = apiFixture.writes.find(({ path }) => path.includes("verdicts"));
  expect(verdict?.body).toMatchObject({ action: "confirm" });
});
