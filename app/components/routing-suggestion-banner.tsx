"use client";

import { FolderOpen } from "lucide-react";

/**
 * 归属建议条（第三层的出口）。
 *
 * 概要整理完之后，系统会问一次这份材料像不像某个已有项目的，足够确定才会出现
 * 这一条。它只是建议：不点「挪过去」就什么都不会发生，记录留在当前项目。
 *
 * 不显示概率。给用户一个 0.87 只会让人去猜这个数是什么意思，而这条建议的正确
 * 用法是看一眼项目名字自己判断。概率留在库里给评估用。
 *
 * 样式复用工作区已有的 workflow-reading-banner，不引入新类名。
 */

export type RoutingSuggestionView = {
  suggestedProjectId: string;
  suggestedProjectName: string;
};

export function RoutingSuggestionBanner({
  suggestion,
  busy,
  onAccept,
  onDismiss,
}: {
  suggestion: RoutingSuggestionView;
  busy: boolean;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const name = suggestion.suggestedProjectName.replace(/^\[SYNTHETIC\]\s*/, "");
  return (
    <aside className="workflow-reading-banner ready" aria-live="polite">
      <span className="workflow-reading-icon" aria-hidden="true"><FolderOpen /></span>
      <div>
        <strong>这条记录可能属于 {name}</strong>
        <p>按整理出来的概要判断的，不一定对。挪过去之后材料和逐字稿都跟着走。</p>
      </div>
      <span className="workflow-reading-actions">
        <button className="text-button" disabled={busy} onClick={onDismiss}>不用了</button>
        <button className="button secondary" disabled={busy} onClick={onAccept}>挪过去</button>
      </span>
    </aside>
  );
}
