/**
 * 材料落到哪个项目的决定规则。
 *
 * 今天在首页拖进一份材料一律新建项目。加上选择器之后多了一条分叉，但分叉只有
 * 两种来源：用户自己点了一个项目（source "user"），或者他跳过了选择器
 * （source "skipped"，等于今天的行为，新建项目）。
 *
 * 这一层单独存在，是因为第三层的 AI 建议要读它：用户已经明确选过项目的材料，
 * 建议层必须闭嘴。把「谁做的决定」和「决定是什么」一起记下来，建议层才有依据；
 * 只记一个项目 id 是区分不出「他选了 A」和「系统默认放进 A」的。
 */

/** 新建项目的哨兵值。项目 id 一律带 `prj_` 前缀，不会与它撞上。 */
export const NEW_PROJECT = "new";

export type RoutingSource = "user" | "skipped";

export type MaterialRoutingInput = {
  /** 用户在选择器里点中的项目。null 或缺省表示他选的是新建项目。 */
  chosenProjectId?: string | null;
  /** 用户没有做选择就关掉了选择器。 */
  skipped?: boolean;
};

export type MaterialRouting = {
  projectId: string | typeof NEW_PROJECT;
  source: RoutingSource;
};

export function routingChoice(input: MaterialRoutingInput): MaterialRouting {
  const chosen = input.chosenProjectId?.trim();
  // 跳过优先判断：跳过的人没有表达任何意向，哪怕调用方顺手带了一个 id 也不算他选的。
  if (input.skipped || !chosen) {
    return { projectId: NEW_PROJECT, source: "skipped" };
  }
  // 在选择器里点「新建项目」也是一次明确表态：这份材料不属于任何现有项目，
  // 所以来源是 user，建议层同样要闭嘴。
  if (chosen === NEW_PROJECT) return { projectId: NEW_PROJECT, source: "user" };
  return { projectId: chosen, source: "user" };
}

/**
 * 建议层是否可以对这份材料出声。
 *
 * 用户已经选过，再弹一条「要不要放到别的项目」就是在质疑他刚做完的决定。
 */
export function suggestionAllowed(source: RoutingSource | null | undefined): boolean {
  return source !== "user";
}
