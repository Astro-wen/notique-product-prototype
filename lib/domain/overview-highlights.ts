/**
 * 全文概要里的关键数字：金额、百分比、日期、时长、面积、房间数。
 *
 * 用规则标，不让模型标：模型两次跑出来标的不一样，还多花输出 token；规则零成本、
 * 每次一致。标出来的片段两种去处：能对上一条结论的，点了打开那条结论去核对；
 * 对不上的，点了跳回概要这句引用的原话。
 */

export type OverviewPiece =
  | { kind: "text"; text: string }
  | { kind: "figure"; text: string; claimId: string | null };

const FIGURE = new RegExp(
  [
    // 金额：$220,000、$1,600/month、120 万美元、220k
    String.raw`(?:[$€£¥]\s?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?(?:k|K|million|m)(?![A-Za-z]))?(?:\s?(?:per|a|\/)\s?(?:month|mo|year|yr|week)(?![A-Za-z]))?)`,
    String.raw`(?:\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:万|亿)?\s?(?:美元|美金|元|块|人民币|dollars?))`,
    // 百分比
    String.raw`(?:\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:%|percent|个点))`,
    // 日期与月份
    // 月份区分大小写：不区分的话 may、march 这些普通词全会被标上。缩写后的句点只在跟着日期时吃掉。
    String.raw`(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)(?:\.(?=\s\d))?)(?:\s\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s\d{4})?)`,
    String.raw`(?:\d{4}\s?年(?:\s?\d{1,2}\s?月(?:\s?\d{1,2}\s?[日号])?)?|\d{1,2}\s?月(?:\s?\d{1,2}\s?[日号])?)`,
    String.raw`(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)`,
    // 时长
    String.raw`(?:\d(?:[\d,]*\d)?(?:\.\d+)?[\s-]?(?:years?|months?|weeks?|days?|hours?|minutes?|年|个月|周|天|小时|分钟)(?![A-Za-z]))`,
    // 面积、距离、房间数
    String.raw`(?:\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:acres?|sq\.?\s?ft|square feet|sqft|平米|平方米|坪|miles?|km|公里))`,
    String.raw`(?:\d+(?:\.\d+)?[\s-]?(?:bed(?:room)?s?|bath(?:room)?s?|story|stories|室|厅|卫|居|层))`,
  ].join("|"),
  "gu",
);

/** 只留数字，用来把片段和结论对上：$220,000 和 220,000 dollars 都是 220000。 */
export function figureDigits(text: string): string {
  return text.replace(/[^\d.]/g, "").replace(/\.$/, "");
}

/**
 * 把一句概要切成普通文字和关键数字片段。
 * claims 里哪条结论的陈述包含同样的数字，就把片段挂到那条结论上；多条都含时取第一条。
 */
export function splitOverviewFigures(
  text: string,
  claims: ReadonlyArray<{ id: string; statement: string }> = [],
): OverviewPiece[] {
  const pieces: OverviewPiece[] = [];
  const claimDigits = claims.map((claim) => ({ id: claim.id, digits: figureDigits(claim.statement) }));
  let last = 0;
  for (const match of text.matchAll(FIGURE)) {
    const start = match.index ?? 0;
    const figure = match[0];
    // 两位以下的裸数字后面跟着单位才算，避免把「三个」「2 人」这种全标上；这里正则已经要求单位。
    if (start > last) pieces.push({ kind: "text", text: text.slice(last, start) });
    const digits = figureDigits(figure);
    const claim = digits.length >= 2 ? claimDigits.find((item) => item.digits.includes(digits)) ?? null : null;
    pieces.push({ kind: "figure", text: figure, claimId: claim?.id ?? null });
    last = start + figure.length;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}
