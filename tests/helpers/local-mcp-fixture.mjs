import {DatabaseSync} from 'node:sqlite';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {digestValue} from '../../lib/server/workflow/snapshot-store.ts';

/** Local-only gateway identities belong to this test and are removed afterward. */
export function localMcpFixture(workspaceId) {
  const root=join(process.cwd(),'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  let db;
  for(const file of readdirSync(root).filter(name=>name.endsWith('.sqlite'))){
    const candidate=new DatabaseSync(join(root,file));
    if(candidate.prepare("SELECT 1 FROM sqlite_master WHERE name='mcp_request_limits'").get() && candidate.prepare('SELECT 1 FROM workspaces WHERE id=?').get(workspaceId)){db=candidate;break;}
    candidate.close();
  }
  if(!db)throw new Error('Migrated local MCP database not found');
  const id='w2qa_mcp_'+crypto.randomUUID().replaceAll('-','');
  const email=id+'@example.test',subject=id+'_subject',startBucket=Math.floor(Date.now()/60000);
  db.prepare("INSERT INTO workspace_members(id,workspace_id,actor_id,role) VALUES (?,?,?,'viewer')").run(id,workspaceId,email);
  return {
    headers:{'oai-authenticated-user-email':email,'oai-authenticated-user-id':subject},email,
    revokeMembership(){db.prepare('UPDATE workspace_members SET revoked_at=? WHERE id=?').run(new Date().toISOString(),id);},
    async cleanup(){
      const keys=[];
      for(let bucket=startBucket-1;bucket<=Math.floor(Date.now()/60000)+1;bucket++)keys.push(await digestValue(['mcp-rate',workspaceId,email,bucket]));
      db.exec('PRAGMA busy_timeout=5000; BEGIN');
      try{
        for(const key of keys)db.prepare('DELETE FROM mcp_request_limits WHERE key=? AND workspace_id=?').run(key,workspaceId);
        db.prepare('DELETE FROM access_grants WHERE workspace_id=? AND actor_id=?').run(workspaceId,email);
        db.prepare('DELETE FROM workspace_members WHERE id=? AND workspace_id=? AND actor_id=?').run(id,workspaceId,email);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      finally{db.close();}
    },
  };
}
