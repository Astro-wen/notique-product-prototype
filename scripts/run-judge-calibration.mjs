#!/usr/bin/env node

/**
 * 跑一遍引用支持度判断方的校准，给出它能不能接进主链路的结论。
 *
 * jev-support-judge.ts 早就能跑通，但一直没接，因为 judge-calibration.ts 的四道门
 * 从来没人量过：没有标注数据的来路。这个脚本把来路补上，量完，把结论写进 docs。
 *
 * 用法：
 *   npm run judge:calibrate -- --dry-run
 *   npm run judge:calibrate -- --from=verdicts,eval --limit=40 --yes
 *
 * 不加 --yes 只打印预估成本，一个请求都不会发。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  buildCalibration,
  collectAnswers,
  dedupe,
  estimateCostUsd,
  findLocalDatabase,
  loadEvalSamples,
  loadVerdictRows,
  localDate,
  parseArgs,
  renderMarkdown,
  renderReport,
  resolveJudge,
  stratify,
  usage,
  verdictSamples,
} from "./lib/judge-calibration-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const CACHE_PATH = join(root, "work", "judge-calibration", "answers.json");

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

async function readApiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  try {
    return parseEnv(await readFile(join(root, ".env.local"), "utf8")).JEV_API_KEY ?? "";
  } catch {
    return "";
  }
}

async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

async function writeCache(cache) {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`, "utf8");
}

async function collectSamples(options) {
  const samples = [];
  const notes = [];
  if (options.from.includes("verdicts")) {
    const databasePath = options.databasePath
      ? resolve(options.databasePath)
      : await findLocalDatabase(root);
    if (!databasePath) {
      notes.push("本地 D1 没找到，verdicts 这一路取到 0 条。先跑 npm run db:migrate:local。");
    } else {
      const rows = loadVerdictRows(databasePath);
      const fromVerdicts = verdictSamples(rows);
      samples.push(...fromVerdicts);
      notes.push(`本地 D1 ${databasePath.replace(`${root}/`, "")}：裁决行 ${rows.length} 条，化出样本 ${fromVerdicts.length} 条。`);
    }
  }
  if (options.from.includes("eval")) {
    const fromEval = await loadEvalSamples(root);
    samples.push(...fromEval);
    notes.push(`离线评估集：样本 ${fromEval.length} 条。`);
  }
  return { samples: dedupe(samples), notes };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { samples: all, notes } = await collectSamples(options);
  for (const note of notes) process.stdout.write(`${note}\n`);
  const samples = stratify(all, options.limit);
  process.stdout.write(`可用样本 ${all.length} 条，本次取 ${samples.length} 条。\n`);

  // 先说要花多少钱，再问要不要花。
  const cost = options.dryRun ? 0 : estimateCostUsd(samples.length);
  process.stdout.write(
    options.dryRun
      ? "预估花费 $0.00：--dry-run 不调接口。\n"
      : `预估花费 $${cost.toFixed(2)}（${samples.length} 条，按每条 $0.001 估，只看量级）。\n`,
  );
  if (!options.dryRun && !options.yes) {
    process.stdout.write("没加 --yes，到此为止，一个请求都没发。确认要花这笔钱就重跑并加上 --yes。\n");
    return;
  }

  const judge = resolveJudge(options, { apiKey: await readApiKey() });
  const cache = options.dryRun ? new Map() : await readCache();
  const answers = await collectAnswers({
    judge,
    samples,
    chunkSize: Math.max(8, options.concurrency * 4),
    cache,
    onCheckpoint: options.dryRun ? async () => {} : writeCache,
    onProgress: ({ done, total, fromCache }) => {
      if (fromCache) process.stdout.write(`缓存里已有 ${fromCache} 条，接着跑剩下的。\n`);
      else process.stdout.write(`已判断 ${done}/${total}\n`);
    },
  });

  const calibration = buildCalibration(samples, answers);
  const context = {
    judgeName: judge.name,
    dryRun: options.dryRun,
    from: options.from,
    date: localDate(),
  };
  process.stdout.write(`\n${renderReport(calibration, context)}\n`);

  if (!options.write) return;
  const outputPath = options.output
    ? resolve(options.output)
    : join(root, "docs", "judge-calibration", `${context.date}${options.dryRun ? "-dry-run" : ""}.md`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderMarkdown(calibration, context), "utf8");
  process.stdout.write(`\n结论写到 ${outputPath.replace(`${root}/`, "")}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "校准没跑起来。"}\n`);
  process.exitCode = 1;
}
