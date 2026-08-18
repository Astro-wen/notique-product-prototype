export type ChunkProgressStatus = "completed" | "processing" | "queued" | "failed";

export type ChunkProgressNode = {
  index: number;
  status: ChunkProgressStatus;
};

export type ChunkProgressModel = {
  total: number;
  completed: number;
  remaining: number;
  percent: number;
  nodes: ChunkProgressNode[];
};

type ChunkStatusInput = {
  index: number;
  status: string;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedChunkStatus(status: string): ChunkProgressStatus {
  if (status === "succeeded") return "completed";
  if (status === "processing") return "processing";
  if (status === "failed") return "failed";
  return "queued";
}

export function buildChunkProgress(input: {
  total: number;
  completed: number;
  chunks?: ChunkStatusInput[];
  currentIndex?: number;
  currentFraction?: number;
}): ChunkProgressModel {
  const total = Math.max(0, Math.floor(input.total));
  const completed = clamp(Math.floor(input.completed), 0, total);
  const knownStatuses = new Map(
    (input.chunks ?? [])
      .filter((chunk) => Number.isInteger(chunk.index) && chunk.index >= 0 && chunk.index < total)
      .map((chunk) => [chunk.index, normalizedChunkStatus(chunk.status)] as const),
  );
  const nodes = Array.from({ length: total }, (_, index): ChunkProgressNode => ({
    index,
    status: knownStatuses.get(index)
      ?? (index < completed
        ? "completed"
        : index === input.currentIndex
          ? "processing"
          : "queued"),
  }));

  // The aggregate completed count is the server contract. If a response has
  // not yet populated every child row, still paint exactly that many nodes as
  // complete instead of showing an apparent regression.
  let paintedCompleted = nodes.filter((node) => node.status === "completed").length;
  for (const node of nodes) {
    if (paintedCompleted >= completed) break;
    if (node.status !== "queued") continue;
    node.status = "completed";
    paintedCompleted += 1;
  }

  const partial = clamp(input.currentFraction ?? 0, 0, 1);
  const percent = total > 0
    ? clamp(Math.floor(((completed + partial) / total) * 100), 0, 100)
    : 0;
  return {
    total,
    completed,
    remaining: Math.max(0, total - completed),
    percent,
    nodes,
  };
}
