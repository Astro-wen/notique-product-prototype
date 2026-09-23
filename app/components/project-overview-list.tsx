"use client";

import { useMemo, useState } from "react";
import { firstString } from "@/lib/domain/claim-fields";
import {
  projectOverviewSectionFor,
  projectOverviewSections,
  type ProjectOverviewSection,
} from "@/lib/domain/project-overview";
import { readingPriority } from "@/lib/domain/ux-priority";
import { formatDate } from "@/lib/domain/project-label";
import { typeLabel } from "@/lib/domain/labels";
import { Search, ArrowUpRight, X } from "lucide-react";

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
  const [query, setQuery] = useState("");

  const rows = useMemo(() => [
    ...trusted.map((item) => ({ item, verified: true, section: projectOverviewSectionFor(item) })),
    ...drafts.map((item) => ({ item, verified: false, section: projectOverviewSectionFor(item) })),
  ].sort((a, b) => readingPriority(a.item) - readingPriority(b.item)), [drafts, trusted]);

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
    && (!query.trim() || (firstString(row.item, ["statement", "text", "title"]) || "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
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
    <div className="overview-toolbar">
      <div className="overview-tally"><strong>{rows.length} 条记录</strong><span>{verifiedTotal} 已确认</span>{rows.length > verifiedTotal && <span className="overview-pending">{rows.length - verifiedTotal} 待核对</span>}</div>
      <label className="overview-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索项目记录" placeholder="搜索预算、条件、房源…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="清除搜索" onClick={() => setQuery("")}><X size={14} /></button>}</label>
    </div>
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
      {visible.map((row, index) => {
        const id = firstString(row.item, ["claim_id", "claimId", "claim_version_id"]);
        const statement = firstString(row.item, ["statement", "text", "title"]) || "未命名记录";
        const type = firstString(row.item, ["type", "claim_type"]) || "other";
        const date = firstString(row.item, ["occurredAt", "occurred_at", "event_date", "updated_at", "updatedAt"]);
        const evidenceCount = Array.isArray(row.item.evidence_ref_ids) ? row.item.evidence_ref_ids.length : 0;
        return <article className={`project-overview-row${row.verified ? " verified" : " draft"}`} key={id || `${row.section}-${index}`}>
          <span className="overview-record-type">{typeLabel(type)}</span>
          <div className="overview-record-body">
            {id ? <button className="overview-record-title" onClick={() => onOpenClaim(id)}>{statement}<ArrowUpRight size={16} aria-hidden="true" /></button> : <p className="overview-record-title">{statement}</p>}
            <div className="overview-record-meta">{evidenceCount > 0 && <span>{evidenceCount} 条原始依据</span>}{date && <time title="记录日期">{formatDate(date)}</time>}</div>
          </div>
          <span className="project-overview-status">{row.verified ? "已确认" : "待核对"}</span>
        </article>;
      })}
    </div> : <div className="overview-empty"><Search size={24} aria-hidden="true" /><strong>{query ? "没有找到匹配的记录" : "没有符合筛选的记录"}</strong><p>{query ? "换一个关键词，或清除筛选再试。" : activeSection?.empty || "试试其他类型。"}</p><button className="text-button" onClick={() => { setQuery(""); setFilter("all"); setVerifiedOnly(false); }}>显示全部记录</button></div>}

  </div>;
}
