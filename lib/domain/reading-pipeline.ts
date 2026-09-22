/**
 * 阅读产物的工作流。
 *
 * 此前四个视图（全文概要、章节速览、发言总结、要点回顾）是同一次模型调用的
 * 四个必填字段，一处契约违规四样全灭，线上出现过。拆开以后又一度排成先后
 * 几跳：章节先出，概要等另外三样出完才动，用户只能干等。
 *
 * 现在的顺序只有一句话：录音转成逐字稿，四个 agent 同时开工，各读一遍原文。
 *
 *   逐字稿 ──┬─→ 章节速览
 *            ├─→ 发言总结（章节已出就拿来当目录，没出不等）
 *            ├─→ 要点回顾（同上）
 *            └─→ 全文概要
 *
 * 易读逐字稿已经删掉：它只是给原稿加标点，一次要吐五到七万 token，却不进
 * 任何后续步骤，阅读区一直直接显示原文。
 *
 * 每个产物的身份是它的输入内容（见 ensureEventAiArtifactRuns 的幂等键），
 * 所以重试抽取不会让任何一个重新生产。
 */

export type ReadingArtifactKind =
  | "readable_transcript"
  | "chapters"
  | "speakers"
  | "key_points"
  | "overview";

/**
 * 旧产物。不再生产，但历史记录里有，前端仍要能读出四个视图。
 */
export const LEGACY_SUMMARY_KIND = "summary" as const;

export type EventAiArtifactKindWithLegacy = ReadingArtifactKind | typeof LEGACY_SUMMARY_KIND;

export type ReadingArtifactDefinition = {
  kind: ReadingArtifactKind;
  /** 必须先成功的产物。空表示只依赖逐字稿本身。 */
  dependsOn: readonly ReadingArtifactKind[];
  /**
   * 有就用、没有不等的上游。发言总结和要点回顾拿章节当目录能按章取材，
   * 但章节没出来它们照样能整篇读；把章节列成硬依赖只是让它们干等一分钟。
   */
  optionalUpstream?: readonly ReadingArtifactKind[];
  /**
   * 依赖失败时是否仍然开跑。
   *
   * true 表示这一步能在缺少上游时退化工作（章节没出来就自己读全文），
   * false 表示没有上游就无从谈起（全文概要不读原文，上游全没了就没得写）。
   */
  degradesWithoutDependencies: boolean;
  /** 是否需要把整份逐字稿送进上下文。决定这一步贵不贵。 */
  readsFullTranscript: boolean;
};

export const READING_ARTIFACT_DEFINITIONS: readonly ReadingArtifactDefinition[] = [
  { kind: "chapters", dependsOn: [], degradesWithoutDependencies: true, readsFullTranscript: true },
  { kind: "speakers", dependsOn: [], optionalUpstream: ["chapters"], degradesWithoutDependencies: true, readsFullTranscript: true },
  { kind: "key_points", dependsOn: [], optionalUpstream: ["chapters"], degradesWithoutDependencies: true, readsFullTranscript: true },
  { kind: "overview", dependsOn: [], degradesWithoutDependencies: true, readsFullTranscript: true },
];

const DEFINITION_BY_KIND = new Map(READING_ARTIFACT_DEFINITIONS.map((item) => [item.kind, item]));

export function readingArtifactDefinition(kind: ReadingArtifactKind): ReadingArtifactDefinition {
  const definition = DEFINITION_BY_KIND.get(kind);
  if (!definition) throw new Error(`Unknown reading artifact kind: ${kind}`);
  return definition;
}

export type DependencyStatus = "queued" | "processing" | "succeeded" | "failed" | "missing";

export type ReadinessDecision =
  /** 依赖齐了，可以开跑。 */
  | { state: "ready"; degraded: false }
  /** 依赖不会再来了，但这一步能退化着跑。 */
  | { state: "ready"; degraded: true; missing: ReadingArtifactKind[] }
  /** 依赖还在跑，等下一轮派发。 */
  | { state: "wait"; blockedBy: ReadingArtifactKind[] }
  /** 依赖全废且这一步离不开它们，直接标失败，不浪费一次调用。 */
  | { state: "abandon"; missing: ReadingArtifactKind[] };

/**
 * 派发前问一次：这个产物现在该不该跑。
 *
 * 上游还在排队或处理中就等，不要抢跑；上游终态失败而自己能退化，就带着
 * 缺失项开跑（并在产物上标出来）；自己离不开上游、上游又全没了，就直接
 * 放弃，省下这一次调用。
 */
export function readingArtifactReadiness(
  kind: ReadingArtifactKind,
  dependencyStatus: (dependency: ReadingArtifactKind) => DependencyStatus,
): ReadinessDecision {
  const definition = readingArtifactDefinition(kind);
  if (definition.dependsOn.length === 0) return { state: "ready", degraded: false };

  const pending: ReadingArtifactKind[] = [];
  const unavailable: ReadingArtifactKind[] = [];
  for (const dependency of definition.dependsOn) {
    const status = dependencyStatus(dependency);
    if (status === "queued" || status === "processing") pending.push(dependency);
    else if (status !== "succeeded") unavailable.push(dependency);
  }

  if (pending.length) return { state: "wait", blockedBy: pending };
  if (!unavailable.length) return { state: "ready", degraded: false };
  if (definition.degradesWithoutDependencies) {
    return { state: "ready", degraded: true, missing: unavailable };
  }
  // 只要还有一个上游成功，不读原文的那一步仍然写得出东西，只是更薄。
  if (unavailable.length < definition.dependsOn.length) {
    return { state: "ready", degraded: true, missing: unavailable };
  }
  return { state: "abandon", missing: unavailable };
}

/**
 * 按依赖排出派发顺序。同一层之间没有先后，可以并行。
 */
export function readingArtifactWaves(): ReadingArtifactKind[][] {
  const waves: ReadingArtifactKind[][] = [];
  const placed = new Set<ReadingArtifactKind>();
  let remaining = READING_ARTIFACT_DEFINITIONS.map((item) => item.kind);
  while (remaining.length) {
    const wave = remaining.filter((kind) =>
      readingArtifactDefinition(kind).dependsOn.every((dependency) => placed.has(dependency)));
    if (!wave.length) throw new Error("Reading artifact dependencies contain a cycle.");
    wave.forEach((kind) => placed.add(kind));
    waves.push(wave);
    remaining = remaining.filter((kind) => !placed.has(kind));
  }
  return waves;
}

export type ReadingViewState = "ready" | "generating" | "failed";

/**
 * 一个阅读视图此刻该显示什么。
 *
 * 逐字稿一出来四个 agent 就同时开工，所以没内容时默认就是「内容生成中」，
 * 连任务还没取到页面上的那几秒也算。只有自己那条任务终态失败，才显示失败并
 * 允许按时间粗分章节。以前页面在取到任务之前就下了「没整理出章节」的结论，
 * 其实四个 agent 正在跑。
 *
 * 唯一的例外：分析已经结束、这条记录却一条阅读任务都没有，说明它不会再有了，
 * 算失败，不让转圈转个没完。
 */
export function readingViewState(input: {
  hasContent: boolean;
  runStatus: string | null | undefined;
  /** 这条记录一条阅读任务都没有，而且分析已经结束。 */
  noReadingWillCome: boolean;
}): ReadingViewState {
  if (input.hasContent) return "ready";
  if (input.runStatus === "failed" || input.runStatus === "succeeded") return "failed";
  if (input.runStatus === "queued" || input.runStatus === "processing") return "generating";
  return input.noReadingWillCome ? "failed" : "generating";
}
