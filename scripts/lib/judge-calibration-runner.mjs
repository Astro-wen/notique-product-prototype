/**
 * 引用支持度判断方的校准流水线。
 *
 * judge-calibration.ts 定义了四道互不补偿的门，但一直没人跑过，因为没有标注数据
 * 的来路。这里把来路补上：本地 D1 里人下过的 confirm / reject，以及离线评估集里
 * 已经标好的引用支持关系，两边都化成同一种样本，喂给同一把尺。
 *
 * 只出聚合数字。陈述和原话从头到尾留在内存里，不写进缓存也不写进文档。
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_JUDGE_GATES,
  calibrationReport,
  judgeGates,
} from "../../lib/domain/judge-calibration.ts";
import { createJevSupportJudge } from "../../lib/server/ai/jev-support-judge.ts";

/** 四种标注来源。报告按它分组，因为两种来源的可信度不一样。 */
export const LABEL_SOURCES = Object.freeze([
  "verdict_confirm",
  "verdict_reject",
  "eval_positive",
  "eval_negative",
]);

/**
 * 每条判断的估价。Jev 没有公开的分档价目，这个数只用来给出量级，
 * 让人在按下 --yes 之前知道自己大概要花掉什么，而不是精确记账。
 */
export const ESTIMATED_USD_PER_QUESTION = 0.001;

export function estimateCostUsd(count) {
  return count * ESTIMATED_USD_PER_QUESTION;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    from: [],
    limit: null,
    concurrency: 8,
    yes: false,
    dryRun: false,
    databasePath: null,
    output: null,
    write: true,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-write") options.write = false;
    else if (arg.startsWith("--from=")) {
      for (const piece of arg.slice("--from=".length).split(",")) {
        const name = piece.trim();
        if (!name) continue;
        if (name !== "verdicts" && name !== "eval") {
          throw new Error(`--from 只认 verdicts 和 eval，收到 ${name}`);
        }
        if (!options.from.includes(name)) options.from.push(name);
      }
    } else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (!Number.isInteger(value) || value < 1) throw new Error("--limit 要一个正整数");
      options.limit = value;
    } else if (arg.startsWith("--concurrency=")) {
      const value = Number(arg.slice("--concurrency=".length));
      if (!Number.isInteger(value) || value < 1) throw new Error("--concurrency 要一个正整数");
      options.concurrency = value;
    } else if (arg.startsWith("--db=")) options.databasePath = arg.slice("--db=".length);
    else if (arg.startsWith("--output=")) options.output = arg.slice("--output=".length);
    else throw new Error(`不认识的参数：${arg}`);
  }
  // 默认读线上标注。空库会如实报成 0 条，比悄悄换成评估集诚实。
  if (!options.from.length) options.from = ["verdicts"];
  return options;
}

export function usage() {
  return `用法：
  npm run judge:calibrate -- [选项]

选项：
  --from=verdicts,eval   标注来源，可叠加。默认 verdicts
  --limit=N              最多取 N 条样本，按标注来源分层截断
  --concurrency=N        并发，默认 8
  --dry-run              不调接口，用一个确定性的词面规则判断方跑通全程
  --yes                  确认花钱。不加它就只打印预估成本，不会发任何请求
  --db=<path>            本地 D1 的 sqlite 路径，默认在 .wrangler/state 下找
  --output=<path>        结果文档写到哪，默认 docs/judge-calibration/<日期>.md
  --no-write             只打印，不写文档
  --help                 看这段`;
}

// ---------------------------------------------------------------------------
// 来源一：本地 D1 的人工裁决
// ---------------------------------------------------------------------------

/**
 * verdicts 挂在 claim 和它当时那一版上（base_version_id），evidence_refs 也挂在
 * 同一版上，所以两边在 claim_versions.id 上对齐。edit 和 withdraw 不进来：它们
 * 说明的是陈述本身要改或要撤，跟引用撑不撑得住是两回事。
 */
export const VERDICT_LABEL_SQL = `
SELECT
  v.action            AS action,
  v.claim_id          AS claim_id,
  v.base_version_id   AS claim_version_id,
  cv.statement        AS statement,
  er.id               AS evidence_ref_id,
  er.quote_raw        AS quote,
  er.evidence_role    AS evidence_role
FROM verdicts v
JOIN claim_versions cv ON cv.id = v.base_version_id
JOIN evidence_refs er ON er.claim_version_id = v.base_version_id
WHERE v.action IN ('confirm', 'reject')
ORDER BY v.created_at, er.id
`.trim();

/**
 * 把裁决行化成样本。
 *
 * 唯一值得说清楚的假设：confirm 是硬标注，人看过证据才点的确认；reject 不是。
 * 一条记录被否，常见原因确实是引用撑不住，但也可能是陈述本身没意义、重复了、
 * 或者人改主意了，引用其实没问题。所以 reject 只是弱证据，不是证明。样本上记着
 * 它从哪来，报告按来源拆开，看的人自己决定这部分负例该信几成。
 */
export function verdictSamples(rows) {
  const byRef = new Map();
  const conflicting = new Set();
  for (const row of rows ?? []) {
    const action = row?.action;
    if (action !== "confirm" && action !== "reject") continue;
    const statement = typeof row.statement === "string" ? row.statement.trim() : "";
    const quote = typeof row.quote === "string" ? row.quote.trim() : "";
    // 没有原话就没有可判断的东西，这条引用指的是别的形态的证据。
    if (!statement || !quote) continue;
    const evidenceRefId = typeof row.evidence_ref_id === "string" ? row.evidence_ref_id : "";
    if (!evidenceRefId) continue;

    const existing = byRef.get(evidenceRefId);
    if (existing && existing.actual !== (action === "confirm")) {
      // 同一条引用上既有确认又有否决，说明不了任何事，两边都丢掉。
      conflicting.add(evidenceRefId);
      continue;
    }
    byRef.set(evidenceRefId, {
      claimId: typeof row.claim_id === "string" ? row.claim_id : "",
      claimVersionId: typeof row.claim_version_id === "string" ? row.claim_version_id : "",
      evidenceRefId,
      statement,
      quote,
      evidenceRole: typeof row.evidence_role === "string" ? row.evidence_role : "direct",
      actual: action === "confirm",
      labelSource: action === "confirm" ? "verdict_confirm" : "verdict_reject",
    });
  }
  for (const id of conflicting) byRef.delete(id);
  return [...byRef.values()];
}

/** miniflare 把 D1 存成一个哈希命名的 sqlite，名字不固定，按表结构认。 */
export async function findLocalDatabase(root) {
  const directory = join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return null;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".sqlite") || entry === "metadata.sqlite") continue;
    const path = join(directory, entry);
    if (hasVerdictTables(path)) return path;
  }
  return null;
}

function hasVerdictTables(path) {
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const found = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('verdicts', 'claim_versions', 'evidence_refs')")
      .all();
    return found.length === 3;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export function loadVerdictRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(VERDICT_LABEL_SQL).all();
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// 来源二：离线评估集
// ---------------------------------------------------------------------------

/**
 * 评估集里的正例是 citationSupport 为 fully_supports 的转写类 claim，
 * 每个 acceptableEvidenceIds 单独算一条：每一条都是单独够用的引用。
 * 负例是 transcriptNegativeControls，mustNotInfer 就是那句不该被推出来的陈述。
 * 图片证据跳过，判断方只看得到文字原话。
 */
export async function loadEvalSamples(root) {
  const casesRoot = join(root, "eval", "cases");
  let caseDirs;
  try {
    caseDirs = (await readdir(casesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const samples = [];
  for (const caseName of caseDirs) {
    const caseRoot = join(casesRoot, caseName);
    let manifest;
    let groundTruth;
    try {
      manifest = JSON.parse(await readFile(join(caseRoot, "manifest.json"), "utf8"));
      groundTruth = JSON.parse(await readFile(join(caseRoot, "ground-truth.json"), "utf8"));
    } catch {
      continue;
    }
    const lookup = await transcriptLookup(caseRoot, manifest);

    for (const claim of groundTruth.claims ?? []) {
      if (claim.modality !== "transcript") continue;
      if (claim.citationSupport !== "fully_supports") continue;
      const statement = typeof claim.statement === "string" ? claim.statement.trim() : "";
      if (!statement) continue;
      for (const evidenceId of claim.acceptableEvidenceIds ?? []) {
        const quote = lookup(evidenceId);
        if (!quote) continue;
        samples.push({
          claimId: `${caseName}:${claim.id}`,
          claimVersionId: `${caseName}:${claim.id}:gt`,
          evidenceRefId: `eval:${caseName}:${claim.id}:${evidenceId}`,
          statement,
          quote,
          evidenceRole: "direct",
          actual: true,
          labelSource: "eval_positive",
        });
      }
    }

    for (const control of groundTruth.transcriptNegativeControls ?? []) {
      const statement = typeof control.mustNotInfer === "string" ? control.mustNotInfer.trim() : "";
      const quote = lookup(control.evidenceId);
      if (!statement || !quote) continue;
      samples.push({
        claimId: `${caseName}:${control.id}`,
        claimVersionId: `${caseName}:${control.id}:gt`,
        evidenceRefId: `eval:${caseName}:${control.id}:${control.evidenceId}`,
        statement,
        quote,
        evidenceRole: "contextual",
        actual: false,
        labelSource: "eval_negative",
      });
    }
  }
  return samples;
}

/** 证据引用长成 tx-r1:seg:3，别名指到某个 Event 的转写，序号是非空行的下标。 */
async function transcriptLookup(caseRoot, manifest) {
  const aliases = manifest?.evidenceAliases?.transcript ?? {};
  const linesByAlias = new Map();
  for (const [alias, info] of Object.entries(aliases)) {
    const event = (manifest.events ?? []).find((candidate) => candidate.key === info.eventKey);
    const path = event?.transcript?.path;
    if (!path) continue;
    try {
      const text = await readFile(join(caseRoot, path), "utf8");
      linesByAlias.set(alias, {
        lines: text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
        ordinalBase: Number.isInteger(info.ordinalBase) ? info.ordinalBase : 0,
      });
    } catch {
      continue;
    }
  }
  return (evidenceId) => {
    if (typeof evidenceId !== "string") return null;
    const parts = evidenceId.split(":");
    if (parts.length !== 3 || parts[1] !== "seg") return null;
    const entry = linesByAlias.get(parts[0]);
    if (!entry) return null;
    const index = Number(parts[2]) - entry.ordinalBase;
    if (!Number.isInteger(index) || index < 0 || index >= entry.lines.length) return null;
    return entry.lines[index];
  };
}

// ---------------------------------------------------------------------------
// 取样
// ---------------------------------------------------------------------------

export function countBySource(samples) {
  const counts = Object.fromEntries(LABEL_SOURCES.map((name) => [name, 0]));
  for (const sample of samples) {
    counts[sample.labelSource] = (counts[sample.labelSource] ?? 0) + 1;
  }
  return counts;
}

/**
 * 按来源轮流取，让任何一个前缀都保留整体的来源比例。
 *
 * 直接截前 N 条会把负例全切掉（它们总排在最后），剩下一堆正例，校准就没意义了。
 * 轮流取是确定性的，所以 --limit 不同的两次跑之间样本是嵌套的，缓存能复用。
 */
export function stratify(samples, limit) {
  const lanes = new Map();
  for (const sample of samples) {
    const lane = lanes.get(sample.labelSource) ?? [];
    lane.push(sample);
    lanes.set(sample.labelSource, lane);
  }
  const ordered = [];
  const names = LABEL_SOURCES.filter((name) => lanes.has(name));
  for (let index = 0; ordered.length < samples.length; index += 1) {
    for (const name of names) {
      const lane = lanes.get(name);
      if (index < lane.length) ordered.push(lane[index]);
    }
  }
  return limit == null ? ordered : ordered.slice(0, limit);
}

export function dedupe(samples) {
  const seen = new Set();
  const result = [];
  for (const sample of samples) {
    if (seen.has(sample.evidenceRefId)) continue;
    seen.add(sample.evidenceRefId);
    result.push(sample);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 判断方
// ---------------------------------------------------------------------------

/**
 * 一个只看词面重合度的判断方，给 --dry-run 用。
 *
 * 它不偷看标注，也就是说它真的是个（很笨的）判断方：算陈述里的词有多少在原话里
 * 出现过。这样整条流水线能在不花钱的情况下跑出一份真实形状的报告，包括分桶和
 * 四道门，而报告里的数字确实是某个判断方的成绩，不是编的。
 */
export function lexicalStubJudge() {
  return {
    name: "stub-lexical",
    async judge(questions) {
      return questions.map((question) => ({
        evidenceRefId: question.evidenceRefId,
        supportProbability: lexicalOverlap(question.statement, question.quote),
      }));
    },
  };
}

function tokenize(text) {
  const lowered = text.toLowerCase();
  const words = lowered.match(/[a-z0-9]+/gu) ?? [];
  const cjk = lowered.match(/[一-鿿]/gu) ?? [];
  return new Set([...words, ...cjk]);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "and", "or", "in",
  "on", "at", "for", "that", "this", "it", "be", "by", "with", "as", "will",
]);

function lexicalOverlap(statement, quote) {
  const left = [...tokenize(statement)].filter((token) => !STOP_WORDS.has(token));
  if (!left.length) return 0.5;
  const right = tokenize(quote);
  const hit = left.filter((token) => right.has(token)).length;
  // 压到 0.05 到 0.95：一个只数词的规则没有资格给出确定的两端。
  return 0.05 + 0.9 * (hit / left.length);
}

/**
 * 决定这次用哪个判断方。
 *
 * 花钱的那一条路只有一个入口，而且 --yes 的检查就在它前面。--dry-run 走规则桩，
 * 不加 --yes 直接抛，免得哪天有人在别处顺手调了一下就把账单跑出来。
 */
export function resolveJudge(options, environment = {}) {
  if (options.dryRun) return lexicalStubJudge();
  if (!options.yes) {
    throw new Error("这一步要调用付费接口，加 --yes 才会真的发请求。");
  }
  const apiKey = environment.apiKey?.trim();
  if (!apiKey) throw new Error("JEV_API_KEY 没配，.env.local 里补上再跑。");
  const judge = createJevSupportJudge({
    apiKey,
    concurrency: options.concurrency,
    // 校准是离线活，慢一点没关系，不该因为超时丢样本。
    timeoutMs: 30_000,
  });
  if (!judge) throw new Error("判断方没建起来，检查 JEV_API_KEY。");
  return judge;
}

// ---------------------------------------------------------------------------
// 跑判断
// ---------------------------------------------------------------------------

/** 缓存键只吃内容的哈希，原文不落盘。 */
export function cacheKey(judgeName, sample) {
  return createHash("sha256")
    .update(`${judgeName} ${sample.statement} ${sample.quote}`)
    .digest("hex")
    .slice(0, 32);
}

export async function collectAnswers({
  judge,
  samples,
  chunkSize = 32,
  cache = new Map(),
  onProgress = () => {},
  onCheckpoint = async () => {},
}) {
  const answers = new Map();
  const pending = [];
  for (const sample of samples) {
    const key = cacheKey(judge.name, sample);
    const cached = cache.get(key);
    if (typeof cached === "number") answers.set(sample.evidenceRefId, cached);
    else pending.push(sample);
  }
  onProgress({ done: answers.size, total: samples.length, fromCache: answers.size });

  for (let index = 0; index < pending.length; index += chunkSize) {
    const chunk = pending.slice(index, index + chunkSize);
    const replies = await judge.judge(chunk.map(toQuestion));
    const byRef = new Map(chunk.map((sample) => [sample.evidenceRefId, sample]));
    for (const reply of replies) {
      const sample = byRef.get(reply.evidenceRefId);
      if (!sample) continue;
      answers.set(reply.evidenceRefId, reply.supportProbability);
      cache.set(cacheKey(judge.name, sample), reply.supportProbability);
    }
    await onCheckpoint(cache);
    onProgress({ done: answers.size, total: samples.length, fromCache: 0 });
  }
  return answers;
}

function toQuestion(sample) {
  return {
    claimId: sample.claimId,
    claimVersionId: sample.claimVersionId,
    evidenceRefId: sample.evidenceRefId,
    statement: sample.statement,
    quote: sample.quote,
    evidenceRole: sample.evidenceRole,
  };
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export function buildCalibration(samples, answers, thresholds = DEFAULT_JUDGE_GATES) {
  const answered = samples.filter((sample) => typeof answers.get(sample.evidenceRefId) === "number");
  const calibrationSamples = answered.map((sample) => ({
    predicted: answers.get(sample.evidenceRefId),
    actual: sample.actual,
  }));
  const report = calibrationReport(calibrationSamples);
  const { passed, gates } = judgeGates(report, thresholds);
  return {
    asked: samples.length,
    answered: answered.length,
    bySource: countBySource(answered),
    bySourceAsked: countBySource(samples),
    report,
    gates,
    passed,
    thresholds,
  };
}

/**
 * 一句话结论。不过就说清楚差在哪，不留给人自己去表里找。
 */
export function gateSentence(calibration) {
  const { report, gates, passed, thresholds } = calibration;
  if (passed) {
    return `判断方可以接进去了，四道门全过，样本 ${report.sampleCount} 条。`;
  }
  const sampleGate = gates.find((gate) => gate.name === "sample_size");
  if (sampleGate && !sampleGate.passed) {
    const missing = thresholds.minSamples - report.sampleCount;
    return `判断方还不能接进去：样本不够，还差 ${missing} 条，校准结论要等样本补齐才算数。`;
  }
  const failed = gates.filter((gate) => !gate.passed).map((gate) => {
    if (gate.name === "calibration_error") return `校准误差 ${round(gate.actual)} 超过 ${thresholds.maxExpectedCalibrationError}`;
    if (gate.name === "worst_bucket_gap") return `最差单桶偏差 ${round(gate.actual)} 超过 ${thresholds.maxBucketGap}`;
    if (gate.name === "accuracy") return `准确率 ${round(gate.actual)} 没到 ${thresholds.minAccuracy}`;
    return `${gate.name} 不过`;
  });
  return `判断方还不能接进去：${failed.join("；")}。`;
}

function round(value) {
  return Number(value).toFixed(3);
}

/** 本地日期。文档按跑的人那天归档，不按 UTC。 */
export function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 最差那一桶是不是薄到说明不了问题。
 *
 * 一个只有两三条样本的桶，实际比例只能是 0、0.5 或 1，偏差天然会很大，跟判断方
 * 准不准没什么关系。这种时候单独报一句，免得有人拿这个数去判判断方的死刑，
 * 而真正的问题是样本太少。
 */
export function thinWorstBucket(report) {
  if (!report.buckets.length) return null;
  const worst = report.buckets.reduce((left, right) => (right.gap > left.gap ? right : left));
  const thin = worst.count <= Math.max(5, Math.round(report.sampleCount * 0.05));
  return thin ? worst : null;
}

function thinBucketNote(report) {
  const worst = thinWorstBucket(report);
  if (!worst) return null;
  return `最差的那一桶（${worst.lower.toFixed(1)} 到 ${worst.upper.toFixed(1)}）只有 ${worst.count} 条样本，实际比例只能取到几个离散值，偏差大不说明判断方偏。等样本补到门槛以上再看这个数。`;
}

const SOURCE_LABELS = {
  verdict_confirm: "线上 确认",
  verdict_reject: "线上 否决（弱标注）",
  eval_positive: "评估集 正例",
  eval_negative: "评估集 负例",
};

/**
 * 报告里要列哪几种来源。
 *
 * 问过但一条都没取到的来源必须留着并显示 0。这次 127 条全来自评估集、线上一条
 * 人工标注都没有，是读这份结论的人最需要先知道的事，不能让它从表里消失。
 */
function shownSources(calibration, context) {
  const requested = new Set();
  if (context.from.includes("verdicts")) {
    requested.add("verdict_confirm");
    requested.add("verdict_reject");
  }
  if (context.from.includes("eval")) {
    requested.add("eval_positive");
    requested.add("eval_negative");
  }
  return LABEL_SOURCES.filter(
    (name) => requested.has(name) || calibration.bySource[name] || calibration.bySourceAsked[name],
  );
}

/** 中文按两格宽算，表格才不会错行。 */
function pad(value, width) {
  let used = 0;
  for (const char of String(value)) used += /[　-鿿＀-￯]/u.test(char) ? 2 : 1;
  return String(value) + " ".repeat(Math.max(1, width - used));
}

export function renderReport(calibration, context) {
  const { report, gates, bySource, asked, answered, thresholds } = calibration;
  const lines = [];
  lines.push(gateSentence(calibration));
  lines.push("");
  lines.push(`判断方 ${context.judgeName}${context.dryRun ? "（--dry-run，没有调用任何接口）" : ""}`);
  lines.push(`标注来源 ${context.from.join(" + ")}，取样 ${asked} 条，判断方回答 ${answered} 条`);
  lines.push("");
  lines.push("样本按标注来源");
  for (const name of shownSources(calibration, context)) {
    lines.push(`  ${pad(SOURCE_LABELS[name], 22)}${pad(bySource[name], 8)}条`);
  }
  lines.push("");
  lines.push(`准确率 ${round(report.accuracy)}`);
  lines.push(`校准误差 ECE ${round(report.expectedCalibrationError)}`);
  lines.push(`最差单桶偏差 ${round(report.maxBucketGap)}`);
  lines.push("");
  lines.push("分桶");
  lines.push(`  ${pad("区间", 14)}${pad("样本", 8)}${pad("说的", 10)}${pad("实际", 10)}偏差`);
  for (const bucket of report.buckets) {
    lines.push(`  ${pad(`${bucket.lower.toFixed(1)} - ${bucket.upper.toFixed(1)}`, 14)}${pad(bucket.count, 8)}${pad(round(bucket.meanPredicted), 10)}${pad(round(bucket.observedRate), 10)}${round(bucket.gap)}`);
  }
  if (!report.buckets.length) lines.push("  没有样本");
  const note = thinBucketNote(report);
  if (note) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push(`四道门（门槛 ${JSON.stringify(thresholds)}）`);
  for (const gate of gates) {
    const actual = gate.name === "sample_size" ? String(gate.actual) : round(gate.actual);
    lines.push(`  ${pad(gate.name, 20)}${pad(gate.passed ? "过" : "不过", 8)}实测 ${pad(actual, 10)}要求 ${gate.expected}`);
  }
  lines.push("");
  lines.push(gateSentence(calibration));
  return lines.join("\n");
}

export function renderMarkdown(calibration, context) {
  const { report, gates, bySource, asked, answered, thresholds } = calibration;
  const lines = [];
  lines.push(`# ${context.date} 引用支持度判断方校准`);
  lines.push("");
  lines.push(gateSentence(calibration));
  lines.push("");
  lines.push(`判断方 \`${context.judgeName}\`。${context.dryRun ? "这是一次 `--dry-run`：判断方是一个只数词面重合度的规则桩，没有调用任何接口，下面的数字是那个桩的成绩，不是 Jev 的成绩。" : "这是一次真实调用。"}`);
  lines.push("");
  lines.push(`标注来源 \`${context.from.join(" + ")}\`，取样 ${asked} 条，判断方回答 ${answered} 条。`);
  lines.push("");
  lines.push("## 样本");
  lines.push("");
  lines.push("| 标注来源 | 条数 | 这是什么 |");
  lines.push("| --- | ---: | --- |");
  const notes = {
    verdict_confirm: "人确认过这条记录，等于确认了它的引用。硬标注。",
    verdict_reject: "人否了这条记录。多半是引用撑不住，但也可能是别的原因，所以只是弱证据。",
    eval_positive: "评估集里标好的 fully_supports 引用。",
    eval_negative: "评估集的负控制项，那句话不该从这条原话里推出来。",
  };
  for (const name of shownSources(calibration, context)) {
    lines.push(`| ${SOURCE_LABELS[name]} | ${bySource[name]} | ${notes[name]} |`);
  }
  lines.push("");
  lines.push("## 校准");
  lines.push("");
  lines.push(`准确率 ${round(report.accuracy)}，校准误差 ECE ${round(report.expectedCalibrationError)}，最差单桶偏差 ${round(report.maxBucketGap)}。`);
  lines.push("");
  lines.push("| 区间 | 样本 | 说的 | 实际 | 偏差 |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const bucket of report.buckets) {
    lines.push(`| ${bucket.lower.toFixed(1)} - ${bucket.upper.toFixed(1)} | ${bucket.count} | ${round(bucket.meanPredicted)} | ${round(bucket.observedRate)} | ${round(bucket.gap)} |`);
  }
  if (!report.buckets.length) lines.push("| 没有样本 | 0 | 0.000 | 0.000 | 0.000 |");
  const note = thinBucketNote(report);
  if (note) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push("## 四道门");
  lines.push("");
  lines.push("互不补偿，任何一道不过就不接。");
  lines.push("");
  lines.push("| 门 | 结果 | 实测 | 要求 |");
  lines.push("| --- | --- | ---: | --- |");
  for (const gate of gates) {
    const actual = gate.name === "sample_size" ? String(gate.actual) : round(gate.actual);
    lines.push(`| ${gate.name} | ${gate.passed ? "过" : "不过"} | ${actual} | ${gate.expected} |`);
  }
  lines.push("");
  lines.push(`门槛取自 \`lib/domain/judge-calibration.ts\` 的 \`DEFAULT_JUDGE_GATES\`：样本 >= ${thresholds.minSamples}，ECE <= ${thresholds.maxExpectedCalibrationError}，最差单桶偏差 <= ${thresholds.maxBucketGap}，准确率 >= ${thresholds.minAccuracy}。`);
  lines.push("");
  lines.push("## 结论");
  lines.push("");
  lines.push(gateSentence(calibration));
  lines.push("");
  lines.push("这份文档只有聚合数字，没有任何陈述原文、引用原话或客户信息。");
  lines.push("");
  return lines.join("\n");
}
