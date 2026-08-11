import type {
  ApiErrorCode,
  ApiErrorResponse,
  ApiSuccess,
} from "@/lib/shared/api-types";

export class ApiFault extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function requestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();
}

function responseHeaders(id: string): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-request-id": id,
  };
}

export function ok<T>(data: T, id: string, status = 200): Response {
  const body: ApiSuccess<T> = { data, request_id: id };
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(id),
  });
}

export function fail(fault: ApiFault, id: string): Response {
  const body: ApiErrorResponse = {
    error: {
      code: fault.code,
      message: fault.message,
      ...(fault.details ? { details: fault.details } : {}),
    },
    request_id: id,
  };
  return new Response(JSON.stringify(body), {
    status: fault.status,
    headers: responseHeaders(id),
  });
}

export function toResponse(error: unknown, id: string): Response {
  if (error instanceof ApiFault) return fail(error, id);

  const message = error instanceof Error ? error.message : "Unexpected error";
  if (message.includes("DATABASE_UNAVAILABLE")) {
    return fail(
      new ApiFault(503, "DATABASE_UNAVAILABLE", "Database binding is unavailable."),
      id,
    );
  }
  if (message.includes("R2_BINDING_UNAVAILABLE")) {
    return fail(
      new ApiFault(503, "R2_BINDING_UNAVAILABLE", "Evidence storage is unavailable."),
      id,
    );
  }

  console.error("api_request_failed", { request_id: id, message });
  return fail(
    new ApiFault(500, "INTERNAL_ERROR", "The request could not be completed."),
    id,
  );
}

export async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  const maxBytes = 1024 * 1024;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new ApiFault(400, "BAD_REQUEST", "Content-Length is invalid.");
    }
    if (parsedLength > maxBytes) {
      throw new ApiFault(413, "BAD_REQUEST", "JSON request body exceeds the 1 MB limit.");
    }
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiFault(413, "BAD_REQUEST", "JSON request body exceeds the 1 MB limit.");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiFault(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiFault(400, "BAD_REQUEST", "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string {
  if (typeof value !== "string") {
    throw new ApiFault(400, "BAD_REQUEST", `${field} must be a string.`, { field });
  }
  const result = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  if (result.length < min || result.length > max) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} has an invalid length.`, {
      field,
      min,
      max,
    });
  }
  return result;
}

export function optionalString(
  value: unknown,
  field: string,
  options: { max?: number } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, { min: 0, max: options.max ?? 500 });
}

export function enumValue<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} has an unsupported value.`, {
      field,
      allowed,
    });
  }
  return value as T;
}

export function isoDate(value: unknown, field: string): string {
  const text = requiredString(value, field, { max: 64 });
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} must be an ISO date.`, { field });
  }
  return new Date(timestamp).toISOString();
}

export function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} must be a non-negative integer.`, {
      field,
    });
  }
  return value as number;
}

export function stringArray(
  value: unknown,
  field: string,
  options: { min?: number; max?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} must be an array.`, { field });
  }
  const min = options.min ?? 0;
  const max = options.max ?? 100;
  if (value.length < min || value.length > max) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} has an invalid item count.`, {
      field,
      min,
      max,
    });
  }
  return value.map((item, index) =>
    requiredString(item, `${field}[${index}]`, { max: 128 }),
  );
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
