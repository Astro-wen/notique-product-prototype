// 用带扩展名的相对路径（与 lib/domain 内部一致），这样这一层能在
// node --test 下直接跑真实的失败路径，而不是只靠源码断言。
import { mapWithConcurrency } from "../../domain/bounded-parallel.ts";
import type {
  JudgeAnswer,
  SupportJudge,
  SupportQuestion,
} from "../../domain/support-judge.ts";

/**
 * TypeSafe Jev 作为引用支持度的判断方。
 *
 * Jev 只回判断不生成文字，正好是这个问题的形状：陈述和原话都已经在手上，
 * 只问「这段原话支不支持这句陈述」。它不需要读全文，也不需要提取任何东西。
 *
 * 这一层是咨询性的，不进主链路的成功条件。没配密钥、超时、限流、服务不可用，
 * 一律返回空，系统表现与今天完全一致（见 support-judge.ts 的 decisionsFrom）。
 * 所以接它不会多一个故障面。
 */

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
/** 一条判断只看一对陈述和原话，几百 token，远在 32k 的单问题上限之内。 */
const JEV_CONCURRENCY = 8;
const JEV_TIMEOUT_MS = 5_000;

type JevResponse = {
  answers?: Record<string, { type?: string; noul?: number }>;
};

export type JevJudgeConfig = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  concurrency?: number;
};

export function createJevSupportJudge(config: JevJudgeConfig): SupportJudge | null {
  const apiKey = config.apiKey?.trim();
  // 没配就没有判断方。调用方拿到 null 之后什么都不做，不是错误路径。
  if (!apiKey) return null;

  const endpoint = config.endpoint?.trim() || JEV_ENDPOINT;
  const model = config.model?.trim() || JEV_MODEL;
  const timeoutMs = config.timeoutMs ?? JEV_TIMEOUT_MS;
  const concurrency = config.concurrency ?? JEV_CONCURRENCY;

  return {
    name: "jev",
    async judge(questions: SupportQuestion[]): Promise<JudgeAnswer[]> {
      if (!questions.length) return [];
      const answers = await mapWithConcurrency(questions, concurrency, async (question) => {
        try {
          return await askOne(question, { apiKey, endpoint, model, timeoutMs });
        } catch {
          // 单条失败只丢这一条，不牵连其余，也不向上抛。
          return null;
        }
      });
      return answers.filter((answer): answer is JudgeAnswer => Boolean(answer));
    },
  };
}

async function askOne(
  question: SupportQuestion,
  options: { apiKey: string; endpoint: string; model: string; timeoutMs: number },
): Promise<JudgeAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        // state 只给这一对，不给全文。判断方看不到的东西就不会拿来发挥。
        state: {
          statement: question.statement,
          quoted_source_line: question.quote,
        },
        questions: {
          supports: {
            type: "noul",
            instructions:
              "Does the quoted source line support the statement? Judge only from the quoted line; do not use outside knowledge.",
            criteria: {
              true: "The quoted line states the statement, or the statement follows directly from it.",
              false:
                "The quoted line does not state it, contradicts it, or only touches a related topic without establishing it.",
            },
          },
        },
      }),
    });
    if (!response.ok) return null;
    const body = await response.json() as JevResponse;
    const noul = body.answers?.supports?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul)) return null;
    return { evidenceRefId: question.evidenceRefId, supportProbability: noul };
  } finally {
    clearTimeout(timer);
  }
}
