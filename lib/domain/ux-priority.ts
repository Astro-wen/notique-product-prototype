import { firstString } from "./claim-fields.ts";

export function readingPriority(item: Record<string, unknown>): number {
  const text = firstString(item, ["text", "statement", "title"]) || "";
  const type = firstString(item, ["type", "claim_type", "kind"]) || "";
  if (type === "budget" || /预算|最高价|\b(?:budget|price[- ]target|maximum|price cap)\b/i.test(text)) return 0;
  if (/[$€£¥]/.test(text)) return 1;
  if (["risk", "open_question", "concern"].includes(type) || /尚未|未确认|冲突|\b(?:not yet|unresolved|subject to|until|not approved)\b/i.test(text)) return 2;
  if (["requirement", "timing"].includes(type) || /必须|截止|\b(?:requires?|must|need|deadline|bedrooms?|bathrooms?|move.in)\b/i.test(text)) return 3;
  if (type === "next_action") return 4;
  return 5;
}

export function prioritizeSummarySections(sections: Record<string, unknown>[]): Record<string, unknown>[] {
  return sections.map((section, sectionIndex) => ({
    ...section,
    items: (Array.isArray(section.items) ? section.items : []).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map((item, itemIndex) => ({ ...item, item_key: item.item_key || `${sectionIndex}-${itemIndex}` })).sort((a, b) => readingPriority(a) - readingPriority(b)),
  })).sort((a, b) => Math.min(6, ...a.items.map(readingPriority)) - Math.min(6, ...b.items.map(readingPriority)));
}
