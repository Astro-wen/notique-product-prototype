"use client";

import { useEffect, useState } from 'react';
import { ArrowUpRight, FileText, Play } from 'lucide-react';
import { Modal } from '@/app/components/modal';
import { NqButton } from '@/app/components/notique-ui';
import type { ProjectOverview, VersionRef } from '@/lib/shared/workflow-v2';
import { workflowService } from '../services/workflow-service';
import type { RecordSource } from './record-workspace';
import styles from './project-source-preview.module.css';

export type ProjectSourceTarget = { eventId: string; claimRefs: VersionRef[]; trigger: string };

export function ProjectSourcePreview({ target, snapshot, onClose, onOpenRecord }: {
  target: ProjectSourceTarget;
  snapshot: ProjectOverview;
  onClose: () => void;
  onOpenRecord: (eventId: string, claimId?: string) => void;
}) {
  const record = snapshot.recordSummaries.find(item => item.eventId === target.eventId);
  const [state, setState] = useState<{ identity: string; loading: boolean; sources: RecordSource[]; error: boolean }>({ identity: "", loading: true, sources: [], error: false });
  const [retry, setRetry] = useState(0);
  const refs = target.claimRefs.map(ref => snapshot.sourceRefs?.find(item => item.claimId === ref.claimId && item.claimVersionId === ref.claimVersionId));
  const unavailable = refs.some(ref => !ref || ref.sourceStatus !== 'ready');
  const ids = unavailable ? [] : [...new Set(refs.flatMap(ref => ref?.evidenceRefIds ?? []))];
  const identity = JSON.stringify(ids);
  const visibleState = state.identity === identity ? state : { loading: true, sources: [], error: false };
  const userInput = refs.length > 0 && refs.every(ref => ref?.origin === 'user_input' || ref?.origin === 'user_selection');
  useEffect(() => {
    let current = true;
    const evidenceIds = JSON.parse(identity) as string[];
    void workflowService.sources(evidenceIds).then(sources => {
      if (current) setState({ identity, loading: false, sources, error: false });
    }).catch(() => { if (current) setState({ identity, loading: false, sources: [], error: true }); });
    return () => { current = false; };
  }, [identity, retry]);
  return <Modal title={userInput ? '补充来源' : '查看来源'} returnFocusSelector={target.trigger} onClose={onClose}>
    <div className={styles.preview}>
      <div className={styles.context}><FileText size={16}/><div><strong>{record?.title ?? '相关对话'}</strong>{record && <time>{new Date(record.occurredAt).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div></div>
      {visibleState.loading && <p className={styles.loading} role="status">正在读取出处…</p>}
      {visibleState.error && <div role="alert"><p>来源暂时无法读取。</p><NqButton variant="secondary" onClick={() => { setState({ identity, loading: true, sources: [], error: false }); setRetry(value => value + 1); }}>重试</NqButton></div>}
      {!visibleState.loading && !visibleState.error && !visibleState.sources.length && <p className={styles.loading}>{unavailable ? '这条内容的来源已变化，请回到对话核对。' : '这项变化没有附带原文片段。'}</p>}
      {visibleState.sources.map(source => <blockquote key={source.evidenceRefId} className={styles.quote}>
        <div className={styles.quoteMeta}><span>{source.kind === 'user_note' ? '用户补充' : source.speaker}</span>{source.timestamp && <time>{source.timestamp}</time>}</div>
        <p>{source.quote || '这份材料没有文字片段。'}</p>
        {source.audioUrl && <div className={styles.audio}><NqButton variant="quiet" onClick={event => { const audio = event.currentTarget.parentElement?.querySelector('audio'); if (audio) { audio.currentTime = source.audioStartSeconds ?? 0; void audio.play().catch(() => undefined); } }}><Play size={13}/>回听 {source.timestamp}</NqButton><audio aria-label={`来源录音 ${source.timestamp}`} controls preload="metadata" src={source.audioUrl} onLoadedMetadata={event => { event.currentTarget.currentTime = source.audioStartSeconds ?? 0; }} onPlay={event => { for (const other of event.currentTarget.closest(`.${styles.preview}`)?.querySelectorAll('audio') ?? []) if (other !== event.currentTarget) other.pause(); }}/></div>}
        {source.viewUrl && <a href={source.viewUrl} target="_blank" rel="noreferrer">打开材料<ArrowUpRight size={12}/></a>}
      </blockquote>)}
      <footer className={styles.footer}><NqButton variant="secondary" onClick={onClose}>返回项目</NqButton><NqButton variant="quiet" onClick={() => onOpenRecord(target.eventId, target.claimRefs[0]?.claimId)}>打开这段对话<ArrowUpRight size={13}/></NqButton></footer>
    </div>
  </Modal>;
}
