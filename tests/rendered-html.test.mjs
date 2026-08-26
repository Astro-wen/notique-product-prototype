import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function builtPageSource() {
  const assets = await readdir(new URL("../dist/client/assets/", import.meta.url));
  const pageAsset = assets.find((name) => /^page-.*\.js$/.test(name));
  assert.ok(pageAsset, "the production build must emit a page client asset");
  return readFile(new URL(`../dist/client/assets/${pageAsset}`, import.meta.url), "utf8");
}

test("production build contains the real-data shell without seeded AI output", async () => {
  const [pageBundle, serverBundle] = await Promise.all([
    builtPageSource(),
    readFile(new URL("../dist/server/index.js", import.meta.url), "utf8"),
  ]);
  assert.match(serverBundle, /Notique AI · Evidence-backed project records/);
  assert.match(pageBundle, /Projects/);
  assert.match(pageBundle, /正在读取 Projects/);
  assert.match(pageBundle, /保存后会进入现有的说话人识别和逐字稿流程/);
  assert.match(pageBundle, /上传已有录音/);
  assert.match(pageBundle, /role:["'`]status["'`]/);
  assert.doesNotMatch(
    `${serverBundle}\n${pageBundle}`,
    /Sample Project|Sample Claim|Budget is \$|mock claim/i,
  );
});

test("client shell starts empty and delegates all durable data to the API", async () => {
  const [page, client, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /useState<Project\[\]>\(\[\]\)/);
  assert.match(page, /useState<Claim\[\]>\(\[\]\)/);
  assert.match(page, /api\.listProjects\(\)/);
  assert.match(page, /api\.getRunClaims\(/);
  assert.match(page, /api\.getView\(/);
  assert.doesNotMatch(page, /const\s+claimSets\s*[:=]/i);
  assert.match(page, /notique\.ui\.public-workspace-acknowledged/);
  assert.equal((page.match(/window\.sessionStorage\.(?:getItem|setItem|removeItem)/g) ?? []).length, 7);
  assert.match(page, /notique\.ui\.summary-first:/);
  assert.match(page, /notique\.ui\.auto-analysis:/);
  assert.match(page, /sessionStorage\.setItem\(autoAnalysisIntentKey\(intent\.eventId\), JSON\.stringify\(intent\)\)/);
  assert.doesNotMatch(page, /sessionStorage\.(?:setItem|removeItem)\([^\n]+(?:TranscriptSegment|Claim|EvidenceRef)/);
  assert.match(page, /notique\.ui\.recent-project-id/);
  assert.match(page, /notique\.ui\.recent-event-id/);
  assert.match(page, /notique\.ui\.workflow-intent-project-id/);
  assert.equal((page.match(/window\.localStorage\.(?:getItem|setItem|removeItem)/g) ?? []).length, 3);
  const preferenceTargets = [...page.matchAll(/storeId\(([^,\n]+)/g)].map((match) => match[1].trim());
  assert.ok(preferenceTargets.every((target) =>
    target === "key: string"
      || target === "recentProjectStorageKey"
      || target === "workflowIntentStorageKey"
      || target === "sidebarCollapsedStorageKey"
      || target.startsWith("recentEventStorageKey("),
  ));
  assert.match(page, /aria-label=\{sidebarCollapsed \? "展开侧栏" : "收起侧栏"\}/);
  assert.match(page, /notique\.ui\.sidebar-collapsed/);
  assert.doesNotMatch(page, /storeId\([^\n]+JSON\.stringify/);
  assert.doesNotMatch(page, /Sample Project|Sample Claim|Budget is \$/i);

  assert.match(client, /async function request<T>/);
  assert.match(client, /\/api\/v1\/projects/);
  assert.match(client, /idempotency-key/i);
  assert.doesNotMatch(client, /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/);
  assert.match(layout, /Notique AI · Evidence-backed project records/);
});
