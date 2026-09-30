# Workflow V2 发布准备

检查日期：2026-09-29，America/Los_Angeles。

当前结论：本轮发布前基线为Sites版本84，源提交937f5bb9470b554e750f649205d4fb5e96e4a196与GitHub main一致，运行环境revision13。人工确认、行动计数和恢复续接补丁已通过1189项工程检查、314条完整PC路径及最终发布检查。最终source SHA、Sites版本与部署回执保存在outputs/workflow-v2/final-release-verification.json。第二轮合成资料提取、行动采纳和撤销通过，当前6句概要已发布。云端恢复请求成功、用户任务产出与自然定时触发分别验收。以下第1节保留版本81的发布前基线，实际产出记录于WORKFLOW_V2_IMPLEMENTATION_STATUS.md。个人MCP登录、真实助手调用、模型质量和独立试用分别验收。

## 1. 已核实的线上基线

| 项目 | 2026-09-29 的实际结果 |
| --- | --- |
| Sites 项目 | `appgprj_6a716fd238e881919b59fbe6e647e8a7` |
| 最新保存版本 | 81 |
| 线上源提交 | `c86be0108c32a1ec8e846df65e2a2933e39c2420` |
| 部署状态 | succeeded |
| 线上地址 | https://notique-evidence-workspace.uclae2e12.chatgpt.site |
| 访问范围 | public，当前账号为 owner |
| 数据绑定 | D1 `DB`，R2 `EVIDENCE` |
| 线上用户表 | 41 张，与本地 0000–0022 的表数量一致 |
| V2 结构 | `events.source_revision`、`claims.workflow_revision`、`claim_versions.workflow_origin`、`verdicts` 的两列 workflow 标识均未应用 |
| MCP | 最新成功部署返回 `has_mcp=false`，请求连接资料明确返回尚未声明 MCP |
| 平台登录客户端 | 现有 Site 已有登录客户端，继续复用 |
| 运行时配置 | revision 12，`APP_ENV=production`，`AUTH_GATEWAY=public`，事实生成及复核 high/high，`MAX_AUDIO_BYTES=104857600` |
| GitHub 基线 | 本次检查时 `main` 与 `origin/main` 都为上面的提交 |

本地 V2 文件仍有未提交修改。线上 81 版本和 GitHub 基线仍是旧实现，保存新版本时要使用最终 V2 提交。

线上环境值与 `wrangler.jsonc` 的本地默认值分别管理。发布保留现有运行时配置、秘密值、DB、EVIDENCE 与 public audience。

## 2. 旧数据增量升级演练

演练在内存 SQLite 进行，使用 0000–0022 创建旧结构并填入合成数据。四张修改表的原始列清单与本次线上只读检查一致。

合成数据包括已采纳与待确认的信息、已拒绝草稿、人类补充、已完成行动、已回答问题、来源、关系、旧 verdict 和幂等重放回执。每次迁移完成后，逐表比较全部原始列和原有行，再执行外键检查。

| 顺序 | 结构变化 | 演练结果 |
| --- | --- | --- |
| 0023_workflow_v2 | 增加版本列、workflow 账本和队列，调整 verdict 索引 | 41 张旧表的原字段及旧数据一致，外键错误 0 |
| 0024_report_snapshot | 给报告增加 `snapshot_json`，常量默认值 `{}` | 旧字段及旧数据一致，外键错误 0 |
| 0025_mcp_request_limits | 增加 MCP 请求限额表和索引 | 旧字段及旧数据一致，外键错误 0 |
| 0026_workflow_mentions | 增加再次提及的决定记录 | 旧字段及旧数据一致，外键错误 0 |

升级后共 60 张用户表。旧 event 的 `source_revision` 为 0，旧 claim 的 `workflow_revision` 为 1，旧版本的 `workflow_origin` 为 null，旧 verdict 的 workflow 标识为 null。

升级后继续执行真实服务层读写，结果如下。

| 接续路径 | 结果 |
| --- | --- |
| public demo 无成员记录读取旧资料 | 成功 |
| 已采纳记录与被拒绝草稿 | 原有状态保持 |
| 旧行动的完成关系 | 继续显示 completed |
| 旧问题的有效答案 | 继续显示 resolved |
| V2 原子确认一条旧待确认信息 | 成功，contextVersion 从 0 变为 1 |
| 新确认的 workflow verdict 与旧 verdict | 同时保存，旧审批记录保持 |
| 最终外键检查 | 错误 0 |

可重跑的演练文件：`/private/tmp/notique-v2-release-migration-audit.mjs`。

本次结果：`/private/tmp/notique-v2-release-migration-audit.json`，完成时间 `2026-09-29T23:20:08.592Z`。

这次演练验证代表性旧数据及结构兼容性。生产全库完整性与恢复能力采用下一节的独立步骤检查。

### 索引与迁移边界

0023 移除 `uq_verdicts_claim_base_action`，改为按 workflow 决定和成员唯一。旧 verdict 原行保持，V2 可对同一信息进行新决定及撤销。当前 V1 写入采用事务、版本 guard 和回执，未发现依赖该旧索引名的 `ON CONFLICT` 语句。

历史 SQL 0000–0022 在本次源码修改中保持一致。四个新 SQL 文件已进入顺序 journal。历史 Drizzle snapshot 停在 0005，后续迁移以 SQL 和 journal 维护。未来执行 schema 自动生成前，需要先整理 snapshot 与完整迁移链的关系，避免重新生成已存在结构。

## 3. 生产数据库备份与恢复

目前 Sites connector 提供表清单和分页只读行查询。可调用工具中没有数据库导出、Time Travel bookmark、数据库恢复、任意 SQL 或实际 Cloudflare database ID 的接口。分页读行只能用于检查，无法替代包含结构、约束及一致性状态的数据库备份。

Cloudflare 原生 D1 提供以下方式。执行时使用有权限的实际账户与实际数据库标识。

1. 读取数据库信息，确认存储版本和恢复窗口。
2. 读取发布前的 Time Travel bookmark，保存 bookmark、UTC 时间、数据库标识和源版本。
3. 若需要独立持久副本，导出完整 schema 和数据到仓库之外的受限目录，记录文件 hash，并在隔离数据库验证导入。
4. 发布前明确恢复操作的实际执行入口和有权限的操作者。

参考命令形状如下，真实数据库标识从获授权的平台入口取得。

```text
wrangler d1 info <actual-database>
wrangler d1 time-travel info <actual-database>
wrangler d1 export <actual-database> --remote --output=<restricted-backup-path>
```

Time Travel 在生产存储后端自动开启，恢复窗口受计划限制。恢复会覆盖数据库并中止运行中的查询。该 Site 的实际恢复窗口和执行权限仍需核实。[Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

完整导出可由 Wrangler 执行，导出期间可能阻塞数据库请求。[Cloudflare D1 导入与导出](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

当前本地构建的 D1 database ID 是 Sites placeholder，只表示逻辑绑定。通过这个 ID 执行 remote 命令不能建立本 Site 的备份。

## 4. 保存与发布的最短路径

Sites 的正常发布链会自动应用 D1 迁移。依据是 `sites-building/references/persistence-and-storage.md` 的明确描述：迁移在 Worker 上传前逐个应用并记录。当前 `build/sites-vite-plugin.ts` 将全部 `drizzle` 文件复制到 `dist/.openai/drizzle`，发布脚本将它们和 hosting manifest 一同放入归档。

因此这次采用带迁移的 archive 保存版本，再通过 Sites 原生部署调用升级现有 DB。本地构建负责携带迁移，生产执行由发布链负责。`wrangler.json` 中的 migration 字段不是本项目这条 Drizzle 迁移链的来源。当前不需要给构建命令追加一条 remote SQL 或 Wrangler 迁移命令。

1. 收齐并停止本轮文件写入。核对最终 diff、共享契约和迁移文件。完成 `npm run typecheck`、`npm run lint`、`npm test`，以及此次变更影响的 PC 点击回归。模型质量与用户试用另行记录。
2. 保存发布前只读数据库基线。额外备份与恢复权限按上一节独立记录，当前 connector 缺少导出或 SQL 接口不构成正常 Sites 自动增量迁移的阻断。原资料正文和秘密值放在受限位置。
3. 在 canonical checkout 提交最终 V2 源码，正常推送 `origin/main`。记录完整 SHA。
4. 读取同一 Site，获取短期源仓库写凭据。凭据保存在工具会话中，通过隐藏 stdin 传给 Sites workflow。
5. 按 `sites-hosting` 工作流执行 `site-workflow.mjs`。使用已有 opening result；若需要重新打开，在同一 checkout 对齐远程状态，保留本轮成果。检查与构建输入使用参数数组，输出 archive 放在绝对路径。
6. 核对 workflow 返回的 `commit_sha` 与 GitHub `origin/main` 一致。归档必须含 `.openai/hosting.json`、Worker 产物、全部 Drizzle SQL 和 journal，且通过秘密审计。
7. 调用 `save_site_version`，使用 workflow 返回的项目、SHA 和 archive。当前 audience 为 public，调用 `deploy_site_version`。
8. 以返回的 deployment ID 读取状态，直到 succeeded。保存版本号、source SHA、部署 ID 和成功 URL。
9. 只读检查线上新增表和列。验收旧资料可读、部分采纳、直接回答问题、行动完成与结果回流、修改后的概要更新。记录使用的合成 QA 资料与实际结果。

调用脚本的入口为：

```text
node /Users/aaronwen/.codex/plugins/cache/openai-curated-remote/sites/0.1.75/scripts/site-workflow.mjs --project-id appgprj_6a716fd238e881919b59fbe6e647e8a7
```

以 `tty: true`、`yield_time_ms: 1000` 启动。等脚本提示接收 JSON 后，通过 `write_stdin` 发送含 credential、commands、archivePath 的单个 JSON 对象。重新使用仍对应当前源码的成功检查结果，避免重复构建。

### 发布失败时的处理

Sites 在上传 Worker 前逐个应用并记录迁移。因此部署失败时，生产数据库可能已应用部分或全部新迁移。

先读取失败原因和已应用边界。确定某个未应用文件存在 `SQLITE_*` 错误后，只修复该失败的未应用迁移及其未应用 metadata，保存新版本再发布。已应用文件继续保持原内容。若边界无法从工具结果确认，取得平台迁移状态后再执行后续步骤。

回到 81 版本恢复的是旧 Worker。V2 数据和新增结构仍然保留。数据库恢复另行使用已记录的恢复点，评估发布后新增决定和资料的保留方式。

## 5. MCP 的实际连接步骤

本地 manifest 已包含 `capabilities: ["mcp"]`，`POST /mcp` 使用官方 SDK 提供 stateless HTTP。生产发布后才会触发 Sites MCP provisioning。

1. 确认新部署的 `has_mcp=true`。
2. 调用 `get_site` 并传 `include_mcp_connection: true`，保存平台返回的 `mcp_url`、`oauth_resource` 和 `plugin_id`。
3. 在 `/connections` 通过现有 Sites 登录流程完成登录，确认连接页显示真实账号。开启只读授权并重新读取状态。
4. 通过 Sites provisioned plugin 的安装或连接界面安装。使用返回的 plugin ID，不另建一个 App 或本地 MCP server。
5. 用真实助手先调用 `list_projects`，然后读取一条合成记录的 `get_record_views` 或 `get_project_brief`。验证版本、草稿标识、来源和分页。
6. 撤销授权，确认后续数据调用被拒绝。再次授权后恢复读取。
7. 比较读取前后的 extraction、artifact 和 workflow 任务数量，以及供应商请求记录，确认只读调用未新增模型生成。

现有 public demo 的一般工作区操作使用固定演示身份。MCP 单独要求 Sites 注入的已验证主体和用户显式只读授权。开启授权时可为真实用户建立 viewer，继续读取演示空间。

客户私有空间使用已验证成员映射。若把现有演示空间改成 `AUTH_GATEWAY=chatgpt`，需要先为真实账号建立明确成员授权，现有资料空间不能依靠“第一个访问者”自动取得 owner。

## 6. 关闭页面后的调度验收

本地构建产物 `dist/server/wrangler.json` 包含每分钟 cron，Worker 的 `scheduled` 入口消费原生分析、artifact 和 V2 workflow 队列。保存后 2.1 秒的短时唤醒用于首次处理。

当前 Sites 工具没有 cron 配置或注册状态读取接口。旧 Worker 注释记录过该部署路径的 cron 未触发。本次最近 180 分钟的 100 条可见生产调用均为 fetch，这个有界样本不足以判断完整 cron 状态。

实际验收采用以下路径。

1. 在隔离的授权合成 QA 项目创建一个后台任务，记录任务 ID、输入版本及 lease。
2. 让任务进入带 checkpoint 的待续处理状态，`available_at` 晚于创建请求的短时唤醒窗口。仅在第一次请求内完成的任务不能证明周期调度。
3. 关闭所有该 Site 的页面和浏览器 heartbeat。等待下一个调度窗口。
4. 通过只读数据库或日志入口核对任务在无网页请求时取得新 lease、保存 checkpoint，并发布对应输入版本的结果。
5. 检查供应商请求 ID 和 usage，验证续取与重试遵守已实现的幂等和 fencing 规则。

如果 Sites 未注册 cron，采用一个实际受支持的持久调度器调用受保护任务入口。本轮已将 `POST /api/internal/jobs/sweep` 扩展为原生分析、artifact 与 workflow 三路维护，复用 `INTERNAL_JOB_TOKEN` 鉴权。三路同时执行，单路拒绝时其他路继续完成，响应为 503、`Retry-After: 30` 并分别给出队列状态。成功响应保留已有原生恢复字段。

原生恢复 helper 增加可选阶段失败 observer。默认 heartbeat 保持继续运行其他阶段的行为，受保护维护请求可识别已记录错误后返回 fallback 的内部阶段，向 caller 返回阶段名称和固定失败码。异常正文和 token 留在接口回执之外。

18 项专用测试与 14 项既有 targeted-dispatch 回归通过，共 32 项。专用测试覆盖缺失或错误 token、未配置 token、三路恢复、各路失败、同步异常、等待所有结果、调度器重试、默认 heartbeat 语义、各个内部阶段失败，以及实际 SQLite 表不可用的错误上报。两份专用文件为 `tests/workflow-v2-maintenance-sweep.test.mjs` 和 `tests/workflow-v2-maintenance-observer.test.mjs`，已包含在 `npm test` 的 `tests/workflow-v2*.test.mjs` 范围中。

端点本地测试证明的是调用与错误隔离。真实队列幂等、lease 与 fencing 以原有 SQLite 用例和生产调度实测分别确认。调度配置和关闭页面验收取得结果后，才把无人值守能力标为完成。

Worker Cron 使用 `scheduled` handler 配合实际注册的 Cron Trigger。[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## 7. 本次完成与继续项

| 检查项 | 本次结果 | 下一步 |
| --- | --- | --- |
| 0023–0026 与旧 ledger 兼容 | 合成旧数据升级及 V2 接续读写通过 | 最终源码冻结后复用演练结果 |
| 线上版本与表结构 | 只读核实完成 | 新发布后检查新增结构 |
| DB、EVIDENCE、audience、运行时配置 | 已核实并记录 | 继续复用 |
| 线上可恢复备份 | 工具能力尚未提供执行入口 | 核实实际 bookmark/export 与恢复权限 |
| GitHub 与 Sites 同一 V2 SHA | 当前尚未提交发布 | 完成最终检查后保存并部署 |
| 真实 MCP 登录和助手调用 | 当前生产未声明 MCP | 新版本 provisioning 后实测 |
| 无页面后台续跑 | 尚未取得生产实测证据 | 检查实际调度，并执行延迟任务路径 |
| 受保护维护入口 | 三路调用、内部失败上报和重试提示已实现，18 项专用测试及 14 项回归通过 | 连接实际持久调度器并验证真实 lease 恢复 |
| 真实模型质量、成本和独立使用者 | 独立验收 | 按模型评估及用户试用报告处理 |

本报告的发布前检查完成只读生产检查、隔离合成数据演练和维护端点补全。该次检查保持版本81基线。后续版本82已应用增量结构并上线，个人MCP授权和真实模型质量继续独立验收。

## 8. 独立恢复后备入口

新增.github/workflows/recover-background-jobs.yml，每5分钟错峰运行，支持workflow_dispatch，串行并发。Python标准库使用Notique-Recovery/1.0客户端标识，向固定Site的维护入口发送请求，禁止重定向。当前执行最多6分钟，12秒间隔续接，两轮无本次活动标idle，时限到达标pending，终态错误标failed。临时错误最多连续重试3次，遵守30秒重试提示。日志仅输出固定队列状态和白名单计数。

独立WORKFLOW_RECOVERY_TOKEN只授权sweep入口，GitHub使用NOTIQUE_RECOVERY_TOKEN。配置采用新增秘密值，原INTERNAL_JOB_TOKEN和全部现有环境值保留。该身份调用commission:false，消费已提交任务及持久化材料意图，旧内部身份维持原扫描权限。实际outbox用例验证恢复身份不会调用旧材料自动扫描，其他内部dispatch入口拒绝该恢复身份。

83项专项检查通过，runner的9个离线Python案例覆盖重定向、401、503、网络重试、超限响应和安全日志。请求标识修复后16项聚焦检查及完整1094项工程检查、类型、lint、构建和包内秘密审计再次通过。GitHub独立执行记录36648873645于2026-09-30 00:09:10 UTC返回200，extraction、event_ai_artifacts和workflow均成功，workflow实际取得1项任务并保存待续状态。实际示例产出和最终source SHA另行记录。GitHub定时任务可能延迟，公开仓库60天无活动会停用调度，该机制当前用于后备恢复。[GitHub定时工作流](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)


## 9. 任务与概要修复的发布检查

新任务采用提取提示词9.4和概要提示词v2。旧付费检查点、成功提取阶段与旧概要审计按冻结版本保留。首次采纳行动继承精确版本的负责人和完整日期，已有空值、人工文字修改与撤销均按当前规范处理。

1139项完整工程测试、typecheck、lint、构建及包内秘密审计通过。314次PC检查中308条通过，6条原手机专属检查跳过。飞书规范revision89与79和本地逐字一致。此次修复的真实模型行为以线上合成材料第二轮产出另行记录。

## 10. 实际原话支持状态与拍板入口

第二轮线上8段资料形成11条草稿，盘点与复核各执行1次。任务的负责人和期限文字保留在同一行动中，采纳后负责人进入行动，正常撤销恢复原草稿。完整日期只在原文提供年份时生成。提取仍耗时约441秒，成本与正式模型质量另行验收。

原材料初始证据状态unreviewed与用户是否采纳分开保存。普通确认、use_candidate和coexist在来源就绪、结构有效及精确版本匹配时允许用户明确采纳unreviewed内容，部分支持与不支持通过修改补齐。SQL提交检查与预检采用相同规则，并固定证据角色。行动冲突回执保存完整负责人、日期和执行状态，撤销恢复原信息。

需要拍板由当前AI行动与来源状态派生，历史持久卡和虚拟卡一致。独立卡或分组计一次，采纳、延期和意图选择结束后更新计数。快照投影版本升级至v3，旧缓存重新生成。

1188项完整工程检查、全项目typecheck、lint、构建及包内秘密审计通过。6条专项PC操作覆盖直接确认、成员窗口、候选采用与行动拍板。原内容版本、AI标签与提取阶段数量均核对保留。完整页面回归与飞书增量同步结果继续附在实施报告中。

最后恢复补丁和三处旧验收断言同步后，1189项完整工程检查、typecheck、lint、构建及秘密审计全部通过，314条PC路径通过，6条手机专属检查跳过。后备恢复的实际Python客户端19个离线模拟通过。飞书最终前端91、后端83，确认规则和恢复规则与本地一致。自然定时触发的实际执行、个人MCP连接及真实模型质量分别保留为待验收项。
