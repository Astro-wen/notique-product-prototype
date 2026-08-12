export const BROWSER_RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

export function chooseBrowserRecordingMime(
  isTypeSupported: (mimeType: string) => boolean,
): string | null {
  return BROWSER_RECORDING_MIME_CANDIDATES.find((mimeType) => isTypeSupported(mimeType)) ?? null;
}

export function browserRecordingExtension(mimeType: string): "webm" | "m4a" {
  return mimeType.toLowerCase().startsWith("audio/mp4") ? "m4a" : "webm";
}

export function browserRecordingFilename(recordedAt: Date, mimeType: string): string {
  const stamp = recordedAt.toISOString().replace(/[:.]/g, "-");
  return `notique-recording-${stamp}.${browserRecordingExtension(mimeType)}`;
}

export function formatRecordingDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
