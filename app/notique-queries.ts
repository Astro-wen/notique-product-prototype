import { queryOptions } from "@tanstack/react-query";
import { api, type ProjectViewName } from "./api-client";

export const notiqueQueryKeys = {
  workflow: (projectId: string) => ["notique", "project", projectId, "workflow"] as const,
  artifacts: (eventId: string) => ["notique", "event", eventId, "artifacts"] as const,
  draftMemory: (projectId: string) => ["notique", "project", projectId, "draft-memory"] as const,
  actions: (projectId: string) => ["notique", "project", projectId, "actions"] as const,
  view: (projectId: string, view: ProjectViewName) => ["notique", "project", projectId, "view", view] as const,
};

export function workflowSnapshotQuery(projectId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.workflow(projectId),
    queryFn: ({ signal }) => api.getWorkflowSnapshot(projectId, signal),
    staleTime: 2_000,
  });
}

export function eventArtifactsQuery(eventId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.artifacts(eventId),
    queryFn: ({ signal }) => api.getEventAiArtifacts(eventId, signal),
    staleTime: 2_000,
  });
}

export function draftMemoryQuery(projectId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.draftMemory(projectId),
    queryFn: ({ signal }) => api.getDraftMemory(projectId, signal),
    staleTime: 5_000,
  });
}

export function projectActionsQuery(projectId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.actions(projectId),
    queryFn: ({ signal }) => api.getProjectActions(projectId, signal),
    staleTime: 5_000,
  });
}

export function verifiedViewQuery(projectId: string, view: ProjectViewName) {
  return queryOptions({
    queryKey: notiqueQueryKeys.view(projectId, view),
    queryFn: ({ signal }) => api.getView(projectId, view, signal),
    staleTime: 10_000,
  });
}
