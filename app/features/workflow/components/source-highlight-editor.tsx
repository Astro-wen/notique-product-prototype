"use client";

import { useEffect, useRef, useState } from 'react';
import { ApiClientError } from '@/app/api-client';
import { Modal } from '@/app/components/modal';
import { NqButton } from '@/app/components/notique-ui';
import { selectSourceRanges, type SourceSegment } from '@/lib/domain/workflow-v2';
import type { SourceHighlightRequest } from '@/lib/shared/workflow-v2';
import {useMemoryDrafts,useDraftCheckpoint} from './memory-drafts';
import styles from './record-workspace.module.css';

export type HighlightSource = SourceSegment & {filename:string;speaker:string|null;startMs:number|null};
type Selection = {assetVersionId:string;ranges:SourceHighlightRequest['ranges'];quote:string};
export function SourceHighlightEditor({contextVersion,canEdit,onLoad,onSave,onClose}: {
  contextVersion:number;canEdit:boolean;onLoad:()=>Promise<HighlightSource[]>;onSave:(body:SourceHighlightRequest)=>Promise<void>;onClose:(saved?:boolean)=>void;
}) {
  const memory=useMemoryDrafts();
  const [restored]=useState(()=>memory?.restored('highlight'));
  const [sources,setSources]=useState<HighlightSource[]>([]);
  const [loading,setLoading]=useState(true);
  const [selection,setSelection]=useState<Selection|null>(null);
  const [base,setBase]=useState(contextVersion);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState('');
  const [conflict,setConflict]=useState(Boolean(restored));
  const [loadError,setLoadError]=useState(false);
  const [discard,setDiscard]=useState(false);
  const container=useRef<HTMLDivElement>(null);
  const [openingContext]=useState(contextVersion);
  useEffect(()=>{
    let active=true;
    onLoad().then(rows=>{if(active){setSources(rows);if(restored){try{const selected=selectSourceRanges({expectedContextVersion:openingContext,assetVersionId:restored.assetVersionId,ranges:restored.ranges},rows);setSelection({assetVersionId:restored.assetVersionId,...selected});setConflict(true);}catch{setError('原文版本已变化，请在当前原文中重新选取。');}}}}).catch(()=>{if(active){setLoadError(true);setError('暂时无法读取原文，请重试。');}}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[onLoad,restored,openingContext]);
  useDraftCheckpoint(selection?{kind:'highlight',targetId:'source-selection',assetVersionId:selection.assetVersionId,ranges:selection.ranges}:null);
  const finish=(saved?:boolean)=>{memory?.clear('highlight');onClose(saved);};
  function choose(assetVersionId:string,ranges:SourceHighlightRequest['ranges']) {
    try {const selected=selectSourceRanges({expectedContextVersion:base,assetVersionId,ranges},sources);setSelection({assetVersionId,...selected});setBase(contextVersion);setConflict(false);setError('');setDiscard(false);}
    catch(e) {setError(e instanceof Error?e.message:'请重新选取原话。');}
  }
  function captureSelection() {
    if(pending || loading) return;
    const selected=window.getSelection();
    if(!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range=selected.getRangeAt(0);
    if(!container.current?.contains(range.startContainer) || !container.current.contains(range.endContainer)) return;
    const ranges:SourceHighlightRequest['ranges']=[];
    const versions=new Set<string>();
    for(const node of container.current.querySelectorAll<HTMLElement>('[data-source-segment]')) {
      if(!range.intersectsNode(node)) continue;
      const segment=sources.find(s=>s.id===node.dataset.sourceSegment)!;
      let startOffset=0,endOffset=segment.textRaw.length;
      if(node.contains(range.startContainer)) {const prefix=document.createRange();prefix.selectNodeContents(node);prefix.setEnd(range.startContainer,range.startOffset);startOffset=prefix.toString().length;}
      if(node.contains(range.endContainer)) {const prefix=document.createRange();prefix.selectNodeContents(node);prefix.setEnd(range.endContainer,range.endOffset);endOffset=prefix.toString().length;}
      if(endOffset>startOffset) {ranges.push({segmentId:segment.id,startOffset,endOffset});versions.add(segment.assetVersionId);}
    }
    if(versions.size>1) {setError('请每次选取一份材料中的原话。');return;}
    if(ranges.length) choose([...versions][0],ranges);
  }
  async function refresh() {
    setLoading(true);setError('');
    try {
      const latest=await onLoad();setSources(latest);setLoadError(false);
      if(selection) {
        try {const current=selectSourceRanges({expectedContextVersion:contextVersion,assetVersionId:selection.assetVersionId,ranges:selection.ranges},latest);if(current.quote!==selection.quote) throw new Error();}
        catch {setError('原文已变化，已保留下方选录预览，请在最新原文中重新选取。');setConflict(true);return;}
      }
      setBase(contextVersion);setConflict(false);
    } catch {setLoadError(true);setError('暂时无法读取原文，请重试。');}
    finally {setLoading(false);}
  }
  async function save() {
    if(!selection || pending || conflict || !canEdit) return;
    setPending(true);setError('');
    try {await onSave({expectedContextVersion:base,assetVersionId:selection.assetVersionId,ranges:selection.ranges});finish(true);}
    catch(e) {setError(e instanceof Error?e.message:'保存失败，选录仍然保留。');if(e instanceof ApiClientError && e.status===409)setConflict(true);}
    finally {setPending(false);}
  }
  function close() {if(pending)return;if(selection)setDiscard(true);else finish();}
  return <Modal wide title="从原文补充重点" description="拖选需要保留的原话，或选录整段。保存后会带着出处进入本次重点。" dismissible={!pending} onClose={close} returnFocusSelector="#add-source-highlight">
    <div className={styles.highlightEditor}>
      <div className={styles.highlightSources} ref={container} onMouseUp={captureSelection} onKeyUp={captureSelection} aria-label="可选录的原文" aria-busy={loading}>
        {loading && <p>正在读取原文…</p>}
        {!loading && !sources.length && !loadError && <p>还没有可选录的原文。材料解析后可在这里补充重点。</p>}
        {sources.map((s,index)=><article key={s.id} className={styles.highlightSegment}>
          <div><span>{s.speaker ?? s.filename}{s.startMs!==null?` · ${Math.floor(s.startMs/60000)}:${String(Math.floor(s.startMs/1000)%60).padStart(2,'0')}`:''}</span><NqButton variant="quiet" disabled={pending || loading || !canEdit} aria-label={`选录第${index+1}段`} onClick={()=>choose(s.assetVersionId,[{segmentId:s.id,startOffset:0,endOffset:s.textRaw.length}])}>选录此段</NqButton></div>
          <p data-source-segment={s.id}>{s.textRaw}</p>
        </article>)}
      </div>
      <aside className={styles.highlightPreview}>
        <h3>将补进重点</h3>
        {selection?<blockquote data-testid="highlight-preview">{selection.quote}</blockquote>:<p>选中左侧原话后，在这里查看。</p>}
        {selection && <small>{selection.quote.length} / 4,000 字符 · 用户选录</small>}
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {(conflict || loadError) && <NqButton variant="secondary" disabled={loading || pending} onClick={()=>void refresh()}>重新核对原文</NqButton>}
        {discard?<div><p>这段选录还未保存。</p><NqButton variant="secondary" onClick={()=>setDiscard(false)}>继续选录</NqButton><NqButton variant="quiet" onClick={()=>finish()}>放弃选录</NqButton></div>:<div className={styles.inlineActions}><NqButton disabled={!selection || conflict || loading || !canEdit} loading={pending} onClick={()=>void save()}>补进重点</NqButton><NqButton variant="quiet" disabled={pending} onClick={close}>取消</NqButton></div>}
      </aside>
    </div>
  </Modal>;
}
