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

test("a warm result tab reuses the same Project, Events, and verified View reads", async ({ page, apiFixture }) => {
  const projectPath = "/api/v1/projects/project-a";
  const eventsPath = "/api/v1/projects/project-a/events";
  const timelinePath = "/api/v1/projects/project-a/views/timeline";
  const actionsPath = "/api/v1/projects/project-a/actions";

  await page.goto("/?project=project-a&event=event-a&view=results&tab=timeline&origin=simple");
  await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人承诺周五前发送三套房源", { exact: true })).toBeVisible();

  const initialProjectReads = apiFixture.readCount(projectPath);
  const initialEventReads = apiFixture.readCount(eventsPath);
  const initialTimelineReads = apiFixture.readCount(timelinePath);
  expect(initialProjectReads).toBeGreaterThan(0);
  expect(initialEventReads).toBeGreaterThan(0);
  expect(initialTimelineReads).toBe(1);

  await page.locator(".result-nav-primary button").filter({ hasText: "下一步" }).click();
  await expect(page.getByRole("heading", { name: "下一步", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人周五前发送三套符合预算的房源", { exact: true })).toBeVisible();
  expect(apiFixture.readCount(actionsPath)).toBe(1);

  await page.locator(".result-nav-primary button").filter({ hasText: "时间线" }).click();
  await expect(page.getByRole("heading", { name: "时间线", exact: true })).toBeVisible();
  await expect(page.getByText("经纪人承诺周五前发送三套房源", { exact: true })).toBeVisible();

  expect(apiFixture.readCount(projectPath)).toBe(initialProjectReads);
  expect(apiFixture.readCount(eventsPath)).toBe(initialEventReads);
  expect(apiFixture.readCount(timelinePath)).toBe(initialTimelineReads);
  expect(apiFixture.readCount(actionsPath)).toBe(1);
});

test("a delayed Project A Query cannot replace Project B after a rapid switch", async ({ page, apiFixture }) => {
  const projectASnapshotPath = "/api/v1/projects/project-a/workflow-snapshot";
  const projectBSnapshotPath = "/api/v1/projects/project-b/workflow-snapshot";
  apiFixture.holdProjectASnapshot = true;

  await page.goto("/?project=project-a&event=event-a&view=simple");
  await apiFixture.waitForProjectASnapshotRequest();
  expect(apiFixture.readCount(projectASnapshotPath)).toBe(1);

  await page.getByLabel("选择当前项目").selectOption("project-b");
  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-b");
  await expect(page.getByRole("heading", { name: "B 初次沟通", exact: true })).toBeVisible();
  await expect.poll(() => apiFixture.readCount(projectBSnapshotPath)).toBeGreaterThan(0);

  apiFixture.releaseProjectASnapshot();
  await expect.poll(() => (
    apiFixture.completedReadCount(projectASnapshotPath)
    + apiFixture.failedReadCount(projectASnapshotPath)
  )).toBeGreaterThan(0);

  await expect(page.getByLabel("选择当前项目")).toHaveValue("project-b");
  await expect(page.getByRole("heading", { name: "B 初次沟通", exact: true })).toBeVisible();
  await expect(page.locator(".current-event-status")).toHaveText("已完成");
  await page.getByRole("button", { name: /^Transcript/ }).click();
  await page.getByRole("button", { name: /^AI 摘要/ }).click();
  await expect(page.getByRole("heading", { name: "B 项目会议重点" })).toBeVisible();
  await expect(page.getByText("预算上限是 120 万美元", { exact: true })).toHaveCount(0);
});
