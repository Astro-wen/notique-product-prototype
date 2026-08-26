"use client";

import { useMemo, useState } from "react";
import { firstString } from "@/lib/domain/claim-fields";
import {
  projectOverviewSectionFor,
  projectOverviewSections,
  type ProjectOverviewSection,
} from "@/lib/domain/project-overview";
import { ViewItem } from "./view-item";

type OverviewFilter = ProjectOverviewSection | "all";

/**
 * One ranked list with type filters rather than a fixed grid of sections.
 *
 * Real project data is long-tailed: across production claims a single section
 * can hold nearly half the records while two others hold none. A fixed grid
 * renders that as one overflowing box beside several empty ones, so the
 * grouping becomes a filter and every row keeps its own type label.
 *
 * Draft and verified records share the list and are told apart by a status
 * chip, because the product's core distinction is per record, not per column.
 */
export function ProjectOverviewList({
  drafts,
  trusted,
  onOpenClaim,
}: {
  drafts: Record<string, unknown>[];
  trusted: Record<string, unknown>[];
  onOpenClaim: (id: string) => void;
}) {
  const [filter, setFilter] = useState<OverviewFilter>("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  const rows = useMemo(() => [
    ...trusted.map((item) => ({ item, verified: true, section: projectOverviewSectionFor(item) })),
    ...drafts.map((item) => ({ item, verified: false, section: projectOverviewSectionFor(item) })),
  ], [drafts, trusted]);

  const counts = useMemo(() => {
    const tally = new Map<ProjectOverviewSection, number>();
    for (const row of rows) {
      if (verifiedOnly && !row.verified) continue;
      tally.set(row.section, (tally.get(row.section) ?? 0) + 1);
    }
    return tally;
  }, [rows, verifiedOnly]);

  const visible = rows.filter((row) => (
    (!verifiedOnly || row.verified) && (filter === "all" || row.section === filter)
  ));
  const total = rows.filter((row) => !verifiedOnly || row.verified).length;
  const verifiedTotal = rows.filter((row) => row.verified).length;
  // An empty section is not a place the reader can go, so it is never offered.
  const offered = projectOverviewSections.filter((section) => (counts.get(section.key) ?? 0) > 0);
  const activeSection = projectOverviewSections.find((section) => section.key === filter);

  if (rows.length === 0) {
    return <p className="muted">还没有整理出项目记录。完成一次分析后，这里会显示关键事实、需求、负责人和下一步。</p>;
  }

  return <div className="project-overview">
    <div className="project-overview-filters" role="group" aria-label="按类型筛选项目记录">
      <button
        className={filter === "all" ? "active" : ""}
        aria-pressed={filter === "all"}
        onClick={() => setFilter("all")}
      >全部<span>{total}</span></button>
      {offered.map((section) => <button
        key={section.key}
        className={filter === section.key ? "active" : ""}
        aria-pressed={filter === section.key}
        onClick={() => setFilter(section.key)}
      >{section.label}<span>{counts.get(section.key)}</span></button>)}
      <label className="project-overview-verified">
        <input
          type="checkbox"
          checked={verifiedOnly}
          onChange={(event) => setVerifiedOnly(event.target.checked)}
        />
        只看已确认{verifiedTotal > 0 && <span>{verifiedTotal}</span>}
      </label>
    </div>

    {visible.length > 0 ? <div className="project-overview-rows">
      {visible.map((row, index) => <div
        className={`project-overview-row${row.verified ? " verified" : " draft"}`}
        key={firstString(row.item, ["claim_id", "claimId", "claim_version_id"]) || `${row.section}-${index}`}
      >
        <span className="project-overview-status">{row.verified ? "已确认" : "AI 草稿"}</span>
        <ViewItem item={row.item} onOpenClaim={onOpenClaim} />
      </div>)}
    </div> : <p className="muted">
      {verifiedOnly && activeSection
        ? `“${activeSection.label}”下还没有人工确认的记录。`
        : activeSection?.empty ?? "没有符合当前筛选的记录。"}
    </p>}
  </div>;
}
