import type { ProjectTimelineEntry } from '../shared/workflow-v2.ts';

export function timelineLabel(entry: ProjectTimelineEntry): string {
  if (entry.proposalType === 'conflicting') return '表述不同';
  if (entry.proposalType === 'possibly_answered' || entry.kind === 'resolved') return '有了回答';
  if (['conflict', 'updated'].includes(entry.kind)) return '说法变化';
  return entry.kind === 'repeated' ? '再次提及' : '首次记录';
}

/** Compact values are a preview of the saved wording, never a new fact. Only
 * collapse a comparison with one unambiguous earlier value and one new value. */
export function timelineValues(before: string, after: string, category: string): { before: string; after: string } | null {
  const patterns: Record<string, RegExp> = {
    金额: /[$€£¥￥]\s*\d[\d,]*(?:\.\d+)?(?:\s*[–—-]\s*(?:[$€£¥￥]\s*)?\d[\d,]*(?:\.\d+)?)?(?:\s*-?\s*(?:million|billion|[kmb]\b|万|亿))?|\d[\d,]*(?:\.\d+)?\s*(?:万元|亿元|美元|人民币)/gi,
    日期: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?\b|\d{4}-\d{2}-\d{2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]/gi,
    数量: /\b\d+(?:\.\d+)?\b/g,
  };
  const pattern = patterns[category];
  if (!pattern) return null;
  if (category==='数量' && !/\b(?:participants?|people|attendees?|participant count)\b|人数|\d\s*人/i.test(before)) return null;
  const dateKey=(value:string)=>value.replace(/,/g,'').replace(/\s+/g,' ').toLowerCase();
  const values = (text: string) => {
    const matches=[...new Set(text.match(pattern) ?? [])];
    // A later sentence may repeat October 20 without the year. Keep the full
    // date when both spellings occur, but retain different explicit years.
    return category==='日期'?matches.filter(value=>!matches.some(other=>dateKey(other)!==dateKey(value) && dateKey(other).startsWith(`${dateKey(value)} `) && /^\d{4}$/.test(dateKey(other).slice(dateKey(value).length+1)))):matches;
  };
  const old = values(before), next = values(after);
  if (old.length !== 1) return null;
  const changed = next.filter(value => category==='日期'?dateKey(value)!==dateKey(old[0]):value !== old[0]);
  return changed.length === 1 && next.length <= 2 ? { before: old[0], after: changed[0] } : null;
}
