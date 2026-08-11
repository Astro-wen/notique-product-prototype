# 音频上传与转写端到端验证

验证时间：2026 年 8 月 10 日（America/Los_Angeles）

## 结论

音频上传、持久化、后台转写、说话人分段、时间戳保存、派生 Transcript、Claim Extraction、场景确认、人工审核和项目结果页的正式代码链路已经真实跑通。本次使用合成语音，不包含客户资料。

这次验证证明录音可以直接进入 Notique 的核心闭环。它不证明现场噪音、口音和远场录音条件下的转写准确率已经达到产品要求。Eric 文档中的收音品质实验仍需另外执行。

## 输入

- 文件：`notique-audio-e2e.wav`
- 格式：16 kHz、单声道 WAV
- 大小：465,968 bytes
- 时长：14.559 秒
- 内容：两位合成说话人讨论厨房墙体开口、预算、石英台面和承重墙问题

## 正式运行记录

- Project ID：`prj_7d8fb5631b164a5ea3bdbd8d565e3530`
- Event ID：`evt_22c5601fae8b4e25b6458d15ac3d4be7`
- Audio Asset ID：`ast_fb183db6b869435aa34c5af787f02321`
- Audio Asset Version ID：`av_1cb9f0a54b3b4392901936dc68c47cea`
- Transcription Run ID：`trun_95fddbdb48c14f7abcaf8117a6f781e0`
- Provider：OpenAI
- Model：`gpt-4o-transcribe-diarize`
- Response format：`diarized_json`
- 运行状态：`succeeded`
- 开始：`2026-08-11T03:00:24.410Z`
- 完成：`2026-08-11T03:00:30.189Z`
- Provider 执行耗时：约 5.8 秒
- 分段数量：3
- 派生 Transcript Asset ID：`ast_9c2bf6f6328d49f1b2d14b341953331c`
- 派生 Transcript Asset Version ID：`av_b70585cfa711480183ffdc0b2535f6de`

## 转写结果

| 说话人 | 开始 | 结束 | 内容 |
|---|---:|---:|---|
| A | 0.000 秒 | 3.300 秒 | The kitchen wall opening will be seventy two inches wide. |
| A | 3.650 秒 | 7.900 秒 | The total project budget cap is twenty one thousand five hundred dollars. |
| B | 8.250 秒 | 14.300 秒 | I approve the warm white quartz; please confirm whether the wall is load bearing before demolition begins. |

## 从录音到项目结果的完整运行

- Extraction Run ID：`run_9e2a97559e644b2eb5b4ad9442c79db1`
- Provider：OpenAI
- Model：`gpt-5.6-luna`
- Reasoning：`max`
- Prompt：`claim-extraction-prompt.v5`
- Input：派生 Transcript Asset Version `av_b70585cfa711480183ffdc0b2535f6de`
- 状态：`succeeded`
- 开始：`2026-08-11T04:21:57.436Z`
- 完成：`2026-08-11T04:23:12.768Z`
- Input Tokens：1,924
- Output Tokens：8,959

模型输出两种场景候选。人工确认的场景为：

> A kitchen renovation or alteration project with a planned wall opening, quartz finish selection, and demolition sequencing.

模型生成 5 条候选记录。人工按原始 Transcript 逐条核对后全部确认：

1. 厨房墙体开口宽 72 英寸。
2. 项目总预算上限为 21,500 美元。
3. Speaker B 批准暖白色石英。
4. 拆除前必须确认厨房墙体是否承重。
5. 厨房墙体是否承重仍是待确认问题。

五条记录都有 canonical Segment ID、逐字引文、说话人和毫秒时间点。确认完成后，Project 的 `pending_claim_count` 从 5 变为 0，`ledger_version` 为 5，`context_version` 为 6。

确认后的 Folder Summary 和 Timeline 都包含五条记录。Decision View 包含暖白色石英批准；Open Questions 和 Next-Meeting Agenda 都包含承重墙问题；Risk View 为空。Brief Card 只填入现有的状态、两条变化和一个问题，保留两个缺项，没有为了凑满格式编造第二个问题或风险。

## 数据完整性核对

- 原始音频保存在 R2，并有 SHA-256、MIME、大小和版本记录。
- Transcription Run 与原始 Audio Asset Version 固定绑定。
- 派生 Transcript Asset 保存 Provider、Model、Response Format 和来源音频版本。
- 三个 Segment 都有稳定 ID、顺序、说话人、开始时间、结束时间和文本。
- Event 在转写完成后处于 `ready`，派生 Transcript 已进入后续分析并生成 Verified Ledger。
- 场景选择只确认一次，并递增 Project 的 Scenario 与 Context Version。
- 五条 Pending Claim 经人工逐条核对后变成 Verified，刷新后仍存在。
- Folder Summary、Timeline、Decision、Open Questions、Agenda 和 Brief 都只读取 Verified Ledger。
- 本次没有风险证据时，Risk View 保持为空；Brief 保留缺项，没有用 AI 补造内容。
- 本次失败提示来自 smoke script 读取错了 Event API 的响应层级。Provider 调用和数据持久化均已成功。脚本已改为从 `data.assets` 读取，并用 `processing_status=ready` 判断派生 Transcript。

## 尚未验证

- 口袋手机、桌面手机、领夹麦三种收音方式的对照。
- 现场噪音、多人抢话、距离和重口音条件下的 Word Error Rate 与 speaker attribution。
- 三种收音方式分别导致多少 Claim 需要人工修正。
- 用户是否能从音频时间点直接听懂并在两分钟内完成整组审核。

因此，音频作为产品入口的工程闭环可以标记为通过；Eric 的硬件与收音品质假设仍保持未验证。
