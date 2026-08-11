# 生产 Run 导出为 Eval Predictions

这个工具把已经完成的正式 Run 冻结成离线评测 Predictions 草稿。它只调用现有 GET API，不创建 Project，不修改 Claim，不触发队列，也不调用模型。

## 使用方法

先启动本地服务，再执行：

```bash
npm run eval:export-run -- \
  --base-url http://localhost:3000 \
  --project-id prj_example \
  --run-id run_example \
  --commit-sha abc123 \
  --output work/predictions/run_example.json
```

`--project-id` 是可选的归属校验。写上以后，如果 Run 不属于该 Project，导出会直接停止。

需要合并三次独立 Run 时，重复提供 `--run-id`：

```bash
npm run eval:export-run -- \
  --base-url http://localhost:3000 \
  --run-id run_1 \
  --run-id run_2 \
  --run-id run_3 \
  --output work/predictions/three-runs.json
```

三个 Run 必须来自同一个 Project 和同一个 Event，并且使用完全相同的 Input Snapshot Hash、Input Manifest、Context Snapshot Hash 和 Context Version。Provider、Model、Prompt、Schema、Parser 和模型参数也必须相同。任何一项不同都会停止合并，避免把不同输入或不同项目状态产生的结果误当成稳定性测试。

输出文件使用独占创建。目标文件已经存在时，工具不会覆盖。这样可以避免误删一份已经做过人工裁决的 Predictions。

## 网络安全限制

默认只允许 `localhost`、`127.0.0.1` 和 `::1`。HTTP Redirect 会被拒绝，URL 里不能放账号或密码。

如果确实需要读取单独的测试环境，必须同时提供两个参数：

```bash
--environment test --allow-test-host api-test.example.com
```

`--allow-test-host` 必须和 URL 的 Host 及端口完全相同。命令没有 Production 模式，也不能用一个宽泛的域名白名单绕过限制。

## 导出了什么

每个 Run 包含：

1. 固定的 Model、Prompt、Schema、Parser 和模型参数。
2. Input Hash、Input Snapshot Hash、Context Version、Context Snapshot Hash 和输入材料清单。
3. 模型输出的全部 Claims，包括 new、reaffirmed 和 duplicate。
4. 已持久化的 Evidence 原文、时间点、图片区域、结构校验状态和语义支持状态。
5. 模型提出的跨 Claim Relations。
6. 当前 Verified Ledger 生成的 Folder Summary、Timeline、Decisions、Preferences、Open Questions、Risks、Gap Check、Agenda 和 Brief Card。
7. Input、Output、Cached Token，记录到数据库的费用，以及 Run 的实际延迟。

导出器只选取 API 中明确需要的字段。它不会复制认证 Header、API Key、Provider Request ID、队列 Lease 或 Idempotency Key。

## 为什么还需要人工评审

这个 JSON 可以直接交给 Eval Runner，但第一次运行通常会失败。这是正常的，因为下面几项不能由导出器代替人工判断：

1. `matchedGroundTruthId` 和 `matchedGroundTruthRelationId` 保持为 `null`。必须使用确定性标准值匹配或人工裁决填写。
2. Evidence 的结构合法性和 Transcript 精确原文可以从正式系统读取。Evidence 是否足以支持整条 Claim，仍然使用数据库中已有的 `semanticSupportVerdict`。未评审时保持 `unreviewed`。
3. 图片是否出现越界推断保持未评审状态。必须由评审人填写 `unsupportedVisualClaim: true | false`。
4. `viewLeakageCount` 保持为 `null`，Brief 的 `useful` 保持为 `false`，直到完成视图检查。
5. 数据库没有记录费用时，`costUsd` 保持为 `null`，不会伪装成零费用。

做完这些裁决后，再运行：

```bash
npm run eval -- ground-truth.json predictions.json report.json
```

Ground Truth 必须由单独流程管理。这个导出器的代码路径没有 Ground Truth 输入，也不会搜索或读取 `eval/cases`。
