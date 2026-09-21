import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { declarationSource, uiSource } from "./helpers/ui-source.mjs";

const repository = await readFile(new URL("../lib/server/db/core-repository.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/v1/[...segments]/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0019_asset_ordering.sql", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("materials arrive through one drop zone that takes every supported kind", () => {
  const shelf = declarationSource("MaterialShelf");
  // 录音、逐字稿、图片共用一个 accept 和一个放置区，而不是四个分头的按钮。
  assert.match(uiSource, /accept=\{`\$\{AUDIO_FILE_ACCEPT\},\$\{acceptedTranscriptTypes\.join\(","\)\},\$\{MODEL_IMAGE_FILE_ACCEPT\}`\}/);
  assert.match(shelf, /className="material-dropzone"/);
  assert.match(shelf, /multiple/);
  assert.match(shelf, /onDrop=\{drop\}/);
  assert.match(styles, /\.material-dropzone \{/);
  // 被它取代的四宫格面板不能留在代码里，否则两套入口会同时出现。
  assert.doesNotMatch(uiSource, /simple-import-action|capture-launchpad|simple-material-list/);
  assert.doesNotMatch(styles, /\.simple-import-action|\.capture-launchpad|\.simple-material-list/);
});

test("a drop that carries no file never starts an upload", () => {
  const shelf = declarationSource("MaterialShelf");
  // 排序拖动和文件拖入走同一个 onDrop，只有带文件的那次才上传。
  assert.match(shelf, /if \(event\.dataTransfer\.files\.length\) takeFiles\(event\.dataTransfer\.files\);/);
});

test("several dropped files upload one after another", () => {
  const addMaterials = declarationSource("addMaterials");
  // onAddFile 一次只收一份，并行提交会被"上一份仍在处理中"挡回来。
  assert.match(addMaterials, /for \(const file of files\)/);
  assert.match(addMaterials, /if \(!await onAddFile\(/);
  assert.match(addMaterials, /capture_role: "handwritten_note"/);
});

test("materials can be reordered and renamed, and both survive a reload", () => {
  const shelf = declarationSource("MaterialShelf");
  assert.match(shelf, /draggable=\{!busy && !renaming\}/);
  assert.match(shelf, /className="material-grip"/);
  // 方向键也能移动，排序不是只有鼠标能做的操作。
  assert.match(shelf, /event\.key === "ArrowUp" \? -1 : 1/);
  assert.match(shelf, /className="material-rename"/);
  assert.match(shelf, /if \(event\.key === "Escape"\)/);
  assert.match(uiSource, /await api\.renameAsset\(assetId, filename\)/);
  assert.match(uiSource, /await api\.reorderEventAssets\(event\.id, assetIds\)/);
  assert.match(route, /segments\.length === 2 && segments\[0\] === "assets"/);
  assert.match(route, /segments\[2\] === "assets" && segments\[3\] === "order"/);
});

test("a reorder must carry the whole list, and the stored order drives the read", () => {
  // 只收到一部分 id 时，漏掉的材料会保留旧名次，和新排定的混在一起，
  // 列表顺序就再也说不清了。所以服务端拒绝子集。
  assert.match(repository, /ASSET_ORDER_STALE/);
  assert.match(repository, /assetIds\.length === visible\.length/);
  assert.match(repository, /new Set\(assetIds\)\.size === assetIds\.length/);
  assert.match(repository, /ORDER BY COALESCE\(a\.sort_order, 2147483647\) ASC, a\.created_at ASC/);
});

test("the ordering column backfills so the list looks unchanged after the migration", () => {
  assert.match(migration, /ALTER TABLE assets ADD COLUMN sort_order INTEGER;/);
  assert.match(migration, /UPDATE assets SET sort_order = \(/);
  // 同一毫秒创建的两份材料靠 id 兜底，回填结果唯一。
  assert.match(migration, /older\.created_at = assets\.created_at AND older\.id < assets\.id/);
  assert.match(migration, /idx_assets_event_order/);
});

test("an order that only the browser believes in is rolled back", () => {
  const shelf = declarationSource("MaterialShelf");
  // 请求失败后退回服务端顺序，不留下一个刷新就消失的排列。
  assert.match(shelf, /setLocalOrder\(null\);\s*\n\s*onNotice\("顺序没保存成功/);
  // 期间若有新材料上传进来，本地顺序不再覆盖完整列表，直接以服务端为准。
  assert.match(shelf, /localOrder && sameSet\(localOrder, ids\) \? localOrder : ids/);
});
