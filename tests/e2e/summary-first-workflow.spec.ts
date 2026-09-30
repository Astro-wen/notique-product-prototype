import { expect, test as base, type Page } from "@playwright/test";
import { NotiqueApiFixture } from "./notique-api-fixture";

type Fixtures = { apiFixture: NotiqueApiFixture };
const test = base.extend<Fixtures>({
  apiFixture: [async ({ page }, provide) => {
    const fixture = new NotiqueApiFixture();
    fixture.enableSummaryFirstFlow();
    fixture.allowMutation("POST", "/api/v1/jobs/dispatch");
    fixture.allowMutation("POST", "/api/v1/projects/project-a/opened");
    await fixture.install(page);
    await provide(fixture);
    for (const wake of fixture.writes.filter(({ path }) => path === "/api/v1/jobs/dispatch")) {
      if (wake.body === null) continue;
      expect(wake.body).toMatchObject({ kind: expect.stringMatching(/^(artifact|extraction)$/), run_id: expect.stringMatching(/^(artifact-run-|run-a$)/) });
    }
    fixture.assertNoUnexpectedWrites();
  }, { auto: true }],
});
const RECORD_URL = "/?project=project-a&event=event-a&view=simple";
const READ_PATH_WRITES = ["/api/v1/jobs/dispatch", "/api/v1/projects/project-a/opened"];
const budgetBullet = (page: Page) => page.getByTestId("bullet-claim-summary-pending");
function nonWakeWrites(fixture: NotiqueApiFixture) { return fixture.writes.filter(({ path }) => !READ_PATH_WRITES.includes(path)); }
function finishReading(fixture: NotiqueApiFixture) { fixture.completeSummary(); fixture.completeReadableTranscript(); fixture.completeFacts(); }
async function openSource(page: Page) {
  await page.getByRole("button", { name: "查看原文", exact: true }).click();
  await expect(page.locator(".reader-workspace-layout.is-source-only")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
}
async function showReadingAids(page: Page) {
  const aids = page.locator(".reader-extra-views");
  if (await aids.getAttribute("open") === null) await aids.locator(":scope > summary").click();
  await expect(aids).toHaveAttribute("open", "");
}
async function selectSourceTurn(page: Page, text: string) {
  const body = page.getByTestId("transcript-turn-body").filter({ hasText: text }).first();
  await body.click(); await expect(body).toHaveAttribute("aria-pressed", "true");
}

// Preserve the historical reading guarantees using V2's record and optional
// source reader. Both configured projects are PC viewports. Decisions happen
// beside bullets, while source reading uses one column without a decision rail.
test("the record opens first and a finished Summary does not steal the source choice", async ({ page, apiFixture }) => {
  await page.goto(RECORD_URL);
  await expect(page.getByRole("button", { name: "本次重点", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("region", { name: "记录整理进度" })).toBeVisible();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  await openSource(page); await showReadingAids(page);
  apiFixture.completeSummary();
  await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.getByRole("button", { name: "原文", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".reader-action-rail")).toHaveCount(0);
  await expect(page.locator(".reader-overview-divider")).toContainText("请结合原文核对");
  expect(nonWakeWrites(apiFixture), "reading must not create or retry a paid run").toEqual([]);
});

test("the completed record and its source survive refresh without another paid run", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(RECORD_URL);
  await expect(budgetBullet(page)).toContainText("预算上限是 120 万美元");
  await expect(budgetBullet(page).getByRole("button", { name: "确认这条", exact: true })).toBeVisible();
  await budgetBullet(page).getByRole("button", { name: "原话", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "原话与出处" })).toContainText("预算上限是 120 万美元。");
  await page.getByRole("button", { name: "返回记录", exact: true }).click();
  await openSource(page); await page.reload();
  await expect(page.locator(".reader-workspace-layout.is-source-only")).toBeVisible();
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("an explicit project overview choice is never replaced when Summary finishes", async ({ page, apiFixture }) => {
  await page.goto(RECORD_URL);
  const scope = page.getByRole("button", { name: "整个项目", exact: true });
  await scope.click(); await expect(scope).toHaveClass(/active/);
  const reads = apiFixture.readCount("/api/v1/projects/project-a/workflow-snapshot");
  apiFixture.completeSummary();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/projects/project-a/workflow-snapshot")).toBeGreaterThan(reads);
  await expect(scope).toHaveClass(/active/); await expect(page.locator(".reader-workspace-layout")).toBeHidden();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a completed Summary never closes an open direct-recording material interaction", async ({ page, apiFixture }) => {
  await page.addInitScript(() => window.sessionStorage.setItem("notique.ui.public-workspace-acknowledged", "1"));
  await page.goto(RECORD_URL);
  const materials = page.locator(".meeting-tabs").getByRole("button", { name: "材料", exact: true });
  await materials.click(); await page.locator(".material-record").click();
  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible();
  const reads = apiFixture.readCount("/api/v1/projects/project-a/workflow-snapshot");
  apiFixture.completeSummary();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/projects/project-a/workflow-snapshot")).toBeGreaterThan(reads);
  await expect(page.getByRole("region", { name: "直接录音" })).toBeVisible(); await expect(materials).toHaveClass(/active/);
  await expect(page.locator(".tingwu-overview-copy p")).toBeHidden(); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("facts finishing preserves an expanded source Summary and its scroll position", async ({ page, apiFixture }) => {
  await page.goto(RECORD_URL); await openSource(page); await showReadingAids(page);
  apiFixture.completeSummary(); await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  const expand = page.locator(".tingwu-overview-copy button.text-button");
  await expand.click(); await expect(expand).toHaveText("收起概要");
  const scroller = page.locator(".reader-reading-scroll"); await scroller.evaluate(node => { node.scrollTop = 600; });
  const before = await scroller.evaluate(node => node.scrollTop); expect(before).toBeGreaterThan(0);
  apiFixture.completeFacts();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/extraction-runs/run-a/claims")).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "原文", exact: true })).toHaveClass(/active/);
  await expect(expand).toHaveText("收起概要"); await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThanOrEqual(before - 60);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a failed Summary does not block the source when the readable pass finishes", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "processing" });
  await page.goto(RECORD_URL); await openSource(page); await showReadingAids(page); apiFixture.completeReadableTranscript();
  await expect(page.locator(".tingwu-overview-copy")).toContainText("需要时可生成原文概要。");
  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元" }).first()).toBeVisible();
  await expect(page.locator("#transcript-document")).toBeVisible(); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("two claims sharing a source retain independent review choices", async ({ page, apiFixture }) => {
  finishReading(apiFixture); apiFixture.enableSharedSummaryClaims(); await page.goto(RECORD_URL);
  const question = page.getByTestId("bullet-claim-summary-shared");
  await expect(budgetBullet(page).getByRole("button", { name: "确认这条", exact: true })).toBeVisible();
  await expect(question.getByRole("button", { name: "补答案", exact: true })).toBeVisible();
  for (const bullet of [budgetBullet(page), question]) {
    await bullet.getByRole("button", { name: "原话", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "原话与出处" })).toContainText("预算上限是 120 万美元。");
    await page.getByRole("button", { name: "返回记录", exact: true }).click();
  }
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a selected source remains selected when another reading artifact finishes", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "succeeded", readableStatus: "processing" });
  await page.goto(RECORD_URL); await openSource(page); await selectSourceTurn(page, "预算上限是 120 万美元");
  const before = apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"); apiFixture.completeReadableTranscript();
  await expect.poll(() => apiFixture.completedReadCount("/api/v1/events/event-a/ai-artifacts"), { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId("transcript-turn-body").filter({ hasText: "预算上限是 120 万美元。" }).first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".reader-action-rail")).toHaveCount(0); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a bullet opens its exact source and returns to the same record", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(RECORD_URL);
  await budgetBullet(page).getByRole("button", { name: "原话", exact: true }).click();
  const source = page.getByRole("dialog", { name: "原话与出处" });
  await expect(source).toContainText("预算上限是 120 万美元。"); await expect(source).toContainText("Buyer");
  await page.getByRole("button", { name: "返回记录", exact: true }).click();
  await expect(source).toHaveCount(0); await expect(budgetBullet(page)).toBeInViewport();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a raw transcript paragraph selects in the source reader without a detour", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(RECORD_URL); await openSource(page); await selectSourceTurn(page, "预算上限是 120 万美元");
  await expect(page.locator(".reader-action-rail")).toHaveCount(0); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元" }).first()).toHaveClass(/selected/);
  await expect(page).toHaveURL(/view=simple/); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("optional Summary and transcript stay in one continuous source document", async ({ page, apiFixture }) => {
  finishReading(apiFixture); apiFixture.enableCompactTranscript(); await page.goto(`${RECORD_URL}&readingTab=summary`); await showReadingAids(page);
  await expect(page.locator(".reader-overview")).toContainText("记录概览"); await expect(page.getByTestId("transcript-turn")).toHaveCount(8);
  const geometry = await page.locator(".reader-reading-scroll").evaluate(node => {
    const summary = node.querySelector(".reader-overview")!; const toolbar = node.querySelector("#transcript-document")!; const turn = node.querySelector('[data-testid="transcript-turn"]')!;
    return { order: summary.getBoundingClientRect().top < toolbar.getBoundingClientRect().top && toolbar.getBoundingClientRect().top < turn.getBoundingClientRect().top,
      containsAll: node.contains(summary) && node.contains(toolbar) && node.contains(turn) };
  });
  expect(geometry).toEqual({ order: true, containsAll: true }); await expect(page.getByRole("button", { name: "查看完整逐字稿", exact: true })).toHaveCount(0);
});

test("the transcript is compact and keeps speaker identity through search", async ({ page, apiFixture }) => {
  finishReading(apiFixture); apiFixture.enableCompactTranscript(); await page.goto(`${RECORD_URL}&readingTab=raw`);
  const turns = page.getByTestId("transcript-turn"); await expect(turns).toHaveCount(8);
  const geometry = await turns.evaluateAll(items => items.slice(0, 6).map(item => {
    const body = item.querySelector<HTMLElement>('[data-testid="transcript-turn-body"]')!; const style = getComputedStyle(body); const textStyle = getComputedStyle(body.querySelector("span")!); const rect = item.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, x: body.getBoundingClientRect().x, height: body.getBoundingClientRect().height, radius: parseFloat(style.borderRadius), shadow: style.boxShadow, font: parseFloat(textStyle.fontSize), line: parseFloat(textStyle.lineHeight) };
  }));
  expect(geometry[5].bottom - geometry[0].top).toBeLessThanOrEqual(660);
  expect(geometry.every(turn => turn.height >= 44 && turn.radius <= 10 && turn.shadow === "none")).toBe(true);
  expect(geometry.every(turn => turn.font >= 14 && turn.line / turn.font >= 1.45 && turn.line / turn.font <= 1.85)).toBe(true);
  expect(Math.max(...geometry.map(turn => turn.x)) - Math.min(...geometry.map(turn => turn.x))).toBeLessThanOrEqual(1);
  for (let index = 1; index < geometry.length; index++) expect(geometry[index].top - geometry[index - 1].bottom).toBeLessThanOrEqual(24);
  const tones = await turns.evaluateAll(items => items.map(item => {
    const style = getComputedStyle(item.querySelector<HTMLElement>(".transcript-speaker-mark")!);
    return { speaker: item.querySelector('[data-testid="transcript-turn-meta"] strong')?.textContent, tone: `${style.backgroundColor}|${style.color}` };
  }));
  for (const speaker of new Set(tones.map(tone => tone.speaker))) expect(new Set(tones.filter(tone => tone.speaker === speaker).map(tone => tone.tone)).size).toBe(1);
  expect(new Set(tones.map(tone => tone.tone)).size).toBeGreaterThan(1);
  await page.getByRole("button", { name: "搜索和筛选逐字稿" }).click(); await page.getByPlaceholder("搜索原话").fill("Buyer detail 5");
  await expect(turns).toHaveCount(1); await page.getByPlaceholder("搜索原话").fill(""); await expect(turns).toHaveCount(8);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("PC transcript controls work with a keyboard and show timestamps without fake playback", async ({ page, apiFixture }) => {
  finishReading(apiFixture); apiFixture.enableCompactTranscript(); await page.goto(`${RECORD_URL}&readingTab=raw`);
  const turn = page.getByTestId("transcript-turn").first(); const body = turn.getByTestId("transcript-turn-body");
  await expect(turn.locator("time.transcript-turn-time")).toBeVisible(); await expect(turn.getByRole("button", { name: /前三秒播放/ })).toHaveCount(0);
  await body.focus(); await page.keyboard.press("Enter"); await expect(body).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "搜索和筛选逐字稿" }).focus(); await page.keyboard.press("Enter"); await expect(page.getByPlaceholder("搜索原话")).toBeVisible();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("the transcript exports itself without a server mutation", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(`${RECORD_URL}&readingTab=raw`); await expect(page.getByTestId("transcript-turn").first()).toBeVisible();
  const before = nonWakeWrites(apiFixture).length; await page.getByRole("button", { name: "导出逐字稿" }).click();
  const downloading = page.waitForEvent("download"); await page.getByRole("menuitem", { name: "原文（TXT）" }).click();
  expect((await downloading).suggestedFilename()).toMatch(/原文\.txt$/); expect(nonWakeWrites(apiFixture).slice(before)).toEqual([]);
});

test("a chapter takes the reader to that moment in the transcript", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(`${RECORD_URL}&readingTab=raw`); await showReadingAids(page);
  await page.getByRole("button", { name: "章节速览", exact: true }).click(); await expect(page.locator(".reader-chapters .reading-chapter").first()).toBeVisible();
  await page.locator(".reader-chapters .chapter-time").last().click(); await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? "")).toMatch(/^raw-group-/);
  await expect(page.locator(".transcript-turn.selected").first()).toBeInViewport(); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("every optional Summary point fits the PC source column", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(`${RECORD_URL}&readingTab=raw`); await showReadingAids(page);
  await page.getByRole("button", { name: "要点回顾", exact: true }).click(); await expect(page.locator(".tingwu-keypoints")).toBeVisible();
  const overflowing = await page.locator(".tingwu-keypoints").evaluate(content => {
    const pane = document.querySelector(".reader-reading-pane")!.getBoundingClientRect();
    return [...content.querySelectorAll<HTMLElement>(".tingwu-point")].filter(item => { const rect = item.getBoundingClientRect(); return rect.left < pane.left - 1 || rect.right > pane.right + 1; }).length;
  });
  expect(overflowing).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
});

test("a sourced bullet is confirmed in place with its exact version", async ({ page, apiFixture }) => {
  finishReading(apiFixture); const path = "/api/v2/review-cards/card-claim-summary-pending/decisions"; apiFixture.allowMutation("POST", path);
  await page.goto(RECORD_URL); await budgetBullet(page).getByRole("button", { name: "原话", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "原话与出处" })).toContainText("预算上限是 120 万美元。"); await page.getByRole("button", { name: "返回记录", exact: true }).click();
  await budgetBullet(page).getByRole("button", { name: "确认这条", exact: true }).click(); await expect(budgetBullet(page)).toContainText("已采纳");
  await expect(budgetBullet(page).getByRole("button", { name: "确认这条", exact: true })).toHaveCount(0); await expect(page).toHaveURL(/view=simple(?!.*readingTab)/);
  expect(apiFixture.writes.find(write => write.path === path)?.body).toMatchObject({ operation: "confirm", expectedContextVersion: 8, expectedCardRevision: 1,
    members: [{ claimId: "claim-summary-pending", claimVersionId: "claim-summary-pending-version-1", operation: "confirm" }] });
});

test("chapter and speaker insights switch above the same transcript document", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(`${RECORD_URL}&readingTab=raw`); await showReadingAids(page);
  const topics = page.getByRole("button", { name: "章节速览", exact: true }); await topics.click(); await expect(topics).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".reader-chapters .reading-chapter").first()).toBeVisible(); const speakers = page.getByRole("button", { name: "发言总结", exact: true });
  await speakers.click(); await expect(speakers).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tingwu-speaker-summaries .speaker-avatar")).toHaveCount(1); await expect(page.locator(".tingwu-speaker-summaries .speaker-avatar svg")).toHaveCount(1);
  await expect(page.locator("#transcript-document")).toBeVisible();
});

test("the PC source dialog closes with Escape and restores focus to the bullet", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(RECORD_URL); const trigger = budgetBullet(page).getByRole("button", { name: "原话", exact: true });
  await trigger.click(); await expect(page.getByRole("dialog", { name: "原话与出处" })).toBeVisible(); await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(budgetBullet(page)).toBeVisible();
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("the PC source uses the canvas and leaves decision controls on the record", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(RECORD_URL); await openSource(page); await selectSourceTurn(page, "预算上限是 120 万美元");
  const bounds = await page.evaluate(() => { const pane = document.querySelector(".reader-reading-pane")!.getBoundingClientRect(); const layout = document.querySelector(".reader-workspace-layout")!.getBoundingClientRect(); return { ratio: pane.width / layout.width, overflow: document.documentElement.scrollWidth > innerWidth }; });
  expect(bounds.ratio).toBeGreaterThanOrEqual(0.95); expect(bounds.overflow).toBe(false); await expect(page.locator(".reader-action-rail")).toHaveCount(0);
  await page.getByRole("button", { name: "本次重点", exact: true }).click(); await expect(budgetBullet(page).getByRole("button", { name: "确认这条", exact: true })).toBeVisible();
});

test("briefly viewing materials preserves the selected source and warm transcript", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(RECORD_URL); await openSource(page); await selectSourceTurn(page, "预算上限是 120 万美元");
  const before = apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments");
  await page.getByRole("button", { name: "材料", exact: true }).click(); await page.getByRole("button", { name: "原文", exact: true }).click();
  await expect(page.getByTestId("transcript-turn-body").filter({ hasText: "预算上限是 120 万美元" }).first()).toHaveAttribute("aria-pressed", "true");
  expect(apiFixture.completedReadCount("/api/v1/events/event-a/transcript-segments")).toBe(before); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("an old run without reading artifacts still opens the original transcript", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow(); await page.goto(RECORD_URL); await expect(budgetBullet(page)).toBeVisible(); await openSource(page);
  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元。" }).first()).toBeVisible();
  await expect(page.locator(".reader-extra-views")).not.toHaveAttribute("open", ""); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("failed reading artifacts leave Raw usable without exposing model error codes", async ({ page, apiFixture }) => {
  apiFixture.enableSummaryFirstFlow({ summaryStatus: "failed", readableStatus: "failed" }); await page.goto(`${RECORD_URL}&readingTab=summary`); await showReadingAids(page);
  await expect(page.getByTestId("transcript-turn").filter({ hasText: "预算上限是 120 万美元。" }).first()).toBeVisible();
  await expect(page.locator(".tingwu-overview-copy")).toContainText("需要时可生成原文概要。"); await page.getByRole("button", { name: "要点回顾", exact: true }).click();
  await expect(page.locator(".reader-overview")).toContainText("需要时可生成原文概要。"); await expect(page.getByText("MODEL_OUTPUT_INVALID", { exact: true })).toHaveCount(0);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("explicit source navigation replaces a Summary deep link and survives reload", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(`${RECORD_URL}&readingTab=summary`); await page.getByRole("button", { name: "本次重点", exact: true }).click();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/); await page.getByRole("button", { name: "原文", exact: true }).click();
  await expect(page).toHaveURL(/readingTab=readable/); await page.reload(); await expect(page).toHaveURL(/readingTab=readable/);
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible(); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a Summary deep link restores its source document and optional intelligence", async ({ page, apiFixture }) => {
  finishReading(apiFixture); await page.goto(`${RECORD_URL}&readingTab=summary`); await showReadingAids(page);
  await expect(page).toHaveURL(/readingTab=summary/); await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.locator("#transcript-document")).toBeVisible(); await page.reload(); await showReadingAids(page);
  await expect(page).toHaveURL(/readingTab=summary/); await expect(page.locator(".tingwu-overview-copy p")).toContainText("A 摘要背景 1");
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible(); expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("workspace source navigation is routed and leaving it clears the reading tab", async ({ page, apiFixture }) => {
  apiFixture.enableLegacyRawFlow(); await page.goto(RECORD_URL); await page.getByRole("button", { name: "原文", exact: true }).click();
  await expect(page).toHaveURL(/readingTab=raw/); await page.getByRole("button", { name: "材料", exact: true }).click();
  await expect(page).toHaveURL(/view=simple(?!.*readingTab)/); await expect(page.getByRole("button", { name: "材料", exact: true })).toHaveClass(/active/);
  expect(nonWakeWrites(apiFixture)).toEqual([]);
});

test("a new processing Summary run never renders an older run's artifact", async ({ page, apiFixture }) => {
  apiFixture.enableNewSummaryRunWithStaleArtifact(); await page.goto(`${RECORD_URL}&readingTab=summary`); await showReadingAids(page);
  await expect(page).toHaveURL(/readingTab=summary/); await expect(page.locator(".tingwu-overview-copy")).toContainText("内容生成中…");
  await expect(page.getByTestId("transcript-turn").first()).toBeVisible(); await expect(page.locator(".tingwu-overview-copy p", { hasText: "A 摘要背景 1" })).toHaveCount(0);
  await expect(page.locator(".tingwu-keypoints .tingwu-point")).toHaveCount(0); expect(nonWakeWrites(apiFixture)).toEqual([]);
});
