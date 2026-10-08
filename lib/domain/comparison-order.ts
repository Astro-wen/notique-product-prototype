type ConversationDate = { occurredAt: string; title: string };

export function datePendingTitle(title:string):boolean {
  return /(?:日期|时间)待(?:核对|确认)|date\s+(?:unknown|pending)/i.test(title);
}

export function conversationTime(record?: ConversationDate): number | null {
  if (!record || datePendingTitle(record.title)) return null;
  const time=Date.parse(record.occurredAt);
  return Number.isFinite(time)?time:null;
}

/** Import timestamps cannot establish chronology for a date-pending record. */
export function comparisonOrder(before?: ConversationDate, after?: ConversationDate): 'forward' | 'reverse' | null {
  const left=conversationTime(before),right=conversationTime(after);
  if (left === null || right === null || left === right) return null;
  return left < right ? 'forward' : 'reverse';
}
