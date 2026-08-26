# Notique AI — 新 Codex Project 交接入口

更新日期：2026-08-26

> 新 Project 请先完整阅读本文件，再读 `tests/ACCEPTANCE_CHECKLIST.md`。不要只依据旧版 `CLAUDE_HANDOFF.md` 或 `ERIC_MVP_PROGRESS.md` 判断当前状态；它们仍含 v23 等历史记录。

## 1. 正确仓库

```text
/Users/aaronwen/.codex/.chatgpt-projects/
g-p-6a5d6f7835f481919605aafa8c6b3c50/notique-web-demo
```

上一级目录的 `sources/` 是 ChatGPT Project 同步参考材料，只读，不是应用仓库。

## 2. 当前源码基线

- 分支：`publish-main`
- 当前提交：`8622615` — `feat: simplify readable transcript and review flow`
- 当前工作树：交接文件创建前为 clean
- 相对本地 `origin/main`：ahead 42；GitHub 主线尚未同步这些提交
- 当前正式站：<https://notique-evidence-workspace.uclae2e12.chatgpt.site/>
- 最近已知发布：Sites v53
- 正式配置：`AI_DRAFT_CONTEXT=0`、`AI_VERIFICATION_USES_READABLE=0`
- 每日模型 Token 人工上限已经移除；供应商自身配额和并发限制仍可能生效

## 3. 产品目标

Notique 不是一般会议摘要器。它帮助买方经纪人从同一客户的多次沟通中持续追踪：

- 预算与融资
- 区域和房屋要求
- 偏好、禁忌和决策人
- 房源反馈
- 尚未解决的问题
- 下一步行动、负责人和期限
- 信息在多次沟通中的新增、变化、矛盾和解决

AI 草稿可以立即阅读；只有人工确认内容才能进入可信记忆、Timeline、Brief 和正式报告。所有正式 Evidence 必须回到原始逐字稿、原图或原文件。

## 4. 当前已经完成

1. 买方旅程固定场景、AI 草稿/可信记忆双层 UI、可选核对、下一次沟通不被 Pending 阻塞。
2. AI Summary、易读逐字稿、原始逐字稿三层阅读；Summary 支持生成动画、原文定位和音频跳转。
3. 录音分段并行转写、每段进度、最多 6 路并发、Speaker 1/2/3 稳定显示；程序禁止出现 Speaker 13 等无限编号。
4. 易读页面合并连续同 Speaker 发言；可以把 `I'd` → 短暂 `Okay` → `say...` 保守接回一句，并隐藏 `uh/um/erm/hmm`。原始逐字稿与 Evidence 不被改写。
5. 时间点点击播放、当前段高亮、播放跟随；侧栏可折叠。
6. 项目回收站、恢复和永久删除；站内 next action 及完成记录。
7. 审核页已简化为 `确认 / 修改 / 不采纳`，移除用户无用的批量核对面板。
8. 外部浏览器可以匿名打开页面和 API；但所有访问者仍共享同一测试 Workspace。
9. 照片支持 JPG/PNG/WebP；录音单文件上限 100 MiB。
10. 当前测试基线为 379/379，TypeScript、Lint、生产构建和发布包敏感信息审计通过。

## 5. 仍未完成，不能宣称通过

### 质量与概念验证

- 当前合同尚无完整可比较的 Realtor Control/Treatment A/B 结果。
- Claim Precision ≥95%、Material Recall ≥90%、Critical Recall 100%、Relation Precision/Recall ≥90% 尚未证明。
- 缺一组运行前冻结 Ground Truth 的脱敏 3–5 次真实买方连续沟通。
- Summary 的原文引用已做确定性校验，但引用存在不代表摘要语义已经人工核对。

### 音频

- 已禁止 Speaker 13，但真实长录音的跨分段身份一致性仍未用人工 Speaker Ground Truth/DER 验证。
- 当前转写模型是 OpenAI `gpt-4o-transcribe-diarize`；Luna 用于 Summary 和事实 Agent，不是音频转写模型。
- 还没有在同一份 26 分钟真实录音上记录最新版的端到端 P50/P95。
- 易读 UI 已能接合短插话两侧的未完句；事实提取是否稳定吸收续句仍需要 Ground Truth 回归。

### 图片、文件与安全

- 历史图片独立事实覆盖曾为 0/4，图片理解质量未通过。
- HEIC/HEIF 尚无转换器；PDF 尚无可靠页面文本提取适配器。
- 公开站是共享测试空间，不具备账号级 Workspace 隔离；真实客户资料仍禁止上传。

### 验收与运维

- 仍缺实体手机（尤其 iPhone/Safari）真人完整流程验收。
- 仍缺最新版正式站完整付费 Demo 的书面记录：上传录音 → 转写 → Summary/易读稿 → 事实识别 → 人工核对 → 客户概览/行动。
- GitHub 仍待同步当前 42 个本地提交。
- 只记录 Token，尚未保存逐 Run 的供应商真实账单费用。
- `docs/CLAUDE_HANDOFF.md`、`docs/ERIC_MVP_PROGRESS.md` 和部分 README 内容需要按 v53 重写；旧版本号和旧架构描述不能作为当前事实。

## 6. 接手顺序

1. 运行 `git status -sb` 和 `git log -8 --oneline`，确认没有并发或未提交改动。
2. 阅读本文件。
3. 阅读 `tests/ACCEPTANCE_CHECKLIST.md`，把历史已完成项与当前未完成质量门分开。
4. 阅读 `README.md` 了解运行与发布；遇到与本文件冲突的旧状态，以源码、配置和最新测试为准。
5. 修改前先运行定向测试；发布前必须运行 `npm test`、`npm run typecheck`、`npm run lint`。
6. 不修改冻结 Ground Truth 来迁就模型结果，不把自动化通过写成 Precision/Recall 已通过。
7. 不在公开站上传真实客户隐私材料。

## 7. 下一步优先级

1. 在当前版本完成并记录一次正式站真实端到端付费 Demo。
2. 用同一份长录音测最新版耗时、说话人漂移和续句完整性。
3. 从干净提交重新跑 Realtor `AI_DRAFT_CONTEXT=0/1` 双臂并完成人工裁决。
4. 达到质量门后再考虑把生产 Draft Context 从 0 切到 1。
5. 补实体手机验收、GitHub 同源同步和文档更新。

