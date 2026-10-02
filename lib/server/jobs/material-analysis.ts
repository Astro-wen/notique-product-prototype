import { getD1 } from '@/db';
import { waitUntil } from 'cloudflare:workers';
import { createExtractionRun } from '@/lib/server/db/core-repository';
import { consumeMaterialAnalysisJobs } from '@/lib/server/workflow/material-analysis';
import { dispatchExtractionRun } from './outbox';
import { dispatchEventAiArtifactsForExtraction } from './event-ai-artifacts';
import { runIndependentTasks } from './independent-tasks';

export async function commissionMaterialAnalysis(scope?: { workspaceId: string; eventId?: string }) {
  const runIds: Array<{ workspaceId: string; runId: string }> = [];
  const result = await consumeMaterialAnalysisJobs(getD1(), {
    create: async input => {
      const created = await createExtractionRun(input.scope, input.eventId, input.key, input.assetVersionIds, false,
        { guard: input.guard, sourceRevision: input.sourceRevision, replay: input.replay });
      runIds.push({ workspaceId: input.scope.workspaceId, runId: created.run.id });
      return { id: created.run.id };
    },
  }, scope);
  return { ...result, runIds };
}

/** Material and its intent are already committed. This accelerates the durable
 * handoff once, while the scheduled consumer owns subsequent recovery. */
export function wakeMaterialAnalysis(workspaceId: string, eventId: string) {
  waitUntil(new Promise(resolve => setTimeout(resolve, 2100)).then(async () => {
    const result = await commissionMaterialAnalysis({ workspaceId, eventId });
    await runIndependentTasks(result.runIds.flatMap(run=>[
      {name:'extraction',run:()=>dispatchExtractionRun(run.workspaceId,run.runId)},
      {name:'reading',run:()=>dispatchEventAiArtifactsForExtraction(run.workspaceId,run.runId)},
    ]));
  }).catch(() => console.error('material_analysis_wake_failed', { eventId, code: 'MATERIAL_WAKE_FAILED' })));
}
