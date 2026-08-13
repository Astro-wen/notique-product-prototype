export type HighlightedTextPart = {
  text: string;
  highlighted: boolean;
};

/**
 * Split a transcript segment around the exact evidence quote. The comparison
 * falls back to case-insensitive matching, while preserving original text.
 */
export function highlightExactPhrase(text: string, phrase: string | null | undefined): HighlightedTextPart[] {
  const source = text || "";
  const target = phrase?.trim() || "";
  if (!source || !target) return source ? [{ text: source, highlighted: false }] : [];

  let start = source.indexOf(target);
  if (start < 0) start = source.toLocaleLowerCase().indexOf(target.toLocaleLowerCase());
  if (start < 0) return [{ text: source, highlighted: false }];

  const parts: HighlightedTextPart[] = [];
  if (start > 0) parts.push({ text: source.slice(0, start), highlighted: false });
  parts.push({ text: source.slice(start, start + target.length), highlighted: true });
  if (start + target.length < source.length) {
    parts.push({ text: source.slice(start + target.length), highlighted: false });
  }
  return parts;
}
