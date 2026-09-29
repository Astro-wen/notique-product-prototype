# 工作流 V2 模型验收

更新日期：2026-09-29

这份说明用于回答三个问题：重点提得准不准，用户需要改多少，以及新流程是否更快、更省。工程测试、实际页面操作和模型验收分别留证。

当前合成开发集有3个场景、11次沟通、107条重要信息，共116条标注信息。它用于开发回归。正式验收继续需要30份授权或脱敏材料、冻结的盲测集、双人标注及裁决、3轮独立运行和实际用量记录。

## 一、准备材料

按后端方案收集三类材料，每类10份，覆盖短、中、长内容。三类为房仲、项目沟通、咨询或个人事务。每个场景安排3至5次连续沟通，一次沟通可以包含多份材料。

每份材料记录固定编号、文件SHA-256、所属场景、沟通编号和授权依据。原录音与其转写按一份业务材料登记，由标注人确认材料清单。评估输入使用可回读、已冻结的分析文件，并把对应哈希保留在Run的输入清单中。

| 准备项 | 实际操作 | 保存结果 |
| --- | --- | --- |
| 材料来源 | 确认授权范围，完成必要脱敏 | 授权记录的文件路径或文档链接 |
| 内容长度 | 三类材料都覆盖短、中、长内容 | 材料清单中的长度档位 |
| 连续沟通 | 每个场景3至5次沟通 | 固定的scenarioId与eventId |
| 重要信息 | 每次沟通预先选5至10条重要信息 | material标注及选择理由 |
| 盲测冻结 | 在模型运行前保存材料、标准答案、配置和哈希 | blindSetFrozenAt与冻结清单 |

重要信息的选择发生在查看模型结果以前。材料中的金额、主体、时间、限定词、未回答问题、约定及行动建议都进入人工标注。超过十条的重要内容另作压力测试，正式审核上限的样本按预先确定的优先级选择。

## 二、建立标准答案

使用[Ground Truth模板](../eval/templates/ground-truth.template.json)。两位标注人先独立阅读原始材料，再比较结果，分歧由第三位裁决人或指定负责人判断。关键金额、主体、时间、歧义和行动的标注尤其需要保留出处与限定词。

关键项全部双人标注并裁决，全体信息至少20%完成双人标注及裁决。正式样本还需要至少40条重要信息、10条关键项、8处关键歧义和8条信息关系。使用图片验收时，至少包含12条图片事实。

标准答案的顶层字段如下。示例中的记录引用替换成真实保存位置。

```json
{
  "schemaVersion": "notique-ground-truth.v1",
  "dataset": "workflow-v2-blind-2026-09",
  "split": "blind",
  "metadata": {
    "synthetic": false,
    "authorization": {
      "approved": true,
      "reference": "授权与脱敏记录路径"
    },
    "evaluationMaterialCount": 30,
    "blindSetFrozenAt": "2026-09-29T00:00:00Z"
  },
  "claims": [],
  "relations": []
}
```

每条信息填写id、scenarioId、eventId、type、statement、normalizedValue、material、critical、modality、可接受出处、时间点、预期分类及目标版本。歧义写明候选解释与需要问用户的问题。`annotation.doubleAnnotated`和`annotation.adjudication`记录实际完成情况。

盲测集在发布门槛判断前保持冻结。需要调整提示词或筛选标准时，用开发集查错，另留一批盲测材料验收。

## 三、独立运行三轮

每轮按相同顺序处理全部场景和沟通。每个Event保存三个独立Run，保留每次真实runId和开始时间。三轮固定源码提交、供应商、模型、Prompt、Schema、Parser、模型参数，以及每个Event的输入和上下文快照。

运行前记录基线。费用和用量按转写、提取、复核、概要、按需阅读视图分别保存，并包含重试。改推理等级或拆分前后端任务比例的方案作为另一组对照运行。

三轮完成以前保持测试上下文一致。人工批阅使用另外的用户流程验收路径。这样模型稳定性比较与批阅造成的内容变化各自可解释。

模型运行需要供应商配置和预算。下面的导出、裁决、聚合、评分命令全部读取已有结果。

## 四、导出每次沟通

每个Event单独导出三个Run，保存原始结果。命令中的ID使用实际运行回执。

```bash
npm run eval:export-run -- \
  --base-url http://localhost:3000 \
  --project-id prj_example \
  --run-id run_event01_round1 \
  --run-id run_event01_round2 \
  --run-id run_event01_round3 \
  --commit-sha actual_commit_sha \
  --output work/model-acceptance/event01.raw.json
```

输出目录提前创建，每次使用新文件名。导出器校验三个Run属于同一个Project与Event，且冻结输入、上下文和配置完全相同。测试环境的导出选项见[生产Run导出说明](../eval/PRODUCTION_RUN_EXPORT.md)。

## 五、逐条裁决模型结果

人工把每条预测与标准答案对应。未命中的预测明确写null，模型多提的内容继续进入精确率分母。逐条核对引用是否支持整句话，图片是否产生越界推断，阅读结果是否混入已拒绝信息，以及六项Brief是否有用。

每个Event保存一份裁决文件，格式如下，三个Run都要填写。

```json
{
  "schemaVersion": "notique-eval-adjudication.v1",
  "groundTruthEventId": "event01",
  "metadata": {
    "reference": "裁决记录路径",
    "reviewedBy": ["reviewer01"],
    "completedAt": "2026-09-29T12:00:00Z"
  },
  "runs": [
    {
      "id": "run_event01_round1",
      "claimMatches": {"prediction01": "gt01", "prediction02": null},
      "claimReviews": {
        "prediction01": {
          "citationSupport": "fully_supports",
          "evidenceSupport": {"evidence01": "fully_supports"}
        },
        "prediction02": {
          "citationSupport": "does_not_support",
          "evidenceSupport": {"evidence02": "does_not_support"},
          "unsupportedVisualClaim": true
        }
      },
      "relationMatches": {"predicted_relation01": "gt_relation01"},
      "viewLeakageCount": 0,
      "usefulBriefSlots": ["current_status", "change_1", "change_2", "question_1", "question_2", "risk"]
    }
  ]
}
```

支持度使用fully_supports、partially_supports或does_not_support。图片预测的unsupportedVisualClaim填写true或false。Evidence使用导出结果中的ID，缺少ID时使用从零开始的`#0`、`#1`。每条Claim、每条Evidence和每条Relation都保留明确判断，缺失评审会保留未完成状态。

```bash
npm run eval:adjudicate -- \
  work/model-acceptance/event01.raw.json \
  work/model-acceptance/event01.decisions.json \
  work/model-acceptance/ground-truth.json \
  work/model-acceptance/event01.reviewed.json \
  work/model-acceptance/event01.ground-truth.json
```

event01.ground-truth.json用于单次沟通诊断。全量评分继续使用已经冻结的完整ground-truth.json。

## 六、按三轮完整数据集聚合

保存sweeps.json，cases列出全部Event的裁决文件，sweeps列出每轮对应的真实runId。路径以sweeps.json所在目录为基准。示例展示两个Event，实际文件列出标准答案中的全部Event。

```json
{
  "schemaVersion": "notique-eval-sweep-manifest.v1",
  "dataset": "workflow-v2-blind-2026-09",
  "verification": {
    "independentRunsVerified": true,
    "reference": "三轮独立执行的核查记录路径"
  },
  "materials": [
    {"id": "material01", "sha256": "实际64位文件哈希"}
  ],
  "cases": [
    {"groundTruthEventId": "event01", "predictionsPath": "event01.reviewed.json"},
    {"groundTruthEventId": "event02", "predictionsPath": "event02.reviewed.json"}
  ],
  "sweeps": [
    {"id": "round1", "runIds": {"event01": "run_event01_round1", "event02": "run_event02_round1"}},
    {"id": "round2", "runIds": {"event01": "run_event01_round2", "event02": "run_event02_round2"}},
    {"id": "round3", "runIds": {"event01": "run_event01_round3", "event02": "run_event02_round3"}}
  ]
}
```

materials登记全部评估文件的编号与SHA-256，数量与evaluationMaterialCount一致，并能在真实Run的冻结输入清单中找到。相同文件哈希去重计数。

```bash
node scripts/aggregate-eval-sweeps.mjs \
  work/model-acceptance/ground-truth.json \
  work/model-acceptance/sweeps.json \
  work/model-acceptance/predictions.json
```

聚合器逐轮保留全部预测与底层Run审计，检测缺失Event、重复或复用Run、改变输入或配置，以及不完整的人工评审记录。独立运行证明、来源哈希或评审依据不足时，qualification.verified与independentRunsVerified为null，issues列明缺项。

每轮保留各Event指标。Brief使用结构最弱的Event，所有结构均有效时使用最少有用项的Event，具体Event写在aggregate.briefEventId。视图泄漏逐Event累加。费用或Token有任一缺失，总量保留null。latencyMs是各底层Run耗时之和，实际等待时长另按执行时间线记录。

## 七、评分与判定

```bash
npm run eval -- \
  work/model-acceptance/ground-truth.json \
  work/model-acceptance/predictions.json \
  work/model-acceptance/report.json
```

先看sampleEligibility，再看gates.pass和每个检查项。程序成功写出报告表示评分已执行，正式通过以报告内容为准。每轮的指标保留在metrics.perRun，门槛使用三轮中最差的结果。

| 检查项 | 通过要求 |
| --- | --- |
| 重要信息 | 召回率至少90%，精确率至少95% |
| 关键内容 | 召回率100%，引用支持100% |
| 引用 | 每条有出处，ID有效，转写原话精确匹配，总体支持率至少95% |
| 关键歧义 | 100%识别，并保留候选解释及澄清问题 |
| 信息关系 | 精确率与召回率均至少90% |
| 重复与复述 | 重复新增率低于10%，复述分类及目标版本100%正确 |
| 三轮稳定性 | 一致率至少85% |
| 时间定位 | 每轮最大偏差小于5秒 |
| 阅读结果 | 泄漏数为0，Brief六项来源唯一有效，至少五项有用 |
| 图片 | 越界推断为0，至少12条图片事实，召回率至少80% |

费用字段costUsd是记录到Run的估计费用，缺失显示null。供应商账单另存并与阶段用量核对。速度和降本使用同一批输入、同一模型配置的基线对照，同时记录用户修改数、首次可用结果时间和完整处理时间。

房仲Draft Context A/B使用现有eval:realtor-ab与eval:realtor-ab:score。它固定使用四次沟通的合成案例，供开发比较事实与行动质量、Token变化。正式材料的三轮验收沿用上面的完整数据集路径。

## 八、当前验证与最小补充

本轮纯离线验证覆盖跨Event聚合、人工裁决、现有导出与评分。测试使用人工构造的单元数据，验证数据流和判定规则。

```bash
node --test tests/aggregate-eval-sweeps.test.mjs tests/apply-eval-adjudication.test.mjs \
  tests/eval-runner.test.mjs tests/eval-runner-cost.test.mjs \
  tests/eval-runner-eligibility.test.mjs tests/export-production-run.test.mjs
```

这组命令验证了缺项及配置变化会被识别、未知费用保持null、逐条引用支持判断保持独立，以及完整数据集三轮结果能交给现有Runner评分。合成开发集与空预测模板的离线报告保持sample_eligible=false。

正式执行只需要用户补充以下信息，材料清单、文件哈希及评估文件由执行人整理：

1. 30份材料的位置，以及允许分析的授权或脱敏依据。
2. 两位标注人和裁决负责人，关键项的判断标准。
3. 使用的供应商配置与本轮模型预算上限。

产品独立试用另安排五位未参与实现的用户，观察直接阅读、只采纳一部分、行动后补结果这三条路径，记录完成情况及求助次数。模型质量、费用对照和用户试用分别给出结论。
