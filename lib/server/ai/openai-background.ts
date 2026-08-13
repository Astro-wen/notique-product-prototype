export type OpenAiBackgroundStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

export type OpenAiBackgroundResponseBody = {
  id?: string;
  status?: unknown;
  [key: string]: unknown;
};

export class OpenAiBackgroundPending extends Error {
  readonly responseId: string;
  readonly responseStatus: "queued" | "in_progress";

  constructor(responseId: string, responseStatus: "queued" | "in_progress") {
    super(`OpenAI background Response is ${responseStatus}.`);
    this.name = "OpenAiBackgroundPending";
    this.responseId = responseId;
    this.responseStatus = responseStatus;
  }
}

export class OpenAiBackgroundRequestFailed extends Error {
  readonly httpStatus: number | null;
  readonly responseId: string | null;
  readonly responseStatus: string | null;

  constructor(input: {
    message: string;
    httpStatus?: number | null;
    responseId?: string | null;
    responseStatus?: string | null;
  }) {
    super(input.message);
    this.name = "OpenAiBackgroundRequestFailed";
    this.httpStatus = input.httpStatus ?? null;
    this.responseId = input.responseId ?? null;
    this.responseStatus = input.responseStatus ?? null;
  }
}

/**
 * Execute one short Responses API interaction. This function deliberately
 * never loops: a Worker invocation creates or retrieves once, persists the
 * ID through onResponse, and lets the durable job runner schedule the next
 * GET when OpenAI is still queued/in_progress.
 */
export async function requestOpenAiBackgroundResponse(input: {
  apiKey: string;
  baseUrl: string;
  requestBody: Record<string, unknown>;
  idempotencyKey?: string;
  resumeResponseId?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onResponse?: (response: { id: string; status: string }) => Promise<void>;
}): Promise<{
  body: OpenAiBackgroundResponseBody;
  response: Response;
}> {
  const fetcher = input.fetcher ?? fetch;
  const responseId = input.resumeResponseId?.trim() || null;
  const response = await fetcher(
    responseId
      ? `${input.baseUrl}/responses/${encodeURIComponent(responseId)}`
      : `${input.baseUrl}/responses`,
    {
      method: responseId ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
        ...(!responseId && input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {}),
      },
      ...(!responseId
        ? { body: JSON.stringify({ ...input.requestBody, background: true }) }
        : {}),
      signal: input.signal,
    },
  );
  if (!response.ok) {
    throw new OpenAiBackgroundRequestFailed({
      message: `OpenAI Responses API returned HTTP ${response.status}.`,
      httpStatus: response.status,
      responseId,
    });
  }
  const body = await response.json() as OpenAiBackgroundResponseBody;
  if (typeof body.id !== "string" || !body.id.trim()) {
    throw new OpenAiBackgroundRequestFailed({
      message: "OpenAI Responses API did not return a durable Response ID.",
      httpStatus: 502,
    });
  }
  const status = typeof body.status === "string" ? body.status : "unknown";
  try {
    await input.onResponse?.({ id: body.id, status });
  } catch {
    // Replaying the same POST with the same idempotency key is safer than
    // losing the Response ID and creating a new stage attempt. The provider
    // adapter treats this null-status failure as transient.
    throw new OpenAiBackgroundRequestFailed({
      message: "OpenAI Response ID could not be persisted for durable resume.",
      httpStatus: null,
      responseId: body.id,
      responseStatus: status,
    });
  }
  if (status === "queued" || status === "in_progress") {
    throw new OpenAiBackgroundPending(body.id, status);
  }
  if (status === "failed" || status === "cancelled") {
    throw new OpenAiBackgroundRequestFailed({
      message: `OpenAI background Response reached terminal status ${status}.`,
      httpStatus: 422,
      responseId: body.id,
      responseStatus: status,
    });
  }
  if (status !== "completed" && status !== "incomplete") {
    throw new OpenAiBackgroundRequestFailed({
      message: `OpenAI background Response returned unknown status ${status}.`,
      httpStatus: 502,
      responseId: body.id,
      responseStatus: status,
    });
  }
  return { body, response };
}
