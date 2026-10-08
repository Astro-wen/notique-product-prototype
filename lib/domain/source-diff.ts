import type { SourceDiff } from '../shared/workflow-v2.ts';

type Source = {
  id: string;
  quote_raw?: string | null;
  kind: string;
  evidence_role: string;
  availability: string;
  structural_validation_status: string;
};

/** Source changes are annotations of one saved claim, not lifecycle verdicts. */
export function sourceDiff(valueJson: string | null, sources: readonly Source[]): SourceDiff | undefined {
  let value: Record<string, unknown>;
  try { value = JSON.parse(valueJson ?? '{}'); } catch { return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const before = value.change_before, after = value.change_after;
  if (typeof before !== 'string' || typeof after !== 'string' || !before.trim() || !after.trim()
    || before.length > 2000 || after.length > 2000 || before.trim() === after.trim()) return;
  const eligible = sources.filter(s => ['text', 'transcript'].includes(s.kind)
    && s.evidence_role === 'direct' && s.availability === 'ready'
    && s.structural_validation_status === 'valid' && s.quote_raw);
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const beforeSource = eligible.find(s => normalize(s.quote_raw!).includes(normalize(before)));
  const afterSource = eligible.find(s => normalize(s.quote_raw!).includes(normalize(after)));
  if (!beforeSource || !afterSource) return;
  return { before: before.trim(), after: after.trim(), evidenceRefIds: [...new Set([beforeSource.id, afterSource.id])] };
}
