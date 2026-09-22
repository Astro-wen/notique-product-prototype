import { getBindings, getD1 } from "@/db";
import { suggestionAllowed } from "@/lib/domain/material-routing";
import {
  overviewExcerpt,
  routingCandidates,
  routingDecision,
  type RoutingCandidateInput,
} from "@/lib/domain/project-routing";
import { parseJson } from "@/lib/server/http/api";
import { createJevProjectRouter } from "@/lib/server/ai/jev-project-router";
import {
  readEventRoutingSource,
  writeRoutingSuggestion,
} from "@/lib/server/db/routing-suggestion-repository";

/**
 * 第三层的触发点：overview 产物写完之后，问一次这份材料是不是属于别的项目。
 *
 * 三条硬约束，顺序就是下面代码的顺序：
 * 一，开关默认关着，接进主链路不改变今天的任何行为；
 * 二，用户在选择器里选过的材料一律不问，这是产品决定不是优化；
 * 三，整段只在后台跑，任何失败都吞掉。它的成败与产物任务无关，产物已经写完了，
 *     再因为一个咨询性的判断把任务标成失败是把可选项变成故障面。
 *
 * 永远不搬东西：这里只写一条建议，界面之后自己决定要不要展示。
 */

type Row = Record<string, unknown>;

/** 候选先按最近更新取这么多，再交给 routingCandidates 去掉时间戳名并截断。 */
const CANDIDATE_SCAN_LIMIT = 60;

function enabled(): boolean {
  const flag = getBindings().PROJECT_ROUTING_ENABLED?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

/** overview 的正文；章节标题另取，当目录用。 */
async function materialFor(eventId: string): Promise<{ overview: string; chapterTitles: string[] } | null> {
  const rows = (await getD1()
    .prepare(
      `SELECT a.kind, a.content_json
         FROM event_ai_artifacts a
         JOIN event_ai_artifact_runs r ON r.id = a.run_id
        WHERE a.event_id = ? AND r.status = 'succeeded' AND a.kind IN ('overview', 'chapters')
        ORDER BY a.artifact_version ASC`,
    )
    .bind(eventId)
    .all<Row>()).results ?? [];

  let overview = "";
  let chapterTitles: string[] = [];
  for (const row of rows) {
    const content = parseJson<Record<string, unknown>>(String(row.content_json ?? "{}"), {});
    if (String(row.kind) === "overview") {
      const sections = content.sections as Array<{ items?: Array<{ text?: string }> }> | undefined;
      overview = overviewExcerpt(sections, 1_200);
    } else {
      const chapters = content.chapters as Array<{ title?: string }> | undefined;
      chapterTitles = (chapters ?? [])
        .map((chapter) => String(chapter.title ?? "").trim())
        .filter(Boolean);
    }
  }
  return overview ? { overview, chapterTitles } : null;
}

async function candidatesFor(workspaceId: string, ownProjectId: string): Promise<RoutingCandidateInput[]> {
  const rows = (await getD1()
    .prepare(
      `SELECT p.id, p.name, p.folder_name, p.scenario, p.updated_at,
              (SELECT a.content_json
                 FROM event_ai_artifacts a
                 JOIN event_ai_artifact_runs r ON r.id = a.run_id
                WHERE a.project_id = p.id AND a.kind = 'overview' AND r.status = 'succeeded'
                ORDER BY a.created_at DESC LIMIT 1) AS overview_json
         FROM projects p
        WHERE p.workspace_id = ? AND p.deleted_at IS NULL AND p.id <> ?
        ORDER BY p.updated_at DESC
        LIMIT ?`,
    )
    .bind(workspaceId, ownProjectId, CANDIDATE_SCAN_LIMIT)
    .all<Row>()).results ?? [];

  return rows.map((row) => {
    const content = row.overview_json
      ? parseJson<Record<string, unknown>>(String(row.overview_json), {})
      : {};
    const sections = content.sections as Array<{ items?: Array<{ text?: string }> }> | undefined;
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      folderName: row.folder_name == null ? null : String(row.folder_name),
      scenarioLabel: row.scenario == null ? null : String(row.scenario),
      lastOverviewExcerpt: overviewExcerpt(sections) || null,
      updatedAt: row.updated_at == null ? null : String(row.updated_at),
    };
  });
}

/**
 * 跑一次归属判断，只在过阈值时落一条建议。
 *
 * 返回值只为测试和日志服务；调用方不应该据此判成败，见下面的 fire-and-forget 包装。
 */
export async function suggestProjectRouting(input: {
  eventId: string;
  workspaceId: string;
  projectId: string;
}): Promise<"disabled" | "user_chose" | "no_candidates" | "silent" | "suggested"> {
  if (!enabled()) return "disabled";

  const source = await readEventRoutingSource(input.eventId);
  // 用户已经说过这份材料放哪了。再问一遍就是在质疑他刚做完的决定。
  if (!suggestionAllowed(source)) return "user_chose";

  const router = createJevProjectRouter({ apiKey: getBindings().JEV_API_KEY });
  if (!router) return "disabled";

  const material = await materialFor(input.eventId);
  if (!material) return "no_candidates";

  const candidates = routingCandidates(await candidatesFor(input.workspaceId, input.projectId));
  if (!candidates.length) return "no_candidates";

  const decision = routingDecision(await router.route(material, candidates));
  if (decision.kind !== "suggest") return "silent";

  await writeRoutingSuggestion({
    eventId: input.eventId,
    workspaceId: input.workspaceId,
    suggestedProjectId: decision.projectId,
    probability: decision.probability,
    judge: router.name,
  });
  return "suggested";
}

/**
 * 产物任务里调这个，不要调上面那个。
 *
 * 不 await，也不让任何异常冒出去：overview 已经写完了，这一层是附加的。
 */
export function scheduleProjectRoutingSuggestion(input: {
  eventId: string;
  workspaceId: string;
  projectId: string;
}): void {
  void suggestProjectRouting(input).catch(() => {});
}
