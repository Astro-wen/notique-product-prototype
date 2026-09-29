import type {McpConnectionStatus} from '../../shared/workflow-v2.ts';
import {digestValue,WorkflowFault,type WorkflowScope} from '../workflow/snapshot-store.ts';
export type McpIdentity={workspaceId:string;actorId:string;gatewaySubject:string};
export type McpRuntime={APP_ENV?:string;AUTH_GATEWAY?:string;INTERNAL_WORKSPACE_ID?:string;MCP_ALLOWED_HOSTS?:string};
export class McpAccessFault extends Error {status:number;constructor(status:number,message:string){super(message);this.status=status;}}
/** Sites strips caller identity headers and injects verified OAuth identity.
 * Anonymous demo and service credentials never substitute for a connected user. */
export function mcpIdentity(request:Request,env:McpRuntime):McpIdentity {
 const email=request.headers.get('oai-authenticated-user-email')?.trim();
 const subject=request.headers.get('oai-authenticated-user-id')?.trim();
 if(!email || !subject || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || subject.length>256 || email.length>320)throw new McpAccessFault(401,'请先通过Site登录并连接自己的AI助手。');
 return {workspaceId:env.INTERNAL_WORKSPACE_ID || 'ws_internal',actorId:email,gatewaySubject:subject};
}
const connectionHash=(i:McpIdentity)=>digestValue(['sites-mcp',i.workspaceId,i.actorId,i.gatewaySubject]);
export async function mcpConnectionStatus(db:D1Database,identity:McpIdentity,now=new Date().toISOString()):Promise<McpConnectionStatus> {
 const hash=await connectionHash(identity);
 const row=await db.prepare(`SELECT g.id,g.expires_at,g.revoked_at,m.revoked_at AS member_revoked FROM access_grants g JOIN workspace_members m ON m.workspace_id=g.workspace_id AND m.actor_id=g.actor_id WHERE g.workspace_id=? AND g.actor_id=? AND g.token_hash=? AND g.scope='mcp:read'`).bind(identity.workspaceId,identity.actorId,hash).first<{id:string;expires_at:string;revoked_at:string|null;member_revoked:string|null}>();
 return {authenticated:true,enabled:Boolean(row && !row.revoked_at && !row.member_revoked && row.expires_at>now),scope:'mcp:read' as const,expiresAt:row?.expires_at ?? null,endpoint:'/mcp' as const,accountEmail:identity.actorId};
}
export async function assertMcpRead(db:D1Database,identity:McpIdentity,now=new Date().toISOString()):Promise<WorkflowScope> {
 if(!(await mcpConnectionStatus(db,identity,now)).enabled)throw new McpAccessFault(403,'请在AI助手连接页开启只读授权，或重新取得工作空间访问权限。');
 return {workspaceId:identity.workspaceId,actorId:identity.actorId,access:'members'};
}
export async function setMcpConnection(db:D1Database,identity:McpIdentity,env:McpRuntime,enabled:boolean,now=new Date().toISOString()) {
 const hash=await connectionHash(identity);
 if(!enabled){await db.prepare("UPDATE access_grants SET revoked_at=? WHERE workspace_id=? AND actor_id=? AND token_hash=? AND scope='mcp:read'").bind(now,identity.workspaceId,identity.actorId,hash).run();return mcpConnectionStatus(db,identity,now);}
 const member=await db.prepare('SELECT revoked_at FROM workspace_members WHERE workspace_id=? AND actor_id=?').bind(identity.workspaceId,identity.actorId).first<{revoked_at:string|null}>();
 if(member?.revoked_at || !member && env.AUTH_GATEWAY!=='public')throw new McpAccessFault(403,'请先取得这个工作空间的成员权限。');
 const statements:D1PreparedStatement[]=[];
 // An explicit public demo already permits anonymous reading. Opt-in creates
 // a viewer for the verified user; private workspaces require existing membership.
 if(!member)statements.push(db.prepare(`INSERT INTO workspace_members(id,workspace_id,actor_id,role,created_at,updated_at) SELECT ?,?,?,'viewer',?,? WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=?) ON CONFLICT(workspace_id,actor_id) DO NOTHING`).bind('wm_'+crypto.randomUUID(),identity.workspaceId,identity.actorId,now,now,identity.workspaceId));
 statements.push(db.prepare(`INSERT INTO access_grants(id,workspace_id,actor_id,token_hash,scope,expires_at,created_at) SELECT ?,?,?,?,'mcp:read',?,? WHERE EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=? AND actor_id=? AND revoked_at IS NULL) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at,revoked_at=NULL WHERE access_grants.workspace_id=excluded.workspace_id AND access_grants.actor_id=excluded.actor_id`).bind('ag_'+crypto.randomUUID(),identity.workspaceId,identity.actorId,hash,new Date(Date.parse(now)+30*86400_000).toISOString(),now,identity.workspaceId,identity.actorId));
 await db.batch(statements);const result=await mcpConnectionStatus(db,identity,now);
 if(!result.enabled)throw new WorkflowFault(403,'forbidden','工作空间权限已变化，请重新读取。');return result;
}
