import { firstString } from "./claim-fields.ts";

export type ProjectOverviewSection = "facts" | "requirements" | "preferences" | "people" | "subjects" | "questions" | "actions";

export const projectOverviewSections: Array<{ key: ProjectOverviewSection; label: string; empty: string }> = [
  { key: "facts", label: "关键事实", empty: "还没有已整理的关键事实" },
  { key: "requirements", label: "需求与约束", empty: "还没有确认需求或约束" },
  { key: "preferences", label: "偏好与条件", empty: "还没有偏好或适用条件" },
  { key: "people", label: "相关人员与职责", empty: "还没有确认相关人员或职责" },
  { key: "subjects", label: "关键对象与反馈", empty: "还没有对象或反馈记录" },
  { key: "questions", label: "未决问题与风险", empty: "目前没有未决问题或风险" },
  { key: "actions", label: "下一步行动", empty: "目前没有下一步行动" },
];

export function projectOverviewSectionFor(item: Record<string, unknown>): ProjectOverviewSection {
  const type = firstString(item, ["type", "claim_type"]) || "";
  const text = firstString(item, ["statement", "title", "text", "summary"]) || "";
  const dealbreaker = /deal.?breaker|must not|cannot accept|won't accept|unacceptable|绝不|不能接受|无法接受|排除/i.test(text);
  const explicitDecisionMaker = /\bdecision[- ]makers?\b|\bboth\b.{0,40}\b(?:must|need to) approve\b|\b(?:must|need(?:s)? to)\s+both\s+approve\b|\bjoint (?:buyer )?approval\b|\bcannot commit (?:for|on behalf of) both(?:\s+buyers?)?\b|\bfinal (?:approval|decision) (?:belongs to|rests with)\b|决策人|共同批准|双方(?:都)?(?:需要|必须)批准|共同决定|最终决定权/i.test(text);
  const nextActionSignal = /\b(?:next step|follow[- ]?up)\b|\b(?:will|needs? to|must|plans? to|is going to)\s+(?:send|provide|confirm|verify|check|ask|schedule|book|order|purchase|submit|sign|call|contact|follow up|review|inspect|update|obtain|upload|arrange|deliver|prepare|complete|move)\b|下一步|(?:将|需要)(?:发送|提供|确认|核实|检查|询问|安排|预约|提交|签署|联系|跟进|购买|准备|完成)/i.test(text);
  const concreteProperty = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Court|Ct\.?|Lane|Ln\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Way)\b/.test(text)
    || /\b[A-Z][A-Za-z0-9.'-]+(?:\s+[A-Z][A-Za-z0-9.'-]+){0,2}\s+(?:Street|Avenue|Road|Court|Lane|Drive|Boulevard|Way)\b/.test(text)
    || /\S+(?:路|街|大道|巷)\d+号/.test(text);
  const showingFeedback = /\b(?:showing|viewing|open house|home tour)\b|看房(?:反馈)?|房源反馈/i.test(text);
  const subjectSignal = concreteProperty
    || showingFeedback
    || /\b(?:property|listing|claim|damage|repair|estimate|quote|contract|document|invoice|asset|case)\b|房源|索赔|损坏|维修|报价|合同|文件|材料|案件/i.test(text);

  if (type === "next_action") return "actions";
  if (type === "person_role" || explicitDecisionMaker) return "people";
  if (type === "open_question" || type === "risk" || type === "concern") return "questions";
  if (type === "requirement" || type === "budget" || type === "timing" || /financ|mortgage|pre.?approv|loan|预算|融资|贷款|按揭|期限|截止|deadline/i.test(text)) return "requirements";
  if (nextActionSignal) return "actions";
  if (type === "property_fact" || concreteProperty || showingFeedback) return "subjects";
  if (type === "preference" || dealbreaker) return "preferences";
  if (subjectSignal) return "subjects";
  return "facts";
}
