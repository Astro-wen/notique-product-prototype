# Eric 要求与 Notique 当前真实状态

更新日期：2026 年 8 月 16 日

## 1. 先说结论

Notique 目前可以称为“买方经纪人客户旅程已经形成可运行工程方案、可以继续做真实验证的 MVP”，不能称为“已经完成 Concept Validation”。

方案已经解决三个最重要的工程问题：

1. AI 先生成有 Evidence 的初稿，人确认后才进入正式项目记忆。
2. AI 草稿可以先使用、稍后核对；可信报告仍只读人工确认内容。可选双层记忆默认关闭，打开后也不能让草稿直接改变正式状态。
3. 正式报告只读取 Verified Ledger，不用另一个 AI 重新润色或补齐。

当前最大的未知不是“页面有没有按钮”，而是：AI 初稿在真实业务材料上能否稳定抓住重要内容，人工到底要改多少，以及整个审核能否真正节省时间。

## 2. Eric 的要求，方案怎样理解

Eric 想要的不是一次性的会议摘要，而是一份会随着多次沟通不断更新、每条内容都能回到原话的项目记忆。

基本循环是：

```text
本次沟通材料
→ AI 初稿
→ AI 草稿立即可读
→ 重要内容可选核对
→ 已确认客户记忆
→ 下一次沟通继续追踪变化
→ 客户进展、下一步、时间线和会前速览
```

“下一步看看 AI 不靠 verification”不等于取消人工核对。它的意思是：人工修正以前，单独测量 AI 第一版是否已经有用。否则最后报告即使正确，也无法判断是 AI 节省了工作，还是人重新做了一遍。

因此方案会分别记录：

1. AI 初稿抓到了什么。
2. 人工补了什么、改了什么、拒绝了什么。
3. 正式结果里最终保留了什么。

## 3. 现在能做

### 3.1 材料和录音

1. 可以上传 Transcript、录音、照片和 PDF。
2. 可以直接使用浏览器录音，覆盖开始、暂停、继续、结束、试听、重录和保存。
3. 录音会先转成带说话人和时间点的逐字稿，再进入分析。
4. 原始材料保留在服务端文件存储，正式 Evidence 可以回到原文和音频位置。
5. 转写失败时录音不会消失，用户可以检查状态或重新转写。

### 3.2 双 Agent AI 初稿

1. Agent A 使用 Luna `xhigh`，先盘点最多 24 条内部原子事实。
2. Agent B 使用 Luna `high`，查漏、纠错、判断重复和前后关系，再选出最多 10 条交给人。
3. 如果出现关键遗漏、低可信关系、冲突、复合 Claim 或错误 Reaffirmed，才会增加一次 `xhigh` 加强复核。
4. 两个 Agent 共用同一个 API Key，不增加第二把密钥。
5. 程序核对 Evidence ID、逐字引用和时间点；模型不能自己编造正式出处。

### 3.3 人工核对

1. 用户可以确认、修改、拒绝或补上 AI 漏掉的信息。
2. Claim 和 Occurrence 在同一个连续队列中处理，保存后自动进入下一条。
3. Relation 会显示新旧两端原文和影响，必须逐条接受或拒绝。
4. Evidence 不完整时确认与修改会被锁住。
5. 初稿“基本可用”的体验反馈与正式事实确认分开保存。
6. Pending 不再阻止下一次沟通。用户可只处理重要项目，也可稍后回来；下一次付费分析仍必须点击确认。

### 3.4 项目记忆和报告

1. 事项概况回答“项目现在是什么状态”。
2. Timeline 回答“每次沟通在什么时候发生了什么变化”。
3. Preference 显示当前偏好、条件、决策人、首次出现、最近确认和历史变化。
4. Decisions、Open Questions、Risks、Agenda 和 Brief 都从 Verified Ledger 生成。
5. Pending、Rejected 和失效内容不能进入报告。
6. Brief 证据不足时会留空，不为了看起来完整而编造。
7. “客户进展”把 AI 当前理解和可信记忆分开显示；“下一步行动”允许确认、修改、不采纳和标记完成。

### 3.5 原稿、易读稿和摘要

1. 原始逐字稿与音频永久保留，AI 无权覆盖；正式 Evidence 仍只引用原始 Segment。
2. Transcript Refiner 使用 Luna `high` 生成完整易读稿，只改善标点、分段、卡顿和高度明确的识别错误。金额、日期、数量、否定、责任与条件都受程序硬检查。
3. Summary Agent 使用 Luna `high` 生成章节和重点，每条重点必须引用同一 Event 的原始 Segment，并复制一段真实原话。
4. Agent A 继续只读原稿并与易读稿并行；Agent B 等易读稿成功或明确失败后再继续，不会因为它慢几秒就静默跳过，也不会重跑已完成的 Agent A。易读稿失败时，事实识别诚实退回 raw-only。
5. 长逐字稿会按原顺序分块续跑，最终只有在 100% 原始 Segment 无遗漏、无重复、顺序不变时才生成完整易读版本。

当前判断：Sites v18 的既有工程和交互已上线；买方旅程、可选核对、站内行动和双层记忆是 v18 之后的本地改动，265 项自动化已通过，但尚未发布或做 v9 付费质量验收。

### 3.6 项目回收站

项目可移入回收站并完整恢复。运行中的项目不能删除；永久删除要求输入完整名称，先清理全部文件再级联删除数据库。方案使用持久删除锁防止“正在清文件时又恢复”的竞态。本地与 Sites v18 均已用空测试项目跑通，测试项目最后已清理。

### 3.7 买方客户旅程和双层记忆（本地完成、尚未上线）

1. 新建项目直接固定为房地产买方旅程，追踪预算与融资、区域、硬性要求、偏好与条件、不能接受项、决策人、购买时间线、房源反馈、未决问题和下一步。
2. Workflow 明确区分 `draft_ready`、`partially_reviewed` 和 `trusted`。分析完成不再等于全部可信。
3. Context Pack v3 分为可信内容、本次新材料和可选旧草稿。Agent A 仍只看本次原始材料，Agent B 才能在灰度开关开启时参考旧草稿。
4. Draft Link 与正式 Relation 分表保存。旧草稿被拒绝或失效后，候选连接不能进入可信层；两端都 Verified 且用户接受后才创建正式关系。
5. 新合同是 Prompt v9、Inventory v3、Verification v4；最终 Claim 输出仍是 v3。灰度开关 `AI_DRAFT_CONTEXT=0` 默认关闭。
6. `next_action` 是正式 Claim 类型。AI 建议只有确认后才进入行动清单；完成动作会生成一条人工确认记录并关闭原行动。

## 4. 本轮修复了什么

### 4.1 返回和跳转

之前所有页面都共用 `/`，同时有多个异步状态决定页面。用户从 Timeline 打开一条已确认记录，再点左上角返回，可能被带到无关的待审核列表；已确认记录还会混入 Pending 队列。

本轮建立了统一导航合同：

1. URL 记录当前项目、沟通、页面、Claim、报告栏目和来源。
2. 时间线打开证据后返回时间线，AI 初稿返回初稿，审核记录返回原列表和游标。
3. 浏览器返回与页面箭头使用同一规则。
4. 直接打开深层链接但没有来源时，回所属沟通。
5. 刷新可以恢复当前页面，不只恢复项目 ID。
6. 用户阅读 Claim、Evidence 或报告时，后台工作流不能抢走页面。
7. 报告中的 Verified Claim 使用只读阅读模式，不显示无关审核队列。

这部分已随 Sites v18 发布。桌面端的时间线只读路径、页面返回、浏览器返回、报告返回和刷新恢复已经在线验收；390px 正式站响应式布局通过，真实实体手机完整流程仍未验收。

### 4.2 排队和计时

用户曾看到“排队等待 10 分 47 秒”。检查后发现，真正的两阶段模型处理约为 **1 分 36 秒**。大部分时间来自旧后台调度没有及时领取当前任务，以及重试仍沿用第一次排队起点。

本轮改成：

1. 创建任务后立即返回 `202 Accepted`，再定向启动刚创建的 Run。
2. 15 秒未领取时重新唤醒同一个 Run，不创建第二个付费任务。
3. 转写和事实识别分别调度，不让旧转写任务挡住新 extraction。
4. 定时任务保留为最后兜底。
5. 首次排队、本轮排队、材料准备、Agent A、Agent B、加强复核、写入和总时间分别显示。
6. workflow snapshot 一次返回页面需要的项目状态和唯一下一步，减少请求风暴。

目标是正常 `queued → processing` P95 小于 10 秒，最后兜底小于 130 秒。这个目标只有在 Sites v18 用新后台架构跑新的付费 Run 后才能确认。

Sites v18 发布后尚未通过新的 OpenAI Background Responses 架构发起付费 Run。本轮线上检查使用已有记录，因此不能把桌面只读 QA 写成 live paid QA，也不能据此更新 P95。

### 4.3 AI 初稿和 Evidence

1. AI 初稿直接使用 Agent B 已经生成的最终候选，不增加新的文案模型请求。
2. 每个重点都保留到 Claim 和 Evidence 的连接。
3. Evidence 默认展示目标句前两段和后两段。
4. 目标句使用更大的字体，目标短语精确高亮。
5. 有音频时可以从目标时间前约 3 秒播放。
6. 用户可以标记“上下文不足”，再修改或拒绝，不必被迫确认。

### 4.4 真正的 Timeline 和 Preference

旧 Timeline 和事项概况太像，基本是同一组卡片换一种排列。

本轮 Timeline 改为纵向变化轨道，节点包含：

- 新增
- 修改或取代
- 已解决
- 矛盾
- 再次确认
- 撤回

每个节点带 Event 日期、顺序、Speaker、Transcript 时间点和 Evidence。第一场默认只展开最重要节点，避免把十条 Claim 全部复制一遍。

Preference 同时保留当前值和历史变化，显示条件、决策人、首次出现和最近确认。它仍然使用通用结构，没有把房地产话术硬编码进生产逻辑。

Evidence 和 Timeline 已在 Sites v18 完成桌面只读验收；Preference 的代码与自动化已完成，但仍需用确实带历史变化的数据做线上验收。390px 正式站布局已通过，实体手机完整流程尚未验收。

### 4.5 Sites v18 发布和正式站验收

本轮已发布到原来的公开测试站。Sites v18 源码为 `1202a5d2778157e11571e3deb752a65007d5087b`；GitHub `main` 仍为 `9751edfb7fd4ab8193cb9aa72134a5c9296d57b1`，待本机重新登录后同步。桌面端使用已有 Verified 数据完成了以下检查：

1. Timeline 显示纵向轨道和节点，每个节点可见 Speaker 与 `mm:ss` 时间点。
2. 从 Timeline 打开已确认 Claim 后，URL 保留 `origin=results` 和 `originTab=timeline`；页面显示“返回时间线”，不出现连续审核队列。
3. 页面箭头和浏览器 Back 均准确回到 Timeline；从报告栏目返回会回到核心工作台。
4. 深层 Claim 刷新后约 2 至 3 秒恢复 readonly 状态和正确返回标签。
5. Evidence 精确标记目标句，默认显示前两段和后两段；音频从目标时间前约 3 秒播放。
6. 检查期间浏览器控制台为 0 error。

Sites v18 当时的发布门全绿，独立审计没有发现 P0/P1。当前本地买方旅程改动为 265/265。手机 CSS 与自动化也通过，但内置浏览器的 viewport override 没有真正改变视口，实际宽度仍是 1280px；因此手机真人验收必须保持未完成。

## 5. Eric 的要求逐条对照

| Eric 关心的事 | 当前状态 | 说明 |
|---|---|---|
| AI 初稿要在人工以前单独看 | 已完成并有一次真实多人音频结果 | 未确认 Scenario/Claim；原始初稿命中 6/8，安全门后命中 4/8 |
| 每条信息回到精确原文 | 部分通过 | 落库引文 6/6 逐字回填；两条任务记录最后只剩职位介绍，语义支持不足 |
| 原句要突出并展示前后文 | Sites v18 桌面只读验收通过 | 精确 mark、默认前两段后两段、音频前约 3 秒均已确认；实体手机待验收 |
| 人可以确认、修改、拒绝和补漏 | 已完成 | 不同动作都会改变后续 Verified Ledger |
| Relation 由人决定 | 已完成 | 未审核 Relation 不能改变生命周期 |
| 后续沟通继承已确认记忆 | 已完成工程链路 | 已在受控多 Event 案例跑通 |
| Timeline 真正显示变化 | Sites v18 桌面只读验收通过 | 已看到纵向节点、Speaker 和 `mm:ss`；实体手机待验收 |
| Preference 可看当前和历史 | 代码和自动化已完成 | 仍需用带历史变化的数据做线上验收；真实连续客户旅程尚未证明 |
| 操作简单、返回稳定、刷新能恢复 | 桌面只读路径已通过 | 页面箭头、浏览器 Back、报告返回和深层刷新均正确；完整审核与手机流程仍待真人完成 |
| 处理速度更快 | 单次真实 Run 的排队已通过目标 | 转写与 Extraction 排队分别为 10 ms、9 ms；仍需多次 Run 才能计算 P95 |
| 正式结果不含 Pending | 已完成 | 自动测试中的 leakage 为 0 |
| 音频上传、转写和后续分析 | 公开许可多人音频已跑通 | 约 21 分钟音频端到端约 10 分钟；质量差距见第 7 节 |

## 6. 历史质量结果应该怎样看

这些旧结果用于说明模型还需要解决什么，不能和当前双 Agent 新版本混成一个平均分。

### 6.1 三行业 Prompt v7 基线

| 场景 | Strict Recall | Coverage Recall | Strict Precision | Relation Strict Recall | 引文与时间点 |
|---|---:|---:|---:|---:|---:|
| Contractor | 46.7% | 70.0% | 46.7% | 45.5% | 100%，0 ms |
| Realtor | 76.3% | 86.8% | 72.5% | 43.8% | 100%，0 ms |
| Insurance | 56.4% | 82.1% | 56.4% | 20.8% | 100%，0 ms |

最稳定的是证据定位，最不稳定的是重要事实取舍、原子化、Reaffirmed 和 Relation target。

### 6.2 同输入三次稳定性

旧 Realtor Event 2 在相同输入下重复三次，严格语义稳定性只有 **5.9%**。每次引文和时间点仍然准确，但事实选择和关系会漂移。

这证明“能找到原话”不等于“能稳定判断什么最重要”。

### 6.3 图片和真人审核

1. Contractor 三次图片独立事实覆盖均为 0/4，图片理解未通过。
2. 内部审核计时曾出现 1 分 25 秒、4 分 12 秒和 2 分 28 秒，其中第一次参考了 Ground Truth。
3. 仍缺一名不看 Ground Truth 的真实用户完成两分钟审核。

### 6.4 历史 Prompt v8.2 与当前 v9

双 Agent Prompt v8.2 / Schema v3 的阶段记录、恢复和安全门已经完成，并有历史真实 Run。当前本地代码已经升级到 Prompt v9、Context Pack v3、Inventory v3、Verification v4；尚未产生 v9 付费分数，因此下面的 v8.2 数字只能作为历史问题，不是当前合同成绩。

这说明证据门在工作，不代表 Recall、Precision 或关系质量已经通过。

## 7. 公开许可真实音频：已完成第一次运行

方案选择 AMI Meeting Corpus 的 `ES2002a`：

1. 约 21 分钟。
2. 四位说话人。
3. 产品设计项目启动会议。
4. CC BY 4.0。
5. 原始 WAV 已转换为小于 25 MB 的 M4A。
6. 原始音频、派生文件和人工标注包的 SHA256 已保存。

在任何 Notique 模型运行前，方案冻结了 8 条 Ground Truth：

1. 售价 25 欧元。
2. 生产成本不得超过 12.50 欧元。
3. 产品面向国际市场。
4. 是否只用于电视尚未确定。
5. 工业设计师的责任。
6. UI 设计师的责任。
7. 市场负责人的责任。
8. 会议讨论的产品功能范围。

### 7.1 评分口径

这次严格把三个层次分开：

1. **Raw final 10：** Agent B 最终采用的十条模型候选，还没有经过服务器 Evidence 安全门。
2. **Persisted 6：** 程序核对引文后真正写入待审核区的六条。
3. **Verified 0：** 本次只测 Eric 所说的“AI 不靠 verification”，没有确认 Scenario，也没有确认任何 Claim。

Ground Truth 是运行模型前冻结的八条。四条 Critical 是售价、成本上限、国际市场和电视功能范围未定；另外四条是三类责任和会议范围。

### 7.2 Audio → Transcript

| 检查 | 结果 | 怎样理解 |
|---|---:|---|
| 关键事实 Coverage | 8/8，100% | 八条事实的核心数字、否定词、责任和问题状态都能在 Transcript 找到 |
| Critical Coverage | 4/4，100% | 四条最重要事实都保留下来 |
| Segment 数量 | 379 | 带说话人标签和毫秒时间点 |
| Ground Truth 起点误差 < 5 秒 | 6/8，75% | 成本句与 David 任务句落在较长 Segment 中，Segment 起点误差分别约 14.9 秒、8.5 秒 |

这个结果不能叫“整场转写准确率 100%”。这里只验证了八个预先固定的业务事实，没有计算全场 Word Error Rate；音频约 21 分 13 秒，派生 Segment 到约 19 分 17 秒，尾部是否全为无业务内容也没有作为准确率结论。

### 7.3 Transcript → AI 初稿

| 指标 | Raw final 10 | Persisted 6 | 质量门 |
|---|---:|---:|---:|
| Ground Truth Strict Recall | 6/8，75% | 4/8，50% | ≥ 90% |
| Ground Truth Coverage Recall | 6/8，75% | 4/8，50% | ≥ 90% |
| Critical Recall | 2/4，50% | 1/4，25% | 100% |
| 候选事实人工核查 | 10/10 在 Transcript 有依据 | 6/6 在 Transcript 有依据 | Claim Precision ≥ 95% |

Strict 与 Coverage 相同，是因为这次六个命中都是完整命中，没有只覆盖半条的情况。Raw final 命中：会议范围、David 任务、Craig 任务、Andrew 任务、售价和成本上限。它漏掉了“国际市场”和“电视功能范围未定”。

Raw final 另外四条是会议里确实存在的 1,500 万欧元目标、售价口径未决、多设备用途设计方向和半小时后的下次会议。它们不在预先挑出的八条评分集中，因此不能提高 Recall；但人工回看也没有发现它们是捏造，不能为了算一个漂亮的 Ground Truth Precision 就把四条真实信息写成错误。

### 7.4 为什么十条只留下六条

服务器没有静默吞掉四条，而是留下了明确原因：

1. Andrew 的市场任务：引用提示与服务器原文不完全一致。
2. 12.50 欧元成本上限：两个引用提示都没有通过逐字核对。
3. 售价是批发还是零售的未决问题：选择的 Segment 不是合法连续范围。
4. 合并多种设备用途的设计方向：选择的 Segment 不是合法连续范围。

因此 Run 以 `completed_with_warnings` 结束。安全门避免了不合格 Evidence 进入审核，这是正确行为；但它也把 Ground Truth 中的成本和市场任务挡掉了，所以落库后的 Recall 反而下降。

### 7.5 Evidence 结果

| 检查 | 结果 | 判定 |
|---|---:|---|
| 落库 quote 是否逐字来自 canonical Transcript | 6/6，100% | 通过机械硬门 |
| 落库时间是否由对应 Segment 回填 | 6/6，0 ms 内部误差 | 通过机械硬门 |
| 落库 Claim 是否被当前 quote 完整支持 | 4/6，66.7% | 未通过 |
| 与 GT 重合的落库 Claim，其 Evidence 起点误差 < 5 秒 | 1/4，25% | 未通过 |

David 和 Craig 的 Claim 包含“被分配具体任务、在下次会议前完成”，但证据安全门最后只留下他们开场自我介绍职位的句子。引文是真的，支持却不完整。这正是为什么 Evidence 不能只检查字符串是否存在，还要继续检查“这句话是否真的证明整条结论”。

### 7.6 本次耗时

| 阶段 | 耗时 |
|---|---:|
| Transcription 排队 | 10 ms |
| Transcription 处理 | 6 分 51.7 秒 |
| Extraction 排队 | 9 ms |
| Agent A inventory · `xhigh` | 1 分 28.4 秒 |
| Agent B verify · `high` | 30.3 秒 |
| verify escalated · `xhigh` | 1 分 09.1 秒 |
| Extraction 总计 | 3 分 07.8 秒 |
| 从开始转写到初稿完成 | 9 分 59.6 秒 |

这次排队已经很快，不能再把总时间解释成“排队十分钟”。主要耗时是长音频转写和三段模型处理。升级阶段没有改善 unresolved conflict，系统回退到 Agent B 的上一份结果；因此下一轮可以优先减少这种无效升级，但不能通过降低 `xhigh/high` 掩盖质量问题。

### 7.7 运行证据和结论边界

- Extraction Run：`run_603f383e77264fafa9c773b1cda18149`
- Transcription Run：`trun_31b196b40f734c75baa22e39cb31cdb9`
- Prompt / Schema：`claim-extraction-prompt.v8.2` / `claim-extraction.v3`
- 状态：`completed_with_warnings`

AMI 是公开许可的真实多人语音，但会议内容来自受控产品设计场景。它证明工程链路能处理真实多人音频，也暴露了 Recall 和 Evidence 选择问题；它不能证明房地产销售、真实客户转化或跨多次沟通 Preference progression 已经成功。

## 8. 需要再花时间看看

1. 在真实手机浏览器完成导航、Evidence、Timeline、Preference、刷新和连续审核验收；桌面只读路径已经通过。
2. 修复 Evidence 选择：自动改用连续、逐字、靠近目标事实的 Segment，尤其是成本上限和三位负责人的任务句。
3. 修复重要事实取舍：国际市场和电视功能范围问题明明存在于 Transcript，却没有进入最终十条。
4. 用当前 Prompt 和同一上下文重复三次，重新测语义稳定性。
5. 找一名没有看过 Ground Truth 的人完成审核，记录时间、修改、拒绝和补漏。
6. 如果能合法取得同一客户旅程中的第二份相关录音，再测 Preference progression；不能用无关会议拼接。
7. 继续修复 Claim 原子化、重要性排序、Reaffirmed 和 Relation target，不增加一个文案 Agent 掩盖错误。

## 9. 当前不能证明

1. 不能说准确率已经达到 95%。
2. 不能把人工修正后的正确报告算成 AI 初稿正确。
3. 不能说照片上传成功就代表图片理解成功。
4. 不能用 AMI 单场受控会议证明房地产或真实销售场景。
5. 不能证明跨沟通 Preference progression，除非有同一客户旅程的第二份材料。
6. 不能证明真人审核已经达到两分钟。
7. 不能把当前共享 Workspace 的 Sites 称为正式多用户 SaaS。
8. 不能说 PDF 已可靠参与分析；缺少页面文本适配器时会明确失败。
9. 不能把 AMI 的八条关键事实 Coverage 8/8 写成整场 Transcript 的 WER 或完整转写准确率。

## v23 发布与当前判断（2026-08-16）

Sites v23 已部署到原有公开地址，源码为 `db556104ef1a58da38c08ad3c1fab697f5405f02`。发布包由该提交重新构建，空库迁移、敏感信息审计、Worker 构建和 343 项自动化通过；生产 `AI_DRAFT_CONTEXT=0`，数据库已包含 `draft_link_candidates` 与 Event AI Artifact 表。

桌面和 390px 浏览器走查确认：公开共享提示、Summary-first、Readable/Raw 切换、刷新路由、客户进展四入口、行动空态、回收站入口和单一项目/沟通选择器均可用；控制台及最近 Worker 错误日志为空。

Realtor A/B 已从同一冻结提交启动并完成 Control；Treatment 因一场基础 Verify 与唯一升级 Verify 均合同无效而停止，未生成可评分的双臂结果。失败 Run 的失败与升级用量已完整记账，未留下 processing 孤儿。故当前不能声称房地产质量门、Draft Context Recall 或 Token 增幅门通过。

仍需完成：真实手机真人完整流程、GitHub 登录恢复后同步、重新跑完整 Realtor A/B 并由人工完成裁决；在此之前继续保持 `AI_DRAFT_CONTEXT=0`。

## 10. 当前公开部署

1. 完整交互应用：Sites v23，<https://notique-evidence-workspace.uclae2e12.chatgpt.site/>
2. GitHub：<https://github.com/Astro-wen/notique-product-prototype>，`main` 仍为 `9751edfb7fd4ab8193cb9aa72134a5c9296d57b1`；Sites v18 源码为 `1202a5d2778157e11571e3deb752a65007d5087b`
3. GitHub Pages 只负责跳转到 Sites，不承担 API、数据库、文件上传或模型任务。
4. 桌面与 390px 正式站 QA 已通过；实体手机真人 QA 和 v18 新付费 Run 仍未完成。

当前 Sites 适合用公开许可、合成或脱敏材料做 MVP 测试。测试者可能共用一个测试 Workspace、项目数据和模型额度。正式给不同客户使用以前，必须补 Workspace、权限和费用隔离。

## 11. 下一次给 Eric 的展示顺序

1. 先说明原来的问题：返回会乱、时间线不像时间线、Evidence 缺上下文、排队数字误导。
2. 演示方案怎样修：确定返回、真实阶段计时、目标句高亮、变化 Timeline。
3. 上传一份 Transcript 或公开许可音频。
4. 先展示 AI 初稿，不做人工修正。
5. 点击一条重点，展示目标句与前后文。
6. 返回初稿，再进入连续核对。
7. 完成后展示 Timeline、Preference 和 Brief。
8. 最后诚实汇报 AI 漏项、人工修改量、审核时间和仍未证明的场景。

## 12. 证据和说明位置

- Eric 简明阶段说明：`docs/ERIC_MVP_PROGRESS.md`
- 普通用户说明：`docs/USER_MANUAL.md`
- Claude 交接：`docs/CLAUDE_HANDOFF.md`
- 工程和质量门：`tests/ACCEPTANCE_CHECKLIST.md`
- AMI 来源与哈希：`work/real-business-audio/AMI_ES2002A_SOURCE.json`
- AMI 运行前 Ground Truth：`work/real-business-audio/AMI_ES2002A_GROUND_TRUTH.md`
- 三次稳定性证据：`work/stability-v5-realtor/`
- 音频工程闭环：`work/audio-transcription-e2e/REPORT.md`
- 三行业合成场景：`eval/cases/`

Google Docs 参考：

1. Product Concept：`1Oxb1UDQv2EYLA6Qw6t4PFiP2GjvItl0RNdcXl2NZv8w`
2. Homework：`16dShTePagThTHfxQMWXTXOSGYPXsJBzrwvUrgeBO_pg`
3. Eric 阶段验收主文档：当前没有确认 Document ID，写入前必须向 Aaron 确认，不能猜测或误写原始 Concept/Homework。
