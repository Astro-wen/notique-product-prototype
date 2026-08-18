# Notique Evidence POC

这是 Notique 的内部验证系统。它把 Project、Event、Transcript、照片和文件保存到服务端，生成待审核的 Claim，并把每条 Claim 连接回原始证据。只有人工确认且仍然有效的 Claim 才能进入事项概况、时间线、决定、偏好、待确认问题和风险等正式结果。

当前代码不包含示例 Claim、假 AI 结果或浏览器本地 Verdict。AI 服务未配置时，提取请求会明确返回 `MODEL_PROVIDER_NOT_CONFIGURED`。

## 当前范围

- 内部测试前端：创建 Project 和 Event、上传 Transcript、照片或录音、提交提取、审核 Claim、查看证据和正式结果
- 服务端 API：统一成功和错误格式、Workspace 隔离、写操作并发保护和幂等控制
- D1：Project、Event、Asset、Transcript Segment、Run、Claim Ledger、Evidence、Verdict、关系、结果快照和 Outbox
- R2：原始材料使用不可覆盖的版本化 Key 保存
- 确定性规则：Transcript 解析、逐字引文回填、状态机、Scenario、Views、Gap、Agenda 和 Brief
- 离线评测：固定公式计算 Recall、Precision、Evidence、Citation、关系、重提、稳定性和 Brief 指标，并单独判断样本量是否达到正式门槛
- ModelProvider 边界：OpenAI 兼容接口已经接好。未配置密钥时明确失败，不会生成占位 Claim
- 后台任务：D1 Outbox、租约、重试、失败收口和每分钟定时 Sweep 已接好；OpenAI 长模型阶段可以按已保存的 Background Response ID 恢复，也可以通过受保护的内部接口手动触发
- 阅读辅助：原始 Transcript 永久保留；Luna `high` 独立生成带原始引用的 AI 摘要和 100% Segment 映射的易读逐字稿。长逐字稿按固定边界分块续跑，任何遗漏、重复、乱序或敏感数字变化都会整份回退 raw-only
- 项目管理：项目可移到回收站、恢复或永久删除；永久删除先清 R2 文件再删 D1，运行中项目不能删除
- 买方客户旅程：新建项目时固定为房地产买方场景，持续追踪预算、融资、区域、硬性要求、偏好、不能接受项、决策人、房源反馈、未决问题和下一步行动
- 双层记忆：AI 草稿可以先读、稍后核对；只有人工确认内容进入可信报告。可选的跨沟通草稿上下文默认关闭，并且不能直接改变任何已确认事实
- 站内行动：`next_action` 可以从 AI 建议变为人工确认的行动，并在完成时留下可追溯的完成记录；不连接 CRM、日历或邮件

## 用户看到的 Transcript 三层

1. **AI 摘要**：用于快速读重点，每条重点都有原始 Segment 和逐字支持句。
2. **易读逐字稿**：完整内容的可读版本，补标点和分段，并显示每处修改；不能代替 Evidence。
3. **原始逐字稿**：不可覆盖的审计来源，所有 Claim 引文、时间点和音频播放都回到这里。

Summary Agent、Transcript Refiner 和事实识别共用现有 `AI_API_KEY`。前两者使用 Luna `high`，事实盘点 Agent A 保持 Luna `xhigh`，事实核对 Agent B 保持 Luna `high`。

## 本地运行

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run db:migrate:local
npm run dev
```

本地页面默认使用 `http://localhost:3000`。D1 和 R2 由当前 Sites/Vinext 开发环境提供。所有模型密钥只能配置在服务端环境变量中，不能写入浏览器代码、仓库、日志或数据库。

本地配置必须显式使用 `APP_ENV=local`。如果这个值缺失，服务会按生产环境处理并拒绝没有可信身份网关的请求。

## 模型和任务配置

复制 `.env.example` 中的变量到服务端环境。真实提取至少需要：

```text
AI_PROVIDER=openai
AI_MODEL=<固定版本的多模态模型>
AI_REASONING_EFFORT=xhigh
AI_VERIFIER_REASONING_EFFORT=high
AI_TWO_PASS_PIPELINE=1
AI_DRAFT_CONTEXT=0
AI_API_KEY=<服务端 Secret>
INTERNAL_JOB_TOKEN=<高强度随机 Secret>
```

OpenAI 的正式提取路径使用 Responses API。当前新 Run 的双阶段合同是 Prompt v9：
Context Pack v3、Agent A Inventory v3、Agent B Verification v4，最终 Claim 输出继续使用
claim-extraction v3。Prompt v8.2 与更早 Run 只作为历史审计，不会混进新合同：
Agent A 使用 `AI_REASONING_EFFORT=xhigh` 盘点最多 24 条内部原子事实，Agent B 默认用
`AI_VERIFIER_REASONING_EFFORT=high` 查漏、纠错、判断 Reaffirmed 和提出关系；确定性检查
发现关键遗漏、低置信关系、冲突、复合 Claim 或错误 Reaffirmed 时，Agent B 才升级到
`xhigh` 再复核一次。两个 Agent 共用同一个 `AI_API_KEY`，不需要第二个密钥。
`max` 不属于当前产品配置；缺失或误填的第一轮强度会回到 `xhigh`，第二轮会回到 `high`。

每个 OpenAI 模型阶段都以 Responses API 的 `background: true` 创建。服务端收到 Response ID
后先把它保存到对应阶段，再释放当前任务租约；后续 Outbox 唤醒使用
`GET /responses/:id` 查询同一个 Response。`queued` 或 `in_progress` 只安排下一次查询，不会
重新 POST 一个付费 Response。这样 Luna `xhigh` 不依赖某一次 Worker 请求一直保持连接，
页面刷新、重复 dispatch 和定时兜底也都能恢复同一个模型任务。

`AI_TWO_PASS_PIPELINE=1` 开启双阶段；设为 `0` 可回滚到单阶段执行。单阶段和非 OpenAI
兼容供应商仍由每分钟定时任务接管，不会放进网页请求的短后台时限。每个阶段的模型、
推理强度、输入哈希、Token、耗时、Provider Request ID、通过 Schema 的输出和升级原因
都会单独保存，成功的 Agent A 阶段可在同一 Run 重试时复用。全部执行参数都会写入 Run
输入指纹，参数改变后必须创建新 Run，不能混用旧结果。

Prompt v9 保持 Agent A `xhigh` 和 Agent B `high` 不变。Agent A 仍只读本次原始材料；
Agent B 可以在功能开关启用时读取之前沟通中有合法原始 Evidence 的 AI 草稿，但这些草稿
不是正式 Evidence、不能成为正式 Relation 目标，也不能关闭、取代或再次确认任何旧 Claim。
模型只可提出独立的 Draft Link，等两端都被人确认后，再由用户决定是否建立正式关系。
`AI_DRAFT_CONTEXT=0` 是本地与生产默认值；完成固定 Realtor 对照测试前不得改为 `1`。

`AI_API_BASE_URL` 只在使用自定义兼容接口时填写。当前 DeepSeek 适配器只允许纯文字输入；有照片的 Event 必须选择支持图片的模型。PDF 仍需要独立的文本或页面提取适配器，系统会明确报错，不会假装已经读取 PDF。

录音转写使用 OpenAI Audio Transcriptions API。默认模型为
`gpt-4o-transcribe-diarize`，输出逐句说话人和开始、结束时间。原音频保留在私有
R2，转写结果作为派生 Transcript 保存；之后的 Claim 仍引用逐字原文和时间点，
证据页可以从对应位置播放原录音。录音支持 MP3、M4A、WAV、WebM、MP4、MPEG
和 MPGA，单文件上限 100 MiB。相关配置为：

```text
AI_TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize
AI_TRANSCRIPTION_TIMEOUT_MS=600000
MAX_AUDIO_BYTES=104857600
```

录音上传、转写和业务提取是三段独立的可重试操作。上传成功但转写失败时，原音频
不会丢失；转写成功前，原音频不会直接进入 Claim 提取。

Run Debug 只保留已经通过服务端 Schema 校验的模型 JSON，大小上限为 1 MiB，并与成功状态在同一个 D1 事务中写入。失败的 Run 保持为空。模型服务的鉴权信息和原始错误正文不会进入这个字段。

照片上传目前只接受 JPEG、PNG 和 WebP，单张上限 15 MiB。HEIC/HEIF 尚未接入转换器，因此前端选择和后端 Asset 初始化都会直接拒绝，文件不会先保存再到 extraction 阶段失败。每个 Run 默认最多 12 张照片、照片合计最多 30 MiB；总字节限制可通过 `MAX_RUN_IMAGE_BYTES` 调整。

每个 Run 在排队前会执行以下硬限制：单次输入 token、图片数量、图片总字节、Workspace 并发数、模型最大输出 token、每日模型 token。每日配额把已完成用量和排队中的预留量一起计算，因此并发请求不能绕过限制。`MAX_DAILY_EVAL_COST_USD` 目前没有参与普通 Run，因为仓库尚未内置经过确认的模型价格表；现阶段不会伪造美元成本。

生产构建会从 `wrangler.jsonc` 带入每分钟一次的 Sweep 和 Dispatch 定时任务。双阶段 OpenAI 提取使用 Responses Background mode：网页请求只负责一个短检查点，Response ID 会先写入 D1，之后按同一 ID 恢复查询；长音频转写和单阶段回滚则由定时任务接管。`POST /api/internal/jobs/dispatch` 与 `POST /api/internal/jobs/sweep` 可用于部署检查，必须提供 `Authorization: Bearer <INTERNAL_JOB_TOKEN>`。当前实现使用 D1 Outbox 调度边界和 OpenAI Background Response 恢复查询，尚未宣称 Cloudflare Queue 已部署。

## 生产安全条件

- `AUTH_GATEWAY=chatgpt` 时，托管网关必须删除外部请求自带的 `oai-authenticated-*` Header，再注入已验证身份
- `AUTH_GATEWAY=cloudflare-access` 时，Cloudflare Access 必须位于 Worker 前方并完成 JWT 签名和 Policy 验证
- `AUTH_GATEWAY=public` 仅适用于明确标注为公开共享测试空间的部署：所有访客共享 `INTERNAL_WORKSPACE_ID` 和固定公开测试身份，任何访客都可以读取和修改其中的数据。真实客户资料不得进入该模式。
- 生产写请求要求同源 `Origin` 和 `Sec-Fetch-Site`
- R2 Bucket 必须保持私有；证据只通过经过 Workspace 校验的 API 返回
- Context Snapshot 只保存图片占位符、Hash 和文本上下文，不保存 base64 图片
- Project、Event、Transcript Import、Asset 初始化、Extraction Run、Scenario 确认和各类 Verdict 要求 `Idempotency-Key`；内容上传和 finalize 通过资源状态、内容 Hash 与数据库 CAS 保证重试安全

## 验证命令

```bash
npm run typecheck
npm run lint
npm run test:domain
npm run test:audit
npm test
npm run eval -- path/to/ground-truth.json path/to/predictions.json path/to/report.json
```

`npm test` 会先完成正式构建，再运行领域规则、泄漏规则、仓库契约和服务端渲染检查。数据库迁移位于 `drizzle/`，Schema 来源是 `db/schema.ts`。

`npm run eval` 需要填入人工确认过的 Ground Truth 和模型结果。空模板只用于说明格式，不能产生验证结论。完整说明见 `eval/README.md`。

## 普通用户使用指南

不需要先理解 Project、Run 或 Ledger。普通用户只需要记住这条循环：

```text
添加材料 → AI 初稿立即可读 → 重要内容可选核对 → 下一次沟通 → 客户进展 / 下一步 / 时间线
```

1. 选择或建立项目，再选择当前沟通。
2. 上传 Transcript、照片、PDF 或自己的录音；也可以直接使用浏览器录音。MP3、M4A、WAV、WebM、MP4、MPEG 和 MPGA 均可，单个录音上限 100 MB。
3. 录音完成转写、材料显示“可以分析”后，点击一次“开始分析”。刷新不会建立第二个付费任务。
4. 第一次分析先确认使用场景，然后阅读整场 AI 初稿。点击重点可以查看放大的目标句、精确高亮和前后两段原文。
5. 优先核对金额、日期、责任人、矛盾、低置信内容和关系；其他草稿可以稍后处理。保存后自动进入下一条。
6. 不清空 Pending 也可以准备下一次沟通；只有用户点击一次，才会开始下一次付费分析。未核对草稿不会进入可信报告。
7. 在“客户进展”同时查看标明可信状态的 AI 当前理解与 Verified-only 可信记忆；在“下一步行动”确认、修改、不采纳或完成行动。
8. Timeline、Brief 和正式报告继续只读取已经人工确认的记录。

页面地址会保存项目、沟通、当前栏目和记录。时间线打开证据后会“返回时间线”，审核记录会“返回审核列表”；刷新后也会从服务器恢复。

出现“仍在后台运行”时，点击“检查状态”只查询原任务。出现“处理失败”时按页面原因重新处理；空输出先检查材料。不要为了让流程继续而确认证据不足的内容。

完整说明、错误恢复、隐私边界和每个功能的位置见 [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md)。Eric 的非技术阶段说明见 [`docs/ERIC_MVP_PROGRESS.md`](docs/ERIC_MVP_PROGRESS.md)。接手项目请先读 [`docs/CLAUDE_HANDOFF.md`](docs/CLAUDE_HANDOFF.md)。

## Eric 一键演示

普通测试界面支持先导入一到十份 Transcript，再从“开始处理全部沟通”进入整组流程。
系统按 Project 中的沟通顺序一次处理一条。新的买方客户项目会直接固定场景，不再让 AI
猜 Scenario；历史项目仍保留原来的 Scenario 确认流程。每次结果先生成可立即阅读的 AI
草稿，用户可以核对重点，也可以稍后继续下一次沟通。默认关闭草稿上下文时，后续分析仍
只继承可信记忆；灰度开启后也只把旧草稿当成带明显标记的理解线索，绝不直接写入正式状态。
页面刷新后会继续读取服务器中的 Run，不会重复发起模型请求。

先按上面的步骤启动本地服务。另开一个终端运行下面这条命令：

```bash
npm run demo:eric -- --accept-fixture-scenario --confirm-reviewed-fixture
```

默认使用 Oak Street contractor 合成案例。也可以从仓库内已经审核过的三套案例中
明确选择一套：

```bash
npm run demo:eric -- --fixture=contractor --accept-fixture-scenario --confirm-reviewed-fixture
npm run demo:eric -- --fixture=realtor --accept-fixture-scenario --confirm-reviewed-fixture
npm run demo:eric -- --fixture=insurance --accept-fixture-scenario --confirm-reviewed-fixture
```

`--fixture` 只接受 `contractor`、`realtor` 和 `insurance`。命令不接受任意文件路径，
因此不能把未审核的本地 manifest 带进自动确认流程。它只调用本地正式 API，创建
Project，导入所选案例的 Transcript 和照片，再按时间顺序发起真实模型提取。每次
提取都等待后台任务完成，再继续下一次。最后打印事项概况、时间线、决定、偏好、
待确认问题、风险、下次议程和 Brief。

`--accept-fixture-scenario` 只用于这三套固定案例。每份 manifest 在运行前声明
`all_required_concepts.v1` 语义验收规则，`expected` 是审计用的稳定标签。案例导入
不会把 `scenario.expected` 或 `scenario.semanticAcceptance` 字段发给模型。模型先
独立生成两个或三个自然语言候选，脚本随后
检查每个候选是否覆盖清单中的全部必要概念。恰好一个候选通过时，脚本确认该候选
的原文；没有候选通过或多个候选同时通过都会停止。置信度不参与自动选择。正式用户
测试仍然必须由人阅读候选项后再作选择。

`--confirm-reviewed-fixture` 表示你明确允许脚本为这个合成案例提交 Evidence 审阅
确认、Claim 确认和重复事实确认。去掉该参数时，Claim 会保留在待审核状态。去掉
`--accept-fixture-scenario` 时，脚本会在第一次提取后停止，因为后续 Event 按产品
规则必须等待场景确认。保留场景确认、去掉自动审阅参数时，三个 Run 会完成，但
报告状态为 `awaiting_review`，不会把空的已确认结果写成成功。脚本不会静默代替
用户作决定。

如果终端连接在 dispatch 后中断，脚本会继续查询已经创建的 Run ID，不会重新创建
Run。若需要从同一个案例身份恢复，可重复使用一个安全的关联 ID：

```bash
npm run demo:eric -- --correlation-id=eric-homework-01 --accept-fixture-scenario --confirm-reviewed-fixture
```

同一个关联 ID 会复用导入和提取步骤的幂等键，避免因为不确定的网络结果重复付费。
同一个关联 ID 用在不同行业案例时会生成不同的内部关联值，因此三套案例不会复用
彼此的 Project、导入或提取结果。
本地队列里即使已有其他任务，脚本也会持续 dispatch 和查询，直到本次 Run 完成或
达到超时。每次调用仍会生成一份新的 JSON 文件，因此恢复记录不会覆盖旧记录。

每次执行都会把完整 JSON 记录写入 `outputs/eric-demo/`。文件名包含所选 fixture。
记录包含 fixture 名称、仓库相对路径、manifest SHA256、内部关联值、模型 Run ID、
服务端 Request ID、模型 Provider Request ID、最终 Project 状态和八份结果。这个
目录不会提交到 Git。失败也会保留已完成步骤和错误对应的 Request ID，方便排查。
如果失败发生在本地网络层且服务端没有返回响应，对应 Request ID 会明确记录为
`null`，不会借用上一条成功请求的 ID。

如果模型没有配置，命令会明确报 `MODEL_PROVIDER_NOT_CONFIGURED`。脚本不读取或
打印 API Key，也不会在安装、构建或测试时自动运行。只有人工执行
`npm run demo:eric` 才会调用付费模型。合成案例只用于工程演示和回归，不能作为
Concept Validation 已经通过的证据。

单次 Run 默认最多等待 10 分钟，覆盖当前服务允许的 9 分钟模型超时。脚本依赖
已经启动的本地服务，本身不会创建后台服务，因此结束时没有临时服务需要清理。
成功 Run 必须至少生成一条可审核 Claim 或 Occurrence。显式自动确认后，Folder
Summary 与 Timeline 必须包含已确认内容，Brief 也必须引用一条已确认状态；否则
命令失败，避免把结构正确但内容为空的响应当成演示成功。

## 尚未完成的外部接入

开始真实 Concept Validation 前还需要确认 Sites 已按 `.openai/hosting.json` 为 `DB` 和 `EVIDENCE` 创建并接好 D1/R2 资源，写入服务端 Secret，选择固定版本的高质量多模态模型，并完成 Ground Truth、稳定性、费用、延迟和 Blind Set 测试。Cloudflare Access 或 ChatGPT 托管网关的可信 Header 注入也必须由部署方确认。没有这些结果时，不能把本仓库称为已经完成的概念验证。
