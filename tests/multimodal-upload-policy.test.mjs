import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadPolicy() {
  const source = await readFile(path.join(root, "lib/domain/asset-policy.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

test("model image policy accepts only JPEG, PNG, and WebP", async () => {
  const policy = await loadPolicy();
  assert.deepEqual([...policy.MODEL_IMAGE_MIME_TYPES], [
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  assert.equal(policy.isSupportedModelImageMime("image/jpeg"), true);
  assert.equal(policy.isSupportedModelImageMime("IMAGE/PNG; charset=binary"), true);
  assert.equal(policy.isSupportedModelImageMime("image/webp"), true);
  assert.equal(policy.isSupportedModelImageMime("image/heic"), false);
  assert.equal(policy.isSupportedModelImageMime("image/heif"), false);
  assert.equal(policy.isSupportedModelImageMime("image/gif"), false);
  assert.equal(policy.MODEL_IMAGE_FILE_ACCEPT.includes("image/*"), false);
});

test("HEIC and HEIF are recognized even when the browser omits or spoofs MIME", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.isHeifLike("IMG_0001.HEIC", ""), true);
  assert.equal(policy.isHeifLike("capture.bin", "image/heif"), true);
  assert.equal(policy.isHeifLike("capture.jpg", "image/heic-sequence"), true);
  assert.equal(policy.isHeifLike("capture.jpg", "image/jpeg"), false);
});

test("common image extensions get a canonical MIME and byte defaults are bounded", async () => {
  const policy = await loadPolicy();
  assert.equal(policy.modelImageMimeFor("photo.JPG", ""), "image/jpeg");
  assert.equal(policy.modelImageMimeFor("photo.png", "application/octet-stream"), "image/png");
  assert.equal(policy.modelImageMimeFor("photo.webp", ""), "image/webp");
  assert.equal(policy.modelImageMimeFor("photo.heic", "image/heic"), null);
  assert.equal(policy.MAX_IMAGE_BYTES, 15 * 1024 * 1024);
  assert.equal(policy.DEFAULT_MAX_RUN_IMAGE_BYTES, 30 * 1024 * 1024);
});

test("frontend, upload repository, run creation, and processor share the boundary", async () => {
  const [page, repository, processor, envExample] = await Promise.all([
    readFile(path.join(root, "app/page.tsx"), "utf8"),
    readFile(path.join(root, "lib/server/db/core-repository.ts"), "utf8"),
    readFile(path.join(root, "lib/server/jobs/extraction-processor.ts"), "utf8"),
    readFile(path.join(root, ".env.example"), "utf8"),
  ]);

  assert.doesNotMatch(page, /accept=["'][^"']*image\/\*/);
  assert.match(page, /photoUploadIssue\(file\.name, file\.type, file\.size\)/);
  assert.match(repository, /isHeifLike\(input\.filename, mimeType\)/);
  assert.match(repository, /Combined image size exceeds the extraction limit/);
  assert.match(repository, /max_total_image_bytes: maxRunImageBytes/);
  assert.match(processor, /bindings\.MAX_RUN_IMAGE_BYTES/);
  assert.match(processor, /total_image_bytes: totalImageBytes/);
  assert.match(envExample, /^MAX_RUN_IMAGE_BYTES=31457280$/m);
});
