/** Conservative correction for a status incorrectly emitted as a future action.
 * Never turn a negative fact into an inferred instruction or change mixed claims.
 */
export function classifyActionStatement(type: string, statement: string): string {
  if (type !== "next_action") return type;
  const text = statement.trim();
  if (/\b(will|should|must|needs? to|plans? to|agreed to|next|tomorrow|schedule|contact)\b|需要|将会|计划|安排|联系/.test(text.toLowerCase())) return type;
  const negativeFinancing = /^(?:the buyer|the client|he|she|they|curtis)\s+(?:has|have)\s+not\s+(?:yet\s+)?(?:obtained|received|secured)\s+(?:mortgage\s+)?pre[- ]?approval(?:\s+or\s+spoken\s+(?:with|to)\s+(?:a|the)\s+lender)?[.!]?$/i;
  const chineseStatus = /^(?:买家|客户)?(?:目前|当前)?(?:尚未|还未|没有)(?:获得|取得)(?:贷款|按揭)?预批[。！]?$/;
  return negativeFinancing.test(text) || chineseStatus.test(text) ? "property_fact" : type;
}
