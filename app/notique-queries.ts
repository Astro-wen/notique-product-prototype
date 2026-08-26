import { queryOptions } from "@tanstack/react-query";
import { api, type ProjectViewName } from "./api-client";

export const notiqueQueryKeys = {
  workflow: (projectId: string) => ["notique", "project", projectId, "workflow"] as const,
  artifacts: (eventId: string) => ["notique", "event", eventId, "artifacts"] as const,
  transcriptSegments: (eventId: string) => ["notique", "event", eventId, "transcript-segments"] as const,
  claimHistory: (claimId: string, versionId?: string) => ["notique", "claim", claimId, "history", versionId || "current"] as const,
  evidence: (refId: string) => ["notique", "evidence", refId] as const,
  evidenceContext: (refId: string) => ["notique", "evidence", refId, "context"] as const,
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

export function eventTranscriptSegmentsQuery(eventId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.transcriptSegments(eventId),
    queryFn: ({ signal }) => api.listEventTranscriptSegments(eventId, signal),
    // The Event may still be receiving its canonical transcript. Artifact
    // polling reuses local component state, while an explicit load must never
    // keep a pre-completion empty result fresh.
    staleTime: 0,
  });
}

export function claimHistoryQuery(claimId: string, versionId?: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.claimHistory(claimId, versionId),
    queryFn: ({ signal }) => api.getClaimHistory(claimId, signal),
    staleTime: 30_000,
  });
}

export function evidenceQuery(refId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.evidence(refId),
    queryFn: ({ signal }) => api.getEvidence(refId, signal),
    staleTime: 5 * 60_000,
  });
}

export function evidenceContextQuery(refId: string) {
  return queryOptions({
    queryKey: notiqueQueryKeys.evidenceContext(refId),
    queryFn: ({ signal }) => api.getEvidenceContext(refId, signal),
    // Context may contain a short-lived signed media URL. Keep only a short
    // review-session cache so prefetch is useful without making URLs sticky.
    staleTime: 30_000,
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
