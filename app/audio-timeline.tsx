"use client";

import { useEffect, useState } from "react";

/** The waveform is decoded from this recording; absent audio never gets a fake waveform. */
export function AudioTimeline({ src, duration, currentTime, chapters, onSeek }: {
  src: string;
  duration: number;
  currentTime: number;
  chapters: Array<{ key: string; title: string; startMs: number }>;
  onSeek: (seconds: number) => void;
}) {
  const [wave, setWave] = useState<{ src: string; path: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let context: AudioContext | null = null;
    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok || Number(response.headers.get("content-length")) > 80_000_000) return;
        const bytes = await response.arrayBuffer();
        if (controller.signal.aborted || bytes.byteLength > 80_000_000) return;
        context = new AudioContext({ sampleRate: 8000 });
        const buffer = await context.decodeAudioData(bytes);
        if (controller.signal.aborted) return;
        const samples = buffer.getChannelData(0);
        const count = 256;
        const stride = Math.max(1, Math.floor(samples.length / count));
        const levels = Array.from({ length: count }, (_, bin) => {
          let energy = 0, n = 0;
          for (let i = bin * stride; i < Math.min((bin + 1) * stride, samples.length); i += 16) {
            energy += samples[i] ** 2; n++;
          }
          return n ? Math.sqrt(energy / n) : 0;
        });
        const peak = Math.max(...levels, .001);
        const path = `M 0 30 ${levels.map((value, i) => `L ${i * 1000 / (count - 1)} ${30 - Math.sqrt(value / peak) * 25}`).join(" ")} L 1000 30 Z`;
        setWave({ src, path });
      } catch { /* Seeking and playback remain available if waveform decoding fails. */ }
      finally { if (context && context.state !== "closed") await context.close(); }
    })();
    return () => { controller.abort(); };
  }, [src]);
  const format = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const progress = duration > 0 ? Math.min(100, currentTime / duration * 100) : 0;
  return <div className="audio-timeline">
    <div className="audio-track">
      {wave?.src === src && <svg className="audio-waveform" viewBox="0 0 1000 32" preserveAspectRatio="none" aria-hidden="true"><path d={wave.path} /></svg>}
      <div className="audio-track-base" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      <input aria-label="录音进度" type="range" min={0} max={Math.max(duration, 1)} step={.1} value={Math.min(currentTime, Math.max(duration, 1))} onChange={(event) => onSeek(Number(event.target.value))} />
      {duration > 0 && chapters.filter((chapter) => chapter.startMs > 0 && chapter.startMs < duration * 1000).map((chapter) => <button key={chapter.key} className="audio-chapter-marker" style={{ left: `${chapter.startMs / (duration * 1000) * 100}%` }} title={`${format(chapter.startMs / 1000)} · ${chapter.title}`} aria-label={`跳到章节 ${format(chapter.startMs / 1000)}：${chapter.title}`} onClick={() => onSeek(chapter.startMs / 1000)} />)}
    </div>
    <div className="audio-track-times"><time>{format(currentTime)}</time><time>{format(duration)}</time></div>
  </div>;
}
