import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';

export async function workflowDatabase({ through = 26 } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../../drizzle/',import.meta.url);
  const files = (await readdir(dir)).filter(f => /^\d+_.+\.sql$/.test(f) && Number(f.slice(0,4)) <= through).sort();
  for (const file of files) sqlite.exec((await readFile(new URL(file,dir),'utf8')).replaceAll('--> statement-breakpoint',''));
  const prepare = (sql,values=[]) => ({
    bind(...v) { return prepare(sql,v); },
    async first(column) { const row = sqlite.prepare(sql).get(...values) ?? null; return column && row ? row[column] : row; },
    async all() { return {success:true,results:sqlite.prepare(sql).all(...values)}; },
    async run() { const r=sqlite.prepare(sql).run(...values); return {success:true,meta:{changes:r.changes}}; },
    sql, values,
  });
  const db = { prepare, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = statements.map(s=>({success:true,results:sqlite.prepare(s.sql).all(...s.values)})); sqlite.exec('COMMIT'); return result; }
    catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  }};
  return {sqlite,db,close:()=>sqlite.close()};
}
export const T = '2026-09-28T10:00:00.000Z';
export const SCOPE = {workspaceId:'ws',actorId:'owner',access:'members'};
export function insert(db,table,values) {
  const keys=Object.keys(values); db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(values));
}
export function seed(db,{legacy=false}={}) {
  insert(db,'workspaces',{id:'ws',name:'Test'});
  if(!legacy) insert(db,'workspace_members',{id:'wm',workspace_id:'ws',actor_id:'owner',role:'owner'});
  insert(db,'projects',{id:'p',workspace_id:'ws',name:'Synthetic project'});
  insert(db,'events',{id:'e',workspace_id:'ws',project_id:'p',event_type:'meeting',title:'Synthetic record',occurred_at:T,sequence_no:1,active_run_id:'run'});
  insert(db,'assets',{id:'asset',workspace_id:'ws',project_id:'p',event_id:'e',kind:'text',filename:'synthetic.txt',current_version_id:'av',processing_status:'ready'});
  insert(db,'asset_versions',{id:'av',asset_id:'asset',version_no:1,content_sha256:'synthetic',mime_type:'text/plain',size_bytes:30,r2_original_key:'synthetic/source',finalized_at:T});
  insert(db,'text_segments',{id:'seg',workspace_id:'ws',project_id:'p',event_id:'e',asset_id:'asset',asset_version_id:'av',ordinal:0,parser_version:'test',text_raw:'预算大约三十万。费用待定。请询价。',text_normalized:'预算大约三十万。费用待定。请询价。'});
  insert(db,'extraction_runs',{id:'run',workspace_id:'ws',project_id:'p',event_id:'e',status:'succeeded',idempotency_key:'seed',input_hash:'seed',input_snapshot_hash:'seed',input_manifest_json:JSON.stringify([{asset_version_id:'av'}]),context_version:0,context_snapshot_hash:'seed',prompt_version:'seed',schema_version:'seed',parser_version:'seed'});
  claim(db,'budget','budget','预算大约三十万');
  claim(db,'question','open_question','费用是多少？');
  claim(db,'action','next_action','向供应商询价');
  relation(db,'basis','action','question','informed_by','proposed');
}
export function claim(db,id,type,text,{status='pending',origin=null}={}) {
  insert(db,'claims',{id,workspace_id:'ws',project_id:'p',event_id:'e',extraction_run_id:'run',client_claim_key:id,type,materiality:'high',review_status:status,current_version_id:`${id}_v1`,first_event_id:'e',created_at:T,updated_at:T});
  insert(db,'claim_versions',{id:`${id}_v1`,claim_id:id,version_no:1,statement:text,source:'ai',...(origin?{workflow_origin:origin}:{})});
  insert(db,'evidence_refs',{id:`${id}_ev`,workspace_id:'ws',project_id:'p',event_id:'e',claim_version_id:`${id}_v1`,kind:'text',asset_version_id:'av',segment_ids_json:'["seg"]',quote_raw:text,evidence_role:'direct',provenance_grade:'primary',structural_validation_status:'valid',semantic_support_verdict:'fully_supports'});
}
export function relation(db,id,source,target,type,status='active') {
  insert(db,'claim_relations',{id,workspace_id:'ws',project_id:'p',type,source_claim_version_id:`${source}_v1`,target_claim_version_id:`${target}_v1`,context_version:0,status});
}
