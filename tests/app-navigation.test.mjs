import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const moduleUrl = pathToFileURL(path.resolve("lib/domain/app-navigation.ts")).href;
const {
  backLabelForRoute,
  fallbackBackRoute,
  isCoreWorkflowRoute,
  isReadonlyClaimRoute,
  parseAppRoute,
  requestOwnerIsCurrent,
  serializeAppRoute,
} = await import(moduleUrl);

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("route query round-trips a report claim and its exact origin", () => {
  const route = {
    view: "claim",
    projectId: "project-1",
    eventId: "event-2",
    claimId: "claim-3",
    origin: "results",
    originTab: "timeline",
  };
  assert.deepEqual(parseAppRoute(serializeAppRoute(route)), route);
});

test("report evidence returns to the exact report tab", () => {
  const route = parseAppRoute("?project=p&event=e&view=claim&claim=c&origin=results&originTab=timeline");
  assert.deepEqual(fallbackBackRoute(route), {
    view: "results",
    projectId: "p",
    eventId: "e",
    tab: "timeline",
    origin: "project",
  });
  assert.equal(backLabelForRoute(route), "返回时间线");
  assert.equal(isReadonlyClaimRoute(route), true);
});

test("review and event claims have deterministic fallback destinations", () => {
  assert.equal(fallbackBackRoute({ view: "claim", projectId: "p", eventId: "e", claimId: "c", origin: "review" }).view, "review");
  assert.equal(backLabelForRoute({ view: "claim", projectId: "p", eventId: "e", claimId: "c", origin: "review" }), "返回审核列表");
  assert.equal(fallbackBackRoute({ view: "claim", projectId: "p", eventId: "e", claimId: "c" }).view, "event");
  assert.equal(fallbackBackRoute({ view: "run-debug", projectId: "p", eventId: "e", runId: "r" }).view, "event");
});

test("a claim opened from the AI summary returns to the same core workspace", () => {
  const route = { view: "claim", projectId: "p", eventId: "e", claimId: "c", origin: "simple" };
  assert.deepEqual(fallbackBackRoute(route), { view: "simple", projectId: "p", eventId: "e" });
  assert.equal(backLabelForRoute(route), "返回 AI 摘要");
});

test("only the core workspace is eligible for guided auto-navigation", () => {
  assert.equal(isCoreWorkflowRoute({ view: "simple", projectId: "p" }), true);
  for (const view of ["draft", "review", "claim", "results", "event", "run-debug"]) {
    assert.equal(isCoreWorkflowRoute({ view, projectId: "p" }), false);
  }
});

test("invalid deep-link values fall back without retaining unsafe fields", () => {
  assert.deepEqual(parseAppRoute("?view=random&tab=random&claim=c&origin=random"), { view: "simple" });
});

test("report tabs replace history and refresh preserves the current app depth", () => {
  const source = fs.readFileSync("app/page.tsx", "utf8");
  assert.match(source, /onSelect=\{\(tab\) => void loadView\(tab, undefined, "replace"\)\}/);
  assert.match(source, /notiqueDepth: currentDepth/);
  assert.match(source, /backLabel=\{backLabelForRoute\(route\)\}/);
});

test("a new project selection invalidates an older workflow snapshot", () => {
  const source = fs.readFileSync("app/page.tsx", "utf8");
  const loadSimpleProject = source.slice(
    source.indexOf("const loadSimpleProject = useCallback"),
    source.indexOf("const loadEvent = useCallback"),
  );
  assert.match(loadSimpleProject, /invalidateProjectSelectionRequests\(\)/);
});

test("a delayed project response cannot overwrite the newer selection", async () => {
  let current = {
    projectId: "project-a",
    projectEpoch: 1,
    eventId: "event-a",
    eventEpoch: 1,
  };
  let visible = "";
  const slowA = deferred();
  const ownerA = { ...current };
  const commit = async (owner, result) => {
    const value = await result;
    if (requestOwnerIsCurrent(owner, current)) visible = value;
  };

  const pendingA = commit(ownerA, slowA.promise);
  current = {
    projectId: "project-b",
    projectEpoch: 2,
    eventId: "event-b",
    eventEpoch: 2,
  };
  await commit({ ...current }, Promise.resolve("project-b claims"));
  slowA.resolve("project-a claims");
  await pendingA;

  assert.equal(visible, "project-b claims");
});

test("a delayed event response cannot overwrite a newer event in the same project", async () => {
  let current = {
    projectId: "project-a",
    projectEpoch: 4,
    eventId: "event-1",
    eventEpoch: 7,
  };
  let visible = "";
  const slowEvent = deferred();
  const ownerEvent1 = { ...current };
  const pendingEvent1 = slowEvent.promise.then((value) => {
    if (requestOwnerIsCurrent(ownerEvent1, current)) visible = value;
  });

  current = { ...current, eventId: "event-2", eventEpoch: 8 };
  if (requestOwnerIsCurrent({ ...current }, current)) visible = "event-2 review";
  slowEvent.resolve("event-1 review");
  await pendingEvent1;

  assert.equal(visible, "event-2 review");
});
