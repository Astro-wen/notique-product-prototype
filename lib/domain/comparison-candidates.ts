import type {ContextPack} from './context-pack.ts';
import type {InventoryOutput} from './two-stage-extraction.ts';

const stop = new Set('the a an and or to of for in on at as is are was were be been by with that this it they their said says stated reported speaker would could should will may about approximately'.split(' '));
function terms(text:string):Set<string> {
  const words=(text.toLowerCase().match(/[a-z][a-z0-9]*|[\u3400-\u9fff]+/g) ?? []).flatMap(word=>{
    if (/^[\u3400-\u9fff]+$/.test(word)) return word.length===1?[word]:Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2));
    const normalized=word.replace(/s$/,'');
    return stop.has(word)?[]:[/^(fee|price|pricing|cost)$/.test(normalized)?'price':normalized];
  });
  return new Set(words);
}
/** Retrieval only. Similarity proposes bounded pairs to the verifier, never a
 * saved change. IDs refer to the exact context versions, not inferred facts. */
export function comparisonCandidates(inventory:InventoryOutput, context:ContextPack, prioritizeAttributes = false) {
  const history=[...context.draft_context.claims,...context.verified_context.active_claims,...context.verified_context.open_questions];
  const unique=[...new Map(history.filter(item=>item.eventId!==context.new_event.event_id && item.normalizedValue?.source_match_status!=='unverified').map(item=>[item.claimVersionId,item])).values()];
  const attribute=(text:string)=>/\b(?:fees?|prices?|pricing|costs?)\b|费用|价格|单价/.test(text.toLowerCase()) ? 'price' : /\bbudget\b|预算/.test(text.toLowerCase()) ? 'budget' : null;
  const forecast=(text:string)=>/\b(?:guess|guessed|predict|predicted|forecast|expect|expects|expected|hypothesized|would|could|may)\b|预期|预计|预测/.test(text.toLowerCase());
  const tokens=unique.map(item=>terms(item.statement));
  const df=new Map<string,number>();for(const set of tokens)for(const token of set)df.set(token,(df.get(token)??0)+1);
  return inventory.candidates.flatMap(candidate=>{
    const query=terms(candidate.statement);
    const matches=unique.map((item,index)=>{
      const shared=[...query].filter(token=>tokens[index].has(token));
      const sameAttribute=prioritizeAttributes && attribute(candidate.statement)!==null && attribute(candidate.statement)===attribute(item.statement);
      const bonus=sameAttribute && forecast(candidate.statement) && forecast(item.statement)?3:0;
      return {item,score:shared.length<2 && !sameAttribute?0:bonus+shared.reduce((sum,token)=>sum+Math.log(1+unique.length/(df.get(token)??1)),0)/Math.sqrt(Math.max(1,tokens[index].size))};
    }).filter(match=>match.score>0).sort((a,b)=>b.score-a.score || a.item.claimVersionId.localeCompare(b.item.claimVersionId)).slice(0,3);
    return matches.length?[{inventory_key:candidate.inventory_key,targets:matches.map(({item})=>({claim_id:item.claimId,claim_version_id:item.claimVersionId}))}]:[];
  });
}
