import { dispatchDueOutbox } from "@/lib/server/jobs/outbox";
import { ApiFault, ok, requestId, toResponse } from "@/lib/server/http/api";
import { requireInternalJobAuthorization } from "@/lib/server/http/internal-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    await requireInternalJobAuthorization(request);
    const text = await request.text();
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiFault(400, "INVALID_JSON", "Request body must be valid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiFault(400, "BAD_REQUEST", "Request body must be an object.");
      }
      const value = (body as Record<string, unknown>).limit;
      if (value !== undefined && value !== 1) {
        throw new ApiFault(400, "BAD_REQUEST", "POC dispatch limit must be 1.");
      }
    }
    return ok({ dispatch: await dispatchDueOutbox() }, id);
  } catch (error) {
    return toResponse(error, id);
  }
}
