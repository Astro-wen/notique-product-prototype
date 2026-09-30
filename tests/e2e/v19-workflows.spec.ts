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

async function openSource(page: Page, claimId: string) {
  await page.getByTestId(`bullet-${claimId}`).getByRole("button", { name: "原话", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "原话与出处" });
  await expect(dialog).toBeVisible();
  return dialog;
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

  await page.locator(".meeting-tabs").getByRole("button", { name: "原文", exact: true }).click();
  await expect(page.locator(".current-event-status:visible")).toHaveText("已完成");
  await page.locator(".reader-extra-views > summary").click();
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
  await page.locator(".meeting-tabs").getByRole("button", { name: "原文", exact: true }).click();
  await expect(page.locator(".current-event-status:visible")).toHaveText("有内容待确认");
});

test("a record point exposes its source and decision beside the same record", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");
  const bullet = page.getByTestId("bullet-claim-summary-pending");
  await expect(bullet).toContainText("AI 草稿");
  await expect(bullet.getByRole("button", { name: "确认这条", exact: true })).toBeVisible();
  const source = await openSource(page, "claim-summary-pending");
  await expect(source).toContainText("预算上限是 120 万美元。");
  await expect(source.getByRole("button", { name: /确认/ })).toHaveCount(0);
  await source.getByRole("button", { name: "返回记录", exact: true }).click();
  await expect(bullet).toBeVisible();
  await expect(page.getByRole("button", { name: "完成：经纪人周五前发送三套房源" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple$/);
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(apiFixture.writes.filter(w => !["/api/v1/jobs/dispatch", "/api/v1/projects/project-a/opened"].includes(w.path))).toEqual([]);
});

test("an accepted item exposes its own source while a draft remains editable", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const accepted = page.getByTestId("bullet-claim-timeline-verified");
  await expect(accepted).toContainText("已采纳");
  await expect(accepted.getByRole("button", { name: "确认这条", exact: true })).toHaveCount(0);
  const source = await openSource(page, "claim-timeline-verified");
  await expect(source).toContainText("周五前发送三套房源。");
  await expect(source).not.toContainText("预算上限是 120 万美元。");
  await source.getByRole("button", { name: "返回记录", exact: true }).click();
  const pending = page.getByTestId("bullet-claim-summary-pending");
  await expect(pending).toContainText("AI 草稿");
  await expect(pending.getByRole("button", { name: "确认这条", exact: true })).toBeVisible();
  await expect(pending.getByRole("button", { name: "改一下", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=simple$/);
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
});

test("the Summary deep link survives reload and returns to the inline source workflow", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await page.locator(".reader-extra-views > summary").click();
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await page.reload();
  await page.locator(".reader-extra-views > summary").click();
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.locator(".raw-artifact")).toBeVisible();
  await page.getByRole("button", { name: "本次重点", exact: true }).click();
  const source = await openSource(page, "claim-summary-pending");
  await expect(source).toContainText("预算上限是 120 万美元。");
  await expect(page).not.toHaveURL(/(?:[?&]view=claim|[?&]claim=)/);
});

test("sources, draft decisions, and follow-up remain in one record", async ({ page }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const source = await openSource(page, "claim-summary-pending");
  await source.getByRole("button", { name: "返回记录", exact: true }).click();
  await expect(page.getByTestId("bullet-claim-summary-pending").getByRole("button", { name: "确认这条", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "完成：经纪人周五前发送三套房源" })).toBeVisible();
  await expect(page.getByRole("button", { name: "补结果", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "已采纳", exact: true }).click();
  await expect(page.getByTestId("bullet-claim-summary-pending")).toHaveCount(0);
  await expect(page.getByTestId("bullet-claim-timeline-verified")).toBeVisible();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("bullet-claim-summary-pending")).toBeVisible();
  await expect(page).toHaveURL(/view=simple$/);
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

test("record review can be worked from the keyboard without deciding typed text", async ({ page, apiFixture }) => {
  const decisionPath = "/api/v2/review-cards/card-claim-summary-pending/decisions";
  apiFixture.allowMutation("POST", decisionPath);
  await page.goto("/?project=project-a&event=event-a&view=simple");
  const bullet = page.getByTestId("bullet-claim-summary-pending");
  const modify = bullet.getByRole("button", { name: "改一下", exact: true });
  await modify.focus();
  await page.keyboard.press("Enter");
  const statement = bullet.getByRole("textbox", { name: "修改重点", exact: true });
  await expect(statement).toBeVisible();
  await expect(statement).toBeFocused();
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  await expect(statement).toBeVisible();
  await expect(statement).toHaveValue(/x\n/);
  expect(apiFixture.writes.filter(({ path }) => path === decisionPath)).toEqual([]);
  await page.keyboard.press("Tab");
  await expect(bullet.getByRole("combobox", { name: "修改依据", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bullet.getByRole("button", { name: "保存修改", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bullet.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(statement).toHaveCount(0);
  const confirm = bullet.getByRole("button", { name: "确认这条", exact: true });
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => apiFixture.writes.filter(({ path }) => path === decisionPath).length).toBe(1);
  const decision = apiFixture.writes.find(({ path }) => path === decisionPath);
  expect(decision?.body).toMatchObject({ operation: "confirm", members: [{ claimId: "claim-summary-pending", claimVersionId: "claim-summary-pending-version-1", operation: "confirm" }] });
  await expect(bullet).toContainText("已采纳");
  await page.reload();
  await expect(bullet).toContainText("已采纳");
  expect(apiFixture.writes.filter(({ path }) => path === decisionPath)).toHaveLength(1);
});
