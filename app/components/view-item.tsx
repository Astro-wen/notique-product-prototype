import { firstString, stringValue } from "@/lib/domain/claim-fields";
import { formatDate } from "@/lib/domain/project-label";
import { typeLabel } from "@/lib/domain/labels";

export function ViewItem({ item, onOpenClaim }: { item: Record<string, unknown>; onOpenClaim: (id: string) => void }) {
  const title = firstString(item, ["statement", "displayText", "display_text", "summary", "title", "question", "label", "text", "slot", "delta_text", "current_value"]) ?? "已确认记录";
  const description = firstString(item, ["description", "reason", "detail", "answer", "change", "previous_value"]);
  const type = firstString(item, ["type", "claim_type", "sourceKind", "source_kind", "delta_type", "status", "materiality"]);
  const date = firstString(item, ["occurredAt", "occurred_at", "event_date", "openedAt", "opened_at", "updatedAt", "updated_at", "createdAt", "created_at"]);
  const claimId = firstString(item, ["claim_id", "claimId"]);
  const versionId = firstString(item, ["claim_version_id", "claimVersionId", "version_id"]);
  const rejected = item.rejectedOptions ?? item.rejected_options;
  const selected = stringValue(item.selectedOption ?? item.selected_option);
  const reason = stringValue(item.reason);
  const openDays = typeof (item.openDays ?? item.open_days) === "number" ? Number(item.openDays ?? item.open_days) : undefined;
  const repeatCount = typeof (item.repeatCount ?? item.repeat_count) === "number" ? Number(item.repeatCount ?? item.repeat_count) : undefined;
  const evidenceIds = Array.isArray(item.evidence_ref_ids) ? item.evidence_ref_ids.map(stringValue).filter(Boolean) : [];
  return (
    <article className="view-card">
      <div className="view-card-top">
        <div>{type && <span className="eyebrow">{typeLabel(type)}</span>}<h3>{title}</h3></div>
        {date && <time>{formatDate(date)}</time>}
      </div>
      {description && description !== title && <p>{description}</p>}
      {selected && <p><b>已选择：</b>{selected}</p>}
      {Array.isArray(rejected) && <p><b>未选择：</b>{rejected.map(stringValue).filter(Boolean).join("、") || "尚未记录"}</p>}
      {reason && reason !== description && <p><b>原因：</b>{reason}</p>}
      {(openDays !== undefined || repeatCount !== undefined) && <p>{openDays !== undefined ? `已开放 ${openDays} 天` : ""}{openDays !== undefined && repeatCount !== undefined ? " · " : ""}{repeatCount !== undefined ? `在 ${repeatCount} 次后续沟通中再次出现` : ""}</p>}
      {evidenceIds.length > 0 && <p>{evidenceIds.length} 条原始证据</p>}
      {(claimId || versionId) && <button className="text-button" onClick={() => onOpenClaim(claimId || versionId!)}>查看记录与证据</button>}
    </article>
  );
}
