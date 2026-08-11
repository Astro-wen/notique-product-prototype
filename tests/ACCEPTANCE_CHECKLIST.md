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
- [x] `npx tsc --noEmit` 除已知 Cloudflare 类型绑定问题外无错误。
- [x] 原有测试已经更新到当前产品，不再测试已删除的 starter skeleton。
- [x] `node --test tests/domain-invariants.test.mjs` 全部通过。
- [x] `node --test tests/repo-readiness.audit.mjs` 全部通过。
- [ ] CI 不调用付费模型；真实模型 Eval 只在手动或有预算上限的工作流运行。
- [ ] 在没有 Provider Key 的环境可以完成 Project/Event/Asset/Transcript Parser、Evidence Validator、Verdict、Scenario、View 和错误路径测试。
- [ ] 没有手改数据库、刷新即丢状态或依赖静态示例数据的演示步骤。

这一组工程门决定真实模型结果能不能被准确测量。当前已经做过两次受控的开发 Run，所以尚未勾选的部署项不会抹掉现有结果，但它们仍然阻止我们把开发 Run 当成正式概念验证。

## 当前自动化证据

- `npm test` 通过，合计 113 项。测试包含生产构建、领域规则、迁移、Eval Runner 算法、Production Run 导出一致性、Repository 契约、多模态上传边界、Glossary、Occurrence 转换、Evidence Review 审计门槛、Evidence 完整加载门槛、Timeline、Project/Event 的 Pending Claim 与 Pending Occurrence 计数、服务端审核计时、最小 UI 的 Scenario 刷新、用户入口隐藏 PDF、生产 Bundle 和真实数据前端外壳。
- `npx tsc --noEmit` 通过，没有忽略 TypeScript 错误。
- `npm run lint` 通过。
- 空 SQLite 数据库可顺序应用全部 D1 Migration，且 `foreign_key_check` 为零。
- 四个资源创建接口均要求 `Idempotency-Key`。Project、Event、Transcript Import 和 Asset Init 会把 Request Hash 与 Response 一起写入 D1。同 Key 同 Body 返回原结果，同 Key 异 Body 返回 409。
- Transcript Item 上传通过 `pending` 到 `uploaded` 的条件更新决定唯一赢家。Finalize 后同内容可重放，不同内容返回 409，上传路径没有把 `finalized` 改回 `uploaded` 的 SQL。
- Outbox 遇到已持久化的 Terminal Failed Run 会确认消息，避免重复调用模型。遇到 `lease_not_acquired` 会先重读 Run；Run 仍是 Queued 或不存在时保留重试，只有 Processing 或 Terminal 状态才确认消息。
- 生产 Worker 配置包含 `*/2 * * * *` 的 Sweep/Dispatch Cron。只有明确的 `APP_ENV=local` 会启用本地身份，缺失或拼错按 Production 处理。
- 审核页会在第一次打开有待核对内容的 Project 时创建服务端计时 Session。计时同时覆盖 Pending Claim 和 Pending Occurrence，刷新或关闭页面不会重置；队列清空后由服务端保存完成时间和总耗时。当前只证明计量工具可用，仍需真人完成一次审核后才能判断两分钟目标。

## K. 真实模型阶段的当前结论

已经完成同一个本地合成 Project 中连续两个 Event 的 production code path 调用，使用本地 D1、R2 与 Outbox Bindings，并实际调用 OpenAI Responses API。两次均使用 `gpt-5.6-luna`、`reasoning=max` 和严格结构化输出；Event 1 使用 Prompt v3，Event 2 使用 Prompt v4。Ground Truth 没有进入模型 Prompt。当前执行示例为 `AI_TIMEOUT_MS=540000`、`AI_MAX_OUTPUT_TOKENS=64000`，不包含任何 Key。

- Event 1 使用 Prompt v3，同时输入 Transcript 和一张 PNG。Run 成功，耗时 3 分 06 秒，5,338 input tokens，24,955 output tokens。模型生成 10 条候选，其中一条确实引用并持久化了照片 Evidence。Transcript 召回为 10/13，图片独立事实召回为 0/4。
- Event 2 使用 Prompt v4，同时输入 Transcript 和一张 PNG，并继承经人工确认的 Event 1 Ledger。Run 成功，耗时 3 分 56 秒，7,181 input tokens，35,157 output tokens。Transcript 召回为 11/13，7 条跨 Event 关系全部正确；图片独立事实召回仍为 0/4，也没有生成照片 Evidence。
- 两次共 20 个模型输出项都有原始材料支持，没有发现无依据的承重、批准、责任、费用或因果推断。
- 结论：多模态传输、模型调用和照片 Evidence 持久化已经真实跑通。Transcript 抽取和跨 Event 关系有可用信号。图片理解目前不稳定，完整召回没有通过。由于两次 Event 使用的 Prompt 版本不同，这组结果也不能充当 v4 的正式质量基线。

核心测试页已经补上 Scenario 确认，并把普通 Claim 与 Occurrence Candidate 一起计入待核对数量。当前 Provider 没有 PDF Adapter，因此核心测试页和高级 Event 上传入口只允许 Transcript 与 JPG、PNG、WebP，不再声称 PDF 可直接分析。后端仍保留 PDF 资产结构，待 Adapter 完成后再开放。`.env.example` 已使用真实成功 Run 所需的 540,000ms Timeout 和 64,000 Output Token 上限。

详细记录见 `work/clean-multimodal-rerun/REPORT.md` 和 `work/clean-multimodal-rerun/event2-v4-audit-summary.json`。

## 尚未取得证据的正式验证

下面几项继续保持未勾选。当前没有对应的 live API 结果或受控评测数据，不能用源码审计代替。

- [ ] 在 Cloudflare Preview 或 Production 实际运行 D1、R2、外部 Queue 和 DLQ，验证重复投递、Lease 过期、重试和死信恢复。
- [x] 使用真实 AI Provider 完成 Transcript 与图片输入，记录输出质量、延迟、Token 和失败类型。
- [ ] 从实际账单或 Provider Usage API 取得并保存每个 Run 的真实费用。当前只保存 Token，未伪造费用。
- [ ] 建立 Ground Truth 数据集，由专业人员标注 Claim、Evidence、Scenario 和应当拒绝的结论。
- [ ] 进行 Blind Eval，评审者不知道输出来自哪一版 Prompt 或模型，并按预先固定的指标评分。
- [ ] 对同一合格输入完成至少三次独立 Run，并通过稳定性门。
- [ ] 从空 Project 开始，用 Prompt v4 连续跑完 Event 1、人工审核和 Event 2，建立同版本基线。
- [ ] 由第二位标注者独立标注 Realtor 和 Insurance 开发集并完成分歧裁决。
- [ ] 真实计时验证一次人工审核可以在两分钟内完成。
- [ ] 通过 live API 验证跨 Workspace、跨 Project 隔离，以及 Verdict、Import、Extraction 的真实并发冲突。
