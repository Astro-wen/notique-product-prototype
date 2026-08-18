# Notique 交接文档：给 Claude

更新日期：2026 年 8 月 16 日

## 当前发布基线（优先于下文历史 v18 记录）

Sites v23 已发布到原有公开 URL，精确源码提交为 `db556104ef1a58da38c08ad3c1fab697f5405f02`。发布包由该提交重新构建并通过 343/343 自动化、空库迁移、生产构建和敏感信息审计；生产 `AI_DRAFT_CONTEXT=0`。公开站已完成桌面与 390px 浏览器走查，控制台和最近 Worker 错误日志为空。

本轮隔离 Realtor A/B 的目的首先是验证编排安全。Control 完成，Treatment 在最后一场遇到基础 Verify 与唯一升级 Verify 均合同无效后按停止门结束；没有可比较的 Precision/Recall 质量结论，也没有切换生产草稿开关。失败和升级调用的用量均已落库，未留下 processing 孤儿。下一步是修复该模型合同/样本问题后，从新的干净提交重新跑完整双臂，并由人工完成裁决。

GitHub 当前仍因本机登录失效未同步；这不影响 Sites v23 已发布。恢复登录后必须把完全相同的提交和文档同步到 GitHub，再更新这里的 SHA。

读完这份文档后，接手者应当可以继续当前工作，不需要从聊天记录重新猜项目目标。

## 1. 项目一句话说明

Notique 是一个面向买方经纪人的“带证据客户旅程记忆”MVP：它从同一买家的多次 Transcript、录音、照片和文件中生成可立即使用的 AI 初稿；人确认后，内容才进入可信记忆、变化时间线、行动和会前报告。

项目不是一般的会议摘要器。最关键的产品边界是：

1. AI 初稿与人工确认后的正式结果必须分开。
2. 每条正式事实必须可以回到原始 Evidence。
3. 默认后续沟通只继承已经确认的内容。灰度双层记忆只能把旧草稿作为 Agent B 的不可信提示，不能污染 Verified Ledger。
4. Relation 必须由人接受或拒绝，不能因为确认 Claim 就自动生效。
5. 报告只读 Verified Ledger，不允许 Pending 或 Rejected 泄漏。

## 2. 当前 Scope

### 2.1 这轮交付范围

1. 稳定的 URL 导航、返回和刷新恢复。
2. 已确认 Claim 的报告阅读模式，不混入 Pending 审核队列。
3. 当前 Run 的定向后台调度、真实分段计时和 workflow snapshot。
4. 可点击的 AI 初稿重点。
5. Evidence 默认显示前两段、后两段和放大的目标句。
6. 真正表达变化的 Timeline moments。
7. Preference 当前状态与历史变化。
8. 使用一段公开许可的业务会议音频做小规模真实验证。
9. 更新 Eric 可读文档、用户说明和验收清单。
10. 原始 Transcript、易读 Transcript 和 AI Summary 三层分离。
11. Project soft delete、回收站、恢复和 R2-first 永久删除。
12. 买方客户固定场景、十类客户旅程覆盖字段和“客户进展”双层页面。
13. Pending 不再阻止下一次沟通；每次新的付费分析仍须用户明确点击。
14. `next_action` 站内行动、负责人、期限和人工完成记录。
15. Context Pack v3 / Verification v4 / Prompt v9 的 Draft Link 安全边界；`AI_DRAFT_CONTEXT=0` 默认关闭。

### 2.2 保留不动的核心规则

1. Agent A 使用 Luna `xhigh`。
2. Agent B 使用 Luna `high`，仅在确定性条件触发时升级 `xhigh`。
3. 两个 Agent 共用一个 OpenAI API Key。
4. 不取消 Claim、Occurrence、Evidence 或 Relation 的人工决定，但不再强迫用户在继续下一场前全部处理完。
5. 不重写 Ledger、模型合同和核心数据层。
6. 不增加会改写正式报告的“文案整理 Agent”；Summary 与 Transcript Refiner 只生成阅读辅助，不能写入 Verified Ledger。
7. 不以降低 reasoning effort 换速度。

### 2.3 这轮不做

- CRM、Calendar、Analytics
- 正式多租户和复杂权限后台
- 完整 Queue 平台或多供应商路由
- 用 YouTube-to-MP3 第三方网站抓取不明授权音频
- 以一份样本宣称房地产或销售 Concept Validation 已通过

## 3. 当前真实状态

### 3.1 已完成或已经进入本轮代码

1. URL 可以记录项目、沟通、页面、Claim、报告栏目和来源。
2. 页面箭头和浏览器返回有明确目的地；深层链接没有来源时回所属沟通。
3. 自动工作流不会在用户阅读 Claim、Evidence 或报告时抢走页面。
4. 报告中的已确认 Claim 使用只读阅读模式，不显示无关连续审核队列。
5. 分析创建后返回 `202 Accepted`，定向唤醒当前 Run；重复唤醒同一 Run 不应重复收费。
6. 计时器分开记录首次排队、本轮排队、材料准备、Agent A、Agent B、加强复核和写入。
7. workflow snapshot 一次返回当前工作流需要的状态与唯一下一步。
8. Evidence context 合同默认返回目标句前两段和后两段，并支持精确高亮与音频定位。
9. Timeline moments 表达新增、取代、解决、矛盾、再次确认和撤回。
10. Preference 数据提供当前值、条件、决策人、首次出现、最近确认和历史变化。
11. Summary Agent 与 Transcript Refiner 均使用 Luna `high` 和 OpenAI Background Responses；它们与事实识别并行、独立失败和独立重试。
12. 易读稿对原始 Segment 做 100% 映射，长会议按最多 120 段或约 45,000 字符分块续跑；最终全局校验遗漏、重复、顺序、金额、日期、数量和否定词。
13. Agent A 继续 raw-only；Agent A 与 readable 并行启动，Agent B 在 inventory 成功后等待 readable terminal，复用 inventory 而不重复付费。Readable failed 才 raw-only fallback；正式 Evidence 仍引用原始 Segment。
14. 项目支持 soft delete、回收站恢复和永久删除。永久删除使用持久 purge lock，并先删 R2 再删 D1，避免恢复和清理并发造成半删除状态。

Summary、Transcript Refiner 和项目回收站已经发布为 Sites v18：当次空库迁移、生产构建、敏感信息审计和 `npm test` 259/259 通过；正式站已验证桌面与 390px 布局、Transcript 三视图，以及空项目删除、恢复和永久删除。尚未付费生成真实 Summary/易读稿，因此只能写成“live 工程与交互通过、模型质量待验收”。

第 12–15 项中与买方旅程、可选核对、站内行动和双层记忆有关的新增代码，是 **Sites v18 之后的本地未发布改动**。当前 `npm test` 为 265/265，类型、Lint、生产 Build、空库 Migration 和发布包敏感信息检查均通过。不要把这段写成已经上线；也不要把自动化通过写成 Realtor 质量门通过。

新 Run 的版本锁定为：Prompt v9、Context Pack v3、Inventory v3、Verification v4、最终 Claim Extraction v3。Agent A 仍为 Luna `xhigh`，Agent B 仍为 Luna `high`。旧 v8.2 和 v7 Run 只作为历史证据，不能与 v9 分数直接合并。

上述代码已经更新为 Sites v18。桌面端继续使用现有 Verified 数据完成线上只读验收：

1. Timeline 显示纵向轨道、节点、Speaker 和 `mm:ss` 时间点。
2. 从 Timeline 打开已确认 Claim 后，URL 保留 `origin=results` 和 `originTab=timeline`，页面显示“返回时间线”，且不出现连续审核队列。
3. 页面箭头和浏览器 Back 都准确返回 Timeline；从报告栏目返回会回到核心工作台。
4. 深层 Claim 刷新后约 2 至 3 秒恢复只读状态和正确返回标签。
5. Evidence 精确标记目标句，默认展示前两段和后两段；音频从目标时间前约 3 秒开始播放。
6. 本轮桌面检查期间浏览器控制台为 0 error。

手机样式和自动化合同已通过，但内置浏览器的 viewport override 实际仍保持 1280px 宽，因此这不是手机真人验收。必须在真实手机浏览器补测，相关项目不能提前勾选。当前本地代码工程测试为 265/265；这不替代手机真人验收。

Extraction 的长模型请求已经改用 OpenAI Responses Background mode。每个阶段先以 `background: true` 创建 Response，把 Response ID 持久化，再由同一 Outbox 任务通过 `GET /responses/:id` 恢复查询；`queued` 或 `in_progress` 不会再次 POST 一个付费 Response。这样不会要求一次 Cloudflare 请求一直等待完整的 Luna `xhigh` 推理，也不会因为重复唤醒创建第二个模型任务。每分钟 Cron 仍是最后兜底。

Sites v18 发布后尚未通过这套新 Background 架构发起新的付费 Run。当前只能写“v18 代码、自动测试、三层 Transcript UI、项目管理和桌面只读线上验收通过”；买方旅程 v9 改动仍未发布，不能写成“线上付费处理或双层记忆质量已通过”。

### 3.2 速度问题的准确解释

用户看到过“排队 10 分 47 秒”。那次真正的两阶段模型处理约 **1 分 36 秒**；主要浪费发生在旧调度没有及时领取当前任务，以及重试仍沿用旧 `queued_at`。

本轮的方向是定向唤醒、15 秒重唤醒同一 Run、定时任务兜底和分开计时，不是把 Luna `xhigh` 改成更低质量模式。

### 3.3 已产生的 AMI 结果

AMI `ES2002a` 已经跑完一次完整 Notique 流程，且 8 条 Ground Truth 在模型运行前冻结。本次没有确认 Scenario 或任何 Claim，所以成绩是人工 Verification 以前的 AI 初稿：

1. Audio → Transcript 的 8 条关键事实 Coverage 为 8/8；这不是全场 WER，也不能写成“整场转写 100% 准确”。
2. Agent B 的 raw final 10 完整命中 6/8，Critical 命中 2/4。
3. 历史 Run 经过 Evidence 安全门后实际持久化 6 条，其中命中 Ground Truth 4/8，Critical 1/4；四条候选因引用或 Segment 连续性检查被挡住。
4. 从开始转写到 AI 初稿完成共 9 分 59.6 秒。两段排队分别只有 10 ms 和 9 ms，主要时间是转写 6 分 51.7 秒和三段模型处理约 3 分 07.8 秒。
5. Extraction Run：`run_603f383e77264fafa9c773b1cda18149`，状态 `completed_with_warnings`；Transcription Run：`trun_31b196b40f734c75baa22e39cb31cdb9`。

这次 Run 之后已经加入保守的省略号 Evidence 修复：模型用 `...` 或 `…` 省略同一段连续原话时，程序按顺序查找所有非空片段，只有全场存在唯一连续答案才接受；乱序、不连续或多解仍拒绝。该修复预计可以保住成本上限、Andrew 任务和 David/Craig 的直接分工证据，但历史 Run 不得事后改分，必须再做一次付费复跑才能得到新成绩。

## 4. 关键链接

### 4.1 产品和代码

- 完整应用：[https://notique-evidence-workspace.uclae2e12.chatgpt.site/](https://notique-evidence-workspace.uclae2e12.chatgpt.site/)
- GitHub：[https://github.com/Astro-wen/notique-product-prototype](https://github.com/Astro-wen/notique-product-prototype)
- GitHub Pages 静态入口：[https://astro-wen.github.io/notique-product-prototype/](https://astro-wen.github.io/notique-product-prototype/)
- Sites v18 源码基线：`1202a5d2778157e11571e3deb752a65007d5087b`。GitHub `main` 仍为 `9751edfb7fd4ab8193cb9aa72134a5c9296d57b1`，本机 GitHub 登录失效后尚未同步。

GitHub Pages 只是跳转页，不能处理上传、数据库或 AI 请求。完整交互必须在 ChatGPT Sites 运行。

### 4.2 Google Docs 参考

1. **Product Concept**
   - Document ID：`1Oxb1UDQv2EYLA6Qw6t4PFiP2GjvItl0RNdcXl2NZv8w`
   - 用途：理解 Eric 的长期产品方向和术语，不要直接改写他的原始要求。
2. **Homework / 验收要求**
   - Document ID：`16dShTePagThTHfxQMWXTXOSGYPXsJBzrwvUrgeBO_pg`
   - 用途：逐项核对 MVP 要求、质量门和演示边界。
3. **Eric 阶段验收主文档**
   - 目标 Document ID 在当前交接信息中未得到确认。
   - 写入前必须向 Aaron 确认目标，不要猜一个 Google Doc，也不要把内容写回 Product Concept 或 Homework 原文。

### 4.3 每个阶段应该回写哪里

1. 人能读懂的阶段说明：`docs/ERIC_MVP_PROGRESS.md`
2. 完整历史与真实状态：`work/ERIC_REQUIREMENTS_STATUS.md`
3. 工程和质量门：`tests/ACCEPTANCE_CHECKLIST.md`
4. 使用方式：`docs/USER_MANUAL.md`
5. Google Eric 主文档：只有确认目标 Document ID 后再写入。

不要把大量 Run ID、Token 和日志堆进 Eric 的主文档。主文档讲问题、方案、变化、使用方式、结果和限制；技术证据放验收清单或附录。

## 5. 本地位置和文件夹地图

### 5.1 Repo 路径

```text
/Users/aaronwen/.codex/.chatgpt-projects/
g-p-6a5d6f7835f481919605aafa8c6b3c50/notique-web-demo
```

这是当前任务实际修改的仓库。上一级 `sources/` 是 ChatGPT Project 同步参考材料，只读，不要编辑。

### 5.2 关键文件夹

| 位置 | 内容 | 接手时先看什么 |
|---|---|---|
| `app/` | 页面、样式、浏览器录音和 API 路由入口 | `app/page.tsx`、`app/api-client.ts`、`app/globals.css` |
| `lib/domain/` | 不依赖数据库的业务规则 | `app-navigation.ts`、`ai-draft.ts`、`views.ts`、`run-timing.ts` |
| `lib/server/db/` | D1 Repository 和业务读写 | workflow、evidence、ledger、verdict repositories |
| `lib/server/jobs/` | 提取、转写、Outbox 和后台执行 | `extraction-processor.ts`、`outbox.ts`、`transcription-outbox.ts` |
| `lib/server/http/` | API 分发、身份和错误合同 | `api.ts`、`context.ts` |
| `db/` | 数据库 Schema 和绑定类型 | `schema.ts` |
| `drizzle/` | D1 Migration | 按编号顺序，不要回改已发布 Migration |
| `tests/` | 工程测试和验收清单 | `ACCEPTANCE_CHECKLIST.md` 与新功能相关测试 |
| `eval/` | 三行业合成 Ground Truth 与评测器 | 不要根据模型输出修改 Ground Truth |
| `work/` | 本地运行证据和 Eric 状态记录 | 默认不作为产品运行时输入 |
| `work/real-business-audio/` | AMI 来源、哈希和运行前 Ground Truth | 运行前确认 `frozen_before_model_run=true` |
| `.openai/` | ChatGPT Sites 托管配置 | 发布时保留既有项目和资源绑定 |

## 6. 数据和模型流程

```text
材料
  ↓
Canonical Transcript / 图片 Asset
  ↓
Agent A：Luna xhigh，全量原子事实盘点
  ↓
Agent B：Luna high，查漏、纠错、重复与关系检查
  ↓
必要时：Luna xhigh 加强复核
  ↓
程序校验 Evidence、原文、时间点、候选映射和上限
  ↓
AI 初稿（仍是 Pending）
  ↓
人工审核 Claim / Occurrence / Relation
  ↓
Verified Ledger
  ↓
确定性生成 Summary / Timeline / Preferences / Risks / Agenda / Brief
```

### 不能破坏的合同

1. Agent A 最多盘点 24 条内部候选。
2. Agent B 最终最多给出 10 条 Claim/Occurrence，并解释每个 Agent A 候选的去向。
3. 模型关系只能是 proposed；人工接受后才能影响生命周期。
4. Evidence ID、Quote 和 Timestamp 必须由服务端材料回填与校验。
5. Pending、Rejected 和失效记录不得进入任何正式 View。
6. Brief 不调用新的文案模型。

## 7. AMI 真实音频验证

### 7.1 样本

- Corpus：AMI Meeting Corpus
- Meeting：`ES2002a`
- 场景：四人产品设计项目启动会
- 时长：约 21 分钟
- 许可：CC BY 4.0
- 原始音频：`ES2002a.Mix-Headset.wav`
- 产品输入：AAC M4A，小于 100 MB
- 官方来源：<https://groups.inf.ed.ac.uk/ami/>
- 官方音频：<https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav>

这是公开许可的真实多人语音，但内容是受控产品设计场景，不是真实客户销售电话。

### 7.2 运行前已经冻结的 8 条事实

1. 售价 25 欧元。
2. 生产成本不得超过 12.50 欧元。
3. 产品将面向国际市场。
4. 是否只用于电视尚未确定。
5. 工业设计师负责实体/工作设计。
6. UI 设计师负责技术功能。
7. 市场负责人负责市场需求。
8. 会议讨论遥控器需要具备的功能。

详细原句、时间点和哈希见：

- `work/real-business-audio/AMI_ES2002A_SOURCE.json`
- `work/real-business-audio/AMI_ES2002A_GROUND_TRUTH.md`
- `work/real-business-audio/AMI_ES2002A_GROUND_TRUTH.json`

当前会话的二进制测试附件位于 `/private/tmp/ES2002a.Mix-Headset.wav`、`/private/tmp/ES2002a.Mix-Headset.m4a` 和 `/private/tmp/ami_public_manual_1.6.2.zip`。`/private/tmp` 不属于仓库，也不保证长期保留；接手时先检查文件是否仍在。缺失时应从上述官方来源重新下载，并核对 `AMI_ES2002A_SOURCE.json` 中的 SHA256，不能随意换成同名文件。

### 7.3 第一次运行结果

| 检查 | 结果 |
|---|---:|
| Transcript 关键事实 Coverage | 8/8 |
| Raw final 10 Ground Truth Recall | 6/8，75% |
| Raw final 10 Critical Recall | 2/4，50% |
| 历史 Persisted 6 Ground Truth Recall | 4/8，50% |
| 历史 Persisted 6 Critical Recall | 1/4，25% |
| 端到端时间 | 9 分 59.6 秒 |
| Scenario / Claim 人工确认 | 0 / 0 |

Raw final 10 的另外四条也能在 Transcript 找到依据，但不在预先冻结的 8 条评分事实中，不能用来提高 Recall，也不能在没有评分合同的情况下粗暴算成四条幻觉。安全门挡住的四条是 Andrew 的市场任务、12.50 欧元成本上限、售价口径未决和多设备用途方向。

详细的人类可读解释见 `docs/ERIC_MVP_PROGRESS.md`；完整指标、Evidence 语义支持和 Run ID 见 `work/ERIC_REQUIREMENTS_STATUS.md` 与 `tests/ACCEPTANCE_CHECKLIST.md`。

### 7.4 下一次付费复跑注意

1. Ground Truth 和原始历史分数保持冻结，不能根据第一次输出改题。
2. 若验证当前产品，使用同一 AMI 音频和当前 Prompt v9 / Context v3 / Inventory v3 / Verification v4；历史 v8.2 分数保留为旧合同结果，不能直接改写。
3. 单独判断省略号修复是否保住成本上限、Andrew 任务和 David/Craig 的直接 Evidence。
4. 新 Run 单独记录，不覆盖 `run_603f383e77264fafa9c773b1cda18149`。
5. 只有实际付费复跑后才能更新新 Recall；代码和自动测试通过不等于模型成绩已经改善。

## 8. 接手后的优先顺序

1. 查看 `git status`，保留其他 Agent 或 Aaron 的未提交改动。
2. 在真实手机浏览器完成导航、Evidence、Timeline、Preference、刷新和连续审核验收；不要再用未生效的 viewport override 代替真人手机结果。
3. 在有明确预算时，通过 Sites v18 发起一次新的付费 Run，验证 Summary、易读稿、Background Response 创建、ID 持久化、恢复查询、重复唤醒和阶段计时；不能用只读 QA 代替。
4. 使用同一 AMI 样本做付费复跑时，保持 Ground Truth 冻结，并单独记录新结果，不覆盖历史分数。
5. 找一名未看过 Ground Truth 的用户完成整套审核，记录用时、修改、拒绝和补漏。
6. 每次后续改动继续完成 typecheck、lint、build、全量测试、Migration、`git diff --check` 和发布包敏感信息审计。
7. 确认 Google Eric 主文档 ID 后，再把人能读懂的阶段记录写进去。

## 9. 当前发布记录与后续检查

1. Sites v18 已保存并发布源码提交 `1202a5d2778157e11571e3deb752a65007d5087b`；GitHub `main` 尚待重新登录后同步。
2. Sites v18 已发布到原有 URL，没有创建第二个站点。
3. Sites v18 发布时的工程门已通过；当前本地买方旅程改动为 265/265，仍需一次独立发布前审查。
4. 桌面与 390px 正式站 QA 已通过；实体手机真人 QA 和 v18 新付费 Run 仍未完成。

后续改动继续执行：

```text
npm run typecheck
npm run lint
npm run build
npm test
```

还要检查：

1. Migration 可以从空数据库按顺序应用。
2. 发布包不含 `.env`、`.dev.vars`、API Key 或内部任务 Token。
3. GitHub Pages 仍只做静态跳转。
4. Sites 继续绑定原有 D1 和 R2，不要新建空数据库覆盖正式测试数据。
5. 公开站测试不要上传真实敏感客户材料。

## 10. 文档写作口径

给 Eric 写时：

1. 主语使用“方案”，不使用“我们”。
2. 先说用户看到的问题，再说方案怎么理解、改了什么、用户现在怎么操作。
3. 使用编号、短段落和清楚的 bullet。
4. 把“能做”“需要再花时间看看”“当前不能证明”分开。
5. 不把代码文件名、Run ID 和 Token 当正文。
6. 质量数字必须说明样本、版本和是否在人工核对前测量。
7. 没运行的测试只能写“已准备”，不能写结果。

## 11. 当前最重要的诚实结论

1. Verified-only、证据追溯和人工审核链路已经是可靠的工程底座。
2. Sites v18 已上线原有公开地址；桌面只读导航、Transcript 三视图、项目回收站、Evidence、Timeline、报告返回和刷新恢复已经通过线上验收。
3. 10 分 47 秒主要不是 Luna 思考时间；真正模型阶段约 1 分 36 秒。
4. Claim/Relation 准确率、同输入稳定性和真人两分钟审核仍未通过完整验收。
5. AMI 已完成第一次真实多人音频运行：关键事实转写 8/8，但 raw AI 初稿只命中 6/8、Critical 2/4，历史 Evidence 安全门后为 4/8、Critical 1/4；没有进行人工确认。
6. 省略号 Evidence 修复已经实现，但尚未做付费 AMI 复跑；v18 也尚未用新 Summary/Refiner/Background 架构发起新付费 Run，不能宣称 Recall、易读质量或线上付费处理已通过。
7. 手机只有样式与自动化结果，真实手机浏览器验收未完成。
8. 当前产品可以称为“可继续测试的 MVP”，不能称为“已经完成 Concept Validation”。
