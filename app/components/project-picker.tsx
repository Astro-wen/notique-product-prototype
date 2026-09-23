"use client";

import { useMemo, useState } from 'react';
import { FolderOpen, Plus, Search } from 'lucide-react';
import { Modal } from './modal';
import { NEW_PROJECT } from '@/lib/domain/material-routing';

/**
 * 拖进材料时的项目选择器（第二层）。
 *
 * 只负责把用户的选择交回去，自己不落库、不建项目、不调接口。跳过等于今天的
 * 行为（新建项目），所以这个组件出不出现都不会改变既有路径。
 *
 * 样式全部复用 globals.css 里已有的 pi-* 规则：这一轮 globals.css 被别人占用，
 * 而 tests/stylesheet-integrity.test.mjs 会拒绝任何在 globals.css 里没有规则的
 * 静态类名，所以这里不引入新类名。
 */

export type PickerProject = {
  id: string;
  name: string;
  folderName?: string;
  updatedAt?: string;
  lastOpenedAt?: string;
};

type Props = {
  projects: PickerProject[];
  /** 用户选中的项目 id；null 表示新建项目。 */
  onChoose: (projectId: string | null) => void;
  /** 关掉选择器但没有表态。调用方按今天的行为处理，也就是新建项目。 */
  onSkip: () => void;
  busy?: boolean;
};

/** 一次最多列这么多个。再多就不是「最近」了，靠搜索找。 */
const VISIBLE_LIMIT = 8;

/** 合成案例的前缀只是数据来源标记，不该出现在用户眼前。 */
const displayName = (name: string) => name.replace(/^\[SYNTHETIC\]\s*/, '');

const recencyOf = (item: PickerProject) => {
  const parsed = Date.parse(item.lastOpenedAt || item.updatedAt || '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const when = (item: PickerProject) => {
  const value = item.lastOpenedAt || item.updatedAt;
  if (!value) return '尚未打开';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(parsed));
};

export function ProjectPicker({ projects, onChoose, onSkip, busy = false }: Props) {
  const [query, setQuery] = useState('');

  const ordered = useMemo(
    // id 兜底，保证没有时间戳的项目之间顺序稳定，列表不会每次渲染都跳。
    () => [...projects].sort((a, b) => (recencyOf(b) - recencyOf(a)) || a.id.localeCompare(b.id)),
    [projects],
  );
  const searchable = ordered.length > VISIBLE_LIMIT;
  const keyword = query.trim().toLocaleLowerCase();
  const matched = keyword
    ? ordered.filter((item) => `${displayName(item.name)} ${item.folderName || ''}`.toLocaleLowerCase().includes(keyword))
    : ordered;
  const visible = matched.slice(0, VISIBLE_LIMIT);

  return (
    <Modal
      title="放进哪个项目"
      description="选一个现有项目，或者新建一个。直接关掉就按新建项目处理。"
      onClose={onSkip}
      dismissible={!busy}
    >
      <div className="pi-dialog-body">
        {searchable && (
          <div className="pi-search">
            <Search size={17} />
            <input
              aria-label="搜索项目"
              placeholder="搜索项目或文件夹…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={busy}
            />
          </div>
        )}
        {visible.length > 0 ? (
          <div className="pi-list">
            {visible.map((item) => (
              <article key={item.id} className="pi-item">
                <div className="pi-item-top"><FolderOpen className="pi-folder-icon" /></div>
                <div className="pi-item-main">
                  <button className="pi-title" disabled={busy} onClick={() => onChoose(item.id)}>{displayName(item.name)}</button>
                  <div className="pi-associations">
                    <span className="pi-folder-tag"><FolderOpen size={13} />{item.folderName || '默认文件夹'}</span>
                  </div>
                </div>
                <span className="pi-event-count">最近打开</span>
                <time className="pi-date">{when(item)}</time>
                <div className="pi-item-actions">
                  <button className="pi-open" aria-label={`放进 ${displayName(item.name)}`} disabled={busy} onClick={() => onChoose(item.id)}>放这里</button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="pi-empty">
            <FolderOpen size={34} />
            <h2>{ordered.length ? '没有匹配的项目' : '还没有项目'}</h2>
            <p>{ordered.length ? '换个名称搜索，或者直接新建一个项目。' : '新建一个项目，这份材料就放进去。'}</p>
          </div>
        )}
        <div className="modal-actions">
          <button className="button secondary" disabled={busy} onClick={onSkip}>跳过</button>
          <button className="button primary" disabled={busy} onClick={() => onChoose(null)}><Plus size={15} />新建项目</button>
        </div>
      </div>
    </Modal>
  );
}

/** 把选择器的回调结果翻成 routingChoice 的入参，调用方不必自己记住 null 的含义。 */
export function pickerChoiceInput(projectId: string | null) {
  return { chosenProjectId: projectId ?? NEW_PROJECT };
}
