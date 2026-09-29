import { sweepAndDispatch, type RecoveryStageFailure } from "@/lib/server/jobs/outbox";
import { sweepAndDispatchEventAiArtifacts } from "@/lib/server/jobs/event-ai-artifacts";
import { dispatchWorkflowOutbox } from "@/lib/server/jobs/workflow-outbox";
import { ApiFault, ok, requestId, toResponse } from "@/lib/server/http/api";
import { requireInternalJobAuthorization } from "@/lib/server/http/internal-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    await requireInternalJobAuthorization(request);
    const extractionFailures: RecoveryStageFailure[] = [];
    const [extraction, artifacts, workflow] = await Promise.allSettled([
      Promise.resolve().then(() => sweepAndDispatch({ onStageFailure: failure => extractionFailures.push(failure) })),
      Promise.resolve().then(() => sweepAndDispatchEventAiArtifacts()),
      Promise.resolve().then(() => dispatchWorkflowOutbox()),
    ]);
    const queueResult = (result: PromiseSettledResult<unknown>) => result.status === "fulfilled"
      ? { state: "succeeded", result: result.value }
      : { state: "failed", code: "QUEUE_SWEEP_FAILED" };
    const queues = {
      extraction: extraction.status === "fulfilled" && extractionFailures.length
        ? { state: "failed", code: "QUEUE_SWEEP_FAILED", stages: extractionFailures, result: extraction.value }
        : queueResult(extraction),
      event_ai_artifacts: queueResult(artifacts),
      workflow: queueResult(workflow),
    };
    if (extraction.status === "rejected" || artifacts.status === "rejected" || workflow.status === "rejected" || extractionFailures.length) {
      console.error("maintenance_sweep_failed", {
        request_id: id,
        queues: Object.entries(queues).filter(([, value]) => value.state === "failed").map(([name]) => name),
        code: "QUEUE_SWEEP_FAILED",
      });
      throw new ApiFault(503, "INTERNAL_ERROR", "One or more background queues could not be processed.", { queues });
    }
    return ok({
      ...extraction.value,
      event_ai_artifacts: artifacts.value,
      workflow: workflow.value,
      queues,
    }, id);
  } catch (error) {
    const response = toResponse(error, id);
    if (response.status === 503) response.headers.set("retry-after", "30");
    return response;
  }
}
