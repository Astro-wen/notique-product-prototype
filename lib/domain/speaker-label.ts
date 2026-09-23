const ALPHABETIC_DIARIZATION_LABEL = /^(?:speaker[\s_-]*)?([a-z])$/i;
const NUMBERED_SPEAKER_LABEL = /^speaker[\s_-]*(\d+)$/i;
const UNKNOWN_SPEAKER_LABEL = /^speaker[\s_-]*(?:unknown|unresolved)$/i;
const MAX_STABLE_SPEAKER_COUNT = 4;

export function displaySpeakerLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "说话人未标注";
  const label = value.trim();
  if (UNKNOWN_SPEAKER_LABEL.test(label)) return "说话人待确认";
  const alphabetic = label.match(ALPHABETIC_DIARIZATION_LABEL);
  if (alphabetic) {
    const number = alphabetic[1].toUpperCase().charCodeAt(0) - 64;
    if (number > MAX_STABLE_SPEAKER_COUNT) return "说话人待确认";
    return `Speaker ${number}`;
  }
  const numbered = label.match(NUMBERED_SPEAKER_LABEL);
  if (numbered) {
    const number = Math.max(1, Number(numbered[1]));
    return number <= MAX_STABLE_SPEAKER_COUNT ? `Speaker ${number}` : "说话人待确认";
  }
  return label;
}
