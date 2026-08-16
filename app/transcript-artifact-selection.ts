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

function sourceSegmentIds(artifact: EventAiArtifactRecord): string[] {
  if (!isRecord(artifact.content)) return [];
  const records = artifact.kind === "summary"
    ? (Array.isArray(artifact.content.sections) ? artifact.content.sections : [])
      .flatMap((section) => isRecord(section) && Array.isArray(section.items) ? section.items : [])
    : Array.isArray(artifact.content.segments)
      ? artifact.content.segments
      : [];
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
