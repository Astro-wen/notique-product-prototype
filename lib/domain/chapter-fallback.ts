/**
 * 章节速览的确定性兜底。
 *
 * 模型生成的章节（event-ai-artifacts 的 summary 产物）三次失败就终止，界面只剩
 * "暂无"。通义听悟之所以"必出章节"，是因为它的分段是确定性模板，不依赖模型。
 * 这里补同样的底：不调模型，只按录音里已有的时间点和说话人轮换，把逐字稿粗切
 * 成几段，标题用时间区间，摘要用该段第一句原话。它不编内容，只是给读者一份
 * 能点着跳的目录，界面上要明确标出这是"按时间粗分"，不是 AI 章节。
 */

export type FallbackChapterSource = {
  id: string;
  text: string;
  speaker: string | null;
  start_ms: number | null;
  end_ms?: number | null;
  asset_version_id: string;
};

export type FallbackChapter = {
  title: string;
  summary: string;
  source_segment_ids: string[];
  /** 界面据此标注"按时间粗分"，并且不把它当成 AI 产物去核对。 */
  fallback: true;
};

export type FallbackChapterOptions = {
  /** 每段目标时长。到了这个长度后，遇到说话人切换或停顿就断开。 */
  targetMs?: number;
  /** 超过这个停顿一定断开，不管当前段多长。 */
  hardPauseMs?: number;
  /** 最多切几段；再长的录音也不会给读者一份 40 行的目录。 */
  maxChapters?: number;
};

const DEFAULTS: Required<FallbackChapterOptions> = {
  targetMs: 5 * 60_000,
  hardPauseMs: 90_000,
  maxChapters: 12,
};

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function firstSentence(text: string, max = 60): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const cut = trimmed.split(/(?<=[。！？!?；;])/)[0] ?? trimmed;
  return cut.length > max ? `${cut.slice(0, max)}…` : cut;
}

/**
 * 只对带时间点的分段切章；没有时间点的分段（纯文本导入的逐字稿）跟在前一段
 * 后面，不单独成章。多份录音各自成组，章节不会跨材料。
 */
export function fallbackChapters(
  segments: FallbackChapterSource[],
  options: FallbackChapterOptions = {},
): FallbackChapter[] {
  const { targetMs, hardPauseMs, maxChapters } = { ...DEFAULTS, ...options };
  const byAsset = new Map<string, FallbackChapterSource[]>();
  for (const segment of segments) {
    const list = byAsset.get(segment.asset_version_id) ?? [];
    list.push(segment);
    byAsset.set(segment.asset_version_id, list);
  }

  const chapters: FallbackChapter[] = [];
  for (const list of byAsset.values()) {
    const timed = list.filter((segment) => segment.start_ms != null);
    if (timed.length === 0) continue;
    // 服务端已按 start_ms 返回，但拖动排序、分块合并都可能打乱顺序，这里再排一次。
    // 没有时间点的分段借用它前面最近一个有时间点的分段的位置，跟着走，
    // 不会被甩到末尾单独成章。
    let carried = -1;
    const keyed = list.map((segment, index) => {
      if (segment.start_ms != null) carried = segment.start_ms;
      return { segment, key: segment.start_ms ?? carried, index };
    });
    keyed.sort((a, b) => a.key - b.key || a.index - b.index);
    const ordered = keyed.map((entry) => entry.segment);

    let current: FallbackChapterSource[] = [];
    let chapterStart = ordered[0]!.start_ms ?? 0;
    let previous: FallbackChapterSource | null = null;
    const groups: FallbackChapterSource[][] = [];

    for (const segment of ordered) {
      if (previous && segment.start_ms != null) {
        const previousEnd = previous.end_ms ?? previous.start_ms ?? segment.start_ms;
        const pause = segment.start_ms - previousEnd;
        const elapsed = segment.start_ms - chapterStart;
        const speakerChanged = segment.speaker !== previous.speaker;
        const softBreak = elapsed >= targetMs && (speakerChanged || pause >= 20_000);
        const hardBreak = pause >= hardPauseMs;
        if ((softBreak || hardBreak) && current.length) {
          groups.push(current);
          current = [];
          chapterStart = segment.start_ms;
        }
      }
      current.push(segment);
      previous = segment;
    }
    if (current.length) groups.push(current);

    // 段数超过上限就按比例合并相邻段，保证每段仍是连续的时间区间。
    while (groups.length > maxChapters) {
      let shortest = 0;
      for (let index = 1; index < groups.length; index += 1) {
        if (span(groups[index]!) < span(groups[shortest]!)) shortest = index;
      }
      const neighbor = shortest === 0 ? 1 : shortest - 1;
      const [lo, hi] = neighbor < shortest ? [neighbor, shortest] : [shortest, neighbor];
      groups.splice(lo, 2, [...groups[lo]!, ...groups[hi]!]);
    }

    for (const group of groups) {
      const timedInGroup = group.filter((segment) => segment.start_ms != null);
      const start = timedInGroup[0]?.start_ms ?? 0;
      const last = timedInGroup[timedInGroup.length - 1];
      const end = last?.end_ms ?? last?.start_ms ?? start;
      const speakers = [...new Set(group.map((segment) => segment.speaker).filter((value): value is string => Boolean(value)))];
      const lead = group.find((segment) => segment.text.trim())?.text ?? "";
      chapters.push({
        title: `${clock(start)}–${clock(end)}${speakers.length === 1 ? ` · ${speakers[0]}` : ""}`,
        summary: firstSentence(lead),
        source_segment_ids: group.map((segment) => segment.id),
        fallback: true,
      });
    }
  }
  return chapters;
}

function span(group: FallbackChapterSource[]): number {
  const timed = group.filter((segment) => segment.start_ms != null);
  if (timed.length === 0) return 0;
  const first = timed[0]!.start_ms ?? 0;
  const last = timed[timed.length - 1]!;
  return (last.end_ms ?? last.start_ms ?? first) - first;
}

/**
 * 什么时候用兜底：模型章节为空，而且不会再来了（失败，或根本没排作业而
 * 分析也没在跑）。作业还在跑时不用，免得两种章节前后闪一下。
 */
/**
 * 按时间粗分的章节只在章节任务真的失败后才顶上。还在生成时显示「内容生成中」，
 * 不拿粗分冒充结果。
 */
export function shouldUseFallbackChapters(input: {
  generatedCount: number;
  viewState: "ready" | "generating" | "failed";
  timedSegmentCount: number;
}): boolean {
  return input.generatedCount === 0 && input.timedSegmentCount > 0 && input.viewState === "failed";
}
