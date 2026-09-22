/**
 * 分析途中项目上下文变了，怎么接着跑。
 *
 * 一次分析开始时钉住项目的上下文版本（已有的结论、词表）。途中有人确认了一条
 * 结论、删了一条记录、改了词表，版本就往前走了。模型是按旧上下文判重和找关系的，
 * 结果不能直接存，这一点不变。
 *
 * 以前的做法是直接判失败，要人手动重跑。确认结论和分析同时发生很常见，于是经常
 * 有一条分析莫名其妙失败。现在失败的同时自动另起一个新任务，用新上下文重跑，界面
 * 直接换到新任务上，不报错。开始调模型之前就发现变了的，新任务一分钱都不多花。
 *
 * 连续被打断时不无限重跑：同一条记录一小时内最多重起三次，之后按原来的失败处理。
 */

/** 旧任务的错误码。界面见到它就去找接班的新任务，而不是报错。 */
export const CONTEXT_CHANGED_RESTARTED = "CONTEXT_CHANGED_RESTARTED";

export const MAX_CONTEXT_RESTARTS_PER_HOUR = 3;

export function mayRestartAfterContextChange(restartsInLastHour: number): boolean {
  return Number.isFinite(restartsInLastHour) && restartsInLastHour < MAX_CONTEXT_RESTARTS_PER_HOUR;
}

/** 接班任务的幂等键。同一个旧任务无论被处理几次，都只会有一个接班。 */
export function contextRestartIdempotencyKey(failedRunId: string): string {
  return `context-restart:${failedRunId}`;
}
