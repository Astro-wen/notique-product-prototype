import assert from "node:assert/strict";
import test from "node:test";
import { NEW_PROJECT, routingChoice, suggestionAllowed } from "../lib/domain/material-routing.ts";
import { declarationSource } from "./helpers/ui-source.mjs";

test("跳过选择器等于今天的行为：新建项目", () => {
  const routing = routingChoice({ skipped: true });
  assert.deepEqual(routing, { projectId: NEW_PROJECT, source: "skipped" });
});

test("什么都没传也按跳过处理，接入之前的调用方不会换一条路径", () => {
  assert.deepEqual(routingChoice({}), { projectId: NEW_PROJECT, source: "skipped" });
  assert.deepEqual(routingChoice({ chosenProjectId: null }), { projectId: NEW_PROJECT, source: "skipped" });
  assert.deepEqual(routingChoice({ chosenProjectId: "   " }), { projectId: NEW_PROJECT, source: "skipped" });
});

test("选中一个项目记为用户决定", () => {
  assert.deepEqual(routingChoice({ chosenProjectId: "prj_1" }), { projectId: "prj_1", source: "user" });
});

test("点「新建项目」也是一次明确表态，来源同样是 user", () => {
  // 这条是建议层沉默的关键：他刚说过这份材料不属于任何现有项目。
  assert.deepEqual(routingChoice({ chosenProjectId: NEW_PROJECT }), { projectId: NEW_PROJECT, source: "user" });
});

test("跳过优先于顺手带上的 id", () => {
  assert.deepEqual(routingChoice({ skipped: true, chosenProjectId: "prj_1" }), {
    projectId: NEW_PROJECT,
    source: "skipped",
  });
});

test("用户选过的材料，建议层必须闭嘴", () => {
  assert.equal(suggestionAllowed("user"), false);
  assert.equal(suggestionAllowed("skipped"), true);
  // 老数据没有来源字段。没记录就等于没人选过，建议层可以出声。
  assert.equal(suggestionAllowed(null), true);
  assert.equal(suggestionAllowed(undefined), true);
});

test("选择器只交回选择，自己不落库也不建项目", () => {
  const source = declarationSource("ProjectPicker");
  for (const forbidden of ["api.", "fetch(", "useEffect"]) {
    assert.equal(source.includes(forbidden), false, `选择器不应出现 ${forbidden}`);
  }
});

test("选择器最多列八个，多出来才给搜索框", () => {
  const source = declarationSource("ProjectPicker");
  assert.match(source, /slice\(0,\s*VISIBLE_LIMIT\)/);
  assert.match(source, /ordered\.length\s*>\s*VISIBLE_LIMIT/);
});

test("合成案例前缀不出现在选择器里", () => {
  const source = declarationSource("displayName");
  assert.match(source, /\\\[SYNTHETIC\\\]/);
});
