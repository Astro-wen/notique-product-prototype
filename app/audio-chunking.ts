"use client";

import {
  AUDIO_CHUNK_OVERLAP_MS,
  AUDIO_CHUNK_TARGET_MS,
  planAudioChunks,
  type AudioChunkPlanItem,
} from "@/lib/domain/audio-chunking";

export type PreparedAudioChunk = AudioChunkPlanItem & {
  blob: Blob;
  filename: string;
  mimeType: "audio/wav";
};

async function mediaInput(source: Blob) {
  const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
  return new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
}

export async function inspectAudioDurationMs(source: Blob): Promise<number> {
  const input = await mediaInput(source);
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) throw new Error("录音中没有可读取的音轨。");
    const duration = await input.computeDuration([audioTrack]);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("无法读取录音时长。");
    }
    return Math.round(duration * 1_000);
  } finally {
    input.dispose();
  }
}

export async function prepareAudioChunk(
  source: Blob,
  item: AudioChunkPlanItem,
  baseFilename: string,
  onProgress?: (progress: number) => void,
): Promise<PreparedAudioChunk> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Output,
    WavOutputFormat,
  } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new WavOutputFormat(), target });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: { discard: true },
      audio: {
        codec: "pcm-s16",
        numberOfChannels: 1,
        sampleRate: 16_000,
        sampleFormat: "s16",
        forceTranscode: true,
      },
      trim: { start: item.startMs / 1_000, end: item.endMs / 1_000 },
      tags: {},
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error("浏览器无法把这份录音转换成转写切片。");
    conversion.onProgress = (progress) => onProgress?.(progress);
    await conversion.execute();
    if (!target.buffer) throw new Error("录音切片没有生成有效内容。");
    const base = baseFilename.replace(/\.[^.]+$/, "").trim() || "recording";
    return {
      ...item,
      blob: new Blob([target.buffer], { type: "audio/wav" }),
      filename: `${base}.part-${String(item.index + 1).padStart(3, "0")}.wav`,
      mimeType: "audio/wav",
    };
  } finally {
    input.dispose();
  }
}

export function audioChunkPlan(durationMs: number): AudioChunkPlanItem[] {
  return planAudioChunks(durationMs, AUDIO_CHUNK_TARGET_MS, AUDIO_CHUNK_OVERLAP_MS);
}
