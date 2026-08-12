"use client";

import { useEffect, useRef, useState } from "react";
import {
  browserRecordingFilename,
  chooseBrowserRecordingMime,
  formatRecordingDuration,
} from "@/lib/domain/browser-recording";

type RecorderState = "idle" | "requesting" | "recording" | "paused" | "preview" | "saving" | "unsupported";

type DirectRecorderProps = {
  disabled?: boolean;
  onSave: (file: File) => Promise<boolean>;
  onClose: () => void;
};

function microphoneIssue(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "没有取得麦克风权限。请在浏览器地址栏允许麦克风后重试。";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "没有找到可用的麦克风。请连接麦克风后重试。";
  }
  return "暂时无法开始录音。你仍可以上传手机或电脑里已有的录音。";
}

export function DirectRecorder({ disabled, onSave, onClose }: DirectRecorderProps) {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef("audio/webm");

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => setElapsedSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!recordingBlob && state !== "recording" && state !== "paused") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [recordingBlob, state]);

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function startRecording() {
    setIssue(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("unsupported");
      return;
    }
    const mimeType = chooseBrowserRecordingMime((value) => MediaRecorder.isTypeSupported(value));
    if (!mimeType) {
      setState("unsupported");
      return;
    }
    setState("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const recorder = new MediaRecorder(stream, { mimeType });
      streamRef.current = stream;
      recorderRef.current = recorder;
      mimeRef.current = mimeType;
      chunksRef.current = [];
      setElapsedSeconds(0);
      setRecordingBlob(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (blob.size < 1) {
          setIssue("这段录音没有可保存的内容，请重新录制。");
          setState("idle");
          return;
        }
        const url = URL.createObjectURL(blob);
        setRecordingBlob(blob);
        setPreviewUrl(url);
        setState("preview");
      }, { once: true });
      recorder.start(1000);
      setState("recording");
    } catch (error) {
      setIssue(microphoneIssue(error));
      setState("idle");
    }
  }

  function pauseOrResume() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      setState("paused");
      return;
    }
    if (recorder.state === "paused") {
      recorder.resume();
      setState("recording");
    }
  }

  function finishRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  function discardRecording() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setRecordingBlob(null);
    setElapsedSeconds(0);
    setIssue(null);
    setState("idle");
  }

  async function saveRecording() {
    if (!recordingBlob) return;
    setState("saving");
    const file = new File(
      [recordingBlob],
      browserRecordingFilename(new Date(), mimeRef.current),
      { type: mimeRef.current },
    );
    const saved = await onSave(file);
    if (saved) {
      discardRecording();
      onClose();
      return;
    }
    setIssue("录音还没有保存成功。试听内容仍在这里，可以再次保存。");
    setState("preview");
  }

  const activelyRecording = state === "recording" || state === "paused";

  return (
    <section className="direct-recorder" aria-label="直接录音" aria-live="polite">
      <header>
        <div>
          <span className={`recording-dot ${activelyRecording ? "active" : ""}`} aria-hidden="true" />
          <span><strong>直接录音</strong><small>保存后会进入现有的说话人识别和逐字稿流程</small></span>
        </div>
        {(state === "idle" || state === "unsupported") && <button className="icon-button" onClick={onClose} aria-label="关闭直接录音">×</button>}
      </header>

      {issue && <p className="recorder-issue">{issue}</p>}

      {(state === "idle" || state === "requesting" || state === "unsupported") && (
        <div className="recorder-start">
          <span className="recorder-mic" aria-hidden="true">●</span>
          <div><strong>{state === "unsupported" ? "这个浏览器不支持直接录音" : "准备好后开始录音"}</strong><small>{state === "unsupported" ? "请改用“上传已有录音”。" : "第一次使用时，浏览器会询问麦克风权限。"}</small></div>
          {state !== "unsupported" && <button className="button record-button" disabled={disabled || state === "requesting"} onClick={() => void startRecording()}>{state === "requesting" ? "正在请求麦克风…" : "开始录音"}</button>}
        </div>
      )}

      {activelyRecording && (
        <div className="recorder-live">
          <div className="recorder-clock"><span>{state === "paused" ? "已暂停" : "录音中"}</span><time>{formatRecordingDuration(elapsedSeconds)}</time></div>
          <div className="recorder-levels" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</div>
          <div className="recorder-controls">
            <button className="button secondary" onClick={pauseOrResume}>{state === "paused" ? "继续" : "暂停"}</button>
            <button className="button record-button" onClick={finishRecording}>结束录音</button>
          </div>
        </div>
      )}

      {(state === "preview" || state === "saving") && previewUrl && (
        <div className="recorder-preview">
          <div><strong>录音完成</strong><small>{formatRecordingDuration(elapsedSeconds)} · 请先试听，再决定保存或重录</small></div>
          <audio controls src={previewUrl} />
          <div className="recorder-controls">
            <button className="button secondary" disabled={state === "saving" || disabled} onClick={discardRecording}>重新录制</button>
            <button className="button primary" disabled={state === "saving" || disabled} onClick={() => void saveRecording()}>{state === "saving" || disabled ? "正在保存…" : "保存并生成逐字稿"}</button>
          </div>
        </div>
      )}
    </section>
  );
}
