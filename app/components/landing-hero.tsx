"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { ArrowRight, FileText, Images, Mic, Upload } from "lucide-react";
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

/**
 * 标题两半各自轮播，且错开换词。
 *
 * 两边同时换会读成一一对应（图片就得到客户档案、音频就得到可信记忆），而实际
 * 上任何一种材料都通向这三样，没有这种映射。所以用半拍的间隔交替换：每个词
 * 各停 ROTATE_MS，但两边永远不在同一刻动。
 */
const UPLOADS = ["音频", "文件", "图片"];
const BUILDS = ["可信记忆", "会前简报", "客户档案"];
const ROTATE_MS = 2600;
const HEADLINE = `上传${UPLOADS.join("、")}，建立专属${BUILDS.join("、")}`;

/** 本机时钟没有「订阅」这回事，退订也就什么都不做。 */
const subscribeToNothing = () => () => {};
const clientGreeting = () => greetingFor(new Date().getHours());
const serverGreeting = () => "";

function Rotator({ words, current }: { words: string[]; current: number }) {
  return (
    <span className="landing-rotator">
      {words.map((word, index) => (
        <span key={word} className={index === current ? "is-current" : ""}>{word}</span>
      ))}
    </span>
  );
}

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
  // 半拍计数：偶数拍换下半句，奇数拍换上半句。
  const [halfStep, setHalfStep] = useState(0);
  const uploadIndex = Math.floor((halfStep + 1) / 2) % UPLOADS.length;
  const buildIndex = Math.floor(halfStep / 2) % BUILDS.length;
  // 问候语要读本机时钟，服务端没有这个东西，所以服务端渲染成空、客户端渲染成
  // 问候语。useSyncExternalStore 的第三个参数就是为这种两边不同准备的：它让
  // React 知道这处不一致是故意的，不会当成 hydration 错误。
  const hello = useSyncExternalStore(subscribeToNothing, clientGreeting, serverGreeting);

  useEffect(() => {
    const cycle = 2 * UPLOADS.length * BUILDS.length;
    const timer = window.setInterval(
      () => setHalfStep((step) => (step + 1) % cycle),
      ROTATE_MS / 2,
    );
    return () => window.clearInterval(timer);
  }, []);

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
        disabled={busy}
        onChange={(event) => { takeFiles(event.target.files); event.target.value = ""; }}
      />

      <header className="landing-hero">
        <div className="landing-top">
          <p className="landing-greeting">{hello}</p>
          {/* 这一页说的是「上传什么、得到什么」，怎么得到的放在这后面。 */}
          <button type="button" className="text-button landing-explain" onClick={onExplain}>
            这东西怎么工作<ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
        {/* 看到的是轮播中的一帧，读屏听到的是完整那一句。标题自己带 aria-label，
            所以它的可访问名字是固定的，不随轮播到哪个词而变。 */}
        <h1 aria-label={HEADLINE}>
          <span className="landing-build" aria-hidden="true">
            上传
            <Rotator words={UPLOADS} current={uploadIndex} />
          </span>
          <span className="landing-build" aria-hidden="true">
            建立专属
            <Rotator words={BUILDS} current={buildIndex} />
          </span>
        </h1>
        <p className="landing-sub">结论都能点开看到原话，确认过的才进报告</p>
      </header>

      <div className="landing-actions">
        <button type="button" className={`landing-action${recorderOpen ? " is-active" : ""}`} disabled={busy} onClick={onRecord}>
          <span className="landing-action-mark record" aria-hidden="true"><Mic /></span>
          <strong>直接录音</strong>
          <small>{recorderOpen ? "录音面板在下面，点这里收起" : "用这台设备的麦克风，录完自动转写"}</small>
        </button>
        <button type="button" className="landing-action" disabled={busy} onClick={onPickAudio}>
          <span className="landing-action-mark audio" aria-hidden="true"><Upload /></span>
          <strong>上传音频</strong>
          <small>分出说话人和时间点</small>
        </button>
        <button type="button" className="landing-action" disabled={busy} onClick={onPickTranscript}>
          <span className="landing-action-mark text" aria-hidden="true"><FileText /></span>
          <strong>上传文件</strong>
          <small>已有逐字稿直接进来，跳过转写</small>
        </button>
        <button type="button" className="landing-action" disabled={busy} onClick={onPickPhoto}>
          <span className="landing-action-mark photo" aria-hidden="true"><Images /></span>
          <strong>上传图片</strong>
          <small>手写笔记、白板、纸质材料</small>
        </button>
      </div>

      <button type="button" className="landing-dropzone" disabled={busy} onClick={() => fileRef.current?.click()}>
        <span className="landing-dropzone-mark" aria-hidden="true">
          {uploading ? <i className="spinner" /> : <Upload />}
        </span>
        <strong>{uploading ? "正在收下材料…" : "把文件拖到这里，或点击选择"}</strong>
        {uploading
          ? <small>处理完会自动打开，不用等在这一页</small>
          // 格式和"会自动建项目"分成两行，挤在一行时会从词中间断开。
          : <><small>音频 MP3 / M4A / WAV / WebM　文本 TXT / VTT / SRT / JSON　图片 JPG / PNG / HEIC</small>
            <small>第一份材料会自动建好项目，不用先想名字</small></>}
      </button>

      {children}
    </div>
  );
}
