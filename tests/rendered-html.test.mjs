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
  assert.match(pageBundle, /页面只显示服务器中的真实数据/);
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
  assert.doesNotMatch(page, /const\s+claimSets\s*[:=]|localStorage|sessionStorage/i);
  assert.doesNotMatch(page, /Sample Project|Sample Claim|Budget is \$/i);

  assert.match(client, /async function request<T>/);
  assert.match(client, /\/api\/v1\/projects/);
  assert.match(client, /idempotency-key/i);
  assert.doesNotMatch(client, /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/);
  assert.match(layout, /Notique AI · Evidence-backed project records/);
});
