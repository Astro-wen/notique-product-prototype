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
- 后台任务：D1 Outbox、租约、重试、失败收口和定时 Sweep 已接好，也可以通过受保护的内部接口手动触发

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
AI_REASONING_EFFORT=max
AI_API_KEY=<服务端 Secret>
INTERNAL_JOB_TOKEN=<高强度随机 Secret>
```

OpenAI 的正式提取路径使用 Responses API。`AI_REASONING_EFFORT=max` 表示对同一个
`gpt-5.6-luna` 模型启用最高推理强度；`max` 不是另一个模型名称。这个值会写进
Run 的输入指纹和调试参数，改变推理强度后必须创建新的 Run，不能复用旧结果。

`AI_API_BASE_URL` 只在使用自定义兼容接口时填写。当前 DeepSeek 适配器只允许纯文字输入；有照片的 Event 必须选择支持图片的模型。PDF 仍需要独立的文本或页面提取适配器，系统会明确报错，不会假装已经读取 PDF。

录音转写使用 OpenAI Audio Transcriptions API。默认模型为
`gpt-4o-transcribe-diarize`，输出逐句说话人和开始、结束时间。原音频保留在私有
R2，转写结果作为派生 Transcript 保存；之后的 Claim 仍引用逐字原文和时间点，
证据页可以从对应位置播放原录音。录音支持 MP3、M4A、WAV、WebM、MP4、MPEG
和 MPGA，单文件上限 25 MiB。相关配置为：

```text
AI_TRANSCRIPTION_MODEL=gpt-4o-transcribe-diarize
AI_TRANSCRIPTION_TIMEOUT_MS=300000
MAX_AUDIO_BYTES=26214400
```

录音上传、转写和业务提取是三段独立的可重试操作。上传成功但转写失败时，原音频
不会丢失；转写成功前，原音频不会直接进入 Claim 提取。

Run Debug 只保留已经通过服务端 Schema 校验的模型 JSON，大小上限为 1 MiB，并与成功状态在同一个 D1 事务中写入。失败的 Run 保持为空。模型服务的鉴权信息和原始错误正文不会进入这个字段。

照片上传目前只接受 JPEG、PNG 和 WebP，单张上限 15 MiB。HEIC/HEIF 尚未接入转换器，因此前端选择和后端 Asset 初始化都会直接拒绝，文件不会先保存再到 extraction 阶段失败。每个 Run 默认最多 12 张照片、照片合计最多 30 MiB；总字节限制可通过 `MAX_RUN_IMAGE_BYTES` 调整。

每个 Run 在排队前会执行以下硬限制：单次输入 token、图片数量、图片总字节、Workspace 并发数、模型最大输出 token、每日模型 token。每日配额把已完成用量和排队中的预留量一起计算，因此并发请求不能绕过限制。`MAX_DAILY_EVAL_COST_USD` 目前没有参与普通 Run，因为仓库尚未内置经过确认的模型价格表；现阶段不会伪造美元成本。

生产构建会从 `wrangler.jsonc` 带入每两分钟一次的 Sweep 和 Dispatch 定时任务。`POST /api/internal/jobs/dispatch` 与 `POST /api/internal/jobs/sweep` 可用于部署检查，必须提供 `Authorization: Bearer <INTERNAL_JOB_TOKEN>`。当前实现使用 D1 Outbox 轮询边界，尚未宣称 Cloudflare Queue 已部署。

## 生产安全条件

- `AUTH_GATEWAY=chatgpt` 时，托管网关必须删除外部请求自带的 `oai-authenticated-*` Header，再注入已验证身份
- `AUTH_GATEWAY=cloudflare-access` 时，Cloudflare Access 必须位于 Worker 前方并完成 JWT 签名和 Policy 验证
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

## 尚未完成的外部接入

开始真实 Concept Validation 前还需要确认 Sites 已按 `.openai/hosting.json` 为 `DB` 和 `EVIDENCE` 创建并接好 D1/R2 资源，写入服务端 Secret，选择固定版本的高质量多模态模型，并完成 Ground Truth、稳定性、费用、延迟和 Blind Set 测试。Cloudflare Access 或 ChatGPT 托管网关的可信 Header 注入也必须由部署方确认。没有这些结果时，不能把本仓库称为已经完成的概念验证。
