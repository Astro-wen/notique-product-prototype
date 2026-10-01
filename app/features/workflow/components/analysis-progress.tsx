"use client";
import { NqButton, NqStatus } from '@/app/components/notique-ui';
import type { AnalysisRun } from '@/lib/shared/workflow-v2';
import styles from './record-workspace.module.css';

export function AnalysisProgress({run,hasRecord,busy,materialPending=false,error,canEdit,onStart,onRetry,onReload}:{run:AnalysisRun|null;hasRecord:boolean;busy:boolean;materialPending?:boolean;error:string;canEdit:boolean;onStart:()=>void;onRetry:()=>void;onReload:()=>void}) {
  const pending=run?.stages.some(s=>s.state==='queued'||s.state==='running')||run?.state==='queued'||run?.state==='running';
  const automaticRetry=run?.stages.some(s=>s.name.endsWith(' · 自动重试')&&(s.state==='queued'||s.state==='running'));
  const failed=run?.stages.filter(s=>s.state==='failed')??[];
  const outputLimitReached=failed.some(s=>s.errorCode==='MODEL_OUTPUT_TOKEN_LIMIT');
  const outdatedSummary=run?.stages.some(s=>s.errorCode==='NARRATIVE_PROMPT_OUTDATED'&&s.retryable)??false;
  const summaryRefreshOnly=outdatedSummary&&!run?.stages.some(s=>s.retryable&&s.errorCode!=='NARRATIVE_PROMPT_OUTDATED');
  const summaryOnly=run?.stages.some(s=>s.name==='更新全文概要'&&(s.state==='queued'||s.state==='running'||s.state==='failed')) && !run.stages.some(s=>s.name!=='更新全文概要'&&(s.state==='queued'||s.state==='running'||s.state==='failed'));
  const quality=run?.qualityNotes;
  const needsSourceReview=Boolean(quality&&(quality.omittedStatements.length||quality.inventoryLimitReached||quality.finalClaimLimitReached||quality.followUpOmitted));
  const label=materialPending?'正在转写录音':automaticRetry?'核对耗时较长，正在自动重试':summaryOnly?(pending?'重点已更新，全文概要正在同步':'重点可用，全文概要尚未更新'):pending?(hasRecord?'正在整理，已有记录仍可阅读':'正在整理这份记录'):failed.length?(hasRecord?'记录可阅读，部分整理尚未完成':'本次整理尚未完成'):run?.state==='cancelled'?'本次整理已停止':run&&!run.coverage.complete?'材料范围已有变化，可重新整理':needsSourceReview?(hasRecord?'重点可用，部分内容需回看原文':'部分内容需回看原文'):summaryRefreshOnly?'重点可用，可以更新全文概要':run?'整理完成':'材料准备好后，可以整理记录';
  const statusLabel={queued:'等待处理',running:'正在处理',partial:'部分完成',succeeded:'已完成',failed:'未完成',cancelled:'已停止'} as const;
  return <section className={styles.analysis} aria-label="记录整理进度">
    <details className={styles.analysisDisclosure} open={!hasRecord}><summary><span role="status">{label}</span><span className={styles.analysisDetailLabel}>查看处理情况</span></summary><div className={styles.analysisBar}><div>
      {canEdit && run?.retryable && <NqButton variant="secondary" loading={busy} disabled={pending||busy||materialPending} onClick={onRetry}>{summaryRefreshOnly?'更新全文概要':'重试失败部分'}</NqButton>}
      {canEdit && <NqButton variant="quiet" loading={busy} disabled={pending||busy||materialPending} onClick={onStart}>{run?'重新整理':'整理记录'}</NqButton>}
    </div></div>
    {(pending || materialPending) && <p>处理在后台继续，可以离开页面。</p>}
    {needsSourceReview && quality && <div role="note" aria-label="内容核对提示">
      {(quality.inventoryLimitReached||quality.finalClaimLimitReached) && <p>本次重点已达到整理容量，可回看原文补充你在意的内容。</p>}
      {quality.followUpOmitted && <p>部分问题或跟进事项尚未进入重点，需要回看原文核对。</p>}
      {quality.omittedStatements.length>0 && <details><summary>需回看原文的内容 {quality.omittedStatements.length}</summary><ul>{quality.omittedStatements.map((statement,index)=><li key={index}>{statement}</li>)}</ul><p>可使用上方的查看原文或从原文补充。</p></details>}
    </div>}
    {error && <p role="alert">{error}<NqButton variant="quiet" onClick={onReload}>读取最新进度</NqButton></p>}
    {run && <details><summary>查看整理进度</summary><ul>{run.stages.map(stage=><li key={stage.id}><span>{stage.name}</span><NqStatus tone={stage.state==='failed'?'pending':stage.errorCode==='NARRATIVE_PROMPT_OUTDATED'?'info':stage.state==='succeeded'?'success':'info'}>{stage.errorCode==='NARRATIVE_PROMPT_OUTDATED'?'可更新':statusLabel[stage.state]}</NqStatus></li>)}</ul>
      <p>{run.coverage.totalSegments>0?<>原文已处理 {run.coverage.completedSegments} / {run.coverage.totalSegments} 段{run.coverage.complete?'':'，其余范围仍需整理'}。</>:run.coverage.complete?'材料已处理完成。':'材料仍需整理。'}</p>
      {failed.length>0 && !run.retryable && <p>{outputLimitReached?'这次整理已用完输出容量。可以先查看原文，或把材料分成较短的记录再整理。':'当前材料或整理条件有变化，可以重新整理这份记录。'}</p>}
    </details>}
    </details>
  </section>;
}
