import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { QueryClient } from "@tanstack/react-query";

const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const querySource = await readFile(new URL("../app/notique-queries.ts", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api-client.ts", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("TanStack Query deduplicates concurrent reads with the same scoped key", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending = deferred();
  let calls = 0;
  const options = {
    queryKey: ["notique", "project", "project-a", "workflow"],
    queryFn: async () => {
      calls += 1;
      return pending.promise;
    },
  };

  const first = client.fetchQuery(options);
  const second = client.fetchQuery(options);
  pending.resolve({ project: "project-a" });

  assert.deepEqual(await first, { project: "project-a" });
  assert.deepEqual(await second, { project: "project-a" });
  assert.equal(calls, 1);
});

test("cancelling a Notique query aborts the fetch signal", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let aborted = false;
  const pending = client.fetchQuery({
    queryKey: ["notique", "event", "event-a", "artifacts"],
    queryFn: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    }),
  });

  await client.cancelQueries({ queryKey: ["notique"] });
  await assert.rejects(pending);
  assert.equal(aborted, true);
});

test("Notique read models use scoped cache keys and forward AbortSignal", () => {
  for (const scope of ["workflow", "artifacts", "transcript-segments", "claimHistory", "evidenceContext", "draft-memory", "actions", "view"]) {
    assert.match(querySource, new RegExp(`\\b${scope.replace("-", "[A-Za-z-]*")}\\b`, "i"));
  }
  assert.match(querySource, /queryFn:\s*\(\{ signal \}\) => api\.getWorkflowSnapshot\(projectId, signal\)/);
  assert.match(querySource, /queryFn:\s*\(\{ signal \}\) => api\.getEventAiArtifacts\(eventId, signal\)/);
  assert.match(querySource, /queryFn:\s*\(\{ signal \}\) => api\.listEventTranscriptSegments\(eventId, signal\)/);
  assert.match(querySource, /queryFn:\s*\(\{ signal \}\) => api\.getClaimHistory\(claimId, signal\)/);
  assert.match(querySource, /queryFn:\s*\(\{ signal \}\) => api\.getEvidence\(refId, signal\)/);
  assert.match(querySource, /queryFn:\s*\(\{ signal \}\) => api\.getEvidenceContext\(refId, signal\)/);
  assert.match(apiSource, /getWorkflowSnapshot\(projectId: Id, signal\?: AbortSignal\)/);
  assert.match(apiSource, /getEventAiArtifacts\(eventId: Id, signal\?: AbortSignal\)/);
  assert.match(apiSource, /getClaimHistory\(claimId: Id, signal\?: AbortSignal\)/);
  assert.match(apiSource, /getEvidence\(refId: Id, signal\?: AbortSignal\)/);
  assert.match(apiSource, /getEvidenceContext\(refId: Id, signal\?: AbortSignal\)/);
  assert.match(pageSource, /queryClient\.cancelQueries\(\{ queryKey: \["notique"\] \}\)/);
  assert.match(pageSource, /queryClient\.fetchQuery\(eventArtifactsQuery\(event\.id\)\)/);
  assert.match(querySource, /eventTranscriptSegmentsQuery[\s\S]{0,400}staleTime: 0/);
  assert.match(pageSource, /previousTranscriptRevision\.current === transcriptRevision/);
  assert.match(pageSource, /queryClient\.invalidateQueries\(\{[\s\S]{0,180}eventTranscriptSegmentsQuery/);
  assert.match(pageSource, /queryClient\.prefetchQuery\(claimHistoryQuery\(followingClaim\.id, followingClaim\.versionId\)\)/);
  assert.match(pageSource, /queryClient\.prefetchQuery\(evidenceContextQuery\(id\)\)/);
  assert.match(pageSource, /queryClient\.fetchQuery\(verifiedViewQuery\(projectId, view\)\)/);
});
