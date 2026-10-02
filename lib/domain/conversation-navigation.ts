type Conversation = { id: string; occurredAt?: string; createdAt?: string };

function conversationTime(event: Conversation): number | null {
  for (const value of [event.occurredAt, event.createdAt]) {
    const parsed = Date.parse(value ?? '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function conversationOrder<T extends Conversation>(events: readonly T[]): T[] {
  return events.toSorted((a, b) => (conversationTime(a) ?? 0) - (conversationTime(b) ?? 0) || a.id.localeCompare(b.id));
}

export function conversationDate(event: Conversation): string {
  const time = conversationTime(event);
  if (time === null) return '日期未设置';
  return new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
