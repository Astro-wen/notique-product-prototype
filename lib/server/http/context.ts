import { getBindings, getD1 } from "@/db";
import { ApiFault } from "@/lib/server/http/api";

export type RequestScope = {
  workspaceId: string;
  actorId: string;
};

export async function getRequestScope(request: Request): Promise<RequestScope> {
  const bindings = getBindings();
  // Only an explicit local binding enables the development identity. Missing or
  // misspelled deployment configuration therefore fails closed as production.
  const environment = bindings.APP_ENV === "local" ? "local" : "production";
  const gateway = bindings.AUTH_GATEWAY;
  // Public mode intentionally ignores any caller-supplied identity headers.
  // Every visitor shares the explicitly public test workspace as one stable
  // actor; this must never be enabled for a private/customer workspace.
  let email = gateway === "public"
    ? "public@notique.test"
    : request.headers.get("oai-authenticated-user-email")?.trim();
  if (environment === "production") {
    if (gateway === "cloudflare-access") {
      const assertion = request.headers.get("cf-access-jwt-assertion")?.trim();
      email = request.headers.get("cf-access-authenticated-user-email")?.trim();
      if (!assertion || !email) {
        throw new ApiFault(401, "UNAUTHORIZED", "Cloudflare Access authentication is required.");
      }
    } else if (gateway === "chatgpt") {
      if (!email) {
        throw new ApiFault(401, "UNAUTHORIZED", "ChatGPT gateway authentication is required.");
      }
      // Managed hosting must strip user-supplied oai-authenticated-* headers
      // before injecting the verified identity used by this mode.
    } else if (gateway === "public") {
      // The fixed actor above is deliberate: public visitors do not get to
      // choose an identity by sending forged gateway headers.
      email = "public@notique.test";
    } else {
      throw new ApiFault(
        503,
        "UNAUTHORIZED",
        "AUTH_GATEWAY must be configured before production traffic is accepted.",
      );
    }
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiFault(401, "UNAUTHORIZED", "Authenticated user identity is invalid.");
  }

  const workspaceId = bindings.INTERNAL_WORKSPACE_ID || "ws_internal";
  const actorId = email || "local@notique.test";

  return { workspaceId, actorId };
}

/**
 * Ensure the authenticated workspace exists before a state-changing request.
 *
 * Authentication and workspace initialization used to be coupled, which made
 * every GET/poll write `workspaces.updated_at`. Keeping this explicit lets
 * ordinary reads remain side-effect free while preserving foreign-key safety
 * for the first mutation in a newly provisioned workspace.
 */
export async function initializeRequestWorkspace(scope: RequestScope): Promise<void> {
  const bindings = getBindings();
  const workspaceName = bindings.INTERNAL_WORKSPACE_NAME || "Notique Internal";
  const timestamp = new Date().toISOString();
  await getD1()
    .prepare(
      `INSERT INTO workspaces (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(scope.workspaceId, workspaceName, timestamp, timestamp)
    .run();
}
