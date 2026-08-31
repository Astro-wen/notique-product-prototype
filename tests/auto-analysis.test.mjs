import assert from "node:assert/strict";
import test from "node:test";

import { autoAnalysisDecision } from "../lib/domain/auto-analysis.ts";

const ready = {
  currentFingerprint: "event-1:photo-v1,transcript-v1",
  currentAssetVersionIds: ["photo-v1", "transcript-v1"],
  latestRunLoaded: false,
  latestRunInProgress: false,
  waitingForAudio: false,
  currentEventTranscriptionRunning: false,
  hasAnalyzableAssets: true,
};

test("ready new material starts automatically", () => {
  assert.equal(autoAnalysisDecision(ready), "start");
});

test("mixed photo and audio waits for a final analyzable transcript", () => {
  assert.equal(autoAnalysisDecision({ ...ready, waitingForAudio: true }), "wait");
  assert.equal(autoAnalysisDecision({ ...ready, currentEventTranscriptionRunning: true }), "wait");
  assert.equal(autoAnalysisDecision({ ...ready, hasAnalyzableAssets: false }), "wait");
});

test("a response-lost refresh clears the same-manifest intent for active or terminal Runs", () => {
  for (const latestRunInProgress of [true, false]) {
    assert.equal(autoAnalysisDecision({
      ...ready,
      baseRunId: "run-before-upload",
      extractionFingerprint: ready.currentFingerprint,
      intentIdempotencyKey: "intent-key",
      latestRunId: "run-created-by-auto-analysis",
      latestRunIdempotencyKey: "intent-key",
      latestRunLoaded: true,
      latestRunInProgress,
    }), "clear");
  }
});

test("an exact source-version manifest safely clears an intent created on another tab", () => {
  assert.equal(autoAnalysisDecision({
    ...ready,
    baseRunId: "run-before-upload",
    extractionFingerprint: ready.currentFingerprint,
    intentIdempotencyKey: "this-tab-key",
    latestRunId: "run-created-on-another-tab",
    latestRunIdempotencyKey: "other-tab-key",
    latestRunAssetVersionIds: ["transcript-v1", "photo-v1"],
    latestRunLoaded: true,
    latestRunInProgress: true,
  }), "clear");
});

test("a still-loading or active earlier Run blocks a second paid Run", () => {
  assert.equal(autoAnalysisDecision({
    ...ready,
    baseRunId: "run-old",
    latestRunId: "run-old",
    latestRunLoaded: false,
  }), "wait");
  assert.equal(autoAnalysisDecision({
    ...ready,
    baseRunId: "run-old",
    latestRunId: "run-old",
    latestRunLoaded: true,
    latestRunInProgress: true,
  }), "wait");
});

test("new manifest may start only after a newer unrelated Run is terminal", () => {
  const input = {
    ...ready,
    baseRunId: "run-old",
    extractionFingerprint: "event-1:photo-v1",
    intentIdempotencyKey: "new-material-key",
    latestRunId: "run-for-photo-only",
    latestRunIdempotencyKey: "old-material-key",
    latestRunAssetVersionIds: ["photo-v1"],
    latestRunLoaded: true,
  };
  assert.equal(autoAnalysisDecision({ ...input, latestRunInProgress: true }), "wait");
  assert.equal(autoAnalysisDecision({ ...input, latestRunInProgress: false }), "start");
});
