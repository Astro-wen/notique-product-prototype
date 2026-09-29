import { actionBasisRefs, resolveActionBasis, claimOrigin, claimSourceStatus, type LedgerClaim, type LedgerRelation, type ProjectionLedger } from '../../domain/workflow-projection.ts';
import { asRef, claimGuard, evidenceGuards, statement, type WriteContext } from './ledger-write.ts';
import { WorkflowFault } from './snapshot-store.ts';
import { mutationId, type MutationPlan } from './transaction.ts';

/** Detect old writers that change relations without advancing project context. */
export function relationGuard(ledger:ProjectionLedger, claim:LedgerClaim, ctx:WriteContext):MutationPlan['guards'][number] {
  const rows=ledger.relations.filter(r=>['active','proposed'].includes(r.status) && (r.source_claim_id===claim.id || r.source_claim_version_id===claim.current_version_id || r.target_claim_version_id===claim.current_version_id));
  const tuple=(r:LedgerRelation)=>[r.id,r.source_claim_version_id,r.target_claim_version_id,r.type,r.status,r.contradiction_status,r.reason];
  return {sql:`(SELECT COALESCE(json_group_array(json_array(id,source_claim_version_id,target_claim_version_id,type,status,contradiction_status,reason)),'[]') FROM
    (SELECT * FROM claim_relations WHERE workspace_id=? AND project_id=? AND status IN ('active','proposed')
      AND (source_claim_version_id IN (SELECT id FROM claim_versions WHERE claim_id=?) OR target_claim_version_id=?) ORDER BY id))=?`,
    values:[ctx.scope.workspaceId,ctx.projectId,claim.id,claim.current_version_id,JSON.stringify(rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(tuple))]};
}

export function actionMetadataGuard(actionId:string,meta:ProjectionLedger['actions'][number]|null,ctx:WriteContext):MutationPlan['guards'][number] {
  return meta?{sql:'EXISTS (SELECT 1 FROM action_metadata WHERE claim_id=? AND workspace_id=? AND basis_version_refs_json=? AND basis_state=? AND cancelled_at IS ? AND owner_hint IS ? AND due_at IS ?)',values:[actionId,ctx.scope.workspaceId,meta.basis_version_refs_json,meta.basis_state,meta.cancelled_at??null,meta.owner_hint??null,meta.due_at??null]}:{sql:'NOT EXISTS (SELECT 1 FROM action_metadata WHERE claim_id=? AND workspace_id=?)',values:[actionId,ctx.scope.workspaceId]};
}

/** A user's explicit confirmation freezes the current basis. Historical links
 * remain as inactive audit rows and the action's execution history is retained. */
export function acceptActionBasis(ctx:WriteContext,ledger:ProjectionLedger,action:LedgerClaim) {
  const prior=actionBasisRefs(ledger,action);
  const paths=prior.map(ref=>{
    const resolved=resolveActionBasis(ledger,ref);
    if(!resolved.source || claimSourceStatus(resolved.source,ledger.evidence)!=='ready')
      throw new WorkflowFault(409,'dependency_conflict','有一条行动依据已经失效，请先补齐对应信息再核对',{claimId:ref.claimId});
    return {...resolved,source:resolved.source};
  });
  const sources=[...new Map(paths.map(p=>[p.source.id,p.source])).values()];
  const guardedClaims=[...new Map(paths.flatMap(p=>p.path.map(c=>[c.id,c] as const))).values()];
  const basis=sources.map(asRef);
  const statements:D1PreparedStatement[]=[];
  const guards:MutationPlan['guards']=[relationGuard(ledger,action,ctx),...guardedClaims.flatMap(c=>[claimGuard(c,ctx.scope),relationGuard(ledger,c,ctx)])];
  for(const c of sources) {
    const candidates=ledger.evidence.filter(e=>e.claim_version_id===c.current_version_id && e.evidence_role!=='contextual');
    const notes=candidates.filter(e=>e.kind==='user_note');
    const evidence=claimOrigin(c)==='user_input' && notes.length?notes:candidates;
    guards.push(...evidenceGuards(ledger,evidence.map(e=>e.id),ctx));
  }
  const previous=ledger.relations.filter(r=>r.type==='informed_by' && ['active','proposed'].includes(r.status) && (r.source_claim_id===action.id || r.source_claim_version_id===action.current_version_id));
  const beforeRelations:Array<LedgerRelation|null>=[...previous];
  const afterRelations:Array<LedgerRelation|null>=previous.map(r=>({...r,status:'inactive'}));
  for(const r of previous) {
    statements.push(statement(ctx,"INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'reject',?,?,?)",mutationId('rvdt'),r.id,r.status,ctx.scope.actorId,ctx.timestamp));
    statements.push(statement(ctx,"UPDATE claim_relations SET status='inactive' WHERE id=? AND workspace_id=?",r.id,ctx.scope.workspaceId));
  }
  for(const b of basis) {
    const id=mutationId('rel');
    beforeRelations.push(null);
    afterRelations.push({id,source_claim_version_id:action.current_version_id,target_claim_version_id:b.claimVersionId,type:'informed_by',status:'active',contradiction_status:null,reason:JSON.stringify({decisionId:ctx.decisionId,operation:'accept_action'})});
    statements.push(statement(ctx,`INSERT INTO claim_relations (id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status,reason,created_at)
      VALUES (?,?,?,'informed_by',?,?,?,'active',?,?)`,id,ctx.scope.workspaceId,ctx.projectId,action.current_version_id,b.claimVersionId,ctx.contextVersion,JSON.stringify({decisionId:ctx.decisionId,operation:'accept_action'}),ctx.timestamp));
    statements.push(statement(ctx,"INSERT INTO relation_verdicts (id,relation_id,action,base_relation_status,user_id,created_at) VALUES (?,?,'confirm','proposed',?,?)",mutationId('rvdt'),id,ctx.scope.actorId,ctx.timestamp));
  }
  statements.push(statement(ctx,`INSERT INTO action_metadata (claim_id,workspace_id,project_id,event_id,basis_version_refs_json,basis_state,created_at,updated_at) VALUES (?,?,?,?,?,'current',?,?)
    ON CONFLICT(claim_id) DO UPDATE SET basis_version_refs_json=excluded.basis_version_refs_json,basis_state='current',updated_at=excluded.updated_at`,action.id,ctx.scope.workspaceId,ctx.projectId,action.event_id,JSON.stringify(basis),ctx.timestamp,ctx.timestamp));
  return {statements,guards,basis,beforeRelations,afterRelations};
}
