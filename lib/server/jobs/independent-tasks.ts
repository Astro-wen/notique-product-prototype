/** Start every persisted lane before waiting. Each lane owns its lease,
 * checkpoint and retry policy, so a failed lane cannot cancel its siblings. */
export async function runIndependentTasks(
  tasks: Array<{ name: string; run: () => Promise<unknown> }>,
  onFailure: (name: string) => void = name => console.error('independent_task_failed', { task: name }),
): Promise<void> {
  await Promise.all(tasks.map(async task => {
    try { await task.run(); }
    catch { onFailure(task.name); }
  }));
}
