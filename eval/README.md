# Notique 离线评测

这个目录只保存评测格式和说明，不保存“看起来像真实结果”的演示数字。

正式评测需要两份 JSON：

1. Ground Truth。由人工读原始材料后填写，并完成规定的双人标注与裁决。
2. Predictions。记录同一固定输入的模型输出、人工匹配结果、证据支持判断、费用和延迟。

运行方式：

```bash
npm run eval -- path/to/ground-truth.json path/to/predictions.json path/to/report.json
```

Runner 不会调用另一个 AI 自动决定两条自然语言 Claim 是否相同。`matchedGroundTruthId` 与 `matchedGroundTruthRelationId` 必须来自确定性标准值匹配或人工裁决。这样可以防止“用一个模型给另一个模型打分”造成虚假的好结果。

报告会同时给出 `gates.pass` 和每一道门的 Actual、Expected。样本不足时仍可用于回归测试，但不能称为概念验证结果。正式稳定性至少需要三个不同 Run。Blind Set 不能进入 Prompt 示例、开发调试记录或反复调参。

## 合成 Transcript 开发包

Realtor 和 Insurance 两个合成场景可以确定性合并成一个 Transcript-only 开发包：

```bash
npm run eval:merge:synthetic-transcripts
```

输出固定为 `eval/combined/synthetic-transcript-development-v1.ground-truth.json`。命令只读取这两个明确列出的 Ground Truth，不接受自定义来源或输出路径。输出会记录来源路径和 SHA-256，合并前检查全局 Claim、Relation、Scenario 和 Event ID，且要求每个 Event 有 5 到 10 条 material Claims。

这个开发包不包含 Contractor pressure fixture，也没有图片 Ground Truth。它目前满足两个场景、八次 Event、材料事实、关键歧义和关系数量等结构门槛，但仍是单人起草的开发集，没有完成双人标注与裁决，也没有三个独立模型 Run。`sample_eligible` 必须保持为 `false`。它可以用于开发回归，不能被描述成 Concept 验证结果或 Blind Set。

评测按以下保守规则计算：

- 每个 Run 中一条 Ground Truth 最多匹配一条预测。重复匹配会同时降低 Recall 和 Precision。
- 所有模型输出的 Claim 都进入 Precision 分母。预测自行填写的 `material` 和 `critical` 不参与口径，二者以 Ground Truth 为准。
- Claim 没有 Evidence 时，`claimsWithEvidence` 和 `evidenceIdValidity` 都会失败。
- 三次一致性包含未匹配 Ground Truth 的幻觉内容，也会识别同一 Run 中的重复 Claim。
- 每个 Event 的 Ground Truth 必须有 5 到 10 条 material Claims。超过 10 条会让“最多输出 10 条”和 80% Recall 互相冲突，Runner 会把这种样本判为不合格，不会给模型一个数学上不可能通过的正式分数。
- Timestamp 对每个 Evidence 区间分别计算最短距离，不用两个不连续引用之间的大区间覆盖答案。
- `viewLeakageCount` 必须经过审查后明确填写。缺失不会默认成零。
- Brief 必须使用 `current_status`、`change_1`、`change_2`、`question_1`、`question_2`、`risk` 六个不同槽位。每项都要有唯一且有效的来源。

## Ground Truth 关键字段

每条 Claim 至少包含：

- `id`、`scenarioId`、`eventId`
- `type`、`statement`、`normalizedValue`
- `material`、`critical`、`modality`
- `acceptableEvidenceIds`
- `citationSupport`
- `expectedClassification`
- `targetVersionId`
- `ambiguity`
- `annotation.doubleAnnotated` 和裁决记录

`citationSupport` 固定使用 `fully_supports`、`partially_supports`、`does_not_support`。它与 Evidence 的 `direct`、`corroborating`、`contextual` 角色是两套不同信息。

## Predictions 关键字段

每次运行保存固定的 Model、Prompt、Schema、参数、Commit SHA 和环境。每条预测 Claim 记录人工确认过的 `matchedGroundTruthId`、分类、目标版本、Evidence 合法性、原文精确匹配和语义支持。三次稳定性评测需要三个独立 Run。报告同时列出每一次 Run 的指标，并使用三次中最差的 Recall、Precision、Evidence、Relation、View 和 Brief 指标执行硬门，避免第一次表现较好时掩盖后续漂移。

Critical Ambiguity 命中还必须填写 `ambiguityAlternatives`、`ambiguityQuestion` 和 `assertedDefinitively: false`。只写 `ambiguityDetected: true` 不算通过。

图片 Claim 必须明确填写 `unsupportedVisualClaim: true | false`，表示已经完成边界审查。缺少该字段时，图片审查门失败。

Brief Slot 格式为：

```json
{
  "slot": "change_1",
  "sourceKind": "timeline_delta",
  "sourceId": "delta_123",
  "sourceValid": true,
  "useful": true
}
```

`current_status` 和 `risk` 使用 `claim`，两条变化使用 `timeline_delta`，两个问题使用 `agenda_item`。缺项、重复来源或无效来源都计为失败。

## 从正式 Run 生成 Predictions 草稿

已经完成的本地 Run 可以通过只读 API 导出。导出器不会调用模型，也不会读取 Ground Truth：

```bash
npm run eval:export-run -- \
  --base-url http://localhost:3000 \
  --project-id prj_example \
  --run-id run_example \
  --commit-sha abc123 \
  --output work/predictions/run_example.json
```

导出结果符合 `notique-eval-predictions.v1` 的基础结构，同时保留 Model、Prompt、Schema、模型参数、Context 哈希、输入清单、Claims、Evidence、Relations、Views、Token 和延迟。详细限制与评审步骤见 [生产 Run 导出说明](./PRODUCTION_RUN_EXPORT.md)。

重复提供多个 `--run-id` 时，导出器只接受同一个 Project、同一个 Event、同一份 Input Snapshot 与 Input Manifest、同一个 Context Snapshot 与 Context Version。这样三次一致性只比较同一测试用例的重复运行，不会混入输入材料或项目状态的变化。
