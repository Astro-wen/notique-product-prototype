import { ApiFault } from "@/lib/server/http/api";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function safe(value: string, field: string): string {
  if (!SAFE_ID.test(value)) {
    throw new ApiFault(400, "BAD_REQUEST", `${field} contains invalid characters.`, {
      field,
    });
  }
  return value;
}

export function assetObjectKey(input: {
  workspaceId: string;
  projectId: string;
  eventId: string;
  assetId: string;
  sha256: string;
}): string {
  const sha = input.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new ApiFault(400, "BAD_REQUEST", "content_sha256 must be a SHA-256 hex value.");
  }
  return [
    "workspaces",
    safe(input.workspaceId, "workspace_id"),
    "projects",
    safe(input.projectId, "project_id"),
    "events",
    safe(input.eventId, "event_id"),
    "assets",
    safe(input.assetId, "asset_id"),
    "versions",
    sha,
    "original",
  ].join("/");
}

export function importObjectKey(input: {
  workspaceId: string;
  projectId: string;
  importId: string;
  itemId: string;
  sha256: string;
}): string {
  const sha = input.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new ApiFault(400, "BAD_REQUEST", "content_sha256 must be a SHA-256 hex value.");
  }
  return [
    "workspaces",
    safe(input.workspaceId, "workspace_id"),
    "projects",
    safe(input.projectId, "project_id"),
    "transcript-imports",
    safe(input.importId, "import_id"),
    safe(input.itemId, "item_id"),
    sha,
  ].join("/");
}

export function transcriptionResultObjectKey(input: {
  workspaceId: string;
  projectId: string;
  eventId: string;
  runId: string;
  sha256: string;
}): string {
  const sha = input.sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new ApiFault(400, "BAD_REQUEST", "content_sha256 must be a SHA-256 hex value.");
  }
  return [
    "workspaces",
    safe(input.workspaceId, "workspace_id"),
    "projects",
    safe(input.projectId, "project_id"),
    "events",
    safe(input.eventId, "event_id"),
    "transcription-runs",
    safe(input.runId, "run_id"),
    sha,
    "diarized-transcript.json",
  ].join("/");
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
