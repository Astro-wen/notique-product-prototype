const ALPHABETIC_DIARIZATION_LABEL = /^(?:speaker[\s_-]*)?([a-z])$/i;
const NUMBERED_SPEAKER_LABEL = /^speaker[\s_-]*(\d+)$/i;

export function displaySpeakerLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "说话人未标注";
  const label = value.trim();
  const alphabetic = label.match(ALPHABETIC_DIARIZATION_LABEL);
  if (alphabetic) {
    const number = alphabetic[1].toUpperCase().charCodeAt(0) - 64;
    return `Speaker ${number}`;
  }
  const numbered = label.match(NUMBERED_SPEAKER_LABEL);
  if (numbered) return `Speaker ${Math.max(1, Number(numbered[1]))}`;
  return label;
}
