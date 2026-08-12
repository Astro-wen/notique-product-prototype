# Notique 工程与真实模型验收清单

这份清单用于判断确定性工程底座和真实模型链路是否已经成立。工程检查通过不代表产品概念已经验证。模型结果仍需经过固定 Ground Truth、重复运行、盲测和人工审核计时。

## 验收原则

- 每项都要有自动测试、API 响应、数据库记录或日志作为证据。只看页面效果不算通过。
- 未配置模型时，系统应明确返回 `MODEL_PROVIDER_NOT_CONFIGURED`，不能返回示例 Claim 或兜底摘要。
- API Key 只存在于 Worker Secret。浏览器代码、Client Bundle、D1、R2 metadata、日志、错误响应和测试快照中都不能出现真实 Key。
- D1、R2、Queue 暂不可用时可以返回明确错误，但不能静默改用浏览器内存、静态数组或 `localStorage`。
- 以下任何 P0 项失败，本阶段整体判定为 Failed。

## A. 运行数据和 Mock 隔离

- [x] 运行时页面不包含写死的 Claim、引文、时间点、Event Summary、View、Brief Card 或 Deliverable 内容。
- [x] Fixture 只能位于 `tests/fixtures` 或明确的开发测试入口，不能被生产页面或 API Route 自动加载。
- [ ] Confirm、Reject、Edit、Withdraw、Import、Create Project 等成功提示只在服务端成功响应后出现。
- [ ] 刷新页面后状态来自 D1，不能依赖 React state、`localStorage` 或模块级 Map。
- [x] 未配置 AI Provider 时，Extraction Run 明确失败或停在不可执行状态，并返回 `MODEL_PROVIDER_NOT_CONFIGURED`。
- [x] 不存在 Mock Provider、Fallback Claim 或“如果调用失败就返回示例结果”的生产路径。

通过证据：静态工程审计、刷新测试、Provider 未配置集成测试。

## B. 最小持久化与隔离

- [ ] D1、R2、Queue 和 DLQ 在本地、Preview、Production 使用各自绑定。
- [ ] Workspace 身份只从服务端认证上下文取得，客户端传入的 `workspace_id` 被忽略。
- [x] Project、Event、Asset、Asset Version、Segment、Run、Claim、Claim Version、Evidence Ref、Verdict、Relation、Scenario Lease、Outbox 均有持久表。
- [ ] Asset Finalize 后不可覆盖，重新上传产生新 Asset Version 和新 R2 Key。
- [ ] 同一 Project 的 `sequence_no` 在事务中分配且唯一。
- [ ] Project A 无法读取 Project B 的 Event、Claim、Evidence、View 或 R2 文件；对外统一返回 `PROJECT_SCOPE_VIOLATION` 或 404。
- [ ] 浏览器关闭后，已入队 Run 仍可完成；Queue 重复投递不重复调用、不重复落 Claim、不重复记费用。

通过证据：D1/R2/Queue 集成测试和跨 Project 隔离测试。

## C. Canonical Transcript 与 Evidence

- [x] Fixture 覆盖精确匹配、仅空格/换行/标点标准化、跨 Segment、多处匹配、错误 ID、越界 Event、倒序 Segment 和完全不匹配。
- [x] 纯领域测试证明正式 Quote 来自原始 `text_raw`，时间点由首尾 Segment 回填，跨说话人引用分段保留。
- [x] Parser 对同一 Asset Version 重跑时 Segment ID、Ordinal 和 `text_raw` 稳定。
- [x] 模型返回的 Quote、Timestamp 或数据库 Claim ID 不被直接采信。
- [x] Segment 必须存在、属于当前 Workspace/Project/Event/Asset Version、在本次输入清单中且顺序合法。
- [x] Exact 失败后只允许空格、换行和标点标准化匹配；多处命中必须返回 `EVIDENCE_QUOTE_AMBIGUOUS`。
- [ ] 任何 Claim 没有结构有效的 Evidence 时都不能进入 Review。
- [x] 结构有效和语义支持分开记录。字符串匹配成功仍是 `unreviewed`；只有人工确认后，Direct Evidence 才变为 `fully_supports`，Corroborating Evidence 变为 `partially_supports`。
- [x] Claim 详情只有在当前 Version 要求的全部 Evidence 都请求成功，且返回数量和 ID 集合完全一致时才进入可审核状态。部分失败、缺失、重复、替换或额外 Evidence 都会显示未完整加载，并锁住 Confirm、核对声明与 Edit。
- [ ] 图片 BBox 只校验数值和边界，不自动证明 Business Claim；图片不能单独证明批准、付款、意图、责任、因果或隐藏条件。

通过证据：`tests/domain-invariants.test.mjs`、Parser Unit Test、Evidence Validator Integration Test。

## D. Verdict 状态机与版本

- [x] 纯领域测试覆盖 Confirm、Reject、Edit、Withdraw、Base Version Conflict 和关系失活，并且所有状态规则通过。
- [x] Confirm 只接受 `pending + active` Claim，成功后变为 `verified + active`。
- [x] Reject 只接受 `pending + active` Claim，不能用于已确认 Claim。
- [x] Edit 只接受 Pending 或 Verified 且未 Withdrawn 的 Claim，并总是新建 Claim Version，保留 AI 原版；两种状态在内部测试台都有修改入口。
- [x] 改变事实含义的 Edit 必须重新选择 Evidence 或明确创建 User Note Evidence，旧引文不能自动沿用。
- [x] Edit 后所有引用旧 Version 的 Active 入向和出向 Relation 在同一事务中失活；人工明确保留的出向关系以新 Relation ID 绑定新 Version。
- [x] Edit 不能用 contextual-only Evidence 直接变成 Verified；必须有 direct/corroborating Evidence 或人工补充依据。
- [x] 错判为 Reaffirmed 的 Candidate 可以拆成 1 至 10 条 Pending Claim，旧 Claim 不变；冻结版本变化后旧 Candidate 无法确认或转换。
- [ ] Withdraw 只接受 Verified 且未 Withdrawn 的 Claim；同一事务递增 Ledger Version 和 Context Version，并失活相关 Relation。
- [ ] Batch Verdict 全部成功或全部回滚。
- [x] Batch Confirm 只允许选择当前用户已对该 Claim Version 明确留下证据核对记录的项目；页面状态不能代替服务器记录，API Guard 也会再次校验。
- [ ] 所有 Verdict 只追加、不覆盖历史，并保存 Actor、Base Version、Request ID、时间和可选说明。
- [ ] 两个并发 Verdict 只有一个能成功，另一个收到 `CLAIM_VERSION_CONFLICT`。

通过证据：D1 Transaction Test、刷新测试、并发 CAS 测试。

## E. Pending、Rejected、Withdrawn 泄漏门

- [x] 纯领域测试证明 Verified Context 排除 Pending、Rejected、Withdrawn，包括由这些 Claim 提供来源的 Glossary。
- [x] 纯领域测试证明当前结果排除 Pending、Rejected、Withdrawn；Preferences 中明确约定的 Drift History 可以保留 Superseded 或 Resolved，Timeline 可以保留带明确 `withdrawn` 标签的历史。
- [ ] Context Pack Builder 在 SQL 层限定 Workspace、Project、`review_status = verified` 和允许的 Lifecycle，不能依赖前端过滤。
- [x] Folder Summary、Current Status、Decisions、Preferences、Open Questions、Risks、Gap、Agenda、Brief Card 都不能出现 Pending、Rejected 或 Withdrawn。
- [ ] Superseded 和 Resolved 只出现在规定的历史位置，不作为当前事实。
- [ ] Withdraw 后旧 View Snapshot、Context Snapshot、Agenda 和 Brief Card 都会失效。
- [ ] View Builder 不读取原始 Transcript、照片或模型输出补事实，只读取 Ledger 和确定性 Relation。

通过证据：Query Integration Test、View Leakage 计数固定为 0。

## F. Scenario Assessment Lease

- [ ] 领域测试和 Repository 测试共同覆盖首个 Event 限制、单 Owner、其他 Owner 冲突、失败释放和 Scenario Version CAS。
- [x] 只有 Project 中首个有序 Event 可以取得 Scenario Assessment Lease。
- [ ] Lease 有 Owner、Event、过期时间和有限重试；Consumer 崩溃或 Run 失败后可安全释放。
- [x] 后续 Event 永远不能在第一 Event 失败时抢占评估。
- [x] Scenario 等待确认时，后续 Extraction 返回 `SCENARIO_CONFIRMATION_REQUIRED`。
- [x] Scenario Confirm 使用 `scenario_version` CAS，同时递增 Scenario Version 和 Context Version。
- [ ] Scenario Confirm 后旧 Folder Summary、Gap、Agenda、Brief Card 和 Context Snapshot 不能继续命中。

通过证据：并发 Integration Test 和 Sweeper 测试。

## G. Idempotency、Outbox 与重复投递

- [x] Repository 测试证明同 Key 同 Hash 只执行一次，同 Key 不同 Hash 被拒绝。
- [ ] 所有写 API 都要求 `Idempotency-Key`；缺少时返回 `IDEMPOTENCY_KEY_REQUIRED`。
- [x] Verdict 和 Extraction 的 Idempotency 记录持久化到 D1，不使用进程内 Map。
- [ ] Canonical Input Hash 包含有序 Asset Version Hash、Segment/Parser、Context Snapshot、Provider/Model 参数、Prompt、Schema 和 Locale。
- [ ] Run 和 Outbox 在同一 D1 事务写入；Queue 首次发布失败后 Dispatcher 能补发。
- [ ] Consumer 使用 CAS Lease；重复 Delivery 返回同一 Run 结果，不重复模型调用。
- [ ] Sweeper 能恢复超时 Lease 和长期 Queued Run；超过重试上限进入 DLQ 并留下明确状态。

通过证据：Outbox、Dispatcher、Consumer、Sweeper 集成测试。

## H. 错误契约

- [x] 所有响应带 `request_id`；错误使用稳定的 `{ error: { code, message, details? }, request_id }` 结构。
- [ ] 已实现并测试：`ASSET_UNSUPPORTED_FORMAT`、`ASSET_TOO_LARGE`、`TOO_MANY_IMAGES`、`IMAGE_CONVERSION_FAILED`、`TRANSCRIPT_PARSE_FAILED`、`EVENT_NOT_READY`、`MODEL_PROVIDER_NOT_CONFIGURED`、`MODEL_TIMEOUT`、`MODEL_OUTPUT_INVALID`、`EVIDENCE_VALIDATION_FAILED`、`RUN_BUDGET_EXCEEDED`、`WORKSPACE_RUN_LIMIT`、`SCENARIO_CONFIRMATION_REQUIRED`、`SCENARIO_VERSION_CONFLICT`、`QUEUE_DISPATCH_DELAYED`、`CLAIM_VERSION_CONFLICT`、`CLAIM_STATE_CONFLICT`、`IDEMPOTENCY_KEY_REQUIRED`、`PROJECT_SCOPE_VIOLATION`。
- [ ] 错误响应不含 Stack、Secret、Provider 认证正文、完整 Transcript、图片 Base64、PDF 文本或 User Note。
- [ ] 部分 Evidence 失败时 Run 为 `completed_with_warnings`，无合格 Claim 时才为 Failed。
- [ ] 413、415、422、409、429、502、504 的 HTTP 映射与技术方案一致。

通过证据：API Contract Test 和敏感内容快照测试。

## I. API Key 与日志

- [ ] `AI_API_KEY` 只通过 Worker Secret 注入；`.env.example` 只有变量名，没有值。
- [x] Client Source 和 `dist/client` 不包含 API Key 变量名、Bearer Token 或真实 Key 形态。
- [ ] Git 跟踪文件不包含 `sk-`、Anthropic/Gemini/OpenAI/DeepSeek 真实 Key、私钥或完整 Authorization Header。
- [ ] 日志只记录 Request/Run/Project/Event ID、版本、Token、图片数量、延迟、费用和错误码。
- [ ] Debug 仅内部访问，普通 API 不返回 Provider 原始错误或原始模型正文。

通过证据：Source Scan、Client Bundle Scan、错误/日志测试。

## J. 确定性工程阶段的完成门

- [x] `npm run build` 通过。
- [x] `npx tsc --noEmit` 通过，没有忽略或豁免类型错误。
- [x] 原有测试已经更新到当前产品，不再测试已删除的 starter skeleton。
- [x] `node --test tests/domain-invariants.test.mjs` 全部通过。
- [x] `node --test tests/repo-readiness.audit.mjs` 全部通过。
- [ ] CI 不调用付费模型；真实模型 Eval 只在手动或有预算上限的工作流运行。
- [ ] 在没有 Provider Key 的环境可以完成 Project/Event/Asset/Transcript Parser、Evidence Validator、Verdict、Scenario、View 和错误路径测试。
- [ ] 没有手改数据库、刷新即丢状态或依赖静态示例数据的演示步骤。

这一组工程门决定真实模型结果能不能被准确测量。当前已经做过两次受控的开发 Run，所以尚未勾选的部署项不会抹掉现有结果，但它们仍然阻止我们把开发 Run 当成正式概念验证。

## 当前自动化证据

- `npm test` 通过，合计 211 项。测试包含生产构建、领域规则、迁移、Eval Runner 算法、Production Run 导出一致性、Repository 契约、多模态上传边界、Glossary、Occurrence 转换、Evidence Review、人工 Relation 决策门、双 Agent v8.2/v3 合同、阶段恢复与分段计时、单 Event Smoke 导入、自然语言 Scenario Gap、Timeline、服务端审核计时、音频上传和转写、浏览器直接录音、三行业一键 Eric 演示、整组沟通顺序工作流、引导式状态恢复、连续审核导航、生产 Bundle 和发布包密钥扫描。
- `npx tsc --noEmit` 通过，没有忽略 TypeScript 错误。
- `npm run lint` 通过。
- 空 SQLite 数据库可顺序应用全部 D1 Migration，且 `foreign_key_check` 为零。
- 四个资源创建接口均要求 `Idempotency-Key`。Project、Event、Transcript Import 和 Asset Init 会把 Request Hash 与 Response 一起写入 D1。同 Key 同 Body 返回原结果，同 Key 异 Body 返回 409。
- Transcript Item 上传通过 `pending` 到 `uploaded` 的条件更新决定唯一赢家。Finalize 后同内容可重放，不同内容返回 409，上传路径没有把 `finalized` 改回 `uploaded` 的 SQL。
- Outbox 遇到已持久化的 Terminal Failed Run 会确认消息，避免重复调用模型。遇到 `lease_not_acquired` 会先重读 Run；Run 仍是 Queued 或不存在时保留重试，只有 Processing 或 Terminal 状态才确认消息。
- 生产 Worker 配置包含 `*/2 * * * *` 的 Sweep/Dispatch Cron。只有明确的 `APP_ENV=local` 会启用本地身份，缺失或拼错按 Production 处理。
- 审核页会在第一次打开有待核对内容的 Project 时创建服务端计时 Session。计时同时覆盖 Pending Claim 和 Pending Occurrence，刷新或关闭页面不会重置；队列清空后由服务端保存完成时间和总耗时。当前只证明计量工具可用，仍需真人完成一次审核后才能判断两分钟目标。
- 最小测试页支持从空白状态直接上传录音。系统会先建立 Project 和第一次 Event，再保存音频并启动转写，不再要求用户先上传 Transcript。转写启动失败时，错误不会被随后的页面刷新覆盖，已上传的音频也不会丢失。失败或长时间停留的任务可以重新检查或重新转写；轮询次数按同一个 Run 累积，不会因页面重复渲染不断归零。成功后既保留简短预览，也可打开包含全部说话人、原文和时间点的完整逐字稿。
- 核心页已重新排布为“沟通列表 + 当前沟通”工作区。当前项目和当前沟通持续显示；材料、Transcript、待核对和结果放在同一条标签导航中；技术调试继续保留在高级工具。桌面端使用左右布局，手机端把沟通列表变为顶部横向选择区。390px 视口实测没有横向溢出。
- 材料区现在同时提供“直接录音”和“上传已有录音”。直接录音覆盖麦克风授权、开始、暂停或继续、结束、试听、重新录制和保存。保存后生成现有音频上传格式，并继续复用同一套持久化、说话人转写和逐字稿流程，没有新增第二套后端逻辑。
- 空白状态也可以直接选择照片或录音。页面会保留用户已经选择的 File，在后台创建 Project 和第一次 Event 后继续同一次上传，不要求重新选择文件。
- 转写遇到 408、429、服务端临时错误、网络中断或超时，会在同一个 Run 和 Outbox 内有限重试。Provider 结果写入 R2 暂存区后，后续数据库持久化重试会复用同一结果，不重复调用 Provider。旧 Run 和旧 Lease 无权覆盖当前录音状态；dead letter 会在同一事务中更新 Run 和当前录音。
- 较长或多人抢话的录音改用 OpenAI 的逐段流式返回，避免把整篇逐字稿塞进一个容易截断的 JSON。模型片段若因重叠说话而乱序，系统会在保留原始时间点的前提下稳定排序。流式结果缺少最终完成事件时仍会拒绝写入，避免把不完整逐字稿当成正式材料；失败页会显示后台保存的具体校验原因。
- Evidence 文件读取支持单一 Byte Range，覆盖完整响应、指定起止、开放结束、后缀范围和越界 416。浏览器音频播放可以从时间点继续读取，同时保持 Workspace 和 Project 范围校验。
- 最小测试页可以用一个大按钮处理 Project 中的一到十次沟通。系统严格使用服务端返回的沟通顺序，一次只处理一条。第一次会停下来让用户确认 Scenario，每次生成候选后会停下来让用户核对；待审核内容清空后才允许继续下一次，所以后续 Context 只继承已经确认的记录。已有 Run 只会继续轮询，不会重复提交。零候选、未就绪材料和旧的单条分析入口都不能绕过这条顺序。
- 引导式页面只在浏览器保存最近 Project ID、Event ID 和“已开始整组处理”的导航意图，不保存 Claim、Evidence、Verdict 或报告。刷新后会从服务器恢复真实 Run、Scenario 和待核对数量。分析完成会直接进入 Scenario 或第一条审核；单条确认、拒绝或修改后自动进入下一条；本次清空后只准备下一次沟通，必须由用户再点击一次才产生下一次模型请求；整组完成后自动打开会前速览。
- 连续审核桌面端使用“队列、Evidence、决定”三栏。手机端队列变为横向选择区。Relation 继续要求逐条接受或拒绝，Evidence 不完整时确认和修改继续锁定；批量处理被收进次级区域，没有削弱服务端 Evidence attestation。后台等待超时显示“仍在后台运行”，其“检查状态”动作只读取原 Run。
- `npm run demo:eric -- --fixture=contractor|realtor|insurance --accept-fixture-scenario --confirm-reviewed-fixture` 会通过正式本地 API 运行仓库白名单中的固定行业案例，默认使用 Oak Street contractor。manifest 预先写明 Scenario 的必要概念，且 `scenario.expected` 与 `scenario.semanticAcceptance` 两个字段不会进入模型输入。模型返回自然语言候选后，脚本只确认唯一一个覆盖全部必要概念的候选原文；零个或多个候选通过都会失败，置信度不会替代语义验收。遇到空结果、错误 Scenario、脏队列或 dispatch 网络结果不明会明确失败或恢复，不会把空页面写成成功。脚本保存 fixture ID、路径、SHA256、隔离后的幂等关联值、Run ID、API Request ID、Provider Request ID、语义匹配记录和八份结果。任意 manifest 路径会在网络请求前被拒绝；自动确认只允许三套合成回归案例，不能算作真人审核或 Concept Validation 证据。
- 14.559 秒双说话人合成 WAV 已通过正式 Audio Asset、R2、Transcription Outbox 和 OpenAI Audio Transcriptions API 跑通。`gpt-4o-transcribe-diarize` 生成 3 个有说话人和毫秒时间戳的 Segment，并创建与原始音频版本绑定的派生 Transcript Asset。
- 派生 Transcript 已继续通过 production extraction path 调用 `gpt-5.6-luna`、`reasoning=max` 和 Prompt v5。Run `run_9e2a97559e644b2eb5b4ad9442c79db1` 生成 5 条有 canonical Evidence 的候选；场景与五条记录经人工核对后写入 Verified Ledger。Project 的 Pending 数量为零，Folder Summary、Timeline、Decision、Open Questions、Agenda 和 Brief 均能读取确认后的内容。详细记录见 `work/audio-transcription-e2e/REPORT.md`。这证明音频作为产品入口的工程闭环，不证明现场收音品质。
- 当前代码已锁定 `claim-extraction-prompt.v8.2` 和 `claim-extraction.v3`。Agent A 最多盘点 24 条内部原子事实，Agent B 必须逐条说明 `included / merged / duplicate / unsupported / lower_priority`，最终仍最多 10 条。关键遗漏、低置信关系、冲突、复合 Claim 或错误 Reaffirmed 会确定性触发 xhigh 加强复核。旧 Prompt 或旧 Schema 的排队任务会在调用模型前失败。v8.2 没有降低 xhigh/high 质量设置，只把共有证据上下文放到稳定前缀并使用同一缓存标识；Prompt v8.1 的质量结果继续作为历史基线，v8.2 尚待同样本付费复测。
- 当前执行强度只允许 Agent A 使用 Luna `xhigh`、Agent B 使用 Luna `high`，升级复核使用 `xhigh`。`max` 已从可接受配置中移除；缺失或误填的第一轮配置回到 `xhigh`，第二轮回到 `high`。连续十分钟没有完成记录的模型阶段会触发恢复检查；旧 `max` Run 不会被原地复用，避免以错误配置继续消耗时间。
- 已确认、仍处于 Active 状态且带结构化歧义的 Claim 会进入 Agenda，并显示追问、原因和候选答案。Pending 歧义不会进入 Agenda。普通 Open Question、未解决矛盾和 Scenario Gap 仍按各自来源生成，结果页不从原始 Transcript 临时补内容。
- 三个合成场景已确定性合并为一个 Transcript-only 开发包，共 3 个 Scenario、11 个 Event。每个 Event 固定有 5 到 10 条 material Ground Truth。原始 Contractor 压力样本每个 Event 分别有 15、15、17 条 material Ground Truth，超过十条模型输出上限，理论最高 Recall 只有 66.7%、66.7% 和 58.8%，不能直接用于正式 80% Recall 判定。合并脚本使用提交在代码中的固定 `single-author-review-priority-v1` 投影，在看到模型结果前为 Contractor 三个 Event 各选定 10 条审核重点，并记录源文件哈希和所选 ID。这个开发包仍是单人标注，`sample_eligible=false`。
- GitHub Pages 构建只生成跳转页，指向完整 Sites 应用，避免把静态页面伪装成可处理上传和分析请求的全栈产品。ChatGPT Sites 已作为公开的全栈测试入口，上传、转写、分析、审核和报告仍要在 Sites 完成，不能直接在 GitHub Pages 静态文件里运行。

## K. 真实模型阶段的当前结论

工程底座和真实模型调用已经成立，产品概念验证尚未通过。当前代码版本是双 Agent Prompt v8.2、Schema v3；Prompt v8 与 v8.1 Contractor 单 Event Smoke 均已运行，v8.1 仍未通过 Recall 与优先级硬门。v8.2 只加入共享上下文缓存与测试计时，尚未产生新的质量结果。三行业连续 Event 仍属于 Prompt v7 历史结果，下面用于说明新合同必须解决的真实缺口。

### 双 Agent Prompt v8 / v8.1 Contractor Smoke

本轮只选 Contractor Event 3，材料为 Transcript 加一张现场图。按照预先停止门，Contractor 未达标后没有继续 Realtor 或 Insurance。

- 首次 Prompt v8 Run `run_a4cd85a961bb4ad0b158ca4662dfc023`：Agent A 成功输出 24 条 inventory；Agent B high 输出合法，但 xhigh 加强复核生成三个不存在于 Verified Context 的 Relation target，服务端正确拒绝，Run 以 `MODEL_OUTPUT_INVALID` 失败。这暴露了“可选升级失败不应抹掉上一份合法结果”和失败 Run 用量聚合两个工程缺口，现已修复。
- 修复回退后的 Prompt v8 Run `run_20ab09437173442ab0dea57289f8b19e`：Run 为 `completed_with_warnings`，三阶段共 23,954 input、44,861 output、4,971 cached tokens。Agent A 把 21/24 候选标成 critical；Agent B high 为保持原子性丢弃了 11 个 critical 候选，xhigh 则把 9/10 条合成复合 Claim。两种结果都不满足硬门，因此停止扩大测试。
- 收紧 critical 定义、升级反馈和最终采用规则后，Prompt v8.1 Run `run_7b8631a91b7844e18a6e0c9bb7c8a56f` 成功。Agent A 为 24 条 inventory 中 10 条标记 critical；Agent B high 直接生成 10 条原子 Claim，不需要第三阶段。总用量 14,657 input、25,014 output，耗时约 180 秒。
- v8.1 的 10/10 Claim 都有逐字 Transcript Evidence，Evidence ID 有效，时间点与标准 Segment 起点误差均为 0 ms；没有不支持的图片推断。但它没有使用照片作为 Evidence，原始图片 material facts 仍为 0/3。
- 对提交前固定的 Contractor Event 3 十条 review-priority Ground Truth，v8.1 最宽松的语义覆盖最多 7/10；moisture cause、appliance assignment、inspection slot 明确遗漏，pendant cancellation 和 labor correction 只保留部分命题。Critical 最宽松覆盖最多 6/7，严格完整匹配更低。因此 Material Recall 90%、Critical Recall 100% 和 Ground Truth Claim Precision 95% 均不能判通过。

结论：双 Agent 已显著改善原子性和 Evidence 可靠性，但还没有解决十条上限下的重要事实排序。下一轮应先修 inventory priority / verifier selection，再只复测同一个 Contractor Event；它通过前不运行另外两行业或完整 11 Event。

### Prompt v7 / xhigh 三行业连续 Event

三组案例均从空 Project 开始，通过正式本地 API 顺序导入 Transcript、确认一次 Scenario、生成审核队列、写入 Verified Ledger，并重新读取 Folder Summary、Timeline、Decisions、Preferences、Open Questions、Risks、Agenda 和 Brief。自动确认仅用于固定合成回归，不等于真人审核。

| 场景 | Event / 输出卡片 | Strict Recall | Coverage Recall | Strict Precision | 关系 Strict Recall | 精确引文 / 时间点 | 最终质量判定 |
|---|---:|---:|---:|---:|---:|---:|---|
| Contractor | 3 / 30 | 14/30，46.7% | 21/30，70.0% | 14/30，46.7% | 5/11，45.5% | 32/32；0 ms | 失败：偏好历史不完整，图片独立事实 0/7 |
| Realtor | 4 / 40 | 29/38，76.3% | 33/38，86.8% | 29/40，72.5% | 7/16，43.8% | 41/41；0 ms | 失败：Risks 为空，后两场 Recall 低 |
| Insurance | 4 / 39 | 22/39，56.4% | 32/39，82.1% | 22/39，56.4% | 5/24，20.8% | 39/39；0 ms | 失败：关系与生命周期错误，当前偏好丢失 |

本轮确定性 View 修复后，三组 Brief 都具备固定六槽且 `missingSlotCount=0`。这只证明结构完整：Contractor 仍缺偏好漂移历史，Realtor 的 Risks 仍为空，Insurance 的 state 与 Agenda 受旧 lifecycle 污染。三组都不能判为 Useful Brief 通过。

本轮 Run ID：Contractor `run_2a93aeae7d8741eb9b8fde21521a05bf`、`run_29f70b9976a84adeb2f54a13671e2868`、`run_017be324754c462a96799a8c57875354`；Realtor `run_76f69381d3b1482baae36d7be6b539d5`、`run_29a67a474b8942deabca66346b3be3c9`、`run_b0dba97ad8284031a210176c3e6d41e6`、`run_fd08b30337b04b7d8244d5792455a5cc`；Insurance `run_8b5bf3818ca04c639ae3736ede65437c`、`run_0a0921539e51425aac0e70aa2af9a710`、`run_aed06179008c46f38f240a084bc133ef`、`run_9f45e00077b944ff94d6a14aed3aa4f7`。

三组逐字引文和时间点均通过 Eric 的硬门，Claim 原子化、重要事实取舍、Reaffirmed、关系类型与 target 选择没有通过。每个 Event 只有一次独立 v7 模型调用，尚未构成三次稳定性证据；所有审核由 synthetic harness 执行，`review_sessions=0`，两分钟真人审核也尚未证明。

### 同一输入三次稳定性

Realtor Event 2 使用完全相同的输入、Verified Context、模型、Prompt v5 和参数独立运行三次：

| 指标 | Run 1 | Run 2 | Run 3 | 门槛 |
|---|---:|---:|---:|---:|
| 重要事实 Recall | 6/9，66.7% | 6/9，66.7% | 8/9，88.9% | 每次至少 80% |
| Claim Precision | 6/10，60.0% | 6/10，60.0% | 8/10，80.0% | 每次至少 85% |
| Relation Recall | 2/5，40.0% | 2/5，40.0% | 3/5，60.0% | 每次 100% |
| Relation Precision | 2/5，40.0% | 2/6，33.3% | 3/6，50.0% | 每次 100% |
| 原文逐字匹配 | 100% | 100% | 100% | 100% |
| 最大时间点误差 | 0 ms | 0 ms | 0 ms | 小于 5,000 ms |

三次严格语义稳定性为 1/17，也就是 5.9%，低于 85% 门槛。Brief 每次只有 4/6 个来源有效，人工 Useful 判定为 0/6。详细记录见 `work/stability-v5-realtor/REPORT.md`。这组结果证明 Evidence 回填稳定，也证明事实取舍、关系分类、重复事实判断和 Brief 仍然不稳定。

### Contractor 三次连续 Event

一个全新 Contractor Project 已连续完成三个 Event。三个 Event 都使用 Prompt v6，并在后续 Event 继承前面已确认的 Ledger。

| 指标 | Event 1 | Event 2 | Event 3 |
|---|---:|---:|---:|
| Transcript Ground Truth 覆盖 | 8/13，61.5% | 7/13，53.8% | 约 9/14，64.3% |
| Critical Ground Truth 覆盖 | 未单列 | 4/7，57.1% | 6/8，75.0% |
| 图片独立事实覆盖 | 0/4 | 0/4 | 0/4 |
| 内部审核时间 | 1 分 25 秒 | 4 分 12 秒 | 2 分 28 秒 |

这组原始 Contractor Ground Truth 超过十条输出上限，只能用作压力测试和遗漏诊断，不能用来给 Homework 的 80% Recall 下正式结论。Event 3 漏掉了一条应当解决旧风险的关系，之后已通过人工补关系修复结果页。这证明 Human Review 可以修正项目状态，也说明模型关系能力仍未通过。

### 当前结论

- Transcript、图片和音频都能进入真实服务链路，Claim、Evidence、人工审核、关系和结果页可以持久化工作。
- 已保存 Run 的逐字引用和时间点准确，重要事实 Recall、Precision、关系和稳定性没有达到门槛。
- Contractor 三次图片独立事实覆盖均为 0/4，图片理解没有通过。
- 音频只用合成 WAV 跑过一次。现场噪音、距离、多人重叠、口音和设备差异没有测试。
- Prompt v8.2 和 Schema v3 的双阶段合同、升级规则、阶段恢复、关系人工审核、分段计时和调试记录已经有自动测试；模型质量仍需重新跑固定样本。
- 当前成果可称为可继续测试的工程原型，不能称为已经完成 Concept Validation。

## 尚未取得证据的正式验证

下面几项继续保持未勾选。当前没有对应的 live API 结果或受控评测数据，不能用源码审计代替。

- [ ] 在 Cloudflare Preview 或 Production 实际运行 D1、R2、外部 Queue 和 DLQ，验证重复投递、Lease 过期、重试和死信恢复。
- [x] 使用真实 AI Provider 完成 Transcript 与图片输入，记录输出质量、延迟、Token 和失败类型。
- [ ] 从实际账单或 Provider Usage API 取得并保存每个 Run 的真实费用。当前只保存 Token，未伪造费用。
- [ ] 建立 Ground Truth 数据集，由专业人员标注 Claim、Evidence、Scenario 和应当拒绝的结论。
- [ ] 进行 Blind Eval，评审者不知道输出来自哪一版 Prompt 或模型，并按预先固定的指标评分。
- [ ] 对同一合格输入完成至少三次独立 Run，并通过稳定性门。
- [ ] 从空 Project 开始，用当前 Prompt v8.2、Schema v3 连续跑完 Event 1、人工审核和后续 Event，建立同版本基线，并记录每阶段耗时与缓存命中。
- [ ] 由第二位标注者独立标注 Realtor 和 Insurance 开发集并完成分歧裁决。
- [ ] 真实计时验证一次人工审核可以在两分钟内完成。
- [ ] 通过 live API 验证跨 Workspace、跨 Project 隔离，以及 Verdict、Import、Extraction 的真实并发冲突。
- [ ] 把当前代码部署为新的 Sites 版本，完成权限、Secret、D1、R2、后台任务、上传、审核和结果页的线上端到端验证；在此之前 GitHub Pages 跳转页不算完整产品部署。
