import { getBindings } from "@/db";
import { ApiFault, ok, requestId, toResponse } from "@/lib/server/http/api";
import { getRequestScope } from "@/lib/server/http/context";
import { dispatchDueOutbox } from "@/lib/server/jobs/outbox";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const id = requestId(request);
  try {
    if (getBindings().APP_ENV !== "local") {
      throw new ApiFault(404, "NOT_FOUND", "Local job dispatch is unavailable.");
    }
    await getRequestScope(request);
    return ok({ dispatch: await dispatchDueOutbox() }, id);
  } catch (error) {
    return toResponse(error, id);
  }
}
