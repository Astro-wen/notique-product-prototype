/**
 * Client-side transcript export. The reader already has the full transcript in
 * front of them; exporting re-serializes what is on screen, so no server call
 * and no new permission is involved.
 */

export type ExportTurn = {
  /** Display label, already resolved (Speaker 1, a real name, …). */
  speaker: string;
  startMs: number | null;
  text: string;
};

export type ExportSegment = {
  speaker: string;
  startMs: number | null;
  endMs: number | null;
  text: string;
};

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 65_500ms → "0:01:05". Hours only appear when reached, like a player. */
export function clockTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
}

/** 65_500ms → "00:01:05,500" (SRT clock). */
export function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const total = Math.floor(clamped / 1000);
  return `${pad(Math.floor(total / 3600), 2)}:${pad(Math.floor((total % 3600) / 60), 2)}:${pad(total % 60, 2)},${pad(clamped % 1000, 3)}`;
}

/**
 * Plain-text transcript: a title line, then one block per turn. Turns without
 * a timestamp keep their place but drop the clock rather than inventing one.
 */
export function buildTranscriptText(title: string, turns: ExportTurn[]): string {
  const blocks = turns
    .filter((turn) => turn.text.trim())
    .map((turn) => {
      const clock = turn.startMs == null ? "" : `[${clockTimestamp(turn.startMs)}] `;
      return `${clock}${turn.speaker}\n${turn.text.trim()}`;
    });
  return `${title}\n\n${blocks.join("\n\n")}\n`;
}

const SRT_FALLBACK_DURATION_MS = 3_000;

/**
 * SRT subtitles from timed segments. A segment without a start cannot be
 * placed on a clock and is skipped; a missing end borrows the next start, or
 * a short fixed duration at the tail.
 */
export function buildTranscriptSrt(segments: ExportSegment[]): string {
  const timed = segments.filter(
    (segment) => segment.startMs != null && segment.text.trim(),
  );
  const cues = timed.map((segment, index) => {
    const start = segment.startMs!;
    const next = timed[index + 1]?.startMs;
    const end = segment.endMs != null && segment.endMs > start
      ? segment.endMs
      : next != null && next > start
        ? next
        : start + SRT_FALLBACK_DURATION_MS;
    return `${index + 1}\n${srtTimestamp(start)} --> ${srtTimestamp(end)}\n${segment.speaker}: ${segment.text.trim()}`;
  });
  return `${cues.join("\n\n")}\n`;
}

/** A filename a file system accepts, keeping the human title readable. */
export function exportFilename(title: string, variant: string, extension: string): string {
  const safe = (title || "逐字稿").replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${safe} · ${variant}.${extension}`;
}
