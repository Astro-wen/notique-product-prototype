import {digestValue} from '../workflow/snapshot-store.ts';
import type {McpIdentity} from './access.ts';

export class McpLimitFault extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Shared D1 counters apply across worker instances, independently of model work. */
export async function reserveMcpRequest(db: D1Database, identity: McpIdentity, now = Date.now()) {
  const bucket = Math.floor(now / 60_000);
  const key = await digestValue(['mcp-rate', identity.workspaceId, identity.actorId, bucket]);
  const results = await db.batch([
    db.prepare('DELETE FROM mcp_request_limits WHERE bucket_start < ?').bind(bucket - 2),
    db.prepare(`INSERT INTO mcp_request_limits(key, workspace_id, bucket_start, request_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET request_count = request_count + 1
      WHERE request_count < 60 RETURNING request_count`).bind(key, identity.workspaceId, bucket),
  ]);
  if (!results[1]?.results?.length) {
    throw new McpLimitFault(429, 'RATE_LIMITED', '读取较频繁，请稍后继续。', 60 - Math.floor(now / 1000) % 60);
  }
}

/** The caller aborts the SDK transport when this bounded read expires. */
export async function withMcpDeadline<T>(work: Promise<T>, onTimeout: () => void, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new McpLimitFault(504, 'READ_TIMEOUT', '读取超时，请减少每页数量后重试。'));
          onTimeout();
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
