import { getD1 } from '@/db';
import { waitUntil } from 'cloudflare:workers';
import { createExtractionRun } from '@/lib/server/db/core-repository';
import { dispatchExtractionRun } from './outbox';
import { dispatchEventAiArtifactRun } from './event-ai-artifacts';
import { dispatchWorkflowOutbox } from './workflow-outbox';
import type { AnalysisCreation } from '@/lib/server/workflow/analysis-service';
import type { AnalysisRun } from '@/lib/shared/workflow-v2';

export async function createWorkflowAnalysis(input:AnalysisCreation):Promise<{id:string}> {
  const result=await createExtractionRun(input.scope,input.eventId,input.key,input.assetVersionIds,false,{guard:input.guard,sourceRevision:input.sourceRevision,replay:input.replay});
  return {id:result.run.id};
}
/** Accelerate persisted tasks once. Browser progress reads never dispatch work. */
export function wakeWorkflowAnalysis(workspaceId:string,run:AnalysisRun) {
  const pending=run.stages.filter(s=>s.state==='queued'||s.state==='running');
  if(!pending.length)return;
  waitUntil((async()=>{
    const extract=await getD1().prepare('SELECT status FROM extraction_runs WHERE id=? AND workspace_id=?').bind(run.id,workspaceId).first<{status:string}>();
    if(extract && ['queued','processing'].includes(extract.status))await dispatchExtractionRun(workspaceId,run.id);
    else for(const stage of pending) {
      if(stage.name==='更新全文概要')await dispatchWorkflowOutbox();
      else await dispatchEventAiArtifactRun(workspaceId,stage.id);
    }
  })().catch(()=>console.error('workflow_analysis_wake_failed',{runId:run.id,code:'WORKFLOW_ANALYSIS_WAKE_FAILED'})));
}
