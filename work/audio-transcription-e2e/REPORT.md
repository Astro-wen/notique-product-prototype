# 音频上传与转写端到端验证

验证时间：2026 年 8 月 10 日（America/Los_Angeles）

## 结论

音频上传、持久化、后台转写、说话人分段、时间戳保存和派生 Transcript Asset 的正式代码链路已经真实跑通。本次使用合成语音，不包含客户资料。

这次验证证明系统能够把录音变成后续 Claim Extraction 可以直接使用的结构化 Transcript。它不证明现场噪音、口音和远场录音条件下的转写准确率已经达到产品要求。Eric 文档中的收音品质实验仍需另外执行。

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

## 数据完整性核对

- 原始音频保存在 R2，并有 SHA-256、MIME、大小和版本记录。
- Transcription Run 与原始 Audio Asset Version 固定绑定。
- 派生 Transcript Asset 保存 Provider、Model、Response Format 和来源音频版本。
- 三个 Segment 都有稳定 ID、顺序、说话人、开始时间、结束时间和文本。
- Event 在转写完成后处于 `ready`，派生 Transcript 可直接进入后续分析。
- 本次失败提示来自 smoke script 读取错了 Event API 的响应层级。Provider 调用和数据持久化均已成功。脚本已改为从 `data.assets` 读取，并用 `processing_status=ready` 判断派生 Transcript。

## 尚未验证

- 口袋手机、桌面手机、领夹麦三种收音方式的对照。
- 现场噪音、多人抢话、距离和重口音条件下的 Word Error Rate 与 speaker attribution。
- 三种收音方式分别导致多少 Claim 需要人工修正。
- 用户是否能从音频时间点直接听懂并在两分钟内完成整组审核。

因此，音频功能的工程链路可以标记为通过；Eric 的硬件与收音品质假设仍保持未验证。
