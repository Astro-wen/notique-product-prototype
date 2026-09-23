export async function mapWithConcurrency<T, Result>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (items.length === 0) return [];
  const laneCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let failure: unknown;

  async function runLane(): Promise<void> {
    while (failure === undefined && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failure = error;
      }
    }
  }

  await Promise.all(Array.from({ length: laneCount }, () => runLane()));
  if (failure !== undefined) throw failure;
  return results;
}
