export type AppView =
  | "simple"
  | "projects"
  | "project"
  | "event"
  | "draft"
  | "review"
  | "claim"
  | "review-summary"
  | "results"
  | "run-debug";

export type AppResultTab =
  | "folder-summary"
  | "timeline"
  | "decisions"
  | "preferences"
  | "open-questions"
  | "risks"
  | "gap-check"
  | "next-meeting-agenda"
  | "brief-card";

export type AppRouteOrigin = "simple" | "projects" | "project" | "event" | "draft" | "review" | "results";

export type AppRoute = {
  view: AppView;
  projectId?: string;
  eventId?: string;
  claimId?: string;
  runId?: string;
  tab?: AppResultTab;
  origin?: AppRouteOrigin;
  originTab?: AppResultTab;
};

export const defaultAppRoute: AppRoute = { view: "simple" };

const appViews = new Set<AppView>([
  "simple",
  "projects",
  "project",
  "event",
  "draft",
  "review",
  "claim",
  "review-summary",
  "results",
  "run-debug",
]);

const resultTabs = new Set<AppResultTab>([
  "folder-summary",
  "timeline",
  "decisions",
  "preferences",
  "open-questions",
  "risks",
  "gap-check",
  "next-meeting-agenda",
  "brief-card",
]);

const routeOrigins = new Set<AppRouteOrigin>([
  "simple",
  "projects",
  "project",
  "event",
  "draft",
  "review",
  "results",
]);

function optionalParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value || undefined;
}

export function normalizeAppRoute(route: AppRoute): AppRoute {
  const next: AppRoute = {
    view: appViews.has(route.view) ? route.view : "simple",
    ...(route.projectId && route.view !== "projects" ? { projectId: route.projectId } : {}),
  };

  if (route.eventId && !["projects", "project"].includes(next.view)) next.eventId = route.eventId;
  if (next.view === "results") next.tab = resultTabs.has(route.tab ?? "folder-summary") ? route.tab ?? "folder-summary" : "folder-summary";
  if (next.view === "claim" && route.claimId) {
    next.claimId = route.claimId;
    if (route.origin && routeOrigins.has(route.origin)) next.origin = route.origin;
    if (route.originTab && resultTabs.has(route.originTab)) next.originTab = route.originTab;
  }
  if (next.view === "run-debug" && route.runId) next.runId = route.runId;
  if (next.view !== "claim" && route.origin && routeOrigins.has(route.origin)) next.origin = route.origin;
  return next;
}

export function parseAppRoute(search: string): AppRoute {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const requestedView = optionalParam(params, "view") as AppView | undefined;
  const tab = optionalParam(params, "tab") as AppResultTab | undefined;
  const origin = optionalParam(params, "origin") as AppRouteOrigin | undefined;
  const originTab = optionalParam(params, "originTab") as AppResultTab | undefined;
  return normalizeAppRoute({
    view: requestedView && appViews.has(requestedView) ? requestedView : "simple",
    projectId: optionalParam(params, "project"),
    eventId: optionalParam(params, "event"),
    claimId: optionalParam(params, "claim"),
    runId: optionalParam(params, "run"),
    tab: tab && resultTabs.has(tab) ? tab : undefined,
    origin: origin && routeOrigins.has(origin) ? origin : undefined,
    originTab: originTab && resultTabs.has(originTab) ? originTab : undefined,
  });
}

export function serializeAppRoute(route: AppRoute): string {
  const normalized = normalizeAppRoute(route);
  const params = new URLSearchParams();
  if (normalized.projectId) params.set("project", normalized.projectId);
  if (normalized.eventId) params.set("event", normalized.eventId);
  params.set("view", normalized.view);
  if (normalized.tab) params.set("tab", normalized.tab);
  if (normalized.claimId) params.set("claim", normalized.claimId);
  if (normalized.runId) params.set("run", normalized.runId);
  if (normalized.origin) params.set("origin", normalized.origin);
  if (normalized.originTab) params.set("originTab", normalized.originTab);
  return `?${params.toString()}`;
}

export function routeForView(current: AppRoute, view: AppView, overrides: Partial<AppRoute> = {}): AppRoute {
  return normalizeAppRoute({ ...current, ...overrides, view });
}

export function fallbackBackRoute(route: AppRoute): AppRoute {
  const project = route.projectId ? { projectId: route.projectId } : {};
  const event = route.eventId ? { eventId: route.eventId } : {};
  switch (route.view) {
    case "claim": {
      if (route.origin === "results") {
        return normalizeAppRoute({ view: "results", ...project, ...event, tab: route.originTab ?? "folder-summary", origin: "project" });
      }
      if (route.origin === "draft") return normalizeAppRoute({ view: "draft", ...project, ...event, origin: "simple" });
      if (route.origin === "review") return normalizeAppRoute({ view: "review", ...project, ...event, origin: "draft" });
      if (route.origin === "event") return normalizeAppRoute({ view: "event", ...project, ...event, origin: "project" });
      return route.eventId
        ? normalizeAppRoute({ view: "event", ...project, ...event, origin: "project" })
        : normalizeAppRoute({ view: "project", ...project, origin: "projects" });
    }
    case "run-debug":
      return route.eventId
        ? normalizeAppRoute({ view: "event", ...project, ...event, origin: "project" })
        : normalizeAppRoute({ view: "project", ...project, origin: "projects" });
    case "event":
      return normalizeAppRoute({ view: "project", ...project, origin: "projects" });
    case "project":
      return { view: "projects" };
    case "draft":
      return normalizeAppRoute({ view: "simple", ...project, ...event });
    case "review":
      return normalizeAppRoute({ view: "draft", ...project, ...event, origin: "simple" });
    case "results":
      return route.origin === "simple"
        ? normalizeAppRoute({ view: "simple", ...project, ...event })
        : normalizeAppRoute({ view: "project", ...project, origin: "projects" });
    case "review-summary":
      return normalizeAppRoute({ view: "review", ...project, ...event, origin: "draft" });
    case "projects":
      return { view: "simple" };
    default:
      return { view: "simple" };
  }
}

export function backLabelForRoute(route: AppRoute): string {
  const destination = fallbackBackRoute(route);
  if (destination.view === "results") {
    if (destination.tab === "timeline") return "返回时间线";
    if (destination.tab === "brief-card") return "返回会前速览";
    return "返回已确认结果";
  }
  if (destination.view === "review") return "返回审核列表";
  if (destination.view === "draft") return "返回 AI 初稿";
  if (destination.view === "event") return "返回本次沟通";
  if (destination.view === "project") return "返回项目";
  if (destination.view === "projects") return "返回项目列表";
  return "返回核心工作台";
}

export function isCoreWorkflowRoute(route: AppRoute): boolean {
  return route.view === "simple";
}

export function isReadonlyClaimRoute(route: AppRoute): boolean {
  return route.view === "claim" && route.origin === "results";
}
