/**
 * 按本机时钟分时段问候。
 *
 * 放在领域层而不是组件里，是因为服务端没有用户的时钟：渲染这一侧只能留空，
 * 由客户端补上。边界统一归后一档，午夜和正午都不会落回上一段。
 */
export function greetingFor(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}
