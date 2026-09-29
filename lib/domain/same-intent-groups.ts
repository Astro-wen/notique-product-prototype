import type { ModelContractIssue } from './model-contract';

export const SAME_INTENT_GROUP_LIMIT = 12;
export type SameIntentGroupProposal = {
  group_key: string;
  record_claim_key: string;
  action_claim_key: string;
  reason: string;
  confidence: number;
};
export type IntentGroupMember = {
  client_claim_key: string;
  disposition: string;
  type: string;
};
const KEYS = ['group_key','record_claim_key','action_claim_key','reason','confidence'];

export function sameIntentGroupIssues(value:unknown):ModelContractIssue[] {
  const issues:ModelContractIssue[]=[];
  if(!Array.isArray(value) || value.length>SAME_INTENT_GROUP_LIMIT)return [{path:'$.same_intent_groups',message:`Expected at most ${SAME_INTENT_GROUP_LIMIT} groups.`}];
  value.forEach((item,index)=>{
    const path=`$.same_intent_groups[${index}]`;
    if(!item || typeof item!=='object' || Array.isArray(item)){issues.push({path,message:'Expected an object.'});return;}
    const g=item as Record<string,unknown>;
    for(const k of Object.keys(g))if(!KEYS.includes(k))issues.push({path:`${path}.${k}`,message:'Unexpected field.'});
    for(const k of KEYS)if(!(k in g))issues.push({path:`${path}.${k}`,message:'Missing required field.'});
    for(const k of KEYS.filter(k=>k!=='confidence')){
      const s=g[k],limit=k==='reason'?4000:200;
      if(typeof s!=='string' || !s.trim() || s.length>limit)issues.push({path:`${path}.${k}`,message:`Expected a non-empty string with at most ${limit} characters.`});
    }
    if(typeof g.confidence!=='number' || !Number.isFinite(g.confidence) || g.confidence<0 || g.confidence>1)issues.push({path:`${path}.confidence`,message:'Expected a confidence from 0 to 1.'});
  });
  return issues;
}

/** Invalid semantic suggestions leave the independent claims readable. */
export function selectSameIntentGroups(value:unknown,members:readonly IntentGroupMember[]):{groups:SameIntentGroupProposal[];issues:ModelContractIssue[]} {
  const issues=sameIntentGroupIssues(value);
  if(issues.length)return {groups:[],issues};
  const proposals=value as SameIntentGroupProposal[],byKey=new Map(members.map(m=>[m.client_claim_key,m]));
  const keyCounts=new Map<string,number>(),memberCounts=new Map<string,number>();
  for(const g of proposals){
    keyCounts.set(g.group_key,(keyCounts.get(g.group_key)??0)+1);
    for(const key of [g.record_claim_key,g.action_claim_key])memberCounts.set(key,(memberCounts.get(key)??0)+1);
  }
  const groups=proposals.filter((g,index)=>{
    const path=`$.same_intent_groups[${index}]`,record=byKey.get(g.record_claim_key),action=byKey.get(g.action_claim_key);
    const message=keyCounts.get(g.group_key)!>1?'Duplicate group key.'
      :[g.record_claim_key,g.action_claim_key].some(k=>memberCounts.get(k)!>1)?'Overlapping group member.'
      :!record || !action?'Group member was not published.'
      :record.disposition!=='new' || action.disposition!=='new'?'A group requires independently published new claims.'
      :record.type!=='decision' || action.type!=='next_action'?'A group requires a decision and a future action.'
      :g.confidence<0.85?'Grouping confidence is below 0.85.':null;
    if(message)issues.push({path,message});
    return !message;
  });
  return {groups,issues};
}
