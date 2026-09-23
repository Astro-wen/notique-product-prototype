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

test("the reading rail is a lens: evidence in 核对详情, decisions only in 待确认, no manual entry", () => {
  // 待确认里点一条就地打开证据和判断；核对详情只看原话，只告诉人这句有几条在等。
  assert.match(page, /function selectClaimInRail\(claim: Claim\) \{[\s\S]{0,400}setInlineReview\(\{ id: claim\.id, edit: false \}\);\s*setActionView\("pending"\)/);
  assert.match(page, /actionView === "pending" && inlineReview && <div className="reader-action-body inline-review-view"/);
  assert.match(page, /这句里有 \{pendingHere\.length\} 条待确认，去处理/);
  assert.doesNotMatch(page, /rail-quick-verdict|rail-review-warning|rail-capture-point/);
  // 手工补录和手写行动的表单都删了：内容只来自模型，人只做判断。
  assert.doesNotMatch(page, /MissingClaimModal|保存这条重点|从原文补充行动|rail-action-composer|添加跟进行动|负责人（可选）/);
  // 行动页是清单：模型找出的下一步先列成建议，勾一下进自己的清单。
  assert.match(page, /async function quickVerdictFromWorkspace/);
  assert.match(page, /const suggestedActions = claims\.filter\(\(claim\) =>[\s\S]{0,80}claim\.type === "next_action" && claim\.reviewStatus === "pending"/);
  assert.match(page, /aria-label="建议加入的行动"/);
  assert.match(page, /aria-label="我的清单"/);
  assert.match(page, /function selectTranscriptGroup/);
  assert.match(page, /const trustedEventActionItems = eventActionItems\.filter/);
  assert.match(page, /action\.status === "confirmed" \|\| action\.status === "completed"/);
  assert.doesNotMatch(page, /setSourceDrawer|className="source-drawer"/);
});

test("the simple launchpad treats a Transcript as a first-class source", () => {
  assert.match(page, /workspaceTranscriptFileRef = useRef<HTMLInputElement>/);
  assert.match(page, /acceptedTranscriptTypes\.join\(","\)\},\$\{MODEL_IMAGE_FILE_ACCEPT\}/);
  assert.match(page, /aria-label="选择 Transcript 文件" accept=\{acceptedTranscriptTypes\.join\(","\)\}/);
  assert.match(page, /const transcriptMime = transcriptMimeFor\(uploadFile\.name, uploadFile\.type\)/);
  assert.match(page, /transcriptMime \? "transcript"/);
  assert.doesNotMatch(page, /onAddTranscript/);
  assert.match(page, /<MaterialShelf/);
});

test("core navigation and reading controls use one SVG icon system", () => {
  const parsedPackage = JSON.parse(packageJson);
  assert.equal(typeof parsedPackage.dependencies?.["lucide-react"], "string");
  assert.match(page, /from "lucide-react"/);
  assert.match(page, /className="brand-mark"><NotebookPen/);
  // 侧栏把「项目工作区」改名叫「首页」，图标也跟着从仪表盘换成了房子。
  assert.match(page, /<HomeIcon aria-hidden="true" \/>/);
  assert.match(page, /<Pause aria-hidden="true" \/> : <Play aria-hidden="true" \/>/);
  assert.match(page, /<Camera aria-hidden="true" \/>添加手写笔记/);
  assert.match(page, /className="speaker-avatar" aria-hidden="true"><Users \/>/);
  assert.doesNotMatch(page, /speaker\.speaker\.slice\(0,\s*1\)/);
  assert.doesNotMatch(page, /className="brand-mark">⌁/);
  assert.doesNotMatch(page, /className="material-action-icon">[T↑▧]/);
  assert.doesNotMatch(page, /className="file-kind">(?:AUD|IMG|PDF|TXT)/);
  assert.doesNotMatch(page, /项目菜单 ···|aria-label="添加记录">＋|aria-label="上移">↑|aria-label="下移">↓/);
  assert.doesNotMatch(`${page}\n${modal}\n${recorder}`, />\s*[×●▰✓]\s*</);
  assert.match(modal, /<X aria-hidden="true" \/>/);
  assert.match(recorder, /<Mic \/>/);
  assert.match(styles, /\.reader-audio-label \{ display: flex; \}/);
});

test("工作区顶栏是面包屑，不再重复侧栏和「项目管理」已有的入口", () => {
  // 换项目在侧栏的项目列表，移到回收站是侧栏每行的垃圾桶，新建项目和回收站在
  // 「项目管理」页。这三件事各留一个入口，顶栏只说现在在哪个项目、哪条记录、
  // 什么状态。再往这条栏里加一个项目选择框或一个项目菜单就是退回去了。
  const bar = page.match(/<section className="simple-session"[\s\S]*?<\/section>/)?.[0];
  assert.ok(bar, "工作区顶栏没找到，选择器或结构被改过");
  assert.doesNotMatch(bar, /选择当前项目|项目菜单|DropdownMenu/);
  assert.doesNotMatch(page, /project-menu/);
  assert.doesNotMatch(styles, /\.project-menu/);
  // 留下的四件东西：项目名、当前记录、添加记录、状态。
  assert.match(bar, /className="simple-session-copy"/);
  assert.match(bar, /aria-label="选择记录"/);
  assert.match(bar, /aria-label="添加记录"/);
  assert.match(bar, /className=\{`simple-session-status/);
});

test("a completed action can be reopened, and the check toggles it back", async () => {
  const [repo, route, client, page] = await Promise.all([
    readFile(new URL("../lib/server/db/buyer-journey-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v1/[...segments]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  const reopen = repo.slice(repo.indexOf("export async function reopenProjectAction"), repo.indexOf("export async function completeProjectAction"));
  // 撤回完成：完成时建的那条「已完成」结论撤回，关系停用，行动回到进行中。
  // 撤回直接删掉合成的那条结论和关系；键带时间，撤回再完成不会撞唯一索引。
  assert.match(reopen, /DELETE FROM claims[\s\S]{0,160}source_claim_version_id FROM claim_relations WHERE id = \?/);
  assert.match(reopen, /DELETE FROM claim_relations WHERE id = \?/);
  assert.match(repo, /`completed:\$\{claimId\}:\$\{timestamp\}`/);
  assert.match(reopen, /SET lifecycle_status = 'active', resolved_at = NULL/);
  assert.match(route, /segments\[2\] === "reopen"/);
  assert.match(client, /\/reopen`/);
  assert.match(page, /action\.status === "completed" \? onReopenAction\(action\.claim_id\) : onCompleteAction\(action\.claim_id\)/);
  // 核对详情里不再有「核对记录」标题、修改按钮、来源三个小标签和手写行动的入口。
  assert.doesNotMatch(page, /<strong>核对记录<\/strong>/);
  assert.doesNotMatch(page, /rail-source-readiness/);
  assert.doesNotMatch(page, /添加跟进行动/);
});
