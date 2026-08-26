import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile(
  new URL("../lib/server/db/review-session-repository.ts", import.meta.url),
  "utf8",
);
const route = await readFile(
  new URL("../app/api/v1/[...segments]/route.ts", import.meta.url),
  "utf8",
);
const client = await readFile(new URL("../app/api-client.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../drizzle/0009_review_session_timing.sql", import.meta.url),
  "utf8",
);

test("review timing is durable, scoped, idempotent, and server-owned", () => {
  assert.match(migration, /CREATE TABLE `review_sessions`/);
  assert.match(
    migration,
    /UNIQUE INDEX `uq_review_sessions_active_actor_project`[\s\S]+WHERE `status` = 'active'/,
  );
  assert.match(repository, /rs\.workspace_id = \?[\s\S]+rs\.actor_id = \?/);
  assert.match(repository, /findMutationReplay<\{ reviewSessionId: string \}>/);
  assert.match(repository, /Date\.parse\(timestamp\) - Date\.parse\(session\.started_at\)/);
  assert.doesNotMatch(repository, /durationMs\s*:\s*input|startedAt\s*:\s*input/);
});

test("both pending Claims and pending occurrences participate in the timer gate", () => {
  assert.match(
    repository,
    /c\.review_status = 'pending' AND c\.lifecycle_status = 'active'/,
  );
  assert.match(repository, /claim_occurrence_candidates occ[\s\S]+occ\.status = 'pending'/);
  assert.match(
    repository,
    /Review session cannot finish while pending work remains/,
  );
  assert.match(
    repository,
    /INSERT INTO mutation_guards[\s\S]+NOT EXISTS \([\s\S]+FROM claims c[\s\S]+NOT EXISTS \([\s\S]+FROM claim_occurrence_candidates occ/,
  );
  assert.match(
    repository,
    /latest\.active_run_id = c\.extraction_run_id/,
    "the timer must ignore pending Claims left by an older Run",
  );
  assert.match(
    repository,
    /latest\.active_run_id = occ\.extraction_run_id/,
    "the timer must ignore occurrence candidates left by an older Run",
  );
});

test("the real UI starts, resumes, and completes the server timer", () => {
  assert.match(route, /projects[\s\S]+review-sessions[\s\S]+startReviewSession/);
  assert.match(route, /review-sessions[\s\S]+complete[\s\S]+completeReviewSession/);
  assert.match(client, /async getReviewSession\(/);
  assert.match(client, /async startReviewSession\([\s\S]+idempotency-key/);
  assert.match(client, /async completeReviewSession\([\s\S]+idempotency-key/);
  assert.match(page, /刷新或关闭页面不会重置/);
  assert.match(page, /达到两分钟目标/);
  assert.match(page, /initialPendingClaimCount \+ reviewSession\.initialPendingOccurrenceCount/);
  assert.match(page, /remainingPendingClaimCount \+ reviewSession\.remainingPendingOccurrenceCount/);
  assert.equal(
    page.match(/await syncReviewTiming\(latestProject(?:, requestIsCurrent)?\);/g)?.length,
    3,
    "queue loads and the fast background refresh must update server-owned counts with stale-response guards",
  );
  const verdict = page.slice(page.indexOf("async function runVerdict"), page.indexOf("async function withdrawClaim"));
  assert.ok(
    verdict.indexOf("await openClaim(nextId") < verdict.indexOf('loadReviewQueue("review"'),
    "a successful non-final verdict must open the locally known next claim before a full queue reload",
  );
  assert.match(verdict, /refreshReviewSnapshotInBackground\(project\.id\)[\s\S]{0,120}await openClaim\(nextId/);
  assert.doesNotMatch(verdict, /await invalidateProjectReadModels/);
  assert.match(page, /const refreshReviewSnapshotInBackground/);
  assert.match(page, /const reviewRefreshEpoch = useRef\(0\)/);
  assert.match(page, /reviewRefreshEpoch\.current === token/);
});
