/** Highlight exact source wording. Navigation uses each sentence's evidence. */

export type OverviewPiece =
  | { kind: "text"; text: string }
  | { kind: "figure"; text: string };

const FIGURE = new RegExp(
  [
    // 金额：$220,000、$1,600/month、120 万美元、220k
    String.raw`(?:[$€£¥]\s?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?(?:k|K|million|m)(?![A-Za-z]))?(?:\s?(?:per|a|\/)\s?(?:month|mo|year|yr|week)(?![A-Za-z]))?)`,
    String.raw`(?:\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:万|亿)?\s?(?:美元|美金|元|块|人民币|dollars?))`,
    // 百分比
    String.raw`(?:\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:%|percent|个点))`,
    // 日期与月份
    // 月份区分大小写：不区分的话 may、march 这些普通词全会被标上。缩写后的句点只在跟着日期时吃掉。
    String.raw`(?<![A-Za-z])(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)(?:\.(?=\s\d))?)(?:\s\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s\d{4})?)(?![A-Za-z])`,
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

export function splitOverviewFigures(text: string): OverviewPiece[] {
  const pieces: OverviewPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(FIGURE)) {
    const start = match.index ?? 0;
    const figure = match[0];
    // 两位以下的裸数字后面跟着单位才算，避免把「三个」「2 人」这种全标上；这里正则已经要求单位。
    if (start > last) pieces.push({ kind: "text", text: text.slice(last, start) });
    pieces.push({ kind: "figure", text: figure });
    last = start + figure.length;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}
