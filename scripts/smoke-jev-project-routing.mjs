/**
 * 对着真实的 Jev API 跑一遍第三层的判断。
 *
 * 界面还没有，所以这是唯一能在接进主链路之前看清它到底准不准的办法。数据全是编的，
 * 没有任何真实客户名、地址或金额。
 *
 * 六个候选项目里有两个名字只是时间戳，它们必须在候选阶段就被排除，不应出现在表里。
 *
 * 用法：npm run smoke:jev-routing [-- --noul]
 *   --noul 强制走每候选一问的退路，用来和 choice 的结果对比。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJevProjectRouter } from "../lib/server/ai/jev-project-router.ts";
import {
  DEFAULT_ROUTING_THRESHOLD,
  routingCandidates,
  routingDecision,
} from "../lib/domain/project-routing.ts";

const root = resolve(import.meta.dirname, "..");

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const PROJECTS = [
  {
    id: "prj_buyer_lin",
    name: "林女士 换房",
    folderName: "买家",
    scenarioLabel: "买家看房",
    updatedAt: "2026-09-19T02:00:00.000Z",
    lastOverviewExcerpt:
      "林女士想在明年开春前换一套三居室，预算上限一百三十五万，最看重的是要落在橡岭小学的学区里。她说车库可以妥协，学区不能。",
  },
  {
    id: "prj_seller_maple",
    name: "枫叶街 214 号 挂牌",
    folderName: "卖家",
    scenarioLabel: "卖家挂牌",
    updatedAt: "2026-09-18T02:00:00.000Z",
    lastOverviewExcerpt:
      "枫叶街 214 号准备挂牌，业主期望价八十九万。下周先做一轮软装陈列，照片拍完再上线。屋顶两年前换过，可以写进房源说明。",
  },
  {
    id: "prj_reno_kitchen",
    name: "河景路 8 号 厨房翻新",
    folderName: "工程",
    scenarioLabel: "装修估价",
    updatedAt: "2026-09-17T02:00:00.000Z",
    lastOverviewExcerpt:
      "河景路 8 号的厨房翻新初步报价四万二，含橱柜、台面和水电改造。橱柜要定制，交期六周。业主希望在圣诞前完工。",
  },
  {
    id: "prj_rental_harbor",
    name: "海港公寓 租赁",
    folderName: "租赁",
    scenarioLabel: "租赁带看",
    updatedAt: "2026-09-16T02:00:00.000Z",
    lastOverviewExcerpt:
      "海港公寓有一套两居室可租，月租三千二，押一付一，可以带家具。租客希望九月底入住，需要确认能不能养猫。",
  },
  // 下面两个名字只是时间戳，必须被 routingCandidates 排除。
  { id: "prj_ts_a", name: "新项目 9/21 15:14", updatedAt: "2026-09-21T07:14:00.000Z" },
  { id: "prj_ts_b", name: "新项目 9/20 09:03", updatedAt: "2026-09-20T01:03:00.000Z" },
];

const MATERIALS = [
  {
    label: "林女士加预算",
    expected: "prj_buyer_lin",
    overview:
      "林女士把预算上限从一百三十五万提到一百四十万，因为她看中的两套都超了。学区仍然是硬条件，必须在橡岭小学的范围内。她同意把车库从必须改成加分项，也接受房龄再老一点。下周想再看三套。",
    chapterTitles: ["预算调整", "学区仍然是硬条件", "车库让步", "下周看房安排"],
  },
  {
    label: "枫叶街定价",
    expected: "prj_seller_maple",
    overview:
      "枫叶街 214 号的软装陈列已经做完，照片周三拍。业主看了同街区最近三笔成交，愿意把期望价从八十九万下调到八十六万五，先挂两周看反馈。屋顶更换的凭证已经找到，可以放进房源说明。",
    chapterTitles: ["陈列完成", "同街区成交比较", "期望价下调", "屋顶凭证"],
  },
  {
    label: "厨房橱柜延期",
    expected: "prj_reno_kitchen",
    overview:
      "河景路 8 号的定制橱柜供应商把交期从六周推到九周，圣诞前完工已经不现实。改用现货柜体可以赶回来，但要多花三千，总价从四万二变成四万五。业主还没决定，要先看现货柜体的样品。",
    chapterTitles: ["橱柜交期延后", "现货替代方案", "总价变动", "等业主确认"],
  },
  {
    label: "新客户问商铺",
    expected: null,
    overview:
      "一位新联系上的陈先生想在市中心租一间约两百平米的临街商铺开餐厅，关心的是排烟条件和消防验收能不能过。他没有买房打算，目前也没有在看住宅。希望这个月内看到三个备选位置。",
    chapterTitles: ["商铺需求", "排烟与消防", "选址时间"],
  },
  {
    label: "海港附近买还是租",
    expected: null,
    overview:
      "来电的人还没想好是买还是租，想先在海港那一带住一年看看。两居室就够，预算说不上死线，月付三千左右可以接受，如果买的话也能考虑一百三十万以内。没有留姓名，只说下周再联系。",
    chapterTitles: ["买还是租未定", "海港一带", "两居室", "下周再联系"],
  },
];

function pad(value, width) {
  // 中文按两格宽算，表格才不会错行。
  let used = 0;
  for (const char of value) used += /[　-鿿＀-￯]/u.test(char) ? 2 : 1;
  return value + " ".repeat(Math.max(1, width - used));
}

async function main() {
  const env = parseEnv(await readFile(resolve(root, ".env.local"), "utf8"));
  const apiKey = process.env.JEV_API_KEY || env.JEV_API_KEY;
  if (!apiKey) throw new Error("JEV_API_KEY is not configured in .env.local");

  const forceNoulFallback = process.argv.includes("--noul");
  const router = createJevProjectRouter({ apiKey, forceNoulFallback, timeoutMs: 30_000 });
  if (!router) throw new Error("router was not created despite a configured key");

  const candidates = routingCandidates(PROJECTS);
  console.log(`候选项目 ${candidates.length} 个（时间戳命名的 ${PROJECTS.length - candidates.length} 个已排除）：`);
  for (const candidate of candidates) console.log(`  ${candidate.id}  ${candidate.name}`);
  console.log(`模式 ${forceNoulFallback ? "noul 退路" : "choice"}，阈值 ${DEFAULT_ROUTING_THRESHOLD}\n`);

  const rows = [];
  for (const material of MATERIALS) {
    const answer = await router.route(
      { overview: material.overview, chapterTitles: material.chapterTitles },
      candidates,
    );
    const decision = routingDecision(answer, DEFAULT_ROUTING_THRESHOLD);
    const suggested = decision.kind === "suggest" ? decision.projectId : null;
    rows.push({
      label: material.label,
      top: answer?.projectId ?? (answer ? "none" : "无回应"),
      probability: answer ? answer.probability.toFixed(3) : "-",
      decision: decision.kind === "suggest" ? `建议 ${decision.projectId}` : "沉默",
      matched: suggested === material.expected ? "是" : "否",
    });
  }

  console.log([
    pad("材料", 22), pad("首选候选", 22), pad("概率", 8),
    pad(`0.8 决定`, 26), "符合预期",
  ].join(""));
  console.log("-".repeat(86));
  for (const row of rows) {
    console.log([
      pad(row.label, 22), pad(row.top, 22), pad(row.probability, 8),
      pad(row.decision, 26), row.matched,
    ].join(""));
  }
  const matched = rows.filter((row) => row.matched === "是").length;
  console.log(`\n${matched}/${rows.length} 条符合预期。`);
}

await main();
