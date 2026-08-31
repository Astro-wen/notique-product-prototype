import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const [page, apiClient, styles, packageJson, modal, recorder, coreRepository, apiRoute] = await Promise.all([
  readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/api-client.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../app/components/modal.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/direct-recorder.tsx", import.meta.url), "utf8"),
  readFile(new URL("../lib/server/db/core-repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/v1/[...segments]/route.ts", import.meta.url), "utf8"),
]);

async function loadApiClient() {
  const { outputText } = ts.transpileModule(apiClient, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("large uploads report progress, can be cancelled, and stop only after a stall", () => {
  assert.match(apiClient, /UPLOAD_STALL_TIMEOUT_MS\s*=\s*120_000/);
  assert.match(apiClient, /new XMLHttpRequest\(\)/);
  assert.match(apiClient, /xhr\.upload\.onprogress/);
  assert.match(apiClient, /resetStallTimer\(\)/);
  assert.match(apiClient, /signal\?\.addEventListener\("abort", abort/);
  assert.match(apiClient, /code: "UPLOAD_TIMEOUT"/);
  assert.match(apiClient, /code: "UPLOAD_NETWORK_ERROR"/);
  assert.match(apiClient, /async abortAsset\(assetId: Id\)/);
  assert.match(page, /className="asset-upload-progress"/);
  assert.match(page, /<progress max=\{Math\.max\(progress\.total, 1\)\}/);
  assert.match(page, /className="text-button upload-cancel"/);
  assert.match(page, /async function recoverAndAbortAssetUpload/);
  assert.match(page, /knownAssetId \?\? \(await api\.initAsset\(/);
  assert.match(page, /pending\.eventId,[\s\S]{0,120}pending\.input,[\s\S]{0,120}pending\.idempotencyKey/);
  assert.match(page, /await api\.abortAsset\(assetId\)/);
  assert.match(page, /async function initializeAssetUploadWithReplayRecovery/);
  assert.match(page, /toIssue\(error\)\.code !== "EVENT_NOT_READY"/);
  assert.match(page, /const rotated = \{ \.\.\.pending, idempotencyKey: crypto\.randomUUID\(\) \}/);
  assert.equal((page.match(/mutationKeys\.current\.set\(fingerprint, rotated\.idempotencyKey\)/g) ?? []).length, 2);
  assert.equal((page.match(/if \(uploadFingerprint && !finalizeStarted && cleanupResolved\) mutationKeys\.current\.delete\(uploadFingerprint\)/g) ?? []).length, 2);
  assert.equal((page.match(/&& \(issue\.status === 0 \|\| issue\.status >= 500\),/g) ?? []).length, 2);
  assert.match(apiClient, /async initAsset\([\s\S]{0,400}signal\?: AbortSignal/);
  assert.match(apiClient, /body: jsonBody\(payload\),\s*signal,/);
  assert.equal((page.match(/phase: "initializing",/g) ?? []).length, 2);
  assert.equal((page.match(/phase: "finalizing",/g) ?? []).length, 2);
  assert.match(page, /!finalizing && <button type="button" className="text-button upload-cancel"/);
  assert.equal(
    (page.match(/assetUploadAbortRef\.current === uploadController\) assetUploadAbortRef\.current = null;[\s\S]{0,220}phase: "finalizing"[\s\S]{0,220}finalizeStarted = true;[\s\S]{0,100}finalizeAssetWithReplayRecovery/g) ?? []).length,
    2,
    "simple and advanced uploads must revoke cancellation before finalize begins",
  );
  assert.match(page, /async function finalizeAssetWithReplayRecovery/);
  assert.match(page, /if \(issue\.status !== 0 && issue\.status < 500\) throw error/);
  assert.equal((page.match(/!finalizeStarted && pendingAssetInit/g) ?? []).length, 2);
  assert.equal((page.match(/assetUploadNeedsContent\(init\.status\)/g) ?? []).length, 2);
  assert.match(apiClient, /status: asset\?\.status/);
  assert.ok(
    (page.match(/initializeAssetUploadWithReplayRecovery\([\s\S]{0,220}uploadController\.signal/g) ?? []).length >= 2,
    "simple and advanced init requests must share the cancellable upload signal",
  );
  assert.match(page, /assetUploadOperationRef = useRef<symbol \| null>\(null\)/);
  assert.ok((page.match(/if \(assetUploadOperationRef\.current\)/g) ?? []).length >= 2);
  assert.match(page, /createTest: \(\) => beginSimpleTest\(false, false\)/);
  assert.match(page, /if \(manageBusyState\) setBusyAction\("simple-start"\)/);
  assert.match(page, /if \(manageBusyState\) setBusyAction\(null\)/);
  assert.match(page, /uploadTranscriptItem\([\s\S]*controller\.signal/);
  assert.match(apiClient, /UPLOAD_HEARTBEAT_INTERVAL_MS\s*=\s*60_000/);
  assert.match(apiClient, /globalThis\.setInterval\([\s\S]{0,500}renewAssetUploadLease\(assetId\)/);
  assert.match(apiClient, /finally \{\s*globalThis\.clearInterval\(heartbeat\);\s*\}/);
  assert.match(apiClient, /\/api\/v1\/assets\/\$\{encodeURIComponent\(assetId\)\}\/heartbeat/);
  assert.match(coreRepository, /export async function heartbeatAssetUpload/);
  assert.match(coreRepository, /processing_status = 'uploading'/);
  assert.match(apiRoute, /segments\[2\] === "heartbeat"[\s\S]{0,120}heartbeatAssetUpload\(scope, segments\[1\]\)/);
  assert.match(
    coreRepository.slice(coreRepository.indexOf("export async function getEvent"), coreRepository.indexOf("export async function createTranscriptImport")),
    /expireStaleAssetUploads\(scope, \{ eventId \}\)[\s\S]{0,1600}eventRecord\(event\)/,
  );
  assert.match(styles, /\.asset-upload-progress progress/);
  assert.match(styles, /\.import-upload-progress progress/);
});

test("cancelling during Asset init aborts the real control-plane request", async () => {
  const originalFetch = globalThis.fetch;
  let observedSignal;
  try {
    globalThis.fetch = async (_url, init = {}) => {
      observedSignal = init.signal;
      return await new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException("cancelled", "AbortError"));
        if (init.signal?.aborted) rejectAbort();
        else init.signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    };
    const { api, ApiClientError } = await loadApiClient();
    const controller = new AbortController();
    const pending = api.initAsset(
      "event-init-cancel",
      { kind: "text", filename: "notes.txt", content_type: "text/plain", size_bytes: 12 },
      "init-cancel-key",
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof ApiClientError && error.code === "UPLOAD_ABORTED",
    );
    assert.equal(observedSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the reading rail supports guarded in-place decisions and source-seeded actions", () => {
  assert.match(page, /async function quickVerdictFromWorkspace/);
  assert.match(page, /if \(!claim\.evidenceRefs\.length \|\| !visibleSourceIds\.length\) return false/);
  assert.match(page, /ref\.kind\.includes\("transcript"\)[\s\S]{0,160}ref\.segmentIds\.every\(\(id\) => visible\.has\(id\)\)/);
  assert.match(page, /const displayedSourceIds = selectedSourceGroups\.flatMap/);
  assert.match(page, /claimEvidenceFitsSourceRail\(claim, displayedSourceIds\)/);
  assert.match(page, /onQuickVerdict\(claim\.id, "confirm", displayedSourceIds\)/);
  assert.match(page, /action === "confirm" && proposedRelations\.length > 0/);
  assert.match(page, /claim\.needsAdditionalEvidence[\s\S]{0,180}relationsForReview/);
  assert.match(page, /onCreateActionInline\(event\.id, actionStatement\.trim\(\), selectedPoint\.sourceIds\.slice\(0, 8\)\)/);
  assert.match(page, /className="rail-action-composer"/);
  assert.match(page, /已关联最相关的 8 段原话/);
  assert.match(page, /function selectTranscriptGroup/);
  assert.match(page, /selectTranscriptGroup\(group, "readable"\)/);
  assert.match(page, /selectTranscriptGroup\(group, "raw"\)/);
  assert.match(page, /const trustedEventActionItems = eventActionItems\.filter/);
  assert.match(page, /action\.status === "confirmed" \|\| action\.status === "completed"/);
  assert.doesNotMatch(page, /setSourceDrawer|className="source-drawer"/);
  assert.match(page, /const stayInWorkspace = stayInWorkspaceOverride \?\? Boolean/);
  assert.match(page, /if \(!stayInWorkspace\) \{\s*await loadReviewQueue\("draft"\)/);
  assert.match(page, /initialSourceText=\{missingClaimSeed\?\.sourceText\}/);
  assert.match(page, /initialStatement=\{missingClaimSeed\?\.statement\}/);
  assert.match(page, /new Set\(initialSegmentIds\.slice\(0, 8\)\)/);
  assert.match(page, /事实或背景，不会直接伪装成行动/);
  assert.match(page, /rail-review-warning/);
  assert.match(styles, /\.rail-quick-verdict/);
});

test("the simple launchpad treats a Transcript as a first-class source", () => {
  assert.match(page, /workspaceTranscriptFileRef = useRef<HTMLInputElement>/);
  assert.match(page, /<strong>上传 Transcript<\/strong>/);
  assert.match(page, /aria-label="选择 Transcript 文件" accept=\{acceptedTranscriptTypes\.join\(","\)\}/);
  assert.match(page, /const transcriptMime = transcriptMimeFor\(uploadFile\.name, uploadFile\.type\)/);
  assert.match(page, /transcriptMime \? "transcript"/);
  assert.doesNotMatch(page, /onAddTranscript/);
  assert.match(page, /录音或导入原文/);
  assert.match(page, /边读边处理/);
});

test("core navigation and reading controls use one SVG icon system", () => {
  const parsedPackage = JSON.parse(packageJson);
  assert.equal(typeof parsedPackage.dependencies?.["lucide-react"], "string");
  assert.match(page, /from "lucide-react"/);
  assert.match(page, /className="brand-mark"><NotebookPen/);
  assert.match(page, /<LayoutDashboard aria-hidden="true" \/>/);
  assert.match(page, /<Sparkles \/><\/span>概要/);
  assert.match(page, /<Pause aria-hidden="true" \/> : <Play aria-hidden="true" \/>/);
  assert.match(page, /<FileImage \/><\/span><span><strong>选择手写笔记照片/);
  assert.match(page, /className="speaker-avatar" aria-hidden="true"><AudioLines \/>/);
  assert.doesNotMatch(page, /speaker\.speaker\.slice\(0,\s*1\)/);
  assert.doesNotMatch(page, /className="brand-mark">⌁/);
  assert.doesNotMatch(page, /className="material-action-icon">[T↑▧]/);
  assert.doesNotMatch(page, /className="file-kind">(?:AUD|IMG|PDF|TXT)/);
  assert.doesNotMatch(page, /项目菜单 ···|aria-label="添加一次沟通">＋|aria-label="上移">↑|aria-label="下移">↓/);
  assert.doesNotMatch(`${page}\n${modal}\n${recorder}`, />\s*[×●▰✓]\s*</);
  assert.match(modal, /<X aria-hidden="true" \/>/);
  assert.match(recorder, /<Mic \/>/);
  assert.match(styles, /\.reader-audio-label \{ display: flex; \}/);
});
