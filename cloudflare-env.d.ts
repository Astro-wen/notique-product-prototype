interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  error?: string;
  meta: {
    changes?: number;
    duration?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
  };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1Result>;
}

interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

interface R2Object {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  blob(): Promise<Blob>;
}

interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
    options?: {
      httpMetadata?: R2HTTPMetadata;
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2Object>;
  delete(keys: string | string[]): Promise<void>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    EVIDENCE?: R2Bucket;
    AI_API_KEY?: string;
    AI_API_BASE_URL?: string;
    AI_MODEL?: string;
    AI_PROVIDER?: string;
    AI_REASONING_EFFORT?: string;
    AI_VERIFIER_REASONING_EFFORT?: string;
    AI_TWO_PASS_PIPELINE?: string;
    AI_EVENT_SUMMARY?: string;
    AI_READABLE_TRANSCRIPT?: string;
    AI_VERIFICATION_USES_READABLE?: string;
    AI_DRAFT_CONTEXT?: string;
    AI_TIMEOUT_MS?: string;
    AI_MAX_OUTPUT_TOKENS?: string;
    AI_TRANSCRIPTION_MODEL?: string;
    AI_TRANSCRIPTION_TIMEOUT_MS?: string;
    APP_ENV?: string;
    AUTH_GATEWAY?: "chatgpt" | "cloudflare-access" | "public";
    INTERNAL_JOB_TOKEN?: string;
    INTERNAL_WORKSPACE_ID?: string;
    INTERNAL_WORKSPACE_NAME?: string;
    MAX_RUN_INPUT_TOKENS?: string;
    MAX_RUN_IMAGE_UNITS?: string;
    MAX_RUN_IMAGE_BYTES?: string;
    MAX_CONCURRENT_RUNS_PER_WORKSPACE?: string;
    MAX_DAILY_EVAL_COST_USD?: string;
    MAX_DAILY_MODEL_TOKENS?: string;
    MAX_AUDIO_BYTES?: string;
    [key: string]: unknown;
  }
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
