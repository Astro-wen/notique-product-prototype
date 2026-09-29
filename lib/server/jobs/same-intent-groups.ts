import {selectSameIntentGroups,type SameIntentGroupProposal} from '../../domain/same-intent-groups.ts';

type PublishedMember = {
  claimId:string;
  versionId:string;
  model:{client_claim_key:string;disposition:string;type:string;statement:string};
};
type GroupScope = {workspaceId:string;projectId:string;eventId:string;runId:string;contextVersion:number;timestamp:string};
const id=(prefix:string)=>`${prefix}_${crypto.randomUUID().replaceAll('-','')}`;

/** The caller publishes these statements with the claims and run lease guards. */
export function sameIntentGroupStatements(db:D1Database,scope:GroupScope,proposals:readonly SameIntentGroupProposal[],members:readonly PublishedMember[],warnings:Array<Record<string,unknown>>):D1PreparedStatement[] {
  const selected=selectSameIntentGroups(proposals,members.map(m=>m.model));
  warnings.push(...selected.issues.map(issue=>({code:'SAME_INTENT_GROUP_NOT_PERSISTED',path:issue.path,reason:issue.message})));
  const byKey=new Map(members.map(m=>[m.model.client_claim_key,m])),statements:D1PreparedStatement[]=[];
  for(const g of selected.groups){
    const record=byKey.get(g.record_claim_key)!,action=byKey.get(g.action_claim_key)!,cardId=`wfc_${action.claimId}`;
    statements.push(
      db.prepare(`INSERT INTO claim_relations (id,workspace_id,project_id,type,source_claim_version_id,target_claim_version_id,context_version,status,reason,confidence,created_at)
        VALUES (?,?,?,'informed_by',?,?,?,'proposed',?,?,?)`).bind(id('rel'),scope.workspaceId,scope.projectId,action.versionId,record.versionId,scope.contextVersion,JSON.stringify({sameIntentGroup:g.group_key,reason:g.reason}),g.confidence,scope.timestamp),
      db.prepare(`INSERT INTO workflow_cards (id,workspace_id,project_id,event_id,group_key,revision,kind,title,needs_decision,reason_code,reason,disposition,created_at,updated_at)
        VALUES (?,?,?,?,?,1,'action',?,1,'action_choice','决定是否加入跟进','active',?,?)`).bind(cardId,scope.workspaceId,scope.projectId,scope.eventId,`same_intent:${scope.runId}:${g.group_key}`,action.model.statement,scope.timestamp,scope.timestamp),
      ...[action,record].map(m=>db.prepare(`INSERT INTO card_members (id,workspace_id,card_id,claim_id,claim_version_id,role,created_at) VALUES (?,?,?,?,?,?,?)`).bind(id('wcm'),scope.workspaceId,cardId,m.claimId,m.versionId,m===action?'primary':'context',scope.timestamp)),
    );
  }
  return statements;
}
