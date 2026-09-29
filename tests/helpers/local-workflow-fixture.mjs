import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { workflowDatabase, seed, relation, claim, insert, T } from './workflow-database.mjs';
import {seedReaffirmedRecord} from './reaffirmed-fixture.mjs';

/** Local integration tests add their own named project to the development DB.
 * Existing projects are never rewritten. Call cleanup for exactly this ID. */
export async function createLocalWorkflowFixture(workspaceId,{withBudgetBasis=false,withConflict=false,withComposite=false,withActionConflict=false,withActionOverlap=false,withFactAnswer=false,withSameIntent=false,withReaffirmed=/** @type {false|'pending'|'confirmed'} */ (false),withIntentConflict=/** @type {false|'record'|'action'} */ (false),priorityCount=0}={}) {
  const root=join(process.cwd(),'.wrangler/state/v3/d1/miniflare-D1DatabaseObject');
  let local;
  for(const filename of readdirSync(root).filter(name=>name.endsWith('.sqlite'))) {
    const candidate=new DatabaseSync(join(root,filename));
    const exists=candidate.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_outcomes'").get();
    if(exists && candidate.prepare('SELECT 1 FROM workspaces WHERE id=?').get(workspaceId)) {local=candidate;break;}
    candidate.close();
  }
  if(!local) throw new Error('Migrated local workspace database was not found');
  const fixture=await workflowDatabase();seed(fixture.sqlite);
  if(withReaffirmed) {fixture.sqlite.prepare("UPDATE claims SET review_status='verified'").run();seedReaffirmedRecord(fixture.sqlite,{targets:withReaffirmed==='confirmed'?['budget','action','question']:['budget'],confirmed:withReaffirmed==='confirmed'});}
  if(withBudgetBasis) relation(fixture.sqlite,'budget-basis','action','budget','informed_by','proposed');
  if(withFactAnswer) {fixture.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();relation(fixture.sqlite,'fact-answer','budget','question','resolves','active');}
  if(withConflict) {fixture.sqlite.prepare("UPDATE claims SET review_status='verified' WHERE id='budget'").run();claim(fixture.sqlite,'new-budget','budget','预算更新为三十五万');relation(fixture.sqlite,'budget-conflict','new-budget','budget','contradicts','proposed');}
  if(withActionConflict) {claim(fixture.sqlite,'new-action','next_action','向厂家确认交期');relation(fixture.sqlite,'new-action-basis','new-action','question','informed_by','proposed');relation(fixture.sqlite,'action-conflict','new-action','action','supersedes','proposed');}
  if(withSameIntent) {
    claim(fixture.sqlite,'agreement','decision','约定向供应商询价');relation(fixture.sqlite,'agreement-basis','action','agreement','informed_by','proposed');
    insert(fixture.sqlite,'workflow_cards',{id:'intent',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'same_intent:agreement',revision:1,kind:'action',title:'向供应商询价',needs_decision:1,reason_code:'action_choice',reason:'决定是否加入跟进',disposition:'active',created_at:T,updated_at:T});
    for(const id of ['agreement','action'])insert(fixture.sqlite,'card_members',{id:`intent_${id}`,workspace_id:'ws',card_id:'intent',claim_id:id,claim_version_id:`${id}_v1`,role:id==='action'?'primary':'context',created_at:T});
    if(withIntentConflict) {claim(fixture.sqlite,'old-intent',withIntentConflict==='action'?'next_action':'decision','原来的询价安排',{status:'verified'});relation(fixture.sqlite,'intent-conflict',withIntentConflict==='action'?'action':'agreement','old-intent','contradicts','proposed');}
  }
  if(withActionOverlap) {
    claim(fixture.sqlite,'manual-action','next_action','向供应商询价并确认报价',{origin:'user_input'});
    fixture.sqlite.prepare("UPDATE claims SET source='human',created_at='2026-09-28T09:00:00.000Z' WHERE id='manual-action'").run();
    fixture.sqlite.prepare("UPDATE claim_versions SET source='human' WHERE id='manual-action_v1'").run();
    const groupKey='action_overlap:'+encodeURIComponent(JSON.stringify({v:1,runId:'run',clientClaimKey:'action',manualRef:{claimId:'manual-action',claimVersionId:'manual-action_v1'},modelRef:{claimId:'action',claimVersionId:'action_v1'}}));
    insert(fixture.sqlite,'workflow_cards',{id:'action-overlap',workspace_id:'ws',project_id:'p',event_id:'e',group_key:groupKey,revision:1,kind:'action',title:'向供应商询价并确认报价',needs_decision:1,reason_code:'action_choice',reason:'你的补充与 AI 建议指向同一行动，请选择要跟进的内容',disposition:'active',created_at:T,updated_at:T});
    for(const id of ['manual-action','action'])insert(fixture.sqlite,'card_members',{id:`overlap_${id}`,workspace_id:'ws',card_id:'action-overlap',claim_id:id,claim_version_id:`${id}_v1`,role:id==='manual-action'?'primary':'context',created_at:T});
  }
  if(withComposite) {
    claim(fixture.sqlite,'time','time','周末确认时间');claim(fixture.sqlite,'place','fact','在门店讨论');claim(fixture.sqlite,'remaining','fact','材料品牌待讨论');
    insert(fixture.sqlite,'workflow_cards',{id:'group',workspace_id:'ws',project_id:'p',event_id:'e',group_key:'group',revision:1,kind:'record',title:'装修安排',needs_decision:0,reason:'',disposition:'active',created_at:T,updated_at:T});
    for(const id of ['budget','time','place','remaining']) insert(fixture.sqlite,'card_members',{id:`group_${id}`,workspace_id:'ws',card_id:'group',claim_id:id,claim_version_id:`${id}_v1`,role:'primary',created_at:T});
  }
  for(let i=0;i<priorityCount;i++) claim(fixture.sqlite,`priority-${i}`,'next_action',`核实第${i+1}项安排`,{origin:'source_statement'});
  const tables=['projects','events','assets','asset_versions','text_segments','extraction_runs','claims','claim_versions','evidence_refs','claim_relations','workflow_cards','card_members','claim_occurrence_candidates','occurrence_verdicts','claim_occurrences'];
  const rows=Object.fromEntries(tables.map(table=>[table,fixture.sqlite.prepare(`SELECT * FROM ${table}`).all()]));
  const prefix='w2qa_'+crypto.randomUUID().replaceAll('-','');
  const ids=new Map([['ws',workspaceId],...Object.values(rows).flat().map(row=>[row.id,`${prefix}_${row.id}`])]);
  const rewrite=value=>{
    if(typeof value!=='string') return value;
    if(ids.has(value)) return ids.get(value);
    if(value.startsWith('action_overlap:'))return 'action_overlap:'+encodeURIComponent(rewrite(decodeURIComponent(value.slice('action_overlap:'.length))));
    try {
      const parsed=JSON.parse(value);
      if(typeof parsed!=='object'||parsed===null) return value;
      const semanticKeys=new Set(['type','kind','schema_version','status','statement','quoteRaw','observation']);
      const walk=(v,key)=>{if(typeof v==='string'){if(semanticKeys.has(key))return v;if(ids.has(v))return ids.get(v);try{const nested=JSON.parse(v);if(nested && typeof nested==='object')return JSON.stringify(walk(nested));}catch{}return v;}return Array.isArray(v)?v.map(x=>walk(x)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x,k)])):v;};
      return JSON.stringify(walk(parsed));
    } catch {return value;}
  };
  local.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN');
  try {
    for(const table of tables) for(const row of rows[table]) {
      const mapped=Object.fromEntries(Object.entries(row).map(([key,value])=>[key,key==='id' || key.endsWith('_id') || key.endsWith('_json') || key==='group_key'?rewrite(value):value]));
      if(table==='projects') mapped.name='[SYNTHETIC] 工作流实际操作验收';
      if(table==='asset_versions') mapped.r2_original_key=`synthetic/${prefix}/${row.id}/source`;
      if(table==='extraction_runs') {mapped.idempotency_key=prefix; mapped.input_hash=prefix; mapped.input_snapshot_hash=prefix;}
      if(table==='events') {mapped.title='预算与供应商报价';mapped.material_status='ready';}
      const keys=Object.keys(mapped);
      local.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(mapped));
    }
    // Only this isolated fixture suppresses paid model work. Production jobs
    // and the user's existing projects keep their normal runtime behavior.
    local.exec(`CREATE TRIGGER ${prefix}_no_paid_models AFTER INSERT ON workflow_outbox WHEN NEW.project_id='${ids.get('p')}' AND NEW.kind<>'initial_analysis' BEGIN UPDATE workflow_outbox SET state='cancelled',error_code='QA_MODEL_DISABLED' WHERE id=NEW.id; END`);
    for(const operation of ['INSERT','UPDATE OF status']) {
      const suffix=operation.startsWith('INSERT')?'insert':'update';
      local.exec(`CREATE TRIGGER ${prefix}_no_extraction_${suffix} AFTER ${operation} ON queue_outbox WHEN NEW.status<>'cancelled' AND EXISTS (SELECT 1 FROM extraction_runs r WHERE r.id=NEW.run_id AND r.project_id='${ids.get('p')}') BEGIN UPDATE queue_outbox SET status='cancelled',last_error_code='QA_MODEL_DISABLED' WHERE id=NEW.id; END`);
      local.exec(`CREATE TRIGGER ${prefix}_no_artifact_${suffix} AFTER ${operation} ON event_ai_artifact_runs WHEN NEW.status IN ('queued','processing') AND NEW.project_id='${ids.get('p')}' BEGIN UPDATE event_ai_artifact_runs SET status='failed',error_code='QA_MODEL_DISABLED' WHERE id=NEW.id; END`);
    }
    local.exec('COMMIT');
  } catch(error) {local.exec('ROLLBACK');local.close();fixture.close();throw error;}
  fixture.close();
  return {repeatEventId:ids.get('e2'),repeatBudgetId:ids.get('repeat-budget'),repeatActionId:ids.get('repeat-action'),repeatQuestionId:ids.get('repeat-question'),oldIntentMemberId:ids.get('old-intent'),intentCardId:ids.get('intent'),actionOverlapCardId:ids.get('action-overlap'),manualActionId:ids.get('manual-action'),agreementId:ids.get('agreement'),groupId:ids.get('group'),timeId:ids.get('time'),placeId:ids.get('place'),remainingId:ids.get('remaining'),projectId:ids.get('p'),eventId:ids.get('e'),budgetId:ids.get('budget'),questionId:ids.get('question'),actionId:ids.get('action'),newBudgetId:ids.get('new-budget'),newActionId:ids.get('new-action'),priorityIds:Array.from({length:priorityCount},(_,i)=>ids.get(`priority-${i}`)),
    seedReadingFailures(){
      for(const kind of ['chapters','speakers','key_points','overview']) {
        const runId=`${prefix}_${kind}`;
        local.prepare(`INSERT INTO event_ai_artifact_runs (id,workspace_id,project_id,event_id,extraction_run_id,kind,status,idempotency_key,input_hash,input_manifest_json,provider,model,reasoning_effort,prompt_version,schema_version,next_attempt_at,queued_at,error_code)
          VALUES (?,?,?,?,?,?,'failed',?,? ,?,'synthetic','synthetic','high','synthetic','synthetic',?,?,'QA_MODEL_DISABLED')`)
          .run(runId,workspaceId,ids.get('p'),ids.get('e'),ids.get('run'),kind,runId,runId,JSON.stringify([{asset_version_id:ids.get('av')}]),new Date().toISOString(),new Date().toISOString());
      }
    },
    replaceRepeatedSource(){local.prepare('UPDATE assets SET current_version_id=NULL WHERE id=?').run(ids.get('asset2'));local.prepare('DELETE FROM workflow_snapshots WHERE project_id=?').run(ids.get('p'));},
    analysisEvidence(){
      const projectId=ids.get('p');
      return {
        intents:local.prepare("SELECT id,state,input_revision,payload_json FROM workflow_outbox WHERE project_id=? AND kind='initial_analysis'").all(projectId),
        runs:local.prepare('SELECT id,status,model_params_json FROM extraction_runs WHERE project_id=? ORDER BY created_at,id').all(projectId),
        modelStages:local.prepare('SELECT count(*) n FROM extraction_model_stages WHERE run_id IN (SELECT id FROM extraction_runs WHERE project_id=?)').get(projectId).n,
        artifacts:local.prepare('SELECT count(*) n FROM event_ai_artifact_runs WHERE project_id=?').get(projectId).n,
      };
    },
    failAnalysis(){
      const runId=ids.get('run');
      local.prepare("UPDATE extraction_runs SET status='failed',error_code='MODEL_PROVIDER_REQUEST_FAILED',updated_at=? WHERE id=?").run(new Date().toISOString(),runId);
      local.prepare("INSERT INTO queue_outbox (id,run_id,payload_hash,payload_json,status,next_attempt_at) VALUES (?,?,'synthetic','{}','sent',?)").run(`${prefix}_outbox`,runId,new Date().toISOString());
      local.prepare('DELETE FROM workflow_snapshots WHERE project_id=?').run(ids.get('p'));
      return runId;
    },
    queueReplacement(){
      const runId=`${prefix}_replacement`;
      local.prepare(`INSERT INTO extraction_runs (id,workspace_id,project_id,event_id,status,idempotency_key,input_hash,input_snapshot_hash,input_manifest_json,context_version,context_snapshot_hash,prompt_version,schema_version,parser_version,created_at,updated_at) SELECT ?,workspace_id,project_id,event_id,'queued',?,'synthetic','synthetic',input_manifest_json,context_version,context_snapshot_hash,prompt_version,schema_version,parser_version,?,? FROM extraction_runs WHERE id=?`).run(runId,runId,new Date().toISOString(),new Date().toISOString(),ids.get('run'));
      local.prepare('UPDATE events SET active_run_id=? WHERE id=?').run(runId,ids.get('e'));
      local.prepare('DELETE FROM workflow_snapshots WHERE project_id=?').run(ids.get('p'));
      return runId;
    },
    finishReplacement(runId){
      local.prepare("UPDATE extraction_runs SET status='cancelled',updated_at=? WHERE id=? AND project_id=?").run(new Date().toISOString(),runId,ids.get('p'));
    },
    seedNarrative(){
      const projectId=ids.get('p'),eventId=ids.get('e');
      const context=local.prepare('SELECT context_version FROM projects WHERE id=?').get(projectId).context_version;
      const claims=local.prepare("SELECT c.id,c.current_version_id,c.review_status,v.statement FROM claims c JOIN claim_versions v ON v.id=c.current_version_id WHERE c.project_id=? AND c.review_status<>'rejected' AND c.lifecycle_status NOT IN ('withdrawn','superseded') ORDER BY c.id").all(projectId);
      const sentences=claims.map(c=>({text:c.statement,claimRefs:[{claimId:c.id,claimVersionId:c.current_version_id}],reviewState:c.review_status==='verified'?'accepted':'draft'}));
      local.prepare("INSERT INTO workflow_narratives (id,workspace_id,project_id,event_id,scope_key,scope_kind,based_on_context_version,text,sentence_refs_json,freshness,input_hash) VALUES (?,?,?,?,?,'mixed',?,?,?,'current','synthetic-ui-output')").run(`${prefix}_narrative_${context}`,workspaceId,projectId,eventId,eventId,context,sentences.map(s=>s.text).join(' '),JSON.stringify(sentences));
      local.prepare('DELETE FROM workflow_snapshots WHERE project_id=?').run(projectId);
    },
    cleanup(){
      const projectId=ids.get('p');
      local.exec('BEGIN');
      try {
        local.prepare('DELETE FROM relation_verdicts WHERE relation_id IN (SELECT id FROM claim_relations WHERE project_id=? AND workspace_id=?)').run(projectId,workspaceId);
        local.prepare('DELETE FROM claim_relations WHERE project_id=? AND workspace_id=?').run(projectId,workspaceId);
        local.prepare('DELETE FROM mutation_replays WHERE workspace_id=? AND (idempotency_key IN (SELECT idempotency_key FROM workflow_decisions WHERE project_id=? AND workspace_id=?) OR endpoint_scope IN (?,?,?))').run(workspaceId,projectId,workspaceId,`projects/${projectId}/reports`,`events/${ids.get('e')}/highlights`,`events/${ids.get('e')}/review-progress`);
        local.prepare(`DELETE FROM mutation_replays WHERE workspace_id=? AND (endpoint_scope=? OR endpoint_scope IN (SELECT 'analysis-runs/'||id||'/retry' FROM extraction_runs WHERE project_id=?))`).run(workspaceId,`events/${ids.get('e')}/analysis`,projectId);
        local.exec(`DROP TRIGGER IF EXISTS ${prefix}_no_paid_models`);
        for(const kind of ['extraction','artifact'])for(const operation of ['insert','update'])local.exec(`DROP TRIGGER IF EXISTS ${prefix}_no_${kind}_${operation}`);
        local.prepare("DELETE FROM mutation_replays WHERE workspace_id=? AND endpoint_scope IN (?,?,?)").run(workspaceId,`events/${ids.get('e')}/assets/init`,`projects/${projectId}/trash`,`projects/${projectId}/permanent`);
        local.prepare("DELETE FROM mutation_replays WHERE workspace_id=? AND endpoint_scope IN (SELECT 'events/'||e.id||'/review-progress' FROM events e WHERE e.project_id=? UNION ALL SELECT 'events/'||e.id||'/highlights' FROM events e WHERE e.project_id=?)").run(workspaceId,projectId,projectId);
        local.prepare('DELETE FROM claim_occurrences WHERE occurrence_verdict_id IN (SELECT v.id FROM occurrence_verdicts v JOIN claim_occurrence_candidates c ON c.id=v.candidate_id WHERE c.project_id=? AND c.workspace_id=?)').run(projectId,workspaceId);
        local.prepare('DELETE FROM claim_occurrence_candidates WHERE project_id=? AND workspace_id=?').run(projectId,workspaceId);
        local.prepare('DELETE FROM projects WHERE id=? AND workspace_id=?').run(projectId,workspaceId);
        local.exec('COMMIT');
      } catch(error) {local.exec('ROLLBACK');throw error;}
      finally {local.close();}
    }};
}
