/**
 * 引用支持度判断。
 *
 * evidence_refs 上有一个字段叫 semantic_support_verdict，枚举是
 * fully_supports / partially_supports / does_not_support / unreviewed。名字像是
 * 一个语义判断，实际不是：抽取时一律写 unreviewed，人工确认时按 evidence_role
 * 机械映射（direct → fully_supports，corroborating → partially_supports）。
 * 没有任何代码路径会写出 does_not_support，等于系统默认"每条引用都支持它的
 * 陈述"。离线评估集上明明有 citationSupportPrecision 和 criticalCitationSupport
 * 两道门在测这件事，线上却没有对应的判断。这个模块补上线上那一半。
 *
 * 这是一个有界判断，不需要生成任何文字：陈述和原话两边都已经在手上，只问
 * 「这段原话支不支持这句陈述」。所以它可以交给任何一个只做判断的模型
 * （见 SupportJudge 接口），也可以先不接，只把问题记下来离线评估。
 *
 * 安全性质（整个设计的支点）：判断只能让一条记录变得更不可信，永远不能让它
 * 变得更可信。说"支持"时什么都不做，说"不支持"时才标出来。产品的立身之本是
 * 「只有你确认过的才进报告」，任何自动确认都会把它毁掉。
 */

export type SupportVerdict =
  | "fully_supports"
  | "partially_supports"
  | "does_not_support"
  | "unreviewed";

/** 一次判断要看的全部内容。两边都是已有数据，判断方不需要读原文全文。 */
export type SupportQuestion = {
  claimId: string;
  claimVersionId: string;
  evidenceRefId: string;
  /** 被核对的陈述。 */
  statement: string;
  /** 系统解析出来的原话。判断方只看它，不另外取材。 */
  quote: string;
  /** 模型给这条证据标的角色，作为先验参考，不作为答案。 */
  evidenceRole: string;
};

/** 判断方的回答。probability 是「支持」的校准概率。 */
export type JudgeAnswer = {
  evidenceRefId: string;
  /** 0 到 1。校准的含义是：说 0.9 的那批里应当约有九成真的支持。 */
  supportProbability: number;
};

/**
 * 只做判断、不生成文字的模型适配口。Jev 这类模型可以直接实现它，
 * 换成别的实现（甚至纯规则）也不影响上层。
 */
export interface SupportJudge {
  readonly name: string;
  judge(questions: SupportQuestion[]): Promise<JudgeAnswer[]>;
}

export type SupportJudgeThresholds = {
  /** 低于它才敢说「不支持」。默认偏保守：宁可沉默，不可错杀。 */
  notSupportedBelow: number;
  /** 高于它算「完全支持」，但这一档不触发任何动作。 */
  fullySupportedAbove: number;
};

export const DEFAULT_SUPPORT_THRESHOLDS: SupportJudgeThresholds = {
  notSupportedBelow: 0.2,
  fullySupportedAbove: 0.8,
};

export type SupportDecision = {
  evidenceRefId: string;
  verdict: SupportVerdict;
  supportProbability: number;
  /**
   * flag：标出来，并挡住一键确认，请人自己看。
   * downgrade：把显示的支持强度降一档，不挡操作。
   * silent：什么都不做。包括判断方说「支持」的情况。
   */
  action: "flag" | "downgrade" | "silent";
};

/**
 * 把一个概率翻译成动作。
 *
 * 三档里只有两档会动界面，而且都是朝「更不可信」的方向。说支持时一律沉默，
 * 因为让系统替人确认正是这个产品不能做的事。中间那段（不够低也不够高）同样
 * 沉默：一个拿不准的判断如果摆到界面上，只会让人分心。
 */
export function supportDecision(
  answer: JudgeAnswer,
  thresholds: SupportJudgeThresholds = DEFAULT_SUPPORT_THRESHOLDS,
): SupportDecision {
  const probability = clamp(answer.supportProbability);
  if (probability < thresholds.notSupportedBelow) {
    return {
      evidenceRefId: answer.evidenceRefId,
      verdict: "does_not_support",
      supportProbability: probability,
      action: "flag",
    };
  }
  if (probability > thresholds.fullySupportedAbove) {
    // 判断方说支持。这不构成任何凭据，界面照旧，仍然等人确认。
    return {
      evidenceRefId: answer.evidenceRefId,
      verdict: "fully_supports",
      supportProbability: probability,
      action: "silent",
    };
  }
  return {
    evidenceRefId: answer.evidenceRefId,
    verdict: "partially_supports",
    supportProbability: probability,
    action: "downgrade",
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * 判断结果能不能写进 evidence_refs。
 *
 * 只允许写「比现状更不可信」的值，且绝不覆盖人已经下过的结论。人工确认写入的
 * fully_supports / partially_supports 是有人负责的，机器判断不许改它。
 */
export function judgeMayWrite(current: SupportVerdict, proposed: SupportVerdict): boolean {
  if (current !== "unreviewed") return false;
  return proposed === "does_not_support" || proposed === "partially_supports";
}

/**
 * 判断方不可用时的行为：什么都不做。
 *
 * 这一层永远是咨询性的，不进主链路的成功条件。判断方挂了、超时了、还没接，
 * 系统的表现都和今天完全一样——人照样核对，报告照样出。
 */
export function decisionsFrom(
  questions: SupportQuestion[],
  answers: JudgeAnswer[] | null,
  thresholds: SupportJudgeThresholds = DEFAULT_SUPPORT_THRESHOLDS,
): SupportDecision[] {
  if (!answers?.length) return [];
  const asked = new Set(questions.map((question) => question.evidenceRefId));
  return answers
    .filter((answer) => asked.has(answer.evidenceRefId))
    .map((answer) => supportDecision(answer, thresholds));
}
