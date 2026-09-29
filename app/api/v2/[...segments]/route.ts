import { createWorkflowAnalysis, wakeWorkflowAnalysis } from '@/lib/server/jobs/workflow-analysis';
import { readAnalysisRun, retryAnalysis, startAnalysis } from '@/lib/server/workflow/analysis-service';
import { wakeWorkflowOutbox } from '@/lib/server/jobs/workflow-outbox';
import { readProjectOverview } from '@/lib/server/workflow/overview-service';
import { saveReviewProgress } from '@/lib/server/workflow/review-progress';
import { getBindings, getD1 } from '@/db';
import { ApiFault, jsonObject, ok, requestId, toResponse } from '@/lib/server/http/api';
import { getRequestScope } from '@/lib/server/http/context';
import { dispatchWorkflowCommand } from '@/lib/server/workflow/commands';
import { readWorkspace, WorkflowFault, type WorkflowScope } from '@/lib/server/workflow/snapshot-store';
import { createReport } from '@/lib/server/workflow/report-service';
import { parseWorkflowRequest, WorkflowValidationError } from '@/lib/shared/workflow-v2';

export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ segments: string[] }> };

async function workflowScope(request: Request): Promise<WorkflowScope> {
  const identity = await getRequestScope(request);
  const bindings = getBindings();
  const demo = (bindings.AUTH_GATEWAY === 'public' && identity.actorId === 'public@notique.test') ||
    (bindings.APP_ENV === 'local' && identity.actorId === 'local@notique.test');
  return { ...identity, access: demo ? 'demo' : 'members' };
}

function workflowError(error: unknown, id: string): Response {
  if (error instanceof WorkflowValidationError) {
    return toResponse(new ApiFault(400, 'BAD_REQUEST', error.message, { field: error.field }), id);
  }
  if (error instanceof WorkflowFault) {
    const response = toResponse(new ApiFault(error.status, error.code, error.message, error.details), id);
    if (error.status === 503) response.headers.set('Retry-After', '1');
    return response;
  }
  return toResponse(error, id);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const id = requestId(request);
  try {
    const scope = await workflowScope(request);
    const { segments } = await context.params;
    if (segments.length === 3 && segments[0] === 'events' && segments[2] === 'workspace') {
      const query = Object.fromEntries(new URL(request.url).searchParams.entries());
      return ok(await readWorkspace(getD1(), scope, segments[1], query), id);
    }
    if(segments.length===2 && segments[0]==='analysis-runs') return ok(await readAnalysisRun(getD1(),scope,segments[1]),id);
    if(segments.length===3 && segments[0]==='projects' && segments[2]==='overview') {
      return ok(await readProjectOverview(getD1(),scope,segments[1],Object.fromEntries(new URL(request.url).searchParams.entries())),id);
    }
    throw new ApiFault(404, 'NOT_FOUND', '没有找到这个工作流入口');
  } catch (error) {
    return workflowError(error, id);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const id = requestId(request);
  try {
    const scope = await workflowScope(request);
    const { segments } = await context.params;
    const body = await jsonObject(request);
    const key = request.headers.get('Idempotency-Key') ?? '';
    if(segments.length===3 && segments[0]==='events' && segments[2]==='analysis') {
      const run=await startAnalysis(getD1(),scope,segments[1],parseWorkflowRequest('StartAnalysisRequest',body),key,createWorkflowAnalysis);
      wakeWorkflowAnalysis(scope.workspaceId,run);
      return ok(run,id,run.state==='queued'||run.state==='running'?202:200);
    }
    if(segments.length===3 && segments[0]==='analysis-runs' && segments[2]==='retry') {
      const run=await retryAnalysis(getD1(),scope,segments[1],parseWorkflowRequest('RetryAnalysisRequest',body),key,new Date().toISOString(),{maxConcurrentRuns:Math.max(1,Number(getBindings().MAX_CONCURRENT_RUNS_PER_WORKSPACE)||2)});
      wakeWorkflowAnalysis(scope.workspaceId,run);
      return ok(run,id,202);
    }
    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'reports') {
      return ok(await createReport(getD1(), scope, { projectId: segments[1], key, request: parseWorkflowRequest('ReportRequest', body) }), id);
    }
    if(segments.length===3 && segments[0]==='events' && segments[2]==='review-progress') {
      return ok(await saveReviewProgress(getD1(),scope,segments[1],parseWorkflowRequest('ReviewProgressRequest',body),key),id);
    }
    const receipt=await dispatchWorkflowCommand(getD1(), scope, segments, body, key);
    if(receipt.refreshState==='updating')wakeWorkflowOutbox();
    return ok(receipt, id);
  } catch (error) {
    return workflowError(error, id);
  }
}
