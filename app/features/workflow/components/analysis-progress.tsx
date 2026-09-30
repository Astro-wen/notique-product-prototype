"use client";
import { NqButton, NqStatus } from '@/app/components/notique-ui';
import type { AnalysisRun } from '@/lib/shared/workflow-v2';
import styles from './record-workspace.module.css';

export function AnalysisProgress({run,hasRecord,busy,error,canEdit,onStart,onRetry,onReload}:{run:AnalysisRun|null;hasRecord:boolean;busy:boolean;error:string;canEdit:boolean;onStart:()=>void;onRetry:()=>void;onReload:()=>void}) {
  const pending=run?.stages.some(s=>s.state==='queued'||s.state==='running')||run?.state==='queued'||run?.state==='running';
  const failed=run?.stages.filter(s=>s.state==='failed')??[];
  const outdatedSummary=run?.stages.some(s=>s.errorCode==='NARRATIVE_PROMPT_OUTDATED'&&s.retryable)??false;
  const summaryRefreshOnly=outdatedSummary&&!run?.stages.some(s=>s.retryable&&s.errorCode!=='NARRATIVE_PROMPT_OUTDATED');
  const summaryOnly=run?.stages.some(s=>s.name==='更新全文概要'&&(s.state==='queued'||s.state==='running'||s.state==='failed')) && !run.stages.some(s=>s.name!=='更新全文概要'&&(s.state==='queued'||s.state==='running'||s.state==='failed'));
  const label=summaryOnly?(pending?'重点已更新，全文概要正在同步':'重点可用，全文概要尚未更新'):pending?(hasRecord?'正在整理，已有记录仍可阅读':'正在整理这份记录'):failed.length?(hasRecord?'记录可阅读，部分整理尚未完成':'本次整理尚未完成'):run?.state==='cancelled'?'本次整理已停止':run&&!run.coverage.complete?'材料范围已有变化，可重新整理':summaryRefreshOnly?'重点可用，可以更新全文概要':run?'整理完成':'材料准备好后，可以整理记录';
  const statusLabel={queued:'等待处理',running:'正在处理',partial:'部分完成',succeeded:'已完成',failed:'未完成',cancelled:'已停止'} as const;
  return <section className={styles.analysis} aria-label="记录整理进度">
    <div className={styles.analysisBar}><span role="status">{label}</span><div>
      {canEdit && run?.retryable && <NqButton variant="secondary" loading={busy} disabled={pending||busy} onClick={onRetry}>{summaryRefreshOnly?'更新全文概要':'重试失败部分'}</NqButton>}
      {canEdit && <NqButton variant="quiet" loading={busy} disabled={pending||busy} onClick={onStart}>{run?'重新整理':'整理记录'}</NqButton>}
    </div></div>
    {pending && <p>可以先查看原文，稍后回到本次重点查看结果。</p>}
    {error && <p role="alert">{error}<NqButton variant="quiet" onClick={onReload}>读取最新进度</NqButton></p>}
    {run && <details><summary>查看整理进度</summary><ul>{run.stages.map(stage=><li key={stage.id}><span>{stage.name}</span><NqStatus tone={stage.state==='failed'?'pending':stage.errorCode==='NARRATIVE_PROMPT_OUTDATED'?'info':stage.state==='succeeded'?'success':'info'}>{stage.errorCode==='NARRATIVE_PROMPT_OUTDATED'?'可更新':statusLabel[stage.state]}</NqStatus></li>)}</ul>
      <p>{run.coverage.totalSegments>0?<>原文已处理 {run.coverage.completedSegments} / {run.coverage.totalSegments} 段{run.coverage.complete?'':'，其余范围仍需整理'}。</>:run.coverage.complete?'材料已处理完成。':'材料仍需整理。'}</p>
      {failed.length>0 && !run.retryable && <p>当前材料或整理条件有变化，可以重新整理这份记录。</p>}
    </details>}
  </section>;
}
