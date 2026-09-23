"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { FileAudio, FileText, GripVertical, Image as ImageIcon, Mic, Upload } from "lucide-react";
import type { Asset } from "@/app/api-client";

export type MaterialShelfProps = {
  assets: Asset[];
  busy: boolean;
  /** 合并后的 accept，录音、逐字稿、图片共用一个选择框。 */
  accept: string;
  onFiles: (files: File[]) => void;
  onRecord: () => void;
  onRename: (assetId: string, filename: string) => Promise<void>;
  onReorder: (assetIds: string[]) => Promise<void>;
  /** 转写状态和重试按钮留在 page.tsx，那里才有 run 的上下文。 */
  renderStatus: (asset: Asset) => ReactNode;
  /** 名字下面那行灰字，比如大小和"保存后自动生成逐字稿"。 */
  describe: (asset: Asset) => string;
  onNotice: (message: string) => void;
};

function kindIcon(asset: Asset) {
  if (asset.kind === "audio") return <FileAudio />;
  if (asset.kind === "photo") return <ImageIcon />;
  return <FileText />;
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function MaterialShelf({ assets, busy, accept, onFiles, onRecord, onRename, onReorder, renderStatus, describe, onNotice }: MaterialShelfProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const ids = assets.map((asset) => asset.id);
  // 松手后先按本地顺序渲染，等服务端确认再交回 props，否则从松手到请求
  // 返回之间列表会跳回旧顺序。期间若有新材料上传进来，本地顺序就不再
  // 覆盖完整列表，这时直接放弃它，以服务端为准。
  const order = localOrder && sameSet(localOrder, ids) ? localOrder : ids;
  const ordered = order.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is Asset => Boolean(asset));

  function takeFiles(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (list.length) onFiles(list);
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    setDropActive(false);
    // 排序拖动不带文件，别让它触发上传。
    if (event.dataTransfer.files.length) takeFiles(event.dataTransfer.files);
  }

  async function commitOrder(next: string[]) {
    setLocalOrder(next);
    try {
      await onReorder(next);
    } catch {
      // 失败时退回服务端顺序，不留下一个只有本地才成立的排列。
      setLocalOrder(null);
      onNotice("顺序没保存成功，请再试一次");
    }
  }

  function moveTo(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const next = order.filter((id) => id !== sourceId);
    next.splice(next.indexOf(targetId), 0, sourceId);
    void commitOrder(next);
  }

  function nudge(assetId: string, delta: number) {
    const from = order.indexOf(assetId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    next.splice(to, 0, ...next.splice(from, 1));
    void commitOrder(next);
  }

  function handleKey(event: KeyboardEvent, assetId: string) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    nudge(assetId, event.key === "ArrowUp" ? -1 : 1);
  }

  async function saveName() {
    if (!renaming) return;
    const value = renaming.value.trim();
    const current = assets.find((asset) => asset.id === renaming.id);
    if (!value || value === current?.filename) return setRenaming(null);
    setSaving(true);
    try {
      await onRename(renaming.id, value);
      setRenaming(null);
    } catch {
      onNotice("名字没改成功，请再试一次");
    } finally {
      setSaving(false);
    }
  }

  const empty = ordered.length === 0;

  return (
    <div
      className={`material-shelf${dropActive ? " is-dropping" : ""}${empty ? " is-empty" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropActive(false); }}
      onDrop={drop}
    >
      <input
        ref={fileRef}
        className="visually-hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-label="选择录音、逐字稿或照片"
        accept={accept}
        disabled={busy}
        onChange={(event) => { takeFiles(event.target.files); event.target.value = ""; }}
      />

      <button type="button" className="material-dropzone" disabled={busy} onClick={() => fileRef.current?.click()}>
        <span className="material-dropzone-mark" aria-hidden="true"><Upload /></span>
        <strong>{empty ? "拖拽录音、逐字稿或照片到这里" : "拖拽文件到这里，或点击上传"}</strong>
        <small>支持 MP3、M4A、WAV、WebM、TXT、VTT、SRT、JSON 和图片</small>
      </button>
      <button type="button" className="text-button material-record" disabled={busy} onClick={onRecord}>
        <Mic aria-hidden="true" />直接录音
      </button>

      {!empty && <ol className="material-list">
        {ordered.map((asset, index) => <li
          key={asset.id}
          className={`material-row${dragId === asset.id ? " is-dragging" : ""}${overId === asset.id ? " is-over" : ""}`}
          draggable={!busy && !renaming}
          onDragStart={(event) => { setDragId(asset.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { setDragId(null); setOverId(null); }}
          onDragOver={(event) => { if (dragId) { event.preventDefault(); setOverId(asset.id); } }}
          onDrop={(event) => { if (dragId) { event.stopPropagation(); moveTo(dragId, asset.id); setDragId(null); setOverId(null); } }}
        >
          <span
            className="material-grip"
            role="button"
            tabIndex={0}
            aria-label={`调整“${asset.filename}”的顺序，当前第 ${index + 1} 位，用上下方向键移动`}
            onKeyDown={(event) => handleKey(event, asset.id)}
          ><GripVertical aria-hidden="true" /></span>

          <span className="material-kind" aria-hidden="true">{kindIcon(asset)}</span>

          {renaming?.id === asset.id
            ? <input
                className="material-rename"
                autoFocus
                maxLength={200}
                value={renaming.value}
                disabled={saving}
                aria-label="材料名称"
                onChange={(event) => setRenaming({ id: asset.id, value: event.target.value })}
                onBlur={() => void saveName()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); void saveName(); }
                  if (event.key === "Escape") { event.preventDefault(); setRenaming(null); }
                }}
              />
            : <button
                type="button"
                className="material-name"
                disabled={busy}
                aria-label={`重命名 ${asset.filename}`}
                onClick={() => setRenaming({ id: asset.id, value: asset.filename })}
              ><b>{asset.filename}</b><small>{describe(asset)}</small></button>}

          <span className="material-status">{renderStatus(asset)}</span>
        </li>)}
      </ol>}
    </div>
  );
}
