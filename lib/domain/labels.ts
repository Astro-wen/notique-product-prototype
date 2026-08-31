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
    measurement: "尺寸与数量",
    person_role: "人员与职责",
    property_fact: "对象事实",
    concern: "顾虑",
    other: "其他重要信息",
    constraint: "限制",
    direct: "直接证据",
    corroborating: "佐证材料",
    contextual: "背景参考",
    meeting: "会议",
    showing: "现场沟通",
    estimate: "估价",
    walkthrough: "现场巡查",
    transcript: "逐字稿",
    photo: "照片",
    pdf: "PDF",
    text: "文本",
    audio: "录音",
  };
  return labels[(value ?? "").toLowerCase()] ?? "其他信息";
}

/**
 * Section names for the AI summary. The model returns a machine kind and an
 * English title; rendering the kind verbatim printed "OVERVIEW" directly above
 * "Overview". The reader gets a name in their own language instead.
 */
export function summarySectionLabel(value?: string): string {
  const labels: Record<string, string> = {
    overview: "整体情况",
    key_fact: "关键事实",
    decision: "决定",
    preference: "偏好",
    open_question: "待确认问题",
    risk: "风险",
    next_step: "下一步",
  };
  return labels[(value ?? "").toLowerCase()] ?? "";
}
