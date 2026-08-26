/**
 * Human labels for the claim and evidence types the model may return.
 * Shared so the page, the overview list and the tests agree on one mapping.
 */
export function typeLabel(value?: string): string {
  const labels: Record<string, string> = {
    fact: "事实",
    preference: "偏好",
    commitment: "承诺",
    decision: "决定",
    risk: "风险",
    open_question: "待确认问题",
    question: "待确认问题",
    requirement: "要求",
    next_action: "下一步行动",
    budget: "预算",
    person_role: "人员与职责",
    property_fact: "对象事实",
    concern: "顾虑",
    other: "其他重要信息",
    constraint: "限制",
    direct: "直接证据",
    corroborating: "佐证材料",
    contextual: "背景参考",
  };
  return labels[(value ?? "").toLowerCase()] ?? (value || "记录").replaceAll("_", " ");
}
