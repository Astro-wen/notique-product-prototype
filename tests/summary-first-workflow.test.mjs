import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadWorkflow() {
  const source = await readFile(path.join(root, "lib/domain/summary-first-workflow.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

async function loadArtifactSelection() {
  const source = await readFile(path.join(root, "app/transcript-artifact-selection.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

function artifactRun(id, createdAt, status = "succeeded") {
  return {
    id,
    kind: "summary",
    status,
    attempt_no: 1,
    created_at: createdAt,
  };
}

function summaryArtifact(runId, sourceId = "seg-current") {
  return {
    id: `artifact-${runId}`,
    run_id: runId,
    kind: "summary",
    artifact_version: 1,
    created_at: "2026-08-15T10:00:00.000Z",
    content: {
      sections: [{ items: [{ source_segment_ids: [sourceId] }] }],
    },
  };
}

test("a current Artifact Run can never display an older Run's Artifact", async () => {
  const { selectTranscriptArtifactPair } = await loadArtifactSelection();
  const oldRun = artifactRun("run-old", "2026-08-15T10:00:00.000Z");
  const currentRun = artifactRun("run-current", "2026-08-15T11:00:00.000Z", "processing");
  const staleArtifact = summaryArtifact(oldRun.id);
  const rawSegmentIds = new Set(["seg-current"]);

  const whileCurrentRuns = selectTranscriptArtifactPair({
    runs: [oldRun, currentRun],
    artifacts: [staleArtifact],
    kind: "summary",
    rawSegmentIds,
  });
  assert.equal(whileCurrentRuns.run.id, currentRun.id);
  assert.equal(whileCurrentRuns.artifact, null);
  assert.equal(whileCurrentRuns.legacyFallback, false);

  const exact = selectTranscriptArtifactPair({
    runs: [oldRun, currentRun],
    artifacts: [staleArtifact, summaryArtifact(currentRun.id)],
    kind: "summary",
    rawSegmentIds,
  });
  assert.equal(exact.artifact.run_id, currentRun.id);

  const sameCreatedAt = "2026-08-15T12:00:00.000Z";
  const stableTie = selectTranscriptArtifactPair({
    runs: [
      { ...artifactRun("run-a-old", sameCreatedAt), attempt_no: 9 },
      { ...artifactRun("run-z-current", sameCreatedAt, "processing"), attempt_no: 0 },
    ],
    artifacts: [summaryArtifact("run-z-current")],
    kind: "summary",
    rawSegmentIds,
  });
  assert.equal(stableTie.run.id, "run-z-current");
  assert.equal(stableTie.artifact.run_id, "run-z-current");
});

test("legacy Artifact fallback is explicit and restricted to current raw Segment IDs", async () => {
  const { selectTranscriptArtifactPair } = await loadArtifactSelection();
  const rawSegmentIds = new Set(["seg-current"]);
  const valid = selectTranscriptArtifactPair({
    runs: [],
    artifacts: [summaryArtifact("legacy-run")],
    kind: "summary",
    rawSegmentIds,
  });
  assert.equal(valid.artifact.run_id, "legacy-run");
  assert.equal(valid.legacyFallback, true);

  const wrongSource = selectTranscriptArtifactPair({
    runs: [],
    artifacts: [summaryArtifact("legacy-run", "seg-from-another-transcript")],
    kind: "summary",
    rawSegmentIds,
  });
  assert.equal(wrongSource.artifact, null);
  assert.equal(wrongSource.legacyFallback, false);
});

test("Raw leads while work is in flight; the readable transcript leads once it succeeds", async () => {
  const { preferredReadingAid } = await loadWorkflow();
  assert.equal(preferredReadingAid({
    rawAvailable: true,
    summaryStatus: "processing",
    readableTranscriptStatus: "queued",
    extractionStatus: "processing",
  }), "raw", "an in-flight readable pass never delays the transcript that already exists");
  // On a real recording raw arrives unpunctuated and full of fillers, so once
  // the readable pass succeeds, reading starts there; raw stays one click away.
  assert.equal(preferredReadingAid({
    rawAvailable: true,
    summaryStatus: "succeeded",
    readableTranscriptStatus: "succeeded",
    extractionStatus: "succeeded",
  }), "readable");
  assert.equal(preferredReadingAid({
    rawAvailable: false,
    summaryStatus: "succeeded",
    readableTranscriptStatus: "processing",
    extractionStatus: "processing",
  }), "summary");
  assert.equal(preferredReadingAid({
    rawAvailable: false,
    summaryStatus: "failed",
    readableTranscriptStatus: "succeeded",
    extractionStatus: "processing",
  }), "readable");
  assert.equal(preferredReadingAid({
    rawAvailable: false,
    summaryStatus: "processing",
    readableTranscriptStatus: "processing",
    extractionStatus: "processing",
  }), null);
  assert.equal(preferredReadingAid({
    summaryStatus: null,
    readableTranscriptStatus: null,
    extractionStatus: "succeeded",
  }), "raw");
});

test("only untouched Raw readiness may auto-focus; completed AI aids never do", async () => {
  const { shouldAutoFocusReadingAid, shouldAutoFocusSummary } = await loadWorkflow();
  const base = {
    target: "raw",
    activeWorkspaceTab: "materials",
    userNavigated: false,
    alreadyFocused: false,
    materialInteractionActive: false,
  };
  assert.equal(shouldAutoFocusReadingAid(base), true);
  assert.equal(shouldAutoFocusReadingAid({ ...base, target: "summary" }), false);
  // The readable transcript is the reading surface too. It used to be excluded,
  // so once it became the preferred destination a finished recording opened at
  // the file list instead of at its own content.
  assert.equal(shouldAutoFocusReadingAid({ ...base, target: "readable" }), true);
  assert.equal(shouldAutoFocusReadingAid({ ...base, activeWorkspaceTab: "results" }), false);
  assert.equal(shouldAutoFocusReadingAid({ ...base, userNavigated: true }), false);
  assert.equal(shouldAutoFocusReadingAid({ ...base, alreadyFocused: true }), false);
  assert.equal(shouldAutoFocusReadingAid({ ...base, materialInteractionActive: true }), false);
  assert.equal(shouldAutoFocusSummary({
    summaryStatus: "succeeded",
    extractionStatus: "processing",
    activeWorkspaceTab: "materials",
    userNavigated: false,
    alreadyFocused: false,
    materialInteractionActive: false,
  }), false);
});

test("a finished readable pass upgrades the destination without re-stealing focus", async () => {
  const { preferredReadingAid, shouldAutoFocusReadingAid } = await loadWorkflow();
  const before = preferredReadingAid({
    rawAvailable: true,
    summaryStatus: "processing",
    readableTranscriptStatus: "processing",
    extractionStatus: "processing",
  });
  const after = preferredReadingAid({
    rawAvailable: true,
    summaryStatus: "succeeded",
    readableTranscriptStatus: "succeeded",
    extractionStatus: "processing",
  });
  assert.equal(before, "raw");
  // The destination upgrades to the readable transcript once it succeeds…
  assert.equal(after, "readable");
  assert.equal(shouldAutoFocusReadingAid({
    target: before,
    activeWorkspaceTab: "materials",
    userNavigated: false,
    alreadyFocused: false,
    materialInteractionActive: false,
  }), true);
  // …and a reader already focused on the transcript is still not yanked again:
  // the guards that matter are the active tab and the already-focused mark,
  // not which of the two transcripts is the better destination.
  assert.equal(shouldAutoFocusReadingAid({
    target: after,
    activeWorkspaceTab: "transcript",
    userNavigated: false,
    alreadyFocused: true,
    materialInteractionActive: false,
  }), false);
});

test("facts can finish without changing the reading destination", async () => {
  const { factsReadyForReview, factsStillRunning } = await loadWorkflow();
  assert.equal(factsStillRunning("verify"), false);
  assert.equal(factsStillRunning("processing"), true);
  assert.equal(factsReadyForReview({
    extractionStatus: "completed_with_warnings",
    pendingCount: 3,
    needsScenarioConfirmation: false,
  }), true);
  assert.equal(factsReadyForReview({
    extractionStatus: "succeeded",
    pendingCount: 3,
    needsScenarioConfirmation: true,
  }), false);
});

test("Summary source overlap returns every candidate instead of silently choosing the first", async () => {
  const { matchingSummarySourceIndexes } = await loadWorkflow();
  assert.deepEqual(matchingSummarySourceIndexes(
    ["seg-shared"],
    [["seg-other", "seg-shared"], ["seg-shared"], ["seg-unrelated"]],
  ), [0, 1]);
  assert.deepEqual(matchingSummarySourceIndexes([], [["seg-shared"]]), []);
});

test("the workspace rail resolves a Claim's evidence instead of shrugging at it", async () => {
  // The Claim list payload carries evidence ids, not the refs, and the rail
  // read claim.evidenceRefs straight from it: every AI 要求 or 事实 opened with
  // 「录音与原话 0 段」 and told the reader its source was kept somewhere in the
  // transcript — in a product whose whole promise is reaching the sentence a
  // claim came from.
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(page, /const claimEvidence = \(claim: \{ id: string; evidenceRefs: EvidenceRef\[\] \}\): EvidenceRef\[\] =>/);
  assert.match(page, /claim\.evidenceRefs\.length \? claim\.evidenceRefs : railEvidence\[claim\.id\] \?\? \[\]/);
  assert.match(page, /queryClient\.fetchQuery\(evidenceQuery\(refId\)\)/,
    "the rail uses the same evidence cache the review screen does");
  assert.match(page, /sourceIds: \[\.\.\.new Set\(claimEvidence\(firstPendingClaim\)\.flatMap\(\(ref\) => ref\.segmentIds\)\)\]/);
  assert.match(page, /const sourceIds = \[\.\.\.new Set\(claimEvidence\(claim\)\.flatMap\(\(ref\) => ref\.segmentIds\)\)\];/);
  assert.match(page, /selectedPointEvidenceLoading\s*\?\s*<p className="rail-muted" role="status">正在定位原话…<\/p>/,
    "a Claim mid-resolution says so rather than claiming its source is gone");
  assert.match(page, /const RAIL_EVIDENCE_LIMIT = 12;/, "the queue is bounded");
});

test("opening the transcript does not pin 原文 as a choice", async () => {
  // Raw is all there is before the readable pass finishes. Recording that in
  // the route like an explicit selection left everyone who looked early — and
  // every later reload of that URL — stuck on the source text.
  const page = await readFile(path.join(root, "app/page.tsx"), "utf8");
  assert.match(page, /if \(readableArtifact\) selectArtifactTab\("readable"\);\s*else \{\s*manuallySelectedTab\.current = false;\s*setTab\("raw"\);\s*\}/);
});
