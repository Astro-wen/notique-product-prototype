/**
 * Shared display formatters. They live in the domain layer so both the page
 * and the extracted components render a timestamp identically.
 */
export function formatTimestamp(value?: string | number): string {
  if (value == null || value === "") return "无法定位具体时间";
  if (typeof value === "string" && value.includes(":")) return value;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return String(value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
