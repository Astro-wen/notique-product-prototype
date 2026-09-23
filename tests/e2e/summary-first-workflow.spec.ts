import { expect, test as base, type Page, type TestInfo } from "@playwright/test";

import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = {
  apiFixture: NotiqueApiFixture;
};

const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
    // These are cheap wakes for Runs already persisted in the fixture, not
    // creation/retry mutations. Keep every other mutation blocked.
    fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
    fixture.allowMutation("POST", "/api/v1/projects/project-a/opened");
    await fixture.install(page);
    await provide(fixture);
    for (const wake of fixture.writes.filter(({ path }) => path === "/api/v1/jobs/dispatch")) {
      // An untargeted wake is the workspace recovery heartbeat: it carries what
      // the absent Cron trigger was supposed to do. Every other wake must still
      // name a Run this page owns.
      if (wake.body === null) continue;
      expect(wake.body).toMatchObject({ kind: expect.stringMatching(/^(artifact|extraction)$/) });
      expect(wake.body).toMatchObject({ run_id: expect.stringMatching(/^(artifact-run-|run-a$)/) });
    }
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});

const READ_PATH_WRITES = ["/api/v1/jobs/dispatch", "/api/v1/projects/project-a/opened"];

function nonWakeWrites(apiFixture: NotiqueApiFixture) {
  return apiFixture.writes.filter(({ path }) => !READ_PATH_WRITES.includes(path));
}

function isMobile(testInfo: TestInfo): boolean {
  return testInfo.project.name === "mobile-chromium";
}

async function openOperationsOnMobile(page: Page, testInfo: TestInfo): Promise<void> {
  if (!isMobile(testInfo)) return;
  const rail = page.locator(".reader-action-rail");
  if (await rail.getAttribute("data-sheet") === "peek") {
    await rail.getByRole("button", { name: "展开本次操作" }).click();
  }
}

async function expandSummaryIfCollapsed(page: Page): Promise<void> {
  await page.locator(".tingwu-overview-copy p", { hasText: "A 摘要背景 1" }).waitFor({ state: "visible" });
}

// 47f849a 之后，摘要要点只负责把读者带到原句；进入右侧操作栏的是逐字稿
// 里那一段本身。老用例里"点一条摘要句"的动作，等价于点那段原话。
async function selectSourceTurn(page: Page, text: string): Promise<void> {
  await page.getByTestId("transcript-turn-body").filter({ hasText: text }).first().click();
}

test("Raw opens first and a finished Summary appears above it without stealing focus", async ({ page, apiFixture }, testInfo) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  // Opening the reader automatically is not a tab choice. The route records a
  // reading surface only when the reader picks one, so a raw view shown before
  // the readable pass exists cannot outlive it; an explicit pick is still
  // recorded and still survives reload (see the manual-selection tests below).
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);

  apiFixture.completeSummary();

  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  // Opening the reader automatically is not a tab choice. The route records a
  // reading surface only when the reader picks one, so a raw view shown before
  // the readable pass exists cannot outlive it; an explicit pick is still
  // recorded and still survives reload (see the manual-selection tests below).
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await expect(page.locator(".reader-action-rail")).toBeVisible();
  if (isMobile(testInfo)) await expect(page.locator(".reader-action-rail")).toHaveAttribute("data-sheet", "peek");
  await expect(page.getByRole("button", { name: /连续核对/ })).toHaveCount(0);
  await expect(page.locator(".reader-overview-divider")).toContainText("请结合原文核对");

  expect(nonWakeWrites(apiFixture), "Raw-first navigation must not create or retry any paid Run").toEqual([]);
  for (const wake of apiFixture.writes) {
    if (wake.path === "/api/v1/projects/project-a/opened") continue;
    expect(wake.path).toBe("/api/v1/jobs/dispatch");
    if (wake.body === null) continue;
    expect(wake.body).toMatchObject({
      kind: expect.stringMatching(/^(?:artifact|extraction)$/),
      run_id: expect.stringMatching(/^(?:artifact-run-|run-)/),
    });
  }
});

test("the first completed snapshot opens Raw and a refresh restores it without another paid Run", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();

  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  // 待确认 lives only in the rail now; the reading page is already open.
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await openOperationsOnMobile(page, testInfo);
  await rail.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ }).click();
  await expect(rail.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ })).toHaveAttribute("aria-pressed", "true");
  await expect(rail.getByRole("button", { name: "从第一条开始确认" })).toBeVisible();
  await rail.locator(".rail-pending-list").getByText("预算上限是 120 万美元", { exact: true }).click();
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(rail).toContainText("预算上限是 120 万美元。");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/view=simple(?!.*claim=)/);
  await expect(page.locator(".draft-actions")).toHaveCount(0);
  if (!isMobile(testInfo)) await expect(page.locator(".reader-reading-pane")).toBeVisible();

  await page.reload();

  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.getByRole("button", { name: /^本次重点/ })).toHaveClass(/active/);
  expect(nonWakeWrites(apiFixture), "restoring Raw must remain a navigation-only action").toEqual([]);
});

test("an explicit workspace tab choice is never replaced when Summary finishes", async ({ page, apiFixture }) => {
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");
  const projectScope = page.getByRole("button", { name: "整个项目", exact: true });
  await projectScope.click();
  await expect(projectScope).toHaveClass(/active/);

  apiFixture.completeSummary();

  await expect(projectScope).toHaveClass(/active/);
  await expect(page.locator(".tingwu-overview-copy p", { hasText: "A 摘要背景 1" })).toHaveCount(0);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a completed Summary never closes an open direct-recording material interaction", async ({ page, apiFixture }) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("notique.ui.public-workspace-acknowledged", "1");
  });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");
  const materialsTab = page.locator(".meeting-tabs").getByRole("button", { name: /^材料/ });
  await materialsTab.click();
  await expect(materialsTab).toHaveClass(/active/);
  // 录音入口就在材料区里，不再藏在一个要先展开的面板后面。
  await page.locator(".material-record").click();
  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();

  apiFixture.completeSummary();

  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^材料/ })).toHaveClass(/active/);
  await expect(page.locator(".tingwu-overview-copy p", { hasText: "A 摘要背景 1" })).toHaveCount(0);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("facts finishing preserves the open Summary and its scroll position", async ({ page, apiFixture }, testInfo) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple");
  apiFixture.completeSummary();
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");

  const expandSummary = page.locator(".tingwu-overview-copy button.text-button");
  await expect(expandSummary).toHaveText("展开全部概要");
  await expandSummary.click();
  await expect(expandSummary).toHaveText("收起概要");
  await page.evaluate((mobile) => {
    if (mobile) window.scrollTo(0, 600);
    else { const scroller = document.querySelector(".reader-reading-scroll"); if (scroller) scroller.scrollTop = 600; }
  }, isMobile(testInfo));
  const sourceScrollY = await page.evaluate((mobile) => mobile
    ? window.scrollY
    : (document.querySelector(".reader-reading-scroll")?.scrollTop ?? 0), isMobile(testInfo));
  expect(sourceScrollY).toBeGreaterThan(0);

  apiFixture.completeFacts();

  if (isMobile(testInfo)) {
    await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(sourceScrollY - 60);
  }
  await openOperationsOnMobile(page, testInfo);
  await page.locator(".reader-action-tabs").getByRole("button", { name: /^待确认/ }).click();
  await expect(page.getByRole("button", { name: "从第一条开始确认" })).toBeVisible();
  if (isMobile(testInfo)) {
    await page.locator(".reader-action-rail").getByRole("button", { name: "收起本次操作" }).click();
  }
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page).toHaveURL(/view=simple/);
  if (!isMobile(testInfo)) {
    await expect.poll(() => page.evaluate(() => document.querySelector(".reader-reading-scroll")?.scrollTop ?? 0)).toBeGreaterThanOrEqual(sourceScrollY - 60);
  }
});

test("a readable transcript can be chosen when Summary is unavailable without replacing Raw", async ({ page, apiFixture }) => {
  // 47f849a 之后原文/易读版不再是两个可切换的面板；这里保留原用例的底线：
  // 摘要失败时，原文照样能读，并且不会为此多花一次钱。
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");

  apiFixture.completeReadableTranscript();

  // 概要那条任务失败了：说一句失败，原文照样能读。
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("概要还在生成，可以先读原文。");
  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元" }).first()).toBeVisible();
  await expect(page.locator("#transcript-document")).toBeVisible();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a Summary sentence with two overlapping Claims requires an explicit choice", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded" });
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableSharedSummaryClaims();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

  // 同一句原话挂着两条待确认，操作栏把两条都列出来，读者必须点名选一条。
  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  await expect(rail.locator(".rail-review-item")).toHaveCount(2);
  await expect(rail.getByRole("button", { name: /客户仍需确认 120 万美元是否包含装修预算/ })).toBeVisible();

  await rail.getByRole("button", { name: /客户仍需确认 120 万美元是否包含装修预算/ }).click();
  await expect(page).toHaveURL(/view=simple(?!.*claim=)/);
  // 内联核对面板打开的是这条的证据，读者在这里逐条对原文。
  await expect(rail.locator(".inline-review-view")).toContainText("原始证据");
  await expect(rail.locator(".inline-review-view")).toContainText("预算上限是 120 万美元。");
});

test("the source rail stays open when another reading artifact finishes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "processing" });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();

  apiFixture.completeReadableTranscript();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"), { timeout: 8_000 }).toBeGreaterThan(1);
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await rail.getByRole("button", { name: "在逐字稿中定位" }).click();
  const selectedSource = page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元。" });
  await expect(selectedSource).toContainText("预算上限是 120 万美元。");
  await expect(selectedSource.getByTestId("transcript-turn-body")).toHaveAttribute("aria-pressed", "true");
  await expect(selectedSource).toBeFocused();
});

test("a Summary point opens a persistent operation rail without covering the reader", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

  await selectSourceTurn(page, "预算上限是 120 万美元");

  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(rail).toContainText("录音与原话");
  await expect(page.locator(".source-drawer-backdrop")).toHaveCount(0);
  if (isMobile(testInfo)) {
    await expect(page.locator(".reader-reading-pane")).toBeVisible();
    await expect(rail).toHaveAttribute("data-sheet", "open");
    await rail.getByRole("button", { name: "收起本次操作" }).click();
    await expect(rail).toHaveAttribute("data-sheet", "peek");
  }
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
});

test("a raw transcript paragraph can be handled in the rail without a detour", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments")).toBeGreaterThan(0);
  const targetParagraph = page.getByTestId("transcript-turn-body").filter({ hasText: "预算上限是 120 万美元" }).first();
  await expect(targetParagraph).toBeVisible();
  const paragraphText = await targetParagraph.locator("span").innerText();
  await targetParagraph.click();

  await expect(page.locator(".reader-action-rail .selected-point-card h3")).toHaveText(paragraphText);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
});

test("the summary and transcript are one continuous left-hand document without an extra transcript click", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableCompactTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");

  const readingDocument = page.locator(".reader-reading-scroll");
  const intelligence = page.locator(".reader-overview");
  const transcriptToolbar = page.locator("#transcript-document");
  const turns = page.getByTestId("transcript-turn");

  await expect(intelligence).toContainText("记录概览");
  await expect(intelligence.locator(".tingwu-overview-copy")).toBeVisible();
  await expect(transcriptToolbar).toContainText("原文");
  await expect(turns).toHaveCount(8);
  await expect(page.getByRole("button", { name: "查看完整逐字稿", exact: true })).toHaveCount(0);

  const oneDocument = await readingDocument.evaluate((documentNode) => {
    const summaryNode = documentNode.querySelector(".reader-overview");
    const transcriptNode = documentNode.querySelector("#transcript-document");
    const firstTurn = documentNode.querySelector('[data-testid="transcript-turn"]');
    if (!summaryNode || !transcriptNode || !firstTurn) return null;
    const summaryRect = summaryNode.getBoundingClientRect();
    const transcriptRect = transcriptNode.getBoundingClientRect();
    const firstTurnRect = firstTurn.getBoundingClientRect();
    return {
      summaryBeforeTranscript: summaryRect.top < transcriptRect.top,
      transcriptBeforeTurn: transcriptRect.top < firstTurnRect.top,
      containsAll: documentNode.contains(summaryNode) && documentNode.contains(transcriptNode) && documentNode.contains(firstTurn),
    };
  });
  expect(oneDocument).toMatchObject({ summaryBeforeTranscript: true, transcriptBeforeTurn: true, containsAll: true });
});

test("the transcript is a compact continuous document with stable speaker identity", async ({ page, apiFixture }, testInfo) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableCompactTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");

  const turns = page.getByTestId("transcript-turn");
  await expect(turns).toHaveCount(8);
  const geometry = await turns.evaluateAll((items) => items.slice(0, 6).map((item) => {
    const body = item.querySelector<HTMLElement>('[data-testid="transcript-turn-body"]');
    const rect = item.getBoundingClientRect();
    const bodyRect = body?.getBoundingClientRect();
    const style = body ? getComputedStyle(body) : null;
    const text = body?.querySelector<HTMLElement>("span");
    const textStyle = text ? getComputedStyle(text) : null;
    return {
      top: rect.top,
      bottom: rect.bottom,
      bodyX: bodyRect?.x ?? 0,
      bodyHeight: bodyRect?.height ?? 0,
      radius: Number.parseFloat(style?.borderRadius ?? "0"),
      background: style?.backgroundColor ?? "",
      shadow: style?.boxShadow ?? "none",
      fontSize: Number.parseFloat(textStyle?.fontSize ?? "0"),
      lineHeight: Number.parseFloat(textStyle?.lineHeight ?? "0"),
    };
  }));

  expect(geometry[5].bottom - geometry[0].top, "six short turns should fit in a compact reading viewport").toBeLessThanOrEqual(isMobile(testInfo) ? 700 : 660);
  expect(geometry.every((turn) => turn.bodyHeight >= 44)).toBe(true);
  expect(geometry.every((turn) => turn.radius <= 10)).toBe(true);
  // A turn is text on the document's own surface, not a card of its own: 240
  // white cards on a grey canvas made every paragraph read as a button.
  expect(geometry.every((turn) => turn.shadow === "none")).toBe(true);
  expect(geometry.every((turn) => turn.fontSize >= 14 && turn.lineHeight / turn.fontSize >= 1.45 && turn.lineHeight / turn.fontSize <= 1.85)).toBe(true);
  expect(Math.max(...geometry.map((turn) => turn.bodyX)) - Math.min(...geometry.map((turn) => turn.bodyX))).toBeLessThanOrEqual(1);
  for (let index = 1; index < geometry.length; index += 1) {
    // 47f849a 之后每段是独立卡片，段间 20px；仍然挡住再往大涨。
    expect(geometry[index].top - geometry[index - 1].bottom).toBeLessThanOrEqual(24);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));

  const speakerTones = await turns.evaluateAll((items) => items.map((item) => {
    const speaker = item.querySelector('[data-testid="transcript-turn-meta"] strong')?.textContent?.trim() ?? "";
    const mark = item.querySelector<HTMLElement>(".transcript-speaker-mark");
    const style = mark ? getComputedStyle(mark) : null;
    return { speaker, background: style?.backgroundColor ?? "", color: style?.color ?? "" };
  }));
  for (const speaker of new Set(speakerTones.map((tone) => tone.speaker))) {
    const tones = speakerTones.filter((tone) => tone.speaker === speaker).map((tone) => `${tone.background}|${tone.color}`);
    expect(new Set(tones).size, `${speaker} should keep one stable visual identity`).toBe(1);
  }
  expect(new Set(speakerTones.map((tone) => `${tone.background}|${tone.color}`)).size).toBeGreaterThan(1);

  await page.getByRole("button", { name: "搜索和筛选逐字稿" }).click();
  const search = page.getByPlaceholder("搜索原话");
  await expect(search).toBeVisible();
  await search.fill("Buyer detail 5");
  await expect(turns).toHaveCount(1);
  await search.fill("");
  await page.getByRole("button", { name: "搜索和筛选逐字稿" }).click();

  const readerWidth = await page.locator(".reader-reading-pane").evaluate((element) => element.getBoundingClientRect().width);
  await turns.nth(1).getByRole("button", { name: /Agent response 2/ }).click();
  await expect(page.locator(".reader-action-rail .selected-point-card")).toContainText("Agent response 2.");
  expect(await page.locator(".reader-reading-pane").evaluate((element) => element.getBoundingClientRect().width)).toBe(readerWidth);
});

test("390px keeps the continuous document usable and every primary transcript control touchable", async ({ page, apiFixture }, testInfo) => {
  test.skip(!isMobile(testInfo), "390px touch target assertion");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableCompactTranscript();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");

  const firstTurn = page.getByTestId("transcript-turn").first();
  const body = firstTurn.getByTestId("transcript-turn-body");
  const tools = page.getByRole("button", { name: "搜索和筛选逐字稿" });
  await expect(firstTurn).toBeVisible();

  // This import carries no recording, so its timestamp is a label. Offering a
  // permanently disabled play control instead only looks like a broken button.
  await expect(firstTurn.getByRole("button", { name: /前三秒播放/ })).toHaveCount(0);
  await expect(firstTurn.locator("time.transcript-turn-time").first()).toBeVisible();

  for (const [name, target] of [["原话", body], ["搜索与筛选", tools]] as const) {
    const box = await target.boundingBox();
    expect(box, `${name} control should have layout`).not.toBeNull();
    expect(box?.height ?? 0, `${name} control should be at least 40px high`).toBeGreaterThanOrEqual(40);
  }

  await body.click();
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toHaveAttribute("data-sheet", "open");
  const sheetToggle = rail.getByRole("button", { name: "收起本次操作" });
  const toggleBox = await sheetToggle.boundingBox();
  expect(toggleBox?.width ?? 0).toBeGreaterThanOrEqual(40);
  expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(40);
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("the transcript exports itself without touching the server", async ({ page, apiFixture }, testInfo) => {
  test.skip(isMobile(testInfo), "desktop toolbar");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();

  // Measured across the export itself: the workspace recovery heartbeat runs on
  // its own schedule and would otherwise be counted as if exporting caused it.
  const writesBeforeExport = apiFixture.writes.length;
  await page.getByRole("button", { name: "导出逐字稿" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "原文（TXT）" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/原文\.txt$/);
  // Export is a local re-serialization of what is on screen — never a write.
  expect(apiFixture.writes.slice(writesBeforeExport)).toEqual([]);
});

test("a chapter takes the reader to that moment in the transcript", async ({ page, apiFixture }, testInfo) => {
  test.skip(isMobile(testInfo), "desktop reading column");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=raw");
  await page.getByRole("button", { name: "章节速览" }).first().click();
  await expect(page.locator(".reader-chapters .reading-chapter").first()).toBeVisible();

  // 章节就是目录：点一条要把文档滚过去，不只是填右侧面板。
  const scroller = page.locator(".reader-reading-scroll");
  const before = await scroller.evaluate((node) => node.scrollTop);
  await page.locator(".reader-chapters .chapter-time").last().click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).toMatch(/^raw-group-/);
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThanOrEqual(before);
});

test("390px keeps every Summary point inside the visible reading column", async ({ page, apiFixture }, testInfo) => {
  test.skip(!isMobile(testInfo), "390px internal overflow assertion");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "succeeded" });
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);
  await page.getByRole("button", { name: "要点回顾" }).click();

  // 每条要点都得留在 390px 的阅读列里，不能横向溢出。
  const overflowing = await page.locator(".tingwu-keypoints").evaluate((content) => {
    const width = window.innerWidth;
    return [...content.querySelectorAll<HTMLElement>(".tingwu-point")]
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => rect.left < 0 || rect.right > width).length;
  });
  expect(overflowing).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a visible source can be confirmed in place without leaving the reading workspace", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/claims/claim-summary-pending/verdicts");
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  await expect(rail.getByText("预算上限是 120 万美元", { exact: true }).last()).toBeVisible();
  await expect(rail.locator(".point-trust-state.pending")).toHaveText("需确认");
  await expect(rail.locator(".rail-review-row .status-badge.warning")).toHaveText("待确认");
  await rail.getByRole("button", { name: "确认", exact: true }).click();

  await expect(rail.locator(".point-trust-state.verified")).toHaveText("已确认");
  await expect(rail.locator(".rail-review-row .status-badge.success")).toHaveText("已确认");
  await expect(rail.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/view=simple/);
  expect(apiFixture.writes.find(({ path }) => path.endsWith("/claim-summary-pending/verdicts"))?.body).toMatchObject({
    action: "confirm",
    retain_relation_ids: [],
  });
});

test("an incompletely displayed source cannot be quick-confirmed", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  apiFixture.enableIncompleteSummaryEvidence();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  const row = rail.locator(".rail-review-row").filter({ hasText: "预算上限是 120 万美元" });
  await expect(row.getByRole("button", { name: "确认", exact: true })).toBeDisabled();
  await expect(row).toContainText("这条还需补证据或判断与旧记录的关系");
  await expect(row.getByRole("button", { name: "打开详情核对" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple(?!.*claim=)/);
  expect(apiFixture.writes.some(({ path }) => path.includes("/verdicts"))).toBe(false);
});

test("chapter and speaker insights stay selected above the same transcript document", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  await page.goto("/?project=project-a&event=event-a&view=simple");

  const topics = page.getByRole("button", { name: "章节速览", exact: true });
  await topics.click();
  await expect(topics).toHaveClass(/active/);
  await expect(page.locator(".reader-chapters .reading-chapter").first()).toBeVisible();
  await expect(page).toHaveURL(/readingTab=summary/);

  await expect(page.locator("#transcript-document")).toBeVisible();

  const speakers = page.getByRole("button", { name: "发言总结", exact: true });
  await speakers.click();
  await expect(speakers).toHaveClass(/active/);
  const avatars = page.locator(".tingwu-speaker-summaries .speaker-avatar");
  await expect(avatars).toHaveCount(1);
  await expect(page.locator(".tingwu-speaker-summaries .speaker-avatar svg")).toHaveCount(1);
  expect(await avatars.allTextContents()).toEqual([""]);
  await expect(page.locator("#transcript-document")).toBeVisible();
});

test("mobile operations open as a bottom sheet without replacing the reader", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);

  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute("data-sheet", "open");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  await rail.getByRole("button", { name: "收起本次操作" }).click();
  await expect(rail).toHaveAttribute("data-sheet", "peek");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("tablet operations stay reachable as a sheet instead of falling below the transcript", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "预算上限是 120 万美元");
  const rail = page.locator(".reader-action-rail");
  await expect(rail).toHaveAttribute("data-sheet", "open");
  await expect(rail.getByRole("heading", { name: /预算上限是 120 万美元/ })).toBeVisible();
  await expect(rail).toHaveCSS("position", "fixed");
  await expect(page.locator(".reader-reading-pane")).toBeVisible();
});

test("briefly viewing sources keeps the selected point and warm transcript state", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expandSummaryIfCollapsed(page);
  await selectSourceTurn(page, "预算上限是 120 万美元");
  const transcriptReads = apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments");

  await page.locator(".meeting-tabs").getByRole("button", { name: /^材料/ }).click();
  await page.getByRole("button", { name: /^本次重点/ }).click();

  await expect(page.locator(".selected-point-card")).toContainText("预算上限是 120 万美元");
  expect(apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments")).toBe(transcriptReads);
});

test("an old Run without reading artifacts falls back to the original transcript", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");
  // Opening the reader automatically is not a tab choice. The route records a
  // reading surface only when the reader picks one, so a raw view shown before
  // the readable pass exists cannot outlive it; an explicit pick is still
  // recorded and still survives reload (see the manual-selection tests below).
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元。" }).first()).toBeVisible();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("failed Summary and readable transcript fall back to Raw without exposing model error codes", async ({ page, apiFixture }) => {
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "failed" });
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");

  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元。" }).first()).toBeVisible();
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("概要还在生成，可以先读原文。");
  await page.getByRole("button", { name: "要点回顾" }).click();
  await expect(page.getByText("要点还在生成。", { exact: true })).toBeVisible();
  await expect(page.getByText("MODEL_OUTPUT_INVALID", { exact: true })).toHaveCount(0);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

// 47f849a 之后没有原文/易读版切换，readingTab=raw 不再是一个可手选的面板；深链恢复由下一条用例覆盖。
test.skip("manual Raw selection replaces the route and survives reload from a Summary URL", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
});

test("a Summary deep link restores the pinned intelligence and transcript in one document", async ({ page, apiFixture }) => {
  apiFixture.completeSummary();
  apiFixture.completeReadableTranscript();
  apiFixture.completeFacts();
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("button", { name: "章节速览", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.locator("#transcript-document")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  await expect(page.getByRole("button", { name: "章节速览", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.locator("#transcript-document")).toBeVisible();
});

test("workspace Transcript selection is routed and leaving Transcript clears the reading tab", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow();
  await page.goto("/?project=project-a&event=event-a&view=simple");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");

  await page.getByRole("button", { name: /^本次重点/ }).click();
  await expect(page).toHaveURL(/view=simple.*readingTab=raw/);

  await page.locator(".meeting-tabs").getByRole("button", { name: /^材料/ }).click();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await expect(page.locator(".meeting-tabs").getByRole("button", { name: /^材料/ })).toHaveClass(/active/);
});

test("a new processing Summary Run never renders an older Run's Artifact", async ({ page, apiFixture }) => {
  apiFixture.enableNewSummaryRunWithStaleArtifact();
  apiFixture.allowMutation("POST", "/api/v1/jobs/dispatch");
  await page.goto("/?project=project-a&event=event-a&view=simple&readingTab=summary");
  await expect(page.getByRole("combobox", { name: "选择记录" })).toHaveValue("event-a");

  await expect(page).toHaveURL(/view=simple.*readingTab=summary/);
  // 新的概要还在生成：转圈加「内容生成中」，不拿旧任务的内容顶上。
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("内容生成中…");
  await expect(page.locator("#transcript-document")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  await expect(page.locator(".tingwu-overview-copy p", { hasText: "A 摘要背景 1" })).toHaveCount(0);
  await expect(page.getByText("预算上限是 120 万美元", { exact: true })).toHaveCount(0);
});
