import { sweepAndDispatch } from "@/lib/server/jobs/outbox";
import { ok, requestId, toResponse } from "@/lib/server/http/api";
import { requireInternalJobAuthorization } from "@/lib/server/http/internal-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    await requireInternalJobAuthorization(request);
    return ok(await sweepAndDispatch(), id);
  } catch (error) {
    return toResponse(error, id);
  }
}
