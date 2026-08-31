import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("public gateway mode is explicit and uses one fixed public actor", () => {
  const context = read("lib/server/http/context.ts");
  const worker = read("worker/index.ts");
  const wrangler = read("wrangler.jsonc");

  assert.match(wrangler, /"AUTH_GATEWAY"\s*:\s*"public"/);
  assert.match(context, /gateway === "public"[\s\S]{0,180}"public@notique\.test"/);
  assert.match(
    context,
    /else if \(gateway === "public"\)[\s\S]{0,180}email = "public@notique\.test"/,
  );
  assert.match(
    worker,
    /const authenticated = env\.AUTH_GATEWAY === "public"\s*\n\s*\? true/,
  );
  assert.match(
    worker,
    /sameOrigin \|\| !authenticated[\s\S]{0,180}A same-origin browser request is required/,
  );
});

test("public mode keeps the shared-space warning visible", () => {
  const page = read("app/page.tsx");
  assert.match(page, /公开演示空间/);
  assert.match(page, /请勿上传真实客户资料或其他敏感信息/);
});
