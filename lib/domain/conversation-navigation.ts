type Conversation = { id: string; occurredAt?: string; createdAt?: string; uploadedAt?:string; title?:string };

export function conversationDisplayTitle(title:string):string {
  return title.replace(/(?:\s*[·|｜,，-]\s*)?(?:会议)?(?:日期|时间)待(?:核对|确认)/g,'').replace(/(?:\s*[·|｜-]\s*)?date\s+(?:unknown|pending)/gi,'').trim();
}

export function conversationUploadTime(event:Omit<Conversation,'id'>):number|null {
  for(const value of [event.uploadedAt,event.createdAt,event.occurredAt]) {
    const parsed=Date.parse(value ?? '');
    if(Number.isFinite(parsed))return parsed;
  }
  return null;
}

/** Display labels only. Stored titles and source identities remain unchanged. */
export function conversationLabels(events: readonly (Conversation & { title?: string })[]): Map<string, string> {
  const ordered = conversationOrder(events);
  const titles = ordered.map(event => conversationDisplayTitle(event.title ?? ''));
  const counts = new Map<string, number>();
  for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
  return new Map(ordered.map((event, index) => {
    const title = titles[index];
    const number = `对话 ${String(index + 1).padStart(2, '0')}`;
    const generic = !title || /^(?:第[一二三四五六七八九十百\d]+[条次段](?:记录|对话)|新(?:记录|对话)|未命名(?:记录|对话))$/.test(title);
    return [event.id, generic ? number : (counts.get(title) ?? 0) > 1 ? `${number} · ${title}` : title];
  }));
}

export function conversationOrder<T extends Conversation>(events: readonly T[]): T[] {
  return events.toSorted((a, b) => (conversationUploadTime(a) ?? 0) - (conversationUploadTime(b) ?? 0) || a.id.localeCompare(b.id));
}

export function conversationDate(event: Conversation): string {
  const time = conversationUploadTime(event);
  if (time === null) return '—';
  return new Date(time).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function conversationCaption(event:Conversation,label:string):string {
  const date=conversationDate(event);
  const title=conversationDisplayTitle(label);
  return title.startsWith(date) ? title : `${date} · ${title}`;
}
