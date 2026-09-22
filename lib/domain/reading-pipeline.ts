/**
 * 阅读产物的工作流。
 *
 * 此前四个视图（全文概要、章节速览、发言总结、要点回顾）是同一次模型调用的
 * 四个必填字段，一处契约违规四样全灭，线上出现过。而且四样都各自通读一遍
 * 11 万 token 的原文，产出之间不互相利用。
 *
 * 重排后章节是脊椎：它是唯一必须通读全文的一步，其余挂在它后面。
 *
 *   逐字稿 ──→ 易读版（独立，只服务阅读，可关）
 *   逐字稿 ──┬─→ 章节速览 ─┐
 *            ├─→ 发言总结 ─┼─→ 全文概要
 *            └─→ 要点回顾 ─┘
 *   三个各读一遍原文，同一波并行；概要只吃它们三个的产出。
 *
 * 这样做省的是输入：全文概要只吃上面三个产物（几千 token），不再吃 88k 原文；
 * 发言总结和要点回顾拿着章节当目录，可以按章取材而不是整篇重读。
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
  // 易读版只依赖原始分段，分块生成后合并。
  { kind: "readable_transcript", dependsOn: [], degradesWithoutDependencies: true, readsFullTranscript: true },
  // 脊椎。读原文，和易读版并行：provider 给章节喂的是原始分段，从没用过
  // 易读版，之前挂在它后面只是白等易读稿那几分钟（七块两批，三万多 token）。
  { kind: "chapters", dependsOn: [], degradesWithoutDependencies: true, readsFullTranscript: true },
  // 和章节同一波并行。章节已经出来就拿它当目录，没出来就整篇读，不等。
  { kind: "speakers", dependsOn: [], optionalUpstream: ["chapters"], degradesWithoutDependencies: true, readsFullTranscript: true },
  { kind: "key_points", dependsOn: [], optionalUpstream: ["chapters"], degradesWithoutDependencies: true, readsFullTranscript: true },
  // 只吃上面三个的产物，不读原文。上游一个都没有就没得写。
  { kind: "overview", dependsOn: ["chapters", "speakers", "key_points"], degradesWithoutDependencies: false, readsFullTranscript: false },
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
