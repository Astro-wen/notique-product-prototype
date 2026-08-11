import { getD1 } from "@/db";
import { ApiFault, parseJson } from "@/lib/server/http/api";
import type { RequestScope } from "@/lib/server/http/context";

type ReplayRow = {
  request_hash: string;
  response_json: string;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

async function requestHash(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stableValue(payload)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export type MutationReplay<T> = {
  requestHash: string;
  response: T | null;
};

export async function findMutationReplay<T>(
  scope: RequestScope,
  endpointScope: string,
  idempotencyKey: string,
  requestPayload: unknown,
): Promise<MutationReplay<T>> {
  const hash = await requestHash(requestPayload);
  const row = await getD1()
    .prepare(
      `SELECT request_hash, response_json
         FROM mutation_replays
        WHERE workspace_id = ? AND actor_id = ?
          AND endpoint_scope = ? AND idempotency_key = ?`,
    )
    .bind(scope.workspaceId, scope.actorId, endpointScope, idempotencyKey)
    .first<ReplayRow>();
  if (!row) return { requestHash: hash, response: null };
  if (row.request_hash !== hash) {
    throw new ApiFault(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used with a different request.",
    );
  }
  return {
    requestHash: hash,
    response: parseJson<T>(row.response_json, null as T),
  };
}

export function mutationReplayStatement(
  scope: RequestScope,
  endpointScope: string,
  idempotencyKey: string,
  hash: string,
  response: unknown,
  timestamp: string,
): D1PreparedStatement {
  return getD1()
    .prepare(
      `INSERT INTO mutation_replays (
         id, workspace_id, actor_id, endpoint_scope, idempotency_key,
         request_hash, response_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `mrep_${crypto.randomUUID().replaceAll("-", "")}`,
      scope.workspaceId,
      scope.actorId,
      endpointScope,
      idempotencyKey,
      hash,
      JSON.stringify(response),
      timestamp,
    );
}
