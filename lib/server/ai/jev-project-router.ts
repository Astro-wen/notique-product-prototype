// 与 jev-support-judge.ts 同一套写法：带扩展名的相对路径，这样这一层能在
// node --test 下直接跑真实的失败路径，而不是只靠源码断言。
import { mapWithConcurrency } from "../../domain/bounded-parallel.ts";
import {
  NO_MATCH_OPTION,
  buildRoutingQuestion,
  type RoutingAnswer,
  type RoutingCandidate,
  type RoutingMaterial,
} from "../../domain/project-routing.ts";

/**
 * TypeSafe Jev 作为「这份材料属于哪个项目」的判断方。
 *
 * 选 Jev 是因为这个问题的形状是挑一个：候选项目都已经在手上，需要的是一个带概率的
 * 选择，不是一段文字。Jev 的 choice 直接回 probabilities，阈值可以照着它卡。
 *
 * 这一层是咨询性的。没配密钥、超时、限流、服务不可用，一律返回 null，
 * 系统表现与今天完全一致：材料留在它落进去的项目里，界面上什么都不多。
 */

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 12_000;
/** 退路模式下每个候选一问，并发上限。 */
const JEV_CONCURRENCY = 6;

type JevChoiceAnswer = {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

type JevNoulAnswer = { type?: string; noul?: number };

type JevResponse = {
  answers?: Record<string, JevChoiceAnswer & JevNoulAnswer>;
};

export type JevProjectRouterConfig = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  concurrency?: number;
  /** 直接走每候选一问的退路，供冒烟脚本对比两种模式。 */
  forceNoulFallback?: boolean;
};

export type ProjectRouterJudge = {
  name: string;
  route(
    material: RoutingMaterial,
    candidates: readonly RoutingCandidate[],
  ): Promise<RoutingAnswer | null>;
};

export function createJevProjectRouter(config: JevProjectRouterConfig): ProjectRouterJudge | null {
  const apiKey = config.apiKey?.trim();
  // 没配就没有判断方。调用方拿到 null 之后什么都不做，不是错误路径。
  if (!apiKey) return null;

  const options = {
    apiKey,
    endpoint: config.endpoint?.trim() || JEV_ENDPOINT,
    model: config.model?.trim() || JEV_MODEL,
    timeoutMs: config.timeoutMs ?? JEV_TIMEOUT_MS,
    concurrency: config.concurrency ?? JEV_CONCURRENCY,
  };

  return {
    name: "jev",
    async route(material, candidates) {
      if (!candidates.length) return null;
      try {
        if (!config.forceNoulFallback) {
          const chosen = await askChoice(material, candidates, options);
          if (chosen) return chosen;
        }
        // choice 不可用（形状对不上、被拒、超时）时退到每候选一问取最大值。
        // 退路更贵，但它只在 choice 失败时跑，不是常态。
        return await askEachCandidate(material, candidates, options);
      } catch {
        return null;
      }
    },
  };
}

type AskOptions = {
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  concurrency: number;
};

async function post(body: unknown, options: AskOptions): Promise<JevResponse | null> {
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
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return await response.json() as JevResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一次 choice：选项就是候选项目 id，外加一个 none。
 *
 * 用一问而不是每候选一问，除了便宜，还因为 choice 的概率是在所有选项之间归一化的。
 * 「A 有 0.9」在 choice 里意味着它同时压过了 B 和 none；每候选一问的 0.9 只说明
 * 单看 A 像，两个候选同时给 0.9 是常事，那种分布卡阈值会一起放行。
 */
async function askChoice(
  material: RoutingMaterial,
  candidates: readonly RoutingCandidate[],
  options: AskOptions,
): Promise<RoutingAnswer | null> {
  const question = buildRoutingQuestion(material, candidates);
  const body = await post({
    model: options.model,
    state: question.state,
    questions: {
      belongs_to: {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  }, options);
  const answer = body?.answers?.belongs_to;
  if (!answer || answer.type !== "choice") return null;
  const choice = answer.choice;
  if (typeof choice !== "string") return null;
  if (choice === NO_MATCH_OPTION) return { projectId: null, probability: probabilityOf(answer, choice) };
  // 回了一个不在候选里的 id 就当没回。判断方编出来的 id 不能落库。
  if (!question.candidateIds.includes(choice)) return null;
  return { projectId: choice, probability: probabilityOf(answer, choice) };
}

function probabilityOf(answer: JevChoiceAnswer, choice: string): number {
  const value = answer.probabilities?.[choice];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // 没给分布时退到 confidence；两个都没有就当 0，由阈值把它拦下。
  const confidence = answer.confidence;
  return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0;
}

/**
 * 退路：每个候选一条 noul，取最大。
 *
 * 这条路没有归一化，所以同一份材料对两个候选都可能给出高分。取最大值之后仍然只
 * 交给 routingDecision 卡阈值，不在这里加额外的判断。
 */
async function askEachCandidate(
  material: RoutingMaterial,
  candidates: readonly RoutingCandidate[],
  options: AskOptions,
): Promise<RoutingAnswer | null> {
  const question = buildRoutingQuestion(material, candidates);
  const scored = await mapWithConcurrency(candidates, options.concurrency, async (candidate) => {
    const body = await post({
      model: options.model,
      state: {
        ...question.state,
        candidate_project: question.criteria[candidate.id],
      },
      questions: {
        belongs: {
          type: "noul",
          instructions:
            "Does the new material belong to the candidate project? Judge only from the text given here.",
          criteria: {
            true: "They concern the same client, the same property or address, or the same job.",
            false:
              "They concern different clients, properties, or jobs. A shared topic alone is not enough.",
          },
        },
      },
    }, options);
    const noul = body?.answers?.belongs?.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul)) return null;
    return { projectId: candidate.id, probability: noul };
  });

  let best: RoutingAnswer | null = null;
  for (const item of scored) {
    if (!item) continue;
    if (!best || item.probability > best.probability) best = item;
  }
  return best;
}
