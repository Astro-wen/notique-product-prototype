import { diffWords } from 'diff';

export type StatementDiffPart = { value: string; added: boolean; removed: boolean };

export function statementDiff(before: string, after: string): StatementDiffPart[] | null {
  if (!before.trim() || !after.trim() || before.length + after.length > 12000) return null;
  const parts = diffWords(before, after, { timeout: 40, maxEditLength: 1500,
    intlSegmenter: new Intl.Segmenter(undefined, { granularity: 'word' }) });
  return parts?.map(p => ({ value: p.value, added: p.added, removed: p.removed })) ?? null;
}
