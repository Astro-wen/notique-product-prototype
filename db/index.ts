import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type RuntimeBindings = {
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
  AUTH_GATEWAY?: "chatgpt" | "cloudflare-access";
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
};

export function getBindings(): RuntimeBindings {
  return env as unknown as RuntimeBindings;
}

export function getD1(): D1Database {
  const bindings = getBindings();
  if (!bindings.DB) {
    throw new Error("DATABASE_UNAVAILABLE: Cloudflare D1 binding `DB` is unavailable.");
  }
  return bindings.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

export function getEvidenceBucket(): R2Bucket {
  const bucket = getBindings().EVIDENCE;
  if (!bucket) {
    throw new Error(
      "R2_BINDING_UNAVAILABLE: Cloudflare R2 binding `EVIDENCE` is unavailable.",
    );
  }
  return bucket;
}
