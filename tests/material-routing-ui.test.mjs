import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { declarationSource } from "./helpers/ui-source.mjs";
import { NEW_PROJECT, routingChoice, suggestionAllowed } from "../lib/domain/material-routing.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("首页拖进材料才问归属，项目里拖的不问", async () => {
  const attachSimpleFile = declarationSource("attachSimpleFile");
  // 已经打开某个项目时 targetProject 非空，整段询问都跳过：待在哪个项目里
  // 本身就是一次选择，再弹一个框是在问一个已经回答过的问题。
  assert.match(attachSimpleFile, /if \(!targetProject\) \{[\s\S]*?askMaterialRouting\(\)/);
  // 项目里拖的那一支直接记成 user，建议层据此闭嘴。
  assert.match(attachSimpleFile, /routingChoice\(\{ chosenProjectId: targetProject\.id \}\)/);
});

test("一批材料只问一次，答案记在 ref 上而不是 state 上", async () => {
  const page = await read("app/page.tsx");
  // 一批材料是串行上传的，同一轮闭包里 project 状态不会更新，用 state 存答案
  // 会让第二份材料重新问一遍。
  assert.match(page, /pendingRoutingRef = useRef<MaterialRouting \| null>\(null\)/);
  const attachSimpleFile = declarationSource("attachSimpleFile");
  assert.match(attachSimpleFile, /let routing = pendingRoutingRef\.current;/);
  assert.match(attachSimpleFile, /pendingRoutingRef\.current = routing;/);
});

test("回到首页会忘掉上一次的归属选择", () => {
  const goHome = declarationSource("goHome");
  // 不清掉的话，回首页再拖一份新材料会沿用上一次选的项目，而且不再问。
  assert.match(goHome, /pendingRoutingRef\.current = null;/);
});

test("没有可选项目时不弹框，直接按新建处理", () => {
  const ask = declarationSource("askMaterialRouting");
  assert.match(ask, /if \(!projects\.length\) return Promise\.resolve\(routingChoice\(\{ skipped: true \}\)\)/);
});

test("新建的记录才写归属来源，且写失败不影响上传", () => {
  const attachSimpleFile = declarationSource("attachSimpleFile");
  assert.match(attachSimpleFile, /if \(target\.createdEvent && routing\)/);
  // 这一步只决定建议层要不要出声，丢了最多多弹一条建议，不该让上传失败。
  assert.match(attachSimpleFile, /setEventRoutingSource\(targetEvent\.id, routing\.source\)\.catch\(\(\) => undefined\)/);
});

test("建议条只在没被忽略、且叫得出目标项目名字时出现", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /routingSuggestion && !routingSuggestion\.dismissed_at/);
  // 目标项目名字是可空的。取不到名字的建议人没法判断该不该接受，不如不出现。
  assert.match(page, /routingSuggestion\.suggested_project_name && <RoutingSuggestionBanner/);
});

test("接受建议先搬记录，再落到目标项目", () => {
  const accept = declarationSource("acceptRoutingSuggestion");
  assert.match(accept, /await api\.moveEvent\(eventId, targetProjectId, key\)/);
  // 接受的意思就是要去那边继续看，所以搬完直接落在目标项目。
  assert.match(accept, /await loadSimpleProject\(targetProjectId, eventId\)/);
  // 搬家是会改数据的操作，必须带幂等键，重复点不能搬两次。
  assert.match(accept, /mutationKeys\.current\.get\(fingerprint\) \|\| crypto\.randomUUID\(\)/);
});

test("建议条不把概率摆给用户看", async () => {
  const banner = await read("app/components/routing-suggestion-banner.tsx");
  // 给一个 0.87 只会让人去猜这个数什么意思。概率留在库里给评估用。
  assert.doesNotMatch(banner, /probability/);
  assert.match(banner, /不一定对/);
});

test("选过项目的材料，建议层必须闭嘴", () => {
  assert.equal(suggestionAllowed("user"), false);
  assert.equal(suggestionAllowed("skipped"), true);
  assert.equal(suggestionAllowed(null), true);
  // 在选择器里点「新建项目」也是明确表态，同样算 user。
  assert.equal(routingChoice({ chosenProjectId: NEW_PROJECT }).source, "user");
  assert.equal(routingChoice({ skipped: true }).source, "skipped");
});

test("选择器不跟着上传的忙碌状态禁用", async () => {
  const page = await read("app/page.tsx");
  // attachSimpleFile 一进来就把 busyAction 设成 asset，而询问发生在那之后。
  // 把这个状态传给选择器会让所有按钮禁用，用户被卡在一个答不了的框里。
  assert.match(page, /<ProjectPicker\n\s+projects=\{projects\}\n\s+busy=\{false\}/);
});
