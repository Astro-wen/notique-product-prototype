export type RawTranscriptSegmentForDiff = {
  id: string;
  ordinal: number;
  text: string;
};

export type ReadableDiffRisk = "amount_or_date" | "negation" | "responsibility";

export type ReadableDiffPart = {
  value: string;
  added: boolean;
  removed: boolean;
  risks: ReadableDiffRisk[];
};

export type ReadableWordDiffResult =
  | {
      status: "ready";
      parts: ReadableDiffPart[];
      risks: ReadableDiffRisk[];
    }
  | {
      status: "fallback";
      reason: "empty_source" | "too_long" | "diff_aborted";
    };

export const READABLE_PARAGRAPH_DIFF_LIMITS = {
  maxTextCharacters: 12_000,
  maxEditLength: 2_000,
  timeoutMs: 80,
} as const;

const amountOrDatePattern = new RegExp([
  "[$€£¥￥%]",
  "\\b\\d+(?:[,.]\\d+)*(?:st|nd|rd|th)?\\b",
  "\\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\\b",
  "\\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b",
  "(?:年|月|日|号|点|分钟|小时|万|千|百|亿)",
].join("|"), "iu");

const negationPattern = /\b(?:no|not|never|none|cannot|can't|cant|won't|wont|don't|dont|doesn't|doesnt|isn't|isnt|aren't|arent|without|reject(?:ed|s|ing)?)\b|(?:不|没|无|未|否|不能|不会|不要|拒绝)/iu;
const responsibilityPattern = /\b(?:responsib(?:le|ility)|owner|assignee|approve|approval|approver|decision[ -]?maker|buyer|seller|agent)\b|(?:负责|责任|审批|批准|决策人|经纪人|买方|卖方|业主)/iu;

export function mappedRawParagraph(
  sourceSegmentIds: string[],
  rawSegments: RawTranscriptSegmentForDiff[],
): { text: string; missingIds: string[] } {
  const byId = new Map(rawSegments.map((segment) => [segment.id, segment]));
  const missingIds: string[] = [];
  const mapped = sourceSegmentIds.flatMap((id) => {
    const segment = byId.get(id);
    if (!segment) {
      missingIds.push(id);
      return [];
    }
    return [segment];
  });

  return {
    // Keep the Artifact's explicit source order. A readable paragraph may map
    // to several adjacent raw Segments, but it must never diff against the
    // entire transcript or text inferred from the model's edit list.
    text: mapped.map((segment) => segment.text).join("\n"),
    missingIds,
  };
}

export function risksForReadableChange(value: string): ReadableDiffRisk[] {
  const risks: ReadableDiffRisk[] = [];
  if (amountOrDatePattern.test(value)) risks.push("amount_or_date");
  if (negationPattern.test(value)) risks.push("negation");
  if (responsibilityPattern.test(value)) risks.push("responsibility");
  return risks;
}

export async function buildReadableWordDiff(
  rawText: string,
  readableText: string,
): Promise<ReadableWordDiffResult> {
  if (!rawText.trim()) return { status: "fallback", reason: "empty_source" };
  if (
    rawText.length > READABLE_PARAGRAPH_DIFF_LIMITS.maxTextCharacters
    || readableText.length > READABLE_PARAGRAPH_DIFF_LIMITS.maxTextCharacters
  ) {
    return { status: "fallback", reason: "too_long" };
  }

  // Keep jsdiff out of the initial transcript bundle. This function is called
  // only after the user expands one readable paragraph's comparison.
  const { diffWords } = await import("diff");
  const changes = diffWords(rawText, readableText, {
    timeout: READABLE_PARAGRAPH_DIFF_LIMITS.timeoutMs,
    maxEditLength: READABLE_PARAGRAPH_DIFF_LIMITS.maxEditLength,
  });
  if (!changes) return { status: "fallback", reason: "diff_aborted" };

  const parts = changes.map((change) => ({
    value: change.value,
    added: change.added,
    removed: change.removed,
    risks: change.added || change.removed ? risksForReadableChange(change.value) : [],
  }));
  const risks = [...new Set(parts.flatMap((part) => part.risks))];
  return { status: "ready", parts, risks };
}
