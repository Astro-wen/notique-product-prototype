CREATE TABLE mcp_request_limits (
  key TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE INDEX idx_mcp_request_limits_bucket ON mcp_request_limits(bucket_start);
