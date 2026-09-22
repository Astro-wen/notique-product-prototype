import type {
  EventAiArtifactKind,
  EventAiArtifactRecord,
  EventAiArtifactRunRecord,
} from "@/lib/shared/api-types";

type ArtifactPair = {
  run: EventAiArtifactRunRecord | null;
  artifact: EventAiArtifactRecord | null;
  legacyFallback: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 一份产物引用了哪些原文段落。
 *
 * 引用分散在每种产物各自的集合里：易读稿在 segments，章节在 chapters，
 * 发言总结在 speaker_summaries，要点在 key_points，概要和旧 summary 在
 * sections[].items。这里曾只认 summary 和 segments 两种形状，四个阅读视图
 * 拆出来之后没跟上，于是章节、发言总结、要点回顾在库里明明成功了，前端
 * 却算出零引用，被当成不属于当前原文而过滤掉，界面退回兜底章节。
 * 按 kind 分支不如把所有已知集合都收进来：形状再变也不会漏。
 */
function sourceSegmentIds(artifact: EventAiArtifactRecord): string[] {
  if (!isRecord(artifact.content)) return [];
  const content = artifact.content;
  const records = [
    ...(Array.isArray(content.sections) ? content.sections : [])
      .flatMap((section) => isRecord(section) && Array.isArray(section.items) ? section.items : []),
    ...[content.key_points, content.speaker_summaries, content.chapters, content.segments]
      .flatMap((items) => Array.isArray(items) ? items : []),
  ];
  return records.flatMap((record) => {
    if (!isRecord(record) || !Array.isArray(record.source_segment_ids)) return [];
    return record.source_segment_ids.filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
  });
}

function artifactBelongsToRawTranscript(
  artifact: EventAiArtifactRecord,
  rawSegmentIds: ReadonlySet<string>,
): boolean {
  const sourceIds = sourceSegmentIds(artifact);
  return sourceIds.length > 0 && sourceIds.every((id) => rawSegmentIds.has(id));
}

/**
 * Pairs one reading Artifact with the newest Run of the same kind.
 * A stale Artifact must never appear under a newly queued/processing Run.
 * Projects predating Artifact Runs may use a source-safe legacy fallback.
 */
export function selectTranscriptArtifactPair(input: {
  runs: readonly EventAiArtifactRunRecord[];
  artifacts: readonly EventAiArtifactRecord[];
  kind: EventAiArtifactKind;
  rawSegmentIds: ReadonlySet<string>;
}): ArtifactPair {
  const run = input.runs
    .filter((candidate) => candidate.kind === input.kind)
    .reduce<EventAiArtifactRunRecord | null>((latest, candidate) => {
      if (!latest) return candidate;
      const timeOrder = candidate.created_at.localeCompare(latest.created_at);
      if (timeOrder !== 0) return timeOrder > 0 ? candidate : latest;
      // attempt_no is mutable retry state, not creation identity. IDs provide
      // a deterministic tie-breaker when storage timestamps have equal
      // precision without letting a later status update reorder the Runs.
      return candidate.id.localeCompare(latest.id) > 0 ? candidate : latest;
    }, null);
  const eligibleArtifacts = input.artifacts.filter((candidate) =>
    candidate.kind === input.kind
    && artifactBelongsToRawTranscript(candidate, input.rawSegmentIds))
    .sort((left, right) =>
      right.artifact_version - left.artifact_version
      || right.created_at.localeCompare(left.created_at));
  if (run) {
    return {
      run,
      artifact: eligibleArtifacts.find((candidate) => candidate.run_id === run.id) ?? null,
      legacyFallback: false,
    };
  }
  return {
    run: null,
    artifact: eligibleArtifacts[0] ?? null,
    legacyFallback: eligibleArtifacts.length > 0,
  };
}
