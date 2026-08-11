# 合成案例测试流

这套案例只用于开发冒烟测试和回归测试。它不能替代真实用户材料，也不能作为产品概念已经得到验证的证据。

## 导入案例

先启动本地服务，再运行：

```bash
npm run fixture:import -- eval/cases/synthetic-contractor-v1/manifest.json \
  --base-url=http://localhost:3000 \
  --probe-unconfigured-provider \
  --output=work/synthetic-contractor-v1-import.json
```

Importer 只调用正式 API。它会创建一个名称以 `[SYNTHETIC]` 开头的 Project，导入三次沟通记录，上传对应图片，然后从 API 和对象存储逐个回读并比较原始字节。它不会直接改 D1、R2 或正式页面代码。

`--probe-unconfigured-provider` 只适合当前没有配置模型的环境。它要求分析接口返回 `MODEL_PROVIDER_NOT_CONFIGURED`，并确认系统没有伪造分析结果。接入模型后不要使用这个参数。

脚本仅接受 `localhost`、`127.0.0.1` 和 `::1`，避免误把合成案例导入线上工作区。

## 给测试页面的最短操作流

页面只需要呈现四步，每一步只有一个主要按钮。

| 步骤 | 用户看到什么 | 主要操作 | 后端依据 | 完成状态 |
| --- | --- | --- | --- | --- |
| 导入资料 | 三次沟通记录及每次对应的照片 | 导入测试案例 | Project、Transcript Import、Asset API | 三个 Event 都是 `ready`，每个 Event 有一份 Transcript 和一张照片 |
| 开始分析 | 已准备好的资料数量 | 开始分析 | `POST /api/v1/events/{eventId}/extraction-runs` | 无模型时明确提示尚未配置；有模型时进入 `queued` 或 `processing` |
| 核对内容 | 每条待确认事实及其原话或照片 | 确认、修改或拒绝 | Run Claims、Evidence Ref、Claim Verdict API | 待确认项处理完毕，保留每次人工决定 |
| 查看结果 | 只显示已经确认的事实 | 查看结果 | Folder Summary、Timeline、Decisions、Open Questions 等确定性 View API | 不显示 rejected 项，withdrawn 只留在历史记录 |

前端不要展示预设 Claim，不要把 Ground Truth 当成模型输出。Ground Truth 只在评测脚本中用于对照。
