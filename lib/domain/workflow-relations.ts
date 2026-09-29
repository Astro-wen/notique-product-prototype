import type { LedgerRelation, ProjectionLedger } from './workflow-projection.ts';

/** Wording corrections keep the same stable answer and question. Independent
 * replacement answers remain outside the originating outcome's relation chain. */
export function outcomeRelationIds(ledger:ProjectionLedger,roots:string[]):string[] {
  const ids=new Set(roots),byId=new Map(ledger.relations.map(r=>[r.id,r]));
  const currentByVersion=new Map(ledger.claims.map(c=>[c.current_version_id,c.id]));
  const questions=new Set(ledger.claims.filter(c=>c.type==='open_question').map(c=>c.id));
  const children=new Map<string,LedgerRelation[]>();
  for(const r of ledger.relations) {
    if(r.type!=='resolves')continue;
    let reason:{questionEdit?:{predecessorRelationId?:string};factEdit?:{predecessorRelationId?:string}}|null=null;
    try {reason=r.reason?JSON.parse(r.reason):null;}catch{}
    const parentId=reason?.factEdit?.predecessorRelationId ?? reason?.questionEdit?.predecessorRelationId;
    if(typeof parentId==='string')children.set(parentId,[...(children.get(parentId) ?? []),r]);
  }
  const questionId=(r:LedgerRelation)=>r.target_claim_id ?? currentByVersion.get(r.target_claim_version_id);
  const answerId=(r:LedgerRelation)=>r.source_claim_id ?? currentByVersion.get(r.source_claim_version_id);
  const pending=[...roots];
  for(let index=0;index<pending.length;index++) {
    const parent=byId.get(pending[index]);
    if(!parent || parent.type!=='resolves')continue;
    const owner=questionId(parent);
    if(!owner || !questions.has(owner))continue;
    for(const child of children.get(parent.id) ?? []) {
      const sameAnswer=parent.source_claim_version_id===child.source_claim_version_id || Boolean(answerId(parent) && answerId(parent)===answerId(child));
      if(ids.has(child.id) || !sameAnswer || owner!==questionId(child))continue;
      ids.add(child.id);pending.push(child.id);
    }
  }
  return [...ids];
}
