/**
 * 判断方的校准度量。
 *
 * 一个只回概率的模型，光看准确率不够。准确率高但概率乱给的模型没法用阈值去
 * 驱动动作：说 0.9 的那批如果只有六成对，那 0.8 这个门就是随手划的。所以要
 * 分桶看「它说多少」和「实际多少」差多远，也就是校准误差。
 *
 * 这里不评价某一家模型，只提供一把尺。接哪个判断方都用同一把尺量，包括不接
 * 模型、纯用规则的情况。判断的是「能不能用阈值驱动动作」，不是「谁更聪明」。
 *
 * ground truth 从哪来：
 *   离线　评估集里本来就标了哪些引用支持哪条陈述，eval-runner 的
 *         citationSupportPrecision 和 criticalCitationSupport 两道门用的就是它。
 *   线上　verdicts 表里人下过的 confirm / reject 是真实标注。人不采纳一条
 *         记录，通常正说明引用撑不住它。
 */

export type CalibrationSample = {
  /** 判断方给的「支持」概率。 */
  predicted: number;
  /** 真实答案：这条引用到底支不支持。 */
  actual: boolean;
};

export type CalibrationBucket = {
  /** 桶的区间，左闭右开，最后一桶右闭。 */
  lower: number;
  upper: number;
  count: number;
  /** 桶内预测概率的平均值。 */
  meanPredicted: number;
  /** 桶内真实为支持的比例。 */
  observedRate: number;
  /** 这一桶偏了多少。 */
  gap: number;
};

export type CalibrationReport = {
  sampleCount: number;
  /** 按 0.5 切的准确率。只看它会被校准问题骗到，所以只是参考。 */
  accuracy: number;
  /**
   * Expected Calibration Error：各桶 |说的 − 实际| 按样本数加权平均。
   * 0 表示说什么就是什么。阈值能不能用，主要看它。
   */
  expectedCalibrationError: number;
  /** 最差的一桶偏了多少。平均值会掩盖单桶塌陷，所以单独看。 */
  maxBucketGap: number;
  buckets: CalibrationBucket[];
};

/**
 * 分桶算校准。默认十桶。
 *
 * 空桶不计入 ECE，也不出现在报告里：没有样本的区间说明不了任何事，
 * 把它按 0 计入会把误差冲淡。
 */
export function calibrationReport(
  samples: readonly CalibrationSample[],
  bucketCount = 10,
): CalibrationReport {
  const valid = samples.filter((sample) => Number.isFinite(sample.predicted));
  if (!valid.length || bucketCount < 1) {
    return {
      sampleCount: 0,
      accuracy: 0,
      expectedCalibrationError: 0,
      maxBucketGap: 0,
      buckets: [],
    };
  }

  const correct = valid.filter((sample) => (sample.predicted >= 0.5) === sample.actual).length;
  const buckets: CalibrationBucket[] = [];
  let weightedGap = 0;
  let maxBucketGap = 0;

  for (let index = 0; index < bucketCount; index += 1) {
    const lower = index / bucketCount;
    const upper = (index + 1) / bucketCount;
    const isLast = index === bucketCount - 1;
    const inBucket = valid.filter((sample) => {
      const value = clamp(sample.predicted);
      return isLast ? value >= lower && value <= upper : value >= lower && value < upper;
    });
    if (!inBucket.length) continue;

    const meanPredicted = mean(inBucket.map((sample) => clamp(sample.predicted)));
    const observedRate = inBucket.filter((sample) => sample.actual).length / inBucket.length;
    const gap = Math.abs(meanPredicted - observedRate);
    weightedGap += gap * inBucket.length;
    maxBucketGap = Math.max(maxBucketGap, gap);
    buckets.push({ lower, upper, count: inBucket.length, meanPredicted, observedRate, gap });
  }

  return {
    sampleCount: valid.length,
    accuracy: correct / valid.length,
    expectedCalibrationError: weightedGap / valid.length,
    maxBucketGap,
    buckets,
  };
}

export type JudgeGateThresholds = {
  /** 样本太少时任何结论都不作数。 */
  minSamples: number;
  maxExpectedCalibrationError: number;
  maxBucketGap: number;
  minAccuracy: number;
};

/**
 * 默认门槛偏严，因为这个判断会挡住一键确认，误判的代价是打断读者。
 * 和 eval-runner 的门一样互不补偿：准确率高补不了校准差。
 */
export const DEFAULT_JUDGE_GATES: JudgeGateThresholds = {
  minSamples: 200,
  maxExpectedCalibrationError: 0.1,
  maxBucketGap: 0.2,
  minAccuracy: 0.85,
};

export type JudgeGateResult = {
  name: string;
  passed: boolean;
  actual: number;
  expected: string;
};

/**
 * 这个判断方够不够格上界面。
 *
 * 每一项独立，任何一项不过就不上；不允许用别的项去补。样本不够时其余项直接
 * 判负而不是判正，免得几十个样本碰巧好看就放行。
 */
export function judgeGates(
  report: CalibrationReport,
  thresholds: JudgeGateThresholds = DEFAULT_JUDGE_GATES,
): { passed: boolean; gates: JudgeGateResult[] } {
  const enough = report.sampleCount >= thresholds.minSamples;
  const gates: JudgeGateResult[] = [
    {
      name: "sample_size",
      passed: enough,
      actual: report.sampleCount,
      expected: `>= ${thresholds.minSamples}`,
    },
    {
      name: "calibration_error",
      passed: enough && report.expectedCalibrationError <= thresholds.maxExpectedCalibrationError,
      actual: report.expectedCalibrationError,
      expected: `<= ${thresholds.maxExpectedCalibrationError}`,
    },
    {
      name: "worst_bucket_gap",
      passed: enough && report.maxBucketGap <= thresholds.maxBucketGap,
      actual: report.maxBucketGap,
      expected: `<= ${thresholds.maxBucketGap}`,
    },
    {
      name: "accuracy",
      passed: enough && report.accuracy >= thresholds.minAccuracy,
      actual: report.accuracy,
      expected: `>= ${thresholds.minAccuracy}`,
    },
  ];
  return { passed: gates.every((gate) => gate.passed), gates };
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
