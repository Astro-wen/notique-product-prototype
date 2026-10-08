"use client";

import { useMemo } from 'react';
import { statementDiff } from '@/lib/domain/statement-diff';
import styles from './statement-diff.module.css';

export function StatementDiff({ before, after, side }: { before: string; after: string; side: 'before' | 'after' }) {
  const parts = useMemo(() => statementDiff(before, after), [before, after]);
  if (!parts) return <>{side === 'before' ? before : after}</>;
  return <>{parts.filter(p => side === 'before' ? !p.added : !p.removed).map((p, i) =>
    p.removed ? <mark key={i} className={styles.removed} aria-label={`原表述：${p.value}`}>{p.value}</mark>
      : p.added ? <mark key={i} className={styles.added} aria-label={`新表述：${p.value}`}>{p.value}</mark>
      : <span key={i}>{p.value}</span>)}</>;
}

export function SourceDiffNote({ before, after, heading = true }: { before: string; after: string; heading?: boolean }) {
  return <div className={styles.note} aria-label="原话中的调整">
    {heading && <small>原话有调整</small>}
    <p><span className={styles.label}>先说</span><StatementDiff before={before} after={after} side="before" /></p>
    <p><span className={styles.label}>随后</span><StatementDiff before={before} after={after} side="after" /></p>
  </div>;
}
