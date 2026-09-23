/**
 * 把一条记录搬到另一个项目，之前要先问的那些问题。
 *
 * 只有在没有任何人工决定压在这条记录上时才允许搬。归属建议是 overview 产物写完
 * 那一刻发出的，那时候还没有人确认过任何东西，所以真正需要搬的永远是刚进来的
 * 材料。已经审阅过的结论跨项目账本搬家是另一件事，也大得多：判断、关系、签字
 * 全都挂在原项目的账本版本上，把记录抽走等于把这些决定和它们的依据拆开。与其
 * 做一半，不如在这里拒绝，并且把拒绝的原因说清楚。
 *
 * 这个文件不碰数据库，只做两件事：把挡路的行数翻译成人看得懂的理由，以及生成
 * 搬动时重写归属的那条语句。
 */

/**
 * 同时带着 project_id 和 event_id 的表，记录搬家时这些表里的行要跟着改。
 *
 * 这份清单是唯一的事实来源，迁移级测试拿它跟真实表结构对一遍。以后新加一张
 * 同时带这两列的表，测试会当场失败，而不是等到某天发现有一批行还留在原项目。
 *
 * event_routing_suggestions 不在这里：它只有 event_id，而且搬完之后那条建议
 * 本身就失效了，仓储层直接删掉它。
 */
export const MOVED_TABLES = [
  "assets",
  "text_segments",
  "extraction_runs",
  "transcription_runs",
  "event_ai_artifact_runs",
  "event_ai_artifacts",
  "claims",
  "evidence_refs",
  "ai_draft_assessments",
  "claim_occurrence_candidates",
] as const;

export type MovedTable = (typeof MOVED_TABLES)[number];

/**
 * 重写一张表里归属列的那条语句。
 *
 * 语句文本放在这里而不是仓储层，是为了让迁移级测试跑的就是线上跑的那一条。
 * 表名只能从上面的常量来，不接受外部输入，所以拼进语句里是安全的。
 *
 * 条件里不带原项目 id：凡是挂在这条记录上的行都要跟着走，哪怕它因为历史原因
 * 记着另一个项目。漏掉一行比多改一行贵得多。
 */
export function eventMoveRewriteSql(table: MovedTable): string {
  return `UPDATE ${table} SET project_id = ? WHERE event_id = ? AND workspace_id = ?`;
}

/** 判定条件要的绑定值，按占位符在语句里出现的顺序列出来。 */
export type BlockerBind = "event" | "workspace" | "sourceProject" | "targetProject";

export type BlockerCheck = {
  key: keyof MoveBlockerCounts;
  sql: string;
  binds: readonly BlockerBind[];
};

export type BlockerContext = Record<BlockerBind, string>;

/**
 * 七类挡路的行，判定条件在这里写一份。
 *
 * 语句文本和上面那条重写语句一样留在这个文件里，理由也一样：预览和写入两条路径
 * 共用同一份条件，而测试要能拿真实的表结构把它跑一遍。写成两份的那一天，就是
 * 预览说可以搬、写入却按另一套标准悄悄放行的那一天；这两次判断之间隔着一个人
 * 思考的时间，足够另一个标签页把一条结论确认掉。
 *
 * 这个文件依然不碰数据库：它只生成语句，谁去执行、用哪个连接，都不归它管。
 */
export const MOVE_BLOCKER_CHECKS: readonly BlockerCheck[] = [
  {
    key: "verdicts",
    sql: `SELECT 1 FROM verdicts v
            JOIN claims c ON c.id = v.claim_id
           WHERE c.event_id = ? AND c.workspace_id = ?`,
    binds: ["event", "workspace"],
  },
  {
    key: "claimRelations",
    sql: `SELECT 1 FROM claim_relations r
           WHERE r.workspace_id = ?
             AND EXISTS (
               SELECT 1 FROM claim_versions cv
                 JOIN claims c ON c.id = cv.claim_id
                WHERE c.event_id = ?
                  AND cv.id IN (r.source_claim_version_id, r.target_claim_version_id)
             )`,
    binds: ["workspace", "event"],
  },
  {
    key: "evidenceAttestations",
    sql: `SELECT 1 FROM claim_evidence_review_attestations a
            JOIN claims c ON c.id = a.claim_id
           WHERE c.event_id = ? AND a.workspace_id = ?`,
    binds: ["event", "workspace"],
  },
  {
    key: "occurrenceDecisions",
    // claim_occurrences 只有 event_id，没有 project_id，所以它不会跟着搬。
    // 两个方向都要看：这条记录里确认过的重复，以及别处确认时指到了这条记录。
    sql: `SELECT 1 FROM claim_occurrences occ
           WHERE occ.event_id = ?
              OR EXISTS (
                SELECT 1 FROM claims c
                 WHERE c.id = occ.claim_id AND c.event_id = ? AND c.workspace_id = ?
              )
          UNION ALL
          SELECT 1 FROM occurrence_verdicts ov
            JOIN claim_occurrence_candidates cand ON cand.id = ov.candidate_id
           WHERE cand.event_id = ? AND cand.workspace_id = ?`,
    binds: ["event", "event", "workspace", "event", "workspace"],
  },
  {
    key: "crossEventLinks",
    // 这三种行都横跨两条记录。搬走一头，另一头还留在原项目，引用就成了空指。
    // 它们不是人工决定，但后果一样不可收拾，所以同样拦住。
    sql: `SELECT 1 FROM draft_link_candidates dl
           WHERE dl.workspace_id = ?
             AND EXISTS (
               SELECT 1 FROM claims c
                WHERE c.event_id = ?
                  AND c.id IN (dl.source_claim_id, dl.target_draft_claim_id)
             )
          UNION ALL
          SELECT 1 FROM claim_occurrence_candidates cand
            JOIN claims target ON target.id = cand.target_claim_id
           WHERE cand.event_id = ? AND cand.workspace_id = ?
             AND target.event_id <> cand.event_id
          UNION ALL
          SELECT 1 FROM claims c
           WHERE c.event_id = ? AND c.workspace_id = ?
             AND c.first_event_id <> c.event_id`,
    binds: ["workspace", "event", "event", "workspace", "event", "workspace"],
  },
  {
    key: "activeReviewSessions",
    // 审阅开始时记下了待办数量，中途两边的账本都变了，这一场就白算了。
    // 已经结束的场次只是历史，不拦。
    sql: `SELECT 1 FROM review_sessions rs
           WHERE rs.workspace_id = ? AND rs.status = 'active'
             AND rs.project_id IN (?, ?)`,
    binds: ["workspace", "sourceProject", "targetProject"],
  },
  {
    key: "scenarioAnchor",
    // 场景未确认时只有序号为 1 的记录能触发场景判定，别的记录一律被挡在分析之外。
    // 把第 1 条抽走，原项目剩下的记录就再也没人能替它们定场景了。原项目空了则无所谓。
    sql: `SELECT 1 FROM events e
            JOIN projects p ON p.id = e.project_id AND p.workspace_id = e.workspace_id
           WHERE e.id = ? AND e.workspace_id = ? AND e.sequence_no = 1
             AND p.scenario_status <> 'confirmed'
             AND EXISTS (
               SELECT 1 FROM events other
                WHERE other.project_id = p.id AND other.id <> e.id
             )`,
    binds: ["event", "workspace"],
  },
];

/** 一次把七类都数出来的语句，列名就是 MoveBlockerCounts 的字段名。 */
export function moveBlockerCountsSql(): string {
  return `SELECT ${MOVE_BLOCKER_CHECKS
    .map((check) => `(SELECT COUNT(*) FROM (${check.sql})) AS ${check.key}`)
    .join(", ")}`;
}

/** 守卫里那半句：七类一个都不许有。 */
export function moveBlockerGuardSql(): string {
  return MOVE_BLOCKER_CHECKS.map((check) => `NOT EXISTS (${check.sql})`).join(" AND ");
}

/** 上面两条语句的绑定值。顺序跟着 MOVE_BLOCKER_CHECKS 走，两边共用同一份。 */
export function moveBlockerBinds(context: BlockerContext): string[] {
  return MOVE_BLOCKER_CHECKS.flatMap((check) => check.binds.map((name) => context[name]));
}

export type MoveBlockerCounts = {
  /** 人工对这条记录的结论下过的判断。 */
  verdicts: number;
  /** 这条记录的结论参与的结论关系。 */
  claimRelations: number;
  /** 人工签过字的证据核对。 */
  evidenceAttestations: number;
  /** 已确认的重复出现，以及对重复候选下过的判断。 */
  occurrenceDecisions: number;
  /** 指向本记录之外的引用：草稿关联、重复候选的目标结论、重复结论的首次出处。 */
  crossEventLinks: number;
  /** 原项目或目标项目里正在进行的审阅。 */
  activeReviewSessions: number;
  /** 这条记录是原项目的第一条，而原项目还有别的记录靠它定场景。 */
  scenarioAnchor: number;
};

/**
 * 每一类的理由。
 *
 * 顺序就是展示顺序：先说人工决定，再说引用关系，最后说时机问题。前两类是「这辈子
 * 都别搬了」，最后两类是「现在别搬」，混在一起人分不清哪条还有救。
 */
const REASONS: ReadonlyArray<[keyof MoveBlockerCounts, (count: number) => string]> = [
  ["verdicts", (n) => `已经人工判过 ${n} 条结论，判断记在原项目的账本上，搬走会让它和依据对不上。`],
  ["claimRelations", (n) => `这条记录的结论参与了 ${n} 条结论关系，关系的另一头还留在原项目。`],
  ["evidenceAttestations", (n) => `有 ${n} 条证据核对已经人工签过字。`],
  ["occurrenceDecisions", (n) => `有 ${n} 条重复出现的结论已经人工处理过。`],
  ["crossEventLinks", (n) => `有 ${n} 处引用指着原项目里的别的记录，搬走之后这些引用会落空。`],
  ["activeReviewSessions", (n) => `有 ${n} 场审阅正在进行，等它结束再搬。`],
  ["scenarioAnchor", () => "这条是原项目的第一条记录，原项目还有别的记录等着它定场景，搬走之后那些记录就分析不了了。"],
];

export type MovePlace = {
  sourceProjectId: string;
  targetProjectId: string;
};

/**
 * 搬去的地方本身就不成立。
 *
 * 单拎出来是因为它和上面那些理由不是一回事：那些是数据状态，这条是调用参数错了，
 * 没有「等一等再搬」的说法。
 */
export function sameProjectBlocker(place: MovePlace): string | null {
  const target = place.targetProjectId.trim();
  if (!target) return "没有说要搬到哪个项目。";
  if (target === place.sourceProjectId.trim()) return "这条记录已经在这个项目里了。";
  return null;
}

/** 把挡路的行数翻译成理由。数目为零、为负、不是有效数字的都不出声。 */
export function moveBlockers(counts: MoveBlockerCounts, place?: MovePlace): string[] {
  const reasons: string[] = [];
  const placeBlocker = place ? sameProjectBlocker(place) : null;
  if (placeBlocker) reasons.push(placeBlocker);
  for (const [key, describe] of REASONS) {
    const count = Math.floor(Number(counts[key]));
    if (Number.isFinite(count) && count > 0) reasons.push(describe(count));
  }
  return reasons;
}

/** 能不能搬。只看数据状态，搬去哪里由 sameProjectBlocker 单独判。 */
export function canMoveEvent(counts: MoveBlockerCounts): boolean {
  return moveBlockers(counts).length === 0;
}
