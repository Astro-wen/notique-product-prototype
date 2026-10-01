import type { ContextPack } from './context-pack.ts';

/** Keep source text and saved checkpoints intact. These aliases only cross
 * the model boundary; every returned reference is restored before validation. */
export function extractionTransport(input: ContextPack) {
  const aliases=new Map<string,string>(),originals=new Map<string,string>();
  const used=new Set<string>();
  const counters=new Map<string,number>();
  const referenceKeys=new Set(['eventId','event_id','assetVersionId','asset_version_id','claimId','claim_id','target_claim_id','claimVersionId','claim_version_id','target_claim_version_id']);
  const referenceArrays=new Set(['segmentIds','segment_ids','sourceSegmentIds','source_segment_ids','evidenceRefIds','evidence_ref_ids']);
  const literalKeys=new Set(['textRaw','textNormalized','statement','quote_hint','quote_raw','observation','normalizedValue','normalized_value','readableText','modelUrl','uncertainty','reason','meaning','term']);
  const collect=(value:unknown):void=>{
    if(Array.isArray(value)){value.forEach(collect);return;}
    if(!value || typeof value!=='object')return;
    for(const [key,item] of Object.entries(value)) {
      if(literalKeys.has(key))continue;
      if((referenceKeys.has(key)||key==='id')&&typeof item==='string')used.add(item);
      else if(referenceArrays.has(key)&&Array.isArray(item))item.forEach(id=>{if(typeof id==='string')used.add(id);});
      else collect(item);
    }
  };
  collect(input);
  const alias=(id:string,kind:string):string=>{
    const existing=aliases.get(id);if(existing)return existing;
    let n=counters.get(kind)??0,candidate:string;
    do {candidate=`${kind}${n++}`;} while(used.has(candidate)||originals.has(candidate));
    counters.set(kind,n);aliases.set(id,candidate);originals.set(candidate,id);return candidate;
  };
  input.new_event.transcript_segments.forEach(s=>alias(s.id,'s'));
  const referenceKind=(key:string)=>key.includes('asset')?'a':key.includes('Version')||key.includes('version')?'v':key.includes('claim')||key.includes('Claim')?'c':'e';
  function transform(value:unknown,decode=false):unknown {
    if(Array.isArray(value))return value.map(item=>transform(item,decode));
    if(!value || typeof value!=='object')return value;
    return Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(literalKeys.has(key))return [key,item];
      if(referenceKeys.has(key)&&typeof item==='string')return [key,decode?originals.get(item)??item:alias(item,referenceKind(key))];
      if(key==='id'&&typeof item==='string'&&aliases.has(item))return [key,decode?item:aliases.get(item)];
      if(referenceArrays.has(key)&&Array.isArray(item))return [key,item.map(id=>typeof id==='string'?(decode?originals.get(id)??id:alias(id,key.includes('egment')?'s':'r')):id)];
      return [key,transform(item,decode)];
    }));
  }
  const encoded=transform(input) as ContextPack;
  return {
    input:encoded,
    encode<T>(value:T):T{return transform(value) as T;},
    decode(value:unknown):unknown{return transform(value,true);},
    feedback(lines:readonly string[]):string[]{return lines.map(line=>{
      for(const [id,short] of aliases)line=line.replaceAll(JSON.stringify(id),JSON.stringify(short));
      return line;
    });},
  };
}
