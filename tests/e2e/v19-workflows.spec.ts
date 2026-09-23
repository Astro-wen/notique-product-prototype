import { expect, test as base, type Page } from "@playwright/test";

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
    fixture.allowMutation("POST", "/api/v1/projects/project-trash/opened");
    await fixture.install(page);
    await provide(fixture);
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

// 换项目走侧栏的项目列表。工作区顶栏那个「当前项目」选择框是第二个入口，已经撤掉。
function sidebarProject(page: Page, name: string) {
  return page.locator("button.sidebar-project").filter({ hasText: name });
}

// 47f849a 之后进入操作栏的是逐字稿里那一段本身，见 summary-first-workflow.spec.ts。
async function selectSourceTurn(page: Page, text: string): Promise<void> {
  await page.getByTestId("transcript-turn-body").filter({ hasText: text }).first().click();
}

async function expandSummaryIfCollapsed(page: Page): Promise<void> {
  await page.locator(".tingwu-overview-copy p", { hasText: "A 摘要背景 1" }).waitFor({ state: "visible" });
}

test("a delayed Project A snapshot and Claims response cannot overwrite Project B", async ({ page, apiFixture }) => {
  apiFixture.holdProjectAClaims = true;
  apiFixture.holdProjectASnapshot = true;

  await page.goto("/?project=project-a&event=event-a&view=simple");
  await Promise.all([
    apiFixture.waitForProjectAClaimsRequest(),
    apiFixture.waitForProjectASnapshotRequest(),
  ]);
  await expect(sidebarProject(page, "Buyer A")).toHaveAttribute("aria-current", "true");

  await sidebarProject(page, "Buyer B").click();
  await expect(sidebarProject(page, "Buyer B")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-b");

  apiFixture.releaseProjectAClaims();
  apiFixture.releaseProjectASnapshot();

  await expect(page.locator(".current-event-status:visible")).toHaveText("已完成");
  await page.getByRole("button", { name: /^本次重点/ }).click();
  await page.getByRole("button", { name: "章节速览", exact: true }).click();
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("B 摘要背景 1");
  await page.getByRole("button", { name: "要点回顾" }).click();
  // 同一句也内联在章节里，只认要点区那一份。
  await expect(page.getByLabel("要点回顾内容").getByText("B 项目只确认学区范围", { exact: true })).toBeVisible();
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

  await sidebarProject(page, "Buyer B").click();
  await expect(sidebarProject(page, "Buyer B")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-b");

  apiFixture.releaseProjectACompletionRefresh();
  await page.waitForTimeout(500);

  await expect(sidebarProject(page, "Buyer B")).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-b");
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
  await expect(page.getByRole("combobox", { name: "选择记录" }).locator("option:checked")).toHaveText("A 初次沟通");
  await expect(page.getByText("A 完成刷新后的沟通", { exact: true })).toHaveCount(0);

  apiFixture.releaseProjectACompletionEventRefresh();
  await expect(page.getByRole("combobox", { name: "选择记录" }).locator("option:checked")).toHaveText("A 完成刷新后的沟通");
  await expect(page.locator(".current-event-status:visible")).toHaveText("有内容待确认");
});

test("a Summary point opens source, verification, and action controls in the same workspace", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");
  await page.getByRole("button", { name: /^本次重点/ }).click();
  await page.getByRole("button", { name: "章节速览", exact: true }).click();
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "预算上限是 120 万美元");

  const rail = page.locator(".reader-action-rail");
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(rail).toContainText("录音与原话");
  await expect(rail.locator(".reader-action-tabs").getByRole("button", { name: "核对详情", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a reviewed Summary item exposes its source in place while pending work remains in the rail", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "周五前发送三套房源");

  const rail = page.locator(".reader-action-rail");
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
  await expect(rail.getByRole("heading", { name: /周五前发送三套房源/ })).toBeVisible();
  await expect(rail.locator(".point-trust-state.verified")).toHaveText("已确认");
  await expect(rail).toContainText("录音与原话");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);

  await rail.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ }).click();
  await expect(rail).toContainText("对照原话检查金额、日期和负责人");
  await rail.locator(".rail-pending-list").getByText("预算上限是 120 万美元", { exact: true }).click();
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(rail.locator(".point-trust-state.pending")).toHaveText("需确认");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
});

test("the Summary reading route survives reload and its source reopens in the same rail", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.getByRole("button", { name: "章节速览", exact: true })).toHaveClass(/active/);
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(rail).toContainText("录音与原话");
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
});

test("source, pending, and action views remain one continuous Summary workflow", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "预算上限是 120 万美元");

  const rail = page.locator(".reader-action-rail");
  const actionTabs = rail.locator(".reader-action-tabs");
  await expect(actionTabs.getByRole("button", { name: "核对详情", exact: true })).toHaveAttribute("aria-pressed", "true");

  await actionTabs.getByRole("button", { name: /^待确认/ }).click();
  await expect(actionTabs.getByRole("button", { name: /^待确认/ })).toHaveAttribute("aria-pressed", "true");
  await expect(rail.getByRole("button", { name: "从第一条开始确认" })).toBeVisible();

  await actionTabs.getByRole("button", { name: /^行动/ }).click();
  await expect(actionTabs.getByRole("button", { name: /^行动/ })).toHaveAttribute("aria-pressed", "true");
  await expect(rail.getByRole("region", { name: "我的清单" })).toBeVisible();

  await actionTabs.getByRole("button", { name: "核对详情", exact: true }).click();
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
});

test("a direct Claim deep link falls back to its communication without a false Summary label", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=claim&claim=claim-summary-pending");
  await expect(page.getByRole("heading", { name: "预算上限是 120 万美元", exact: true })).toBeVisible();
  await expect(page.getByLabel("返回工作台")).toBeVisible();
  await expect(page.getByLabel("返回 AI 摘要")).toHaveCount(0);

  // The event page is absorbed: its communication lives in the workspace.
  await page.getByLabel("返回工作台").click();
  await expect(page).toHaveURL(/project=project-a.*event=event-a.*view=simple/);
});

test("Timeline opens a verified Claim in read-only mode and returns to Timeline", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=results&tab=timeline&origin=simple");
  await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人承诺周五前发送三套房源", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "查看记录与原始证据" }).click();
  await expect(page).toHaveURL(/view=claim.*claim=claim-timeline-verified.*origin=results.*originTab=timeline/);
  await expect(page.getByText("只读依据模式", { exact: true })).toBeVisible();
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

  // 这一段测的是回收站恢复，不是导航。回收站现在只在「项目管理」页，从侧栏一步到。
  await page.locator(".sidebar").getByRole("button", { name: "项目管理" }).click();
  await expect(page).toHaveURL(/view=projects/);
  await page.locator(".pi-heading").getByRole("button", { name: "回收站" }).click();
  await expect(page.getByRole("dialog", { name: "回收站" })).toBeVisible();
  await expect(page.getByText("Recovered Buyer", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "恢复并打开" }).click();

  await expect(page).toHaveURL(/view=simple/);
  await expect(sidebarProject(page, "Recovered Buyer")).toHaveAttribute("aria-current", "true");

  // Dispatcher wakes are the workspace recovery heartbeat, not content
  // mutations: production has no working Cron trigger, so an open workspace is
  // what recovers stalled work. What matters here is that nothing else wrote.
  const contentWrites = apiFixture.writes.filter(({ path }) => path !== "/api/v1/jobs/dispatch" && !path.endsWith("/opened"));
  expect(contentWrites.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/v1/actions/claim-action-confirmed/complete",
    "POST /api/v1/projects/project-trash/restore",
  ]);
  for (const write of contentWrites) {
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
  await expect(page.locator(".review-shortcut-hints")).toBeVisible();
  await page.locator("body").press("Enter");
  await expect
    .poll(() => apiFixture.writes.filter(({ path }) => path.includes("verdicts")).length)
    .toBe(1);
  const verdict = apiFixture.writes.find(({ path }) => path.includes("verdicts"));
  expect(verdict?.body).toMatchObject({ action: "confirm" });
});
