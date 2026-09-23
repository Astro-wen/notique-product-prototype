/**
 * 第三层：材料读完之后，判断它属于哪个已有项目。
 *
 * 粒度只到项目，永远不到文件夹。文件夹是用户自己起的分类，系统猜错文件夹比猜错
 * 项目更冒犯，而且这个产品里文件夹本来就不是材料的归属单位。
 *
 * 这一层只产出「建议」，不搬任何东西。过不了阈值就一声不吭，这是默认结果而不是
 * 异常结果：大多数材料本来就属于它刚落进去的那个项目。
 *
 * 这个文件是纯的：只负责拼问题和读答案，不认识 Jev，也不落库。
 */

/** 没有任何已有项目匹配时的选项。Jev 必须有一个「都不是」可选，否则它一定会挑一个。 */
export const NO_MATCH_OPTION = "none";

/** 默认阈值。低于它就沉默：一条错的建议比没有建议更贵。 */
export const DEFAULT_ROUTING_THRESHOLD = 0.8;

/** 最多送进去这么多候选项目，按最近更新取。 */
export const MAX_ROUTING_CANDIDATES = 30;

/** 单个项目的概要摘录上限。超过这个长度对判断没有增量，只在烧 token。 */
const MAX_EXCERPT_CHARS = 220;
/** 本次材料概要的上限。 */
const MAX_OVERVIEW_CHARS = 1_200;
/** 章节标题只当目录用，取前若干条即可。 */
const MAX_CHAPTER_TITLES = 20;
const MAX_CHAPTER_TITLE_CHARS = 60;

export type RoutingCandidateInput = {
  id: string;
  name: string;
  folderName?: string | null;
  scenarioLabel?: string | null;
  lastOverviewExcerpt?: string | null;
  updatedAt?: string | null;
};

export type RoutingCandidate = {
  id: string;
  name: string;
  folderName: string | null;
  scenarioLabel: string | null;
  lastOverviewExcerpt: string | null;
};

export type RoutingMaterial = {
  overview: string;
  chapterTitles: readonly string[];
};

export type RoutingQuestion = {
  state: Record<string, unknown>;
  /** 选项 id 到评判说明的映射，直接就是 Jev choice 的 criteria。 */
  criteria: Record<string, string>;
  instructions: string;
  candidateIds: string[];
};

export type RoutingAnswer = {
  /** 选中的项目 id；null 表示「都不是」。 */
  projectId: string | null;
  probability: number;
};

export type RoutingDecision =
  | { kind: "suggest"; projectId: string; probability: number }
  | { kind: "silent" };

function clip(value: string | null | undefined, limit: number): string {
  const text = (value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 名字只是一个时间戳的项目。
 *
 * 新建项目时系统给的占位名形如「新项目 9/21 15:14」。这种名字里没有任何关于
 * 内容的信息，把它放进候选只会让判断方在一堆无法区分的选项之间瞎猜，而且这类
 * 项目往往正是上一份材料随手落下的空壳。直接排除，比让判断方自己识别可靠。
 */
export function isTimestampProjectName(name: string): boolean {
  const stripped = name
    .replace(/^\[SYNTHETIC\]\s*/u, "")
    .replace(/新项目|新建项目|未命名项目|未命名|新记录|上午|下午/gu, "")
    // 上下午标记只在整词位置去掉。放进字符类会把 Pam、Sam 这样的人名也吃光。
    .replace(/\b(?:am|pm)\b/giu, "")
    // 数字、日期时间分隔符、中文年月日时分秒。
    .replace(/[0-9\s/:\-.年月日时分秒点]/gu, "")
    .trim();
  return stripped.length === 0;
}

/**
 * 候选集合：同工作空间里的其他项目，去掉时间戳名，按最近更新截断。
 *
 * 截断放在这里而不是 SQL 里，是为了让「排除了谁、为什么」可测。
 */
export function routingCandidates(
  projects: readonly RoutingCandidateInput[],
  limit: number = MAX_ROUTING_CANDIDATES,
): RoutingCandidate[] {
  const cap = Math.max(0, Math.floor(limit));
  return [...projects]
    .filter((project) => project.name.trim() && !isTimestampProjectName(project.name))
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt ?? "");
      const bt = Date.parse(b.updatedAt ?? "");
      const av = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
      const bv = Number.isFinite(bt) ? bt : Number.NEGATIVE_INFINITY;
      return (bv - av) || a.id.localeCompare(b.id);
    })
    .slice(0, cap)
    .map((project) => ({
      id: project.id,
      name: clip(project.name.replace(/^\[SYNTHETIC\]\s*/u, ""), 80),
      folderName: clip(project.folderName, 40) || null,
      scenarioLabel: clip(project.scenarioLabel, 40) || null,
      lastOverviewExcerpt: clip(project.lastOverviewExcerpt, MAX_EXCERPT_CHARS) || null,
    }));
}

/**
 * 拼出送给判断方的问题。
 *
 * state 里只放这份材料的概要和章节标题，加上候选项目的名字与一小段既往概要。
 * 不送逐字稿：判断「属于谁」靠的是人名、地址、金额这些在概要里已经出现的锚点，
 * 送全文只会把上下文挤爆（单问题上限 32k），并不会更准。
 */
export function buildRoutingQuestion(
  material: RoutingMaterial,
  candidates: readonly RoutingCandidate[],
): RoutingQuestion {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    const parts = [
      `Project name: ${candidate.name}`,
      candidate.folderName ? `Folder: ${candidate.folderName}` : "",
      candidate.scenarioLabel ? `Scenario: ${candidate.scenarioLabel}` : "",
      candidate.lastOverviewExcerpt ? `Earlier material: ${candidate.lastOverviewExcerpt}` : "",
    ].filter(Boolean);
    criteria[candidate.id] = parts.join(" | ");
  }
  // 「都不是」必须排在最后写入，但它是一个普通选项，不是兜底逻辑：
  // 判断方要能明确地选它，调用方才敢把沉默当作一个有效答案。
  criteria[NO_MATCH_OPTION] =
    "None of the listed projects. The new material is about a different client, property, or job than every project above.";

  return {
    state: {
      new_material_overview: clip(material.overview, MAX_OVERVIEW_CHARS),
      new_material_chapters: material.chapterTitles
        .slice(0, MAX_CHAPTER_TITLES)
        .map((title) => clip(title, MAX_CHAPTER_TITLE_CHARS))
        .filter(Boolean),
    },
    criteria,
    instructions: [
      "A new piece of material has just been transcribed and summarised.",
      "Decide which existing project it belongs to, judging only from the text given here.",
      "Two items belong together when they concern the same client, the same property or address, or the same job.",
      "A shared topic alone (both are about buying a house) is not enough.",
      `Answer ${NO_MATCH_OPTION} when no listed project matches.`,
    ].join(" "),
    candidateIds: candidates.map((candidate) => candidate.id),
  };
}

/** 粗略估算 state 的体量，用来守住 32k 的单问题上限。 */
export function routingQuestionCharacters(question: RoutingQuestion): number {
  return JSON.stringify(question.state).length
    + JSON.stringify(question.criteria).length
    + question.instructions.length;
}

/**
 * 从答案得出要不要出声。
 *
 * 只有明确选中某个项目、并且把握过了阈值，才给建议。选「都不是」、概率不够、
 * 概率不是有效数字，一律沉默。
 */
export function routingDecision(
  answer: RoutingAnswer | null | undefined,
  threshold: number = DEFAULT_ROUTING_THRESHOLD,
): RoutingDecision {
  if (!answer) return { kind: "silent" };
  const { projectId, probability } = answer;
  if (!projectId || projectId === NO_MATCH_OPTION) return { kind: "silent" };
  if (typeof probability !== "number" || !Number.isFinite(probability)) return { kind: "silent" };
  if (probability < threshold) return { kind: "silent" };
  return { kind: "suggest", projectId, probability };
}

/**
 * 把一份 overview 产物压成一段可比对的文字。
 *
 * overview 的结构是若干 section，每个 section 若干 item。判断方只需要里面的句子。
 */
export function overviewExcerpt(
  sections: ReadonlyArray<{ items?: ReadonlyArray<{ text?: string }> }> | null | undefined,
  limit: number = MAX_EXCERPT_CHARS,
): string {
  const sentences: string[] = [];
  for (const section of sections ?? []) {
    for (const item of section.items ?? []) {
      const text = (item.text ?? "").trim();
      if (text) sentences.push(text);
    }
  }
  return clip(sentences.join(" "), limit);
}
