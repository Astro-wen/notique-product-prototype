import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildContextPack } from "../lib/domain/context-pack.ts";
import { planProjectWorkflow } from "../lib/domain/project-workflow.ts";

function ledger() {
  return {
    projectId: "project-buyer",
    locale: "en-US",
    scenario: {
      status: "confirmed",
      value: "real_estate_buyer_journey",
      version: 1,
    },
    claims: [],
    claimVersions: [],
    relations: [],
    withdraws: [],
    events: [{
      id: "event-13",
      projectId: "project-buyer",
      title: "Current meeting",
      occurredAt: "2026-08-15T12:00:00.000Z",
      sequenceNo: 13,
    }],
  };
}

function draftClaim(index) {
  return {
    claimId: `draft-${index}`,
    claimVersionId: `draft-${index}-v1`,
    eventId: `event-${index}`,
    eventSequenceNo: index,
    type: "preference",
    statement: `Preference from meeting ${index}`,
    confidence: 0.8,
    evidenceRefIds: [`evidence-${index}`],
  };
}

test("draft context is opt-in, evidence-backed, stable, and limited to the latest ten meetings", () => {
  const claims = Array.from({ length: 12 }, (_, index) => draftClaim(index + 1));
  const enabled = buildContextPack({
    ledger: ledger(),
    contextVersion: 3,
    eventId: "event-13",
    transcriptSegments: [],
    draftContextEnabled: true,
    draftClaims: [
      ...claims,
      { ...draftClaim(13), evidenceRefIds: [] },
    ],
  });
  assert.equal(enabled.schema_version, "context-pack.v3");
  assert.equal(enabled.draft_context.enabled, true);
  assert.deepEqual(
    [...new Set(enabled.draft_context.claims.map((claim) => claim.eventId))],
    Array.from({ length: 10 }, (_, index) => `event-${index + 3}`),
  );
  assert.equal(enabled.draft_context.claims.every((claim) => claim.evidenceRefIds.length > 0), true);

  const disabled = buildContextPack({
    ledger: ledger(),
    contextVersion: 3,
    eventId: "event-13",
    transcriptSegments: [],
    draftContextEnabled: false,
    draftClaims: claims,
  });
  assert.deepEqual(disabled.draft_context, { enabled: false, claims: [] });
});

test("draft context keeps the newest 100 candidates and then restores chronological order", () => {
  const claims = Array.from({ length: 12 }, (_, eventIndex) =>
    Array.from({ length: 15 }, (_, claimIndex) => ({
      claimId: `draft-${String(eventIndex + 1).padStart(2, "0")}-${String(claimIndex + 1).padStart(2, "0")}`,
      claimVersionId: `draft-version-${String(eventIndex + 1).padStart(2, "0")}-${String(claimIndex + 1).padStart(2, "0")}`,
      eventId: `event-${String(eventIndex + 1).padStart(2, "0")}`,
      eventSequenceNo: eventIndex + 1,
      type: "preference",
      statement: `Preference ${eventIndex + 1}.${claimIndex + 1}`,
      confidence: 0.8,
      evidenceRefIds: [`evidence-${eventIndex + 1}-${claimIndex + 1}`],
    })),
  ).flat();
  const result = buildContextPack({
    ledger: ledger(),
    contextVersion: 3,
    eventId: "event-13",
    transcriptSegments: [],
    draftContextEnabled: true,
    draftClaims: claims,
  });
  assert.equal(result.draft_context.claims.length, 100);
  assert.equal(result.draft_context.claims[0].eventId, "event-06");
  assert.equal(result.draft_context.claims.at(-1).eventId, "event-12");
  assert.deepEqual(
    result.draft_context.claims.map((claim) => claim.eventSequenceNo),
    result.draft_context.claims.map((claim) => claim.eventSequenceNo).toSorted((a, b) => a - b),
  );
});

test("a Run reloads its exact frozen draft set while live draft memory uses newest-first limits", async () => {
  const [repository, processor, core] = await Promise.all([
    readFile(new URL("../lib/server/db/buyer-journey-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/db/core-repository.ts", import.meta.url), "utf8"),
  ]);
  assert.match(
    repository,
    /WITH frozen AS[\s\S]{0,500}FROM json_each\(\?\)[\s\S]{0,700}frozen\.claim_id = c\.id[\s\S]{0,200}frozen\.claim_version_id = c\.current_version_id/,
    "a worker must reload exact frozen Claim/version pairs instead of filtering a limited live list",
  );
  assert.match(
    repository,
    /ORDER BY e\.sequence_no DESC, c\.created_at DESC, c\.id DESC[\s\S]{0,80}LIMIT 100[\s\S]{0,180}ORDER BY recent_claims\.event_sequence_no/,
    "live draft memory must select the newest 100 before restoring chronological order",
  );
  assert.match(
    core,
    /ORDER BY source_event\.sequence_no DESC, c\.created_at DESC, c\.id DESC[\s\S]{0,80}LIMIT 100[\s\S]{0,200}ORDER BY recent_claims\.event_sequence_no/,
    "the frozen Run manifest must also select the newest 100 candidates",
  );
  assert.match(
    processor,
    /listProjectDraftMemory\(scope, String\(run\.project_id\), \{[\s\S]{0,120}frozenClaims: draftContextManifest/,
  );
  assert.doesNotMatch(
    processor,
    /draftMemory\.claims\s*\.filter\([^)]*frozenDraftIds/,
    "frozen candidates must not be filtered after an unrelated live LIMIT",
  );
});

test("rejecting draft Claims invalidates frozen context and formal actions remain verified-only", async () => {
  const [repository, verdicts] = await Promise.all([
    readFile(new URL("../lib/server/db/buyer-journey-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/db/verdict-repository.ts", import.meta.url), "utf8"),
  ]);
  const actionSection = repository.slice(
    repository.indexOf("export async function listProjectActions"),
    repository.indexOf("export async function completeProjectAction"),
  );
  assert.match(
    actionSection,
    /c\.review_status = 'verified' AND c\.lifecycle_status <> 'withdrawn'/,
    "the formal Next Actions endpoint must exclude pending, rejected, and withdrawn Claims",
  );

  const rejectSection = verdicts.slice(
    verdicts.indexOf('} else if (input.action === "reject")'),
    verdicts.indexOf("} else {", verdicts.indexOf('} else if (input.action === "reject")')),
  );
  const batchSection = verdicts.slice(
    verdicts.indexOf("export async function applyBatchVerdicts"),
    verdicts.indexOf("export async function applyOccurrenceVerdict"),
  );
  assert.match(
    rejectSection,
    /UPDATE projects[\s\S]{0,180}context_version = context_version \+ 1/,
    "a single rejection removes a draft-context candidate and must stale any frozen Run",
  );
  assert.match(
    batchSection,
    /UPDATE projects[\s\S]{0,180}context_version = context_version \+ 1/,
    "a batch containing rejections must invalidate the affected Project context",
  );
  assert.doesNotMatch(batchSection, /changesContext \?/);
});

test("pending review no longer blocks the next paid-analysis confirmation", () => {
  const plan = planProjectWorkflow({
    events: [
      {
        id: "event-1",
        title: "Buyer intake",
        hasMaterial: true,
        ready: true,
        runId: "run-1",
        runStatus: "succeeded",
        candidateCount: 4,
        pendingCount: 3,
      },
      {
        id: "event-2",
        title: "First showing",
        hasMaterial: true,
        ready: true,
        candidateCount: 0,
        pendingCount: 0,
      },
    ],
    needsScenarioConfirmation: false,
  });
  assert.equal(plan.phase, "ready");
  assert.equal(plan.currentEventId, "event-2");
  assert.equal(plan.completed, 1);
  assert.equal(plan.pendingTotal, 3);
  assert.equal(plan.trustState, "partially_reviewed");
});

test("workflow separates a readable AI draft from partially reviewed and trusted memory", () => {
  const draftReady = planProjectWorkflow({
    events: [{
      id: "event-1",
      title: "Buyer intake",
      hasMaterial: true,
      ready: true,
      runId: "run-1",
      runStatus: "succeeded",
      candidateCount: 4,
      pendingCount: 4,
    }],
    needsScenarioConfirmation: false,
  });
  assert.equal(draftReady.phase, "draft_ready");
  assert.equal(draftReady.trustState, "draft_ready");
  assert.equal(draftReady.completed, 1);

  const partiallyReviewed = planProjectWorkflow({
    events: [{
      id: "event-1",
      title: "Buyer intake",
      hasMaterial: true,
      ready: true,
      runId: "run-1",
      runStatus: "succeeded",
      candidateCount: 4,
      pendingCount: 2,
    }],
    needsScenarioConfirmation: false,
  });
  assert.equal(partiallyReviewed.phase, "partially_reviewed");
  assert.equal(partiallyReviewed.trustState, "partially_reviewed");

  const trusted = planProjectWorkflow({
    events: [{
      id: "event-1",
      title: "Buyer intake",
      hasMaterial: true,
      ready: true,
      runId: "run-1",
      runStatus: "succeeded",
      candidateCount: 4,
      pendingCount: 0,
    }],
    needsScenarioConfirmation: false,
  });
  assert.equal(trusted.phase, "complete");
  assert.equal(trusted.trustState, "trusted");
});

test("draft context stays disabled in documented local and production defaults", async () => {
  const [envExample, wrangler] = await Promise.all([
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ]);
  assert.match(envExample, /^AI_DRAFT_CONTEXT=0$/m);
  assert.match(wrangler, /"AI_DRAFT_CONTEXT"\s*:\s*"0"/);
});

test("buyer journey APIs keep draft links separate from formal relations and actions auditable", async () => {
  const [repository, processor, route, page, provider] = await Promise.all([
    readFile(new URL("../lib/server/db/buyer-journey-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/jobs/extraction-processor.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/[...segments]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/ai/model-provider.ts", import.meta.url), "utf8"),
  ]);
  assert.match(processor, /INSERT INTO draft_link_candidates/);
  assert.match(processor, /draft_context: \{ enabled: false, claims: \[\] \}/);
  assert.match(repository, /Both draft-link records must be current and human-confirmed/);
  assert.match(repository, /DRAFT_LINK_RELATION_TYPES/);
  assert.match(repository, /INSERT INTO mutation_guards[\s\S]*type = 'next_action'/);
  assert.match(repository, /The user marked this confirmed action as completed/);
  assert.match(route, /segments\[0\] === "draft-links"[\s\S]*applyDraftLinkVerdict/);
  assert.match(route, /segments\[0\] === "actions"[\s\S]*completeProjectAction/);
  assert.match(page, /新建买方客户项目/);
  assert.match(page, /onStartOwn=\{\(\) => \{ setSimpleFlow\(true\); setShowNewProject\(true\); \}\}/);
  assert.match(page, /if \(simpleFlow\) await loadSimpleProject\(created\.id\)/);
  assert.match(page, /稍后核对，继续客户旅程/);
  assert.match(page, /两边确认后可接受/);
  assert.match(page, /AI 当前理解/);
  assert.match(page, /可信记忆/);
  assert.match(provider, /Use type next_action only for a concrete future action/);
});
