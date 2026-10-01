"use client";

import { useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { ArrowRight, FileText, Images, Mic, Upload } from "lucide-react";
import { NqActionCard } from "./notique-ui";
import { greetingFor } from "@/lib/domain/greeting";

export type LandingHeroProps = {
  busy: boolean;
  uploading: boolean;
  /** 录音面板是否展开。不是「正在录音」——录没录由面板自己显示。 */
  recorderOpen: boolean;
  accept: string;
  onFiles: (files: File[]) => void;
  onRecord: () => void;
  onPickAudio: () => void;
  onPickTranscript: () => void;
  onPickPhoto: () => void;
  onExplain: () => void;
  /** 录音面板和上传进度由父组件塞进来，它们依赖工作区的状态。 */
  children?: ReactNode;
};

/** 本机时钟没有「订阅」这回事，退订也就什么都不做。 */
const subscribeToNothing = () => () => {};
const clientGreeting = () => greetingFor(new Date().getHours());
const serverGreeting = () => "";
const clientReady = () => true;
const serverReady = () => false;

export function LandingHero({
  busy,
  uploading,
  recorderOpen,
  accept,
  onFiles,
  onRecord,
  onPickAudio,
  onPickTranscript,
  onPickPhoto,
  onExplain,
  children,
}: LandingHeroProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0);
  // 问候语要读本机时钟，服务端没有这个东西，所以服务端渲染成空、客户端渲染成
  // 问候语。useSyncExternalStore 的第三个参数就是为这种两边不同准备的：它让
  // React 知道这处不一致是故意的，不会当成 hydration 错误。
  const hello = useSyncExternalStore(subscribeToNothing, clientGreeting, serverGreeting);
  const ready = useSyncExternalStore(subscribeToNothing, clientReady, serverReady);

  function takeFiles(files: FileList | null) {
    const list = Array.from(files ?? []);
    if (list.length) onFiles(list);
  }

  return (
    <div
      className={`landing${dragDepth > 0 ? " is-dropping" : ""}`}
      // 用进出计数而不是 dragleave 直接清零：鼠标划过子元素也会触发 dragleave，
      // 只看事件会让高亮闪。
      onDragEnter={(event: DragEvent) => { event.preventDefault(); setDragDepth((depth) => depth + 1); }}
      onDragOver={(event: DragEvent) => event.preventDefault()}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        setDragDepth(0);
        if (event.dataTransfer.files.length) takeFiles(event.dataTransfer.files);
      }}
    >
      <input
        ref={fileRef}
        className="visually-hidden"
        type="file"
        multiple
        tabIndex={-1}
        aria-label="选择录音、逐字稿或照片"
        accept={accept}
        disabled={!ready || busy}
        onChange={(event) => { takeFiles(event.target.files); event.target.value = ""; }}
      />

      <header className="landing-hero">
        <div className="landing-top">
          <p className="landing-greeting">{hello}</p>
          {/* 这一页说的是「上传什么、得到什么」，怎么得到的放在这后面。 */}
          <button type="button" className="text-button landing-explain" disabled={!ready} onClick={onExplain}>
            使用说明<ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
        <h1>
          <span className="landing-build">上传录音或笔记</span>
          <span className="landing-build">整理成<span className="landing-accent">重点和下一步</span></span>
        </h1>
        <p className="landing-sub">查看原文和重点，确认后可跟进或补充结果</p>
      </header>

      <div className="landing-actions">
        <NqActionCard icon={Mic} kind="record" title="直接录音" description={recorderOpen ? "点击收起录音面板" : "使用麦克风录音，结束后自动转写"} active={recorderOpen} disabled={!ready || busy} onClick={onRecord} />
        <NqActionCard icon={Upload} kind="audio" title="上传音频" description="会议录音、语音备忘录" disabled={!ready || busy} onClick={onPickAudio} />
        <NqActionCard icon={FileText} kind="text" title="上传文件" description="逐字稿、文字笔记" disabled={!ready || busy} onClick={onPickTranscript} />
        <NqActionCard icon={Images} kind="photo" title="上传图片" description="手写笔记、白板、纸质材料" disabled={!ready || busy} onClick={onPickPhoto} />
      </div>

      <button type="button" className="landing-dropzone" disabled={!ready || busy} onClick={() => fileRef.current?.click()}>
        <span className="landing-dropzone-mark" aria-hidden="true">
          {uploading ? <i className="spinner" /> : <Upload />}
        </span>
        <strong>{uploading ? "正在上传…" : "把文件拖到这里，或点击选择"}</strong>
        {uploading
          ? <small>处理完成后自动打开记录</small>
          // 格式和"会自动建项目"分成两行，挤在一行时会从词中间断开。
          : <><small>音频 MP3 / M4A / WAV / WebM　文本 TXT / VTT / SRT / JSON　图片 JPG / PNG / HEIC</small>
            <small>首次上传会自动创建项目</small></>}
      </button>

      {children}
    </div>
  );
}
