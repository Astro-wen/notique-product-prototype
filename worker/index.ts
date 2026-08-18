/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  dispatchDueOutbox,
  dispatchExtractionRun,
  sweepAndDispatch,
} from "@/lib/server/jobs/outbox";
import {
  dispatchTranscriptionRun,
  wakeTranscriptionRun,
} from "@/lib/server/jobs/transcription-outbox";
import {
  dispatchEventAiArtifactRun,
  dispatchEventAiArtifactsForExtraction,
  sweepAndDispatchEventAiArtifacts,
} from "@/lib/server/jobs/event-ai-artifacts";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EVIDENCE: R2Bucket;
  APP_ENV?: string;
  AUTH_GATEWAY?: "chatgpt" | "cloudflare-access" | "public";
  INTERNAL_WORKSPACE_ID?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

function dispatchResponse(data: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify({ data, request_id: requestId }), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

function dispatchError(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return new Response(JSON.stringify({ error: { code, message }, request_id: requestId }), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
    },
  });
}

type DispatchKind = "extraction" | "transcription" | "artifact";

async function dispatchInput(
  request: Request,
): Promise<{ kind: DispatchKind; runId: string } | null> {
  const text = await request.text();
  if (!text.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BAD_REQUEST");
  }
  const body = value as Record<string, unknown>;
  if (
    (body.kind !== "extraction" && body.kind !== "transcription" && body.kind !== "artifact") ||
    typeof body.run_id !== "string" ||
    !body.run_id.trim() ||
    body.run_id.length > 128
  ) {
    throw new Error("BAD_REQUEST");
  }
  return { kind: body.kind, runId: body.run_id.trim() };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || crypto.randomUUID();

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname === "/api/v1/jobs/dispatch") {
      if (request.method !== "POST") {
        return dispatchError(405, "METHOD_NOT_ALLOWED", "HTTP method is not supported.", requestId);
      }
      if (env.APP_ENV !== "local") {
        const origin = request.headers.get("origin");
        const sameOrigin = origin === url.origin && request.headers.get("sec-fetch-site") === "same-origin";
        const authenticated = env.AUTH_GATEWAY === "public"
          ? true
          : env.AUTH_GATEWAY === "cloudflare-access"
          ? Boolean(
              request.headers.get("cf-access-jwt-assertion") &&
              request.headers.get("cf-access-authenticated-user-email"),
            )
          : Boolean(
              request.headers.get("oai-authenticated-user-id") ||
              request.headers.get("oai-authenticated-user-email"),
            );
        if (!sameOrigin || !authenticated) {
          return dispatchError(401, "UNAUTHORIZED", "A same-origin browser request is required.", requestId);
        }
      }
      try {
        const input = await dispatchInput(request);
        if (!input) {
          // Compatibility for older clients. New callers always provide a
          // target so one user's click cannot be delayed by an unrelated job.
          // Only Responses background polling is safe in an HTTP waitUntil;
          // long audio transcription is owned by the one-minute Cron trigger.
          ctx.waitUntil(dispatchDueOutbox());
          return dispatchResponse({ accepted: true, kind: "all" }, requestId, 202);
        }
        const workspaceId = env.INTERNAL_WORKSPACE_ID || "ws_internal";
        const table = input.kind === "extraction"
          ? "extraction_runs"
          : input.kind === "transcription"
            ? "transcription_runs"
            : "event_ai_artifact_runs";
        const run = await env.DB
          .prepare(`SELECT status FROM ${table} WHERE id = ? AND workspace_id = ?`)
          .bind(input.runId, workspaceId)
          .first<{ status: string }>();
        if (!run) {
          return dispatchError(404, "PROJECT_SCOPE_VIOLATION", "Run was not found.", requestId);
        }
        if (input.kind === "extraction") {
          ctx.waitUntil(Promise.all([
            dispatchExtractionRun(workspaceId, input.runId),
            dispatchEventAiArtifactsForExtraction(workspaceId, input.runId),
          ]).catch((error) => {
            console.error("targeted_dispatch_failed", {
              request_id: requestId,
              kind: input.kind,
              run_id: input.runId,
              message: error instanceof Error ? error.message : "Unexpected error",
            });
          }));
        } else if (input.kind === "artifact") {
          ctx.waitUntil(dispatchEventAiArtifactRun(workspaceId, input.runId).catch((error) => {
            console.error("targeted_dispatch_failed", {
              request_id: requestId,
              kind: input.kind,
              run_id: input.runId,
              message: error instanceof Error ? error.message : "Unexpected error",
            });
          }));
        } else if (env.APP_ENV === "local") {
          // Local development has no Cron trigger and no 30-second HTTP
          // waitUntil cutoff, so keep the immediate smoke-test experience.
          ctx.waitUntil(dispatchTranscriptionRun(workspaceId, input.runId).catch((error) => {
            console.error("targeted_dispatch_failed", {
              request_id: requestId,
              kind: input.kind,
              run_id: input.runId,
              message: error instanceof Error ? error.message : "Unexpected error",
            });
          }));
        } else {
          // The audio endpoint has no OpenAI Background Response ID. Keep its
          // durable outbox due and let the every-minute scheduled invocation,
          // which has a 15-minute wall-time budget, perform the provider call.
          await wakeTranscriptionRun(workspaceId, input.runId);
        }
        return dispatchResponse({
          accepted: true,
          kind: input.kind,
          run_id: input.runId,
          run_status: run.status,
        }, requestId, 202);
      } catch (error) {
        if (error instanceof Error && error.message === "INVALID_JSON") {
          return dispatchError(400, "INVALID_JSON", "Request body must be valid JSON.", requestId);
        }
        if (error instanceof Error && error.message === "BAD_REQUEST") {
          return dispatchError(
            400,
            "BAD_REQUEST",
            "kind and run_id must identify an extraction, transcription, or AI artifact Run.",
            requestId,
          );
        }
        console.error("browser_dispatch_failed", {
          request_id: requestId,
          message: error instanceof Error ? error.message : "Unexpected error",
        });
        return dispatchError(500, "INTERNAL_ERROR", "The background task could not be accepted.", requestId);
      }
    }

    return handler.fetch(request, env, ctx);
  },
  scheduled(_controller: unknown, _env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(Promise.all([sweepAndDispatch(), sweepAndDispatchEventAiArtifacts()]));
  },
};

export default worker;
