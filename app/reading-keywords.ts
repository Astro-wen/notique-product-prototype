/** Extract labels already present in source-linked summaries. No inferred facts. */
export function readingKeywords(text: string): string[] {
  const phrases = text.match(/\b(?:pre[- ]?approv(?:al|ed)|San Antonio|open floor plan|game room|buyer(?:'s)? representation|school district|monthly payment|lender approval|four bedrooms|three bathrooms|VA loan|281 corridor)\b/gi) ?? [];
  const distinctPhrases = phrases.filter((phrase, index) => phrases.findIndex((item) => item.toLowerCase() === phrase.toLowerCase()) === index);
  if (distinctPhrases.length >= 4) return distinctPhrases.slice(0, 12);
  const stop = new Set('the and that this with from have has had was were will would could should their there they them into about approximately buyer agent said says stated states currently over under than then when which what also been being before after looking looking need needs wants want home house homes purchase meeting covered curtis his her for not yet but are its who how our you your she him can does did these those through some more other money amount most all any one two three four five six around'.split(' '));
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (!stop.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...new Set([...distinctPhrases, ...[...counts].sort((a, b) => b[1] - a[1]).map(([word]) => word)])].slice(0, 12);
}
