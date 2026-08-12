/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { sweepAndDispatch } from "@/lib/server/jobs/outbox";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EVIDENCE: R2Bucket;
  APP_ENV?: string;
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
        const authenticated = Boolean(
          request.headers.get("oai-authenticated-user-id") ||
          request.headers.get("oai-authenticated-user-email"),
        );
        if (!sameOrigin || !authenticated) {
          return dispatchError(401, "UNAUTHORIZED", "A signed-in same-origin request is required.", requestId);
        }
      }
      try {
        // A browser retry must also recover an expired lease. Sites cron is the
        // normal safety net, but a visible user action should never leave a
        // stale Run spinning until the next scheduled invocation.
        return dispatchResponse(await sweepAndDispatch(), requestId);
      } catch (error) {
        console.error("browser_dispatch_failed", {
          request_id: requestId,
          message: error instanceof Error ? error.message : "Unexpected error",
        });
        return dispatchError(500, "INTERNAL_ERROR", "The background task could not be started.", requestId);
      }
    }

    return handler.fetch(request, env, ctx);
  },
  scheduled(_controller: unknown, _env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(sweepAndDispatch());
  },
};

export default worker;
