"use client";

import { ChevronLeft, ChevronRight, FolderOpen, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { Event } from '@/app/api-client';
import { conversationOrder, conversationDate } from '@/lib/domain/conversation-navigation';
import styles from './workspace-navigation.module.css';

type WorkspaceTab = 'highlights' | 'materials' | 'transcript' | 'review' | 'results';
type Props = {
  projectName: string;
  events: Event[];
  event: Event | null;
  activeTab: WorkspaceTab;
  busy: boolean;
  loading: boolean;
  materialCount: number;
  onSelect: (id: string) => void;
  onTab: (tab: WorkspaceTab) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
};

export function WorkspaceNavigation({ projectName, events, event, activeTab, busy, loading, materialCount, onSelect, onTab, onAdd, onDelete }: Props) {
  const ordered = conversationOrder(events);
  const index = ordered.findIndex(item => item.id === event?.id);
  const projectScope = activeTab === 'results';
  const disabled = busy || loading;
  return <header className={styles.header} aria-label="项目与对话">
    <div className={styles.projectRow}>
      <div className={styles.projectIdentity}>
        <span className={styles.projectIcon} aria-hidden="true"><FolderOpen size={21}/></span>
        <div><span className={styles.eyebrow}>项目 <span className={styles.version}>1.6.1</span></span><h1 title={projectName}>{projectName.replace(/^\[SYNTHETIC\]\s*/, '')}</h1></div>
      </div>
      <div className={styles.scopes} aria-label="查看范围">
        <button aria-pressed={projectScope} aria-label="整个项目" onClick={() => onTab('results')}>项目总览<span>{events.length} 次对话</span></button>
        <button aria-pressed={!projectScope} onClick={() => onTab('highlights')}>当前对话</button>
      </div>
    </div>
    <div className={styles.conversationBar}>
      <div className={styles.switcher}>
        <button className={styles.iconButton} disabled={disabled || index <= 0} aria-label="上一段对话" title="上一段对话" onClick={() => onSelect(ordered[index - 1].id)}><ChevronLeft size={16}/></button>
        <label className={styles.selectLabel}><span className="visually-hidden">选择对话</span>
          <select aria-label="选择对话" value={event?.id ?? ''} disabled={disabled || !events.length} onChange={change => onSelect(change.target.value)}>
            {!event && <option value="">选择对话</option>}
            {ordered.map(item => <option key={item.id} value={item.id}>{conversationDate(item)} · {item.id === event?.id ? event.title : item.title}</option>)}
          </select>
        </label>
        <button className={styles.iconButton} disabled={disabled || index < 0 || index >= ordered.length - 1} aria-label="下一段对话" title="下一段对话" onClick={() => onSelect(ordered[index + 1].id)}><ChevronRight size={16}/></button>
        <span className={styles.position}>{index < 0 ? 0 : index + 1}<span> / {events.length}</span></span>
        <button className={styles.addButton} disabled={disabled} onClick={onAdd}><Plus size={15}/>新对话</button>
        {event && <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className={styles.iconButton} disabled={disabled} aria-label="对话选项"><MoreHorizontal size={17}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className={styles.menu} align="end" sideOffset={8}><DropdownMenu.Item className={styles.deleteItem} onSelect={() => onDelete(event.id)}><Trash2 size={14}/>删除这段对话</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
      </div>
      {!projectScope ? <nav className={styles.tabs} aria-label="当前对话内容">
        <button aria-current={activeTab === 'transcript' || activeTab === 'review' ? 'page' : undefined} onClick={() => onTab('transcript')}>原文</button>
        <button aria-label="本次重点" aria-current={activeTab === 'highlights' ? 'page' : undefined} onClick={() => onTab('highlights')}>重点</button>
        <button aria-label="材料" aria-current={activeTab === 'materials' ? 'page' : undefined} onClick={() => onTab('materials')}>材料<span>{loading ? "…" : materialCount}</span></button>
      </nav> : <span className={styles.scopeNote}>汇总全部对话</span>}
    </div>
    <span className="visually-hidden" role="status">{loading ? '正在切换对话' : ''}</span>
  </header>;
}
