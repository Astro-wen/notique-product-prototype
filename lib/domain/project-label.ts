/**
 * Project option labelling. Duplicate project names must stay distinguishable
 * in a selector without ever renaming the stored project.
 */
export type ProjectSelectionInput = {
  id: string;
  name: string;
  eventCount?: number;
  updatedAt?: string;
};

export function formatDate(value?: string, includeTime = false): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", includeTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export function projectSelectionLabel<T extends ProjectSelectionInput>(item: T, projects: T[]): string {
  const displayName = item.name.startsWith("[SYNTHETIC]")
    ? `现成案例：${item.name.replace(/^\[SYNTHETIC\]\s*/, "")}`
    : item.name;
  const normalizedName = item.name.trim().toLocaleLowerCase();
  const duplicates = projects.filter((candidate) => candidate.name.trim().toLocaleLowerCase() === normalizedName);
  if (duplicates.length < 2) return displayName;

  const eventCount = item.eventCount == null ? "沟通数待同步" : `${item.eventCount} 次沟通`;
  const updatedAt = item.updatedAt ? `更新 ${formatDate(item.updatedAt, true)}` : "更新时间未记录";
  const sameDetails = duplicates.filter((candidate) => (
    candidate.eventCount === item.eventCount
    && (candidate.updatedAt || "") === (item.updatedAt || "")
  ));
  const uniqueSuffix = sameDetails.length > 1 ? ` · ${item.id.slice(-6)}` : "";
  return `${displayName} · ${eventCount} · ${updatedAt}${uniqueSuffix}`;
}
