import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_ROUTING_THRESHOLD,
  MAX_ROUTING_CANDIDATES,
  NO_MATCH_OPTION,
  buildRoutingQuestion,
  isTimestampProjectName,
  overviewExcerpt,
  routingCandidates,
  routingDecision,
  routingQuestionCharacters,
} from "../lib/domain/project-routing.ts";
import { createJevProjectRouter } from "../lib/server/ai/jev-project-router.ts";

const material = {
  overview: "林女士把预算上限提到一百四十万，学区仍然是硬条件。",
  chapterTitles: ["预算调整", "学区"],
};

const candidate = (id, extra = {}) => ({
  id,
  name: `项目 ${id}`,
  updatedAt: "2026-09-19T02:00:00.000Z",
  ...extra,
});

test("名字只是时间戳的项目不进候选", () => {
  for (const name of [
    "新项目 9/21 15:14",
    "新项目 2026-09-21 15:14",
    "新项目 9月21日 15:14",
    "未命名 9/21",
    "9/21 15:14",
  ]) {
    assert.equal(isTimestampProjectName(name), true, name);
  }
  for (const name of [
    "林女士 换房",
    "枫叶街 214 号 挂牌",
    "Pam 的房子",
    "AM Realty 复盘",
  ]) {
    assert.equal(isTimestampProjectName(name), false, name);
  }
});

test("时间戳命名的项目在候选阶段就被剔掉", () => {
  const candidates = routingCandidates([
    candidate("prj_a", { name: "林女士 换房" }),
    candidate("prj_ts", { name: "新项目 9/21 15:14" }),
    candidate("prj_blank", { name: "   " }),
  ]);
  assert.deepEqual(candidates.map((item) => item.id), ["prj_a"]);
});

test("候选按最近更新截断", () => {
  const many = Array.from({ length: 50 }, (unused, index) => candidate(`prj_${String(index).padStart(2, "0")}`, {
    name: `客户 ${index}`,
    updatedAt: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
  }));
  const capped = routingCandidates(many);
  assert.equal(capped.length, MAX_ROUTING_CANDIDATES);
  // 最新的排最前，被截掉的是最旧的那些。
  assert.equal(capped[0].id, "prj_49");
  assert.equal(capped.at(-1).id, "prj_20");
  assert.equal(routingCandidates(many, 5).length, 5);
  assert.equal(routingCandidates(many, 0).length, 0);
});

test("摘录被截断，问题体量守得住 32k 的上限", () => {
  const many = Array.from({ length: 60 }, (unused, index) => candidate(`prj_${index}`, {
    name: "客户".repeat(200),
    folderName: "文件夹".repeat(200),
    scenarioLabel: "场景".repeat(200),
    lastOverviewExcerpt: "长得离谱的既往概要。".repeat(500),
  }));
  const question = buildRoutingQuestion({
    overview: "同样长得离谱的本次概要。".repeat(500),
    chapterTitles: Array.from({ length: 80 }, () => "很长的章节标题".repeat(50)),
  }, routingCandidates(many));
  // 中文最坏情况按一字一 token 估，这个体量离单问题上限还有一大截。
  assert.ok(routingQuestionCharacters(question) < 20_000, `太大了：${routingQuestionCharacters(question)}`);
});

test("选项里一定有一个「都不是」，否则判断方一定会挑一个", () => {
  const question = buildRoutingQuestion(material, routingCandidates([candidate("prj_a")]));
  assert.deepEqual(Object.keys(question.criteria).sort(), ["none", "prj_a"]);
  assert.match(question.instructions, /none/);
  assert.deepEqual(question.candidateIds, ["prj_a"]);
});

test("送进去的是概要和章节标题，不是逐字稿", () => {
  const question = buildRoutingQuestion(material, routingCandidates([candidate("prj_a")]));
  assert.deepEqual(Object.keys(question.state).sort(), ["new_material_chapters", "new_material_overview"]);
});

test("过了阈值才出声", () => {
  assert.deepEqual(
    routingDecision({ projectId: "prj_a", probability: 0.81 }),
    { kind: "suggest", projectId: "prj_a", probability: 0.81 },
  );
  assert.deepEqual(routingDecision({ projectId: "prj_a", probability: DEFAULT_ROUTING_THRESHOLD }).kind, "suggest");
  assert.deepEqual(routingDecision({ projectId: "prj_a", probability: 0.79 }), { kind: "silent" });
  assert.deepEqual(routingDecision({ projectId: "prj_a", probability: 0.5 }, 0.4).kind, "suggest");
});

test("选「都不是」、没有答案、概率不是数字，一律沉默", () => {
  assert.deepEqual(routingDecision({ projectId: NO_MATCH_OPTION, probability: 1 }), { kind: "silent" });
  assert.deepEqual(routingDecision({ projectId: null, probability: 1 }), { kind: "silent" });
  assert.deepEqual(routingDecision(null), { kind: "silent" });
  assert.deepEqual(routingDecision(undefined), { kind: "silent" });
  assert.deepEqual(routingDecision({ projectId: "prj_a", probability: Number.NaN }), { kind: "silent" });
});

test("永远不返回文件夹", () => {
  const candidates = routingCandidates([candidate("prj_a", { folderName: "买家" })]);
  const question = buildRoutingQuestion(material, candidates);
  // 文件夹只作为候选项目的描述出现，不会自己成为一个可选项。
  assert.equal(Object.keys(question.criteria).includes("买家"), false);
  assert.deepEqual(routingDecision({ projectId: "prj_a", probability: 1 }), {
    kind: "suggest", projectId: "prj_a", probability: 1,
  });
});

test("overview 被压成一段可比对的文字", () => {
  const text = overviewExcerpt([
    { items: [{ text: "预算提到一百四十万。" }, { text: "学区不变。" }] },
    { items: [{ text: "下周再看三套。" }] },
  ]);
  assert.equal(text, "预算提到一百四十万。 学区不变。 下周再看三套。");
  assert.equal(overviewExcerpt(null), "");
  assert.equal(overviewExcerpt([{ items: [{}] }]), "");
});

test("没配密钥就没有判断方", () => {
  assert.equal(createJevProjectRouter({}), null);
  assert.equal(createJevProjectRouter({ apiKey: "   " }), null);
});

test("端点不可达时什么都不返回，也不抛", async () => {
  const router = createJevProjectRouter({
    apiKey: "test-key-not-a-real-one",
    // 保留域名，一定解析不到，不会误打到任何真实服务。
    endpoint: "https://project-routing.invalid/v1/systemone",
    timeoutMs: 1_500,
  });
  assert.ok(router);
  const answer = await router.route(material, routingCandidates([candidate("prj_a")]));
  assert.equal(answer, null);
});

test("没有候选时连请求都不发", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error("不该发出去"); };
  try {
    const router = createJevProjectRouter({ apiKey: "test-key-not-a-real-one" });
    assert.equal(await router.route(material, []), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("判断方编出来的项目 id 不落库", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    answers: { belongs_to: { type: "choice", choice: "prj_编的", probabilities: { "prj_编的": 1 } } },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const router = createJevProjectRouter({ apiKey: "test-key-not-a-real-one", timeoutMs: 1_000 });
    // choice 回了不在候选里的 id，于是退到每候选一问；退路同样拿不到有效答案。
    assert.equal(await router.route(material, routingCandidates([candidate("prj_a")])), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("choice 的概率原样透出，不在适配层里改写", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    answers: { belongs_to: { type: "choice", choice: "prj_a", probabilities: { prj_a: 0.93, none: 0.07 }, confidence: 0.5 } },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const router = createJevProjectRouter({ apiKey: "test-key-not-a-real-one", timeoutMs: 1_000 });
    assert.deepEqual(
      await router.route(material, routingCandidates([candidate("prj_a")])),
      { projectId: "prj_a", probability: 0.93 },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("选「都不是」时项目 id 为空，决定层据此沉默", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    answers: { belongs_to: { type: "choice", choice: "none", probabilities: { none: 0.99, prj_a: 0.01 } } },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const router = createJevProjectRouter({ apiKey: "test-key-not-a-real-one", timeoutMs: 1_000 });
    const answer = await router.route(material, routingCandidates([candidate("prj_a")]));
    assert.deepEqual(answer, { projectId: null, probability: 0.99 });
    assert.deepEqual(routingDecision(answer), { kind: "silent" });
  } finally {
    globalThis.fetch = original;
  }
});

/**
 * 下面几条是源码断言。钩子跑在 Cloudflare 绑定里，node --test 起不了它，
 * 但「不许把产物任务拖下水」和「开关默认关」是这一层能不能接进主链路的前提，
 * 值得用源码守住。
 */

const hookSource = await readFile(new URL("../lib/server/jobs/project-routing.ts", import.meta.url), "utf8");
const artifactJobSource = await readFile(new URL("../lib/server/jobs/event-ai-artifacts.ts", import.meta.url), "utf8");

test("钩子挂在 overview 写完之后，且不 await", () => {
  assert.match(artifactJobSource, /kind === "overview"[\s\S]{0,400}scheduleProjectRoutingSuggestion\(/);
  // 只有 schedule 版本会被产物任务调到；await 的那个是给测试和脚本用的。
  assert.equal(artifactJobSource.includes("await suggestProjectRouting"), false);
});

test("钩子把所有失败吞在自己这一层", () => {
  assert.match(hookSource, /void suggestProjectRouting\(input\)\.catch\(\(\) => \{\}\)/);
});

test("开关默认关，没配就一行都不跑", () => {
  assert.match(hookSource, /PROJECT_ROUTING_ENABLED/);
  assert.match(hookSource, /if \(!enabled\(\)\) return "disabled";/);
  // 开关的判断必须排在读库和发请求之前。比的是调用位置，不是文件顶上的 import。
  const gate = hookSource.indexOf('if (!enabled()) return "disabled";');
  assert.ok(gate > 0);
  assert.ok(gate < hookSource.indexOf("readEventRoutingSource(input.eventId)"));
  assert.ok(gate < hookSource.indexOf("createJevProjectRouter({"));
});

test("用户选过的材料不问判断方", () => {
  const gate = hookSource.indexOf("suggestionAllowed(source)");
  assert.ok(gate > 0);
  assert.ok(gate < hookSource.indexOf("createJevProjectRouter({"));
});

test("开关登记在 db/index.ts 和 cloudflare-env.d.ts 里", async () => {
  for (const file of ["../db/index.ts", "../cloudflare-env.d.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /PROJECT_ROUTING_ENABLED\?: string;/, file);
  }
});
