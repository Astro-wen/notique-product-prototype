import { getBindings, getD1 } from '@/db';
import { waitUntil } from 'cloudflare:workers';
import { cancelBackgroundResponses, createModelProvider } from '@/lib/server/ai/model-provider';
import { workflowNarrativeModelConfig } from '@/lib/domain/workflow-narrative-config';
import { consumeNarrativeJobs, type NarrativeModelConfig } from '@/lib/server/workflow/narrative-jobs';

export function dispatchWorkflowOutbox() {
  const bindings=getBindings();
  const config:NarrativeModelConfig=workflowNarrativeModelConfig(bindings);
  return consumeNarrativeJobs(getD1(),{config,provider:frozen=>createModelProvider({...bindings,AI_API_BASE_URL:frozen.baseUrl},{...frozen,timeoutMs:25_000}),cancelProvider:(frozen,id)=>cancelBackgroundResponses({...bindings,AI_API_BASE_URL:frozen.baseUrl},[id])});
}
/** Short wake accelerates a saved edit. Durable scheduled consumption owns
 * recovery after the HTTP invocation ends. */
export function wakeWorkflowOutbox() {
  waitUntil(new Promise(resolve=>setTimeout(resolve,2100)).then(()=>dispatchWorkflowOutbox()).catch(()=>{
    console.error('workflow_outbox_wake_failed',{code:'WORKFLOW_WAKE_FAILED'});
  }));
}
