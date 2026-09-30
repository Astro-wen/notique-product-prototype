import { getBindings } from "@/db";
import { ApiFault } from "@/lib/server/http/api";

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0);
  }
  return mismatch === 0;
}

export type InternalJobAuthorization = 'internal' | 'workflow_recovery';

export async function requireInternalJobAuthorization(
  request: Request,
  options: { allowWorkflowRecoveryToken?: boolean } = {},
): Promise<InternalJobAuthorization> {
  const bindings = getBindings();
  const configured = bindings.INTERNAL_JOB_TOKEN?.trim();
  const recovery = options.allowWorkflowRecoveryToken ? bindings.WORKFLOW_RECOVERY_TOKEN?.trim() : undefined;
  if (!configured && !recovery) {
    throw new ApiFault(503, "QUEUE_NOT_CONFIGURED", "Internal job authorization is not configured.");
  }
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!supplied) {
    throw new ApiFault(401, "UNAUTHORIZED", "Internal job authorization failed.");
  }
  const [internalMatch, recoveryMatch] = await Promise.all([
    configured ? constantTimeEqual(supplied, configured) : false,
    recovery ? constantTimeEqual(supplied, recovery) : false,
  ]);
  if (internalMatch) return 'internal';
  if (recoveryMatch) return 'workflow_recovery';
  throw new ApiFault(401, "UNAUTHORIZED", "Internal job authorization failed.");
}
