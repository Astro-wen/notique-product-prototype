"use client";
import {createContext,useContext,useLayoutEffect,useState,useSyncExternalStore} from 'react';
import {NqButton} from '@/app/components/notique-ui';
import {MemoryDraftSession,ownDraftText,type BoundDraftSession,type MemoryDraft} from '../services/memory-drafts';
import {WORKFLOW_LEAVE_EVENT} from '../state-navigation';
import styles from './record-workspace.module.css';

export const MemoryDraftContext=createContext<BoundDraftSession|null>(null);
export const useMemoryDrafts=()=>useContext(MemoryDraftContext);
export function useDraftCheckpoint(draft:MemoryDraft|null) {
  const session=useMemoryDrafts();
  const serialized=JSON.stringify(draft);
  useLayoutEffect(()=>{if(session && serialized!=='null')session.put(JSON.parse(serialized) as MemoryDraft);},[session,serialized]);
}
export function RetainedInputs({session,onDiscard}: {session:MemoryDraftSession;onDiscard?:()=>void}) {
  const [confirmDiscard,setConfirmDiscard]=useState(false);
  const drafts=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
  useLayoutEffect(()=>{
    if(!drafts.length)return;
    const unload=(e:BeforeUnloadEvent)=>e.preventDefault();
    const leave=(e:Event)=>e.preventDefault();
    window.addEventListener('beforeunload',unload);window.addEventListener(WORKFLOW_LEAVE_EVENT,leave);
    return ()=>{window.removeEventListener('beforeunload',unload);window.removeEventListener(WORKFLOW_LEAVE_EVENT,leave);};
  },[drafts.length]);
  if(!drafts.length)return null;
  const fields=drafts.flatMap(ownDraftText);
  return <div className={styles.retainedInputs} role="region" aria-label="保留的输入"><p>未保存的输入保留在本页，恢复访问后可以继续核对。</p>{fields.map((f,i)=><label key={i}>{f.label}<textarea aria-label={`保留的${f.label}${i+1}`} value={f.text} readOnly rows={3}/></label>)}{!fields.length && <p>你的处理选择与选录范围已保留。</p>}{onDiscard && (confirmDiscard?<div><p>放弃后，本页保留的输入将清除。</p><NqButton variant="secondary" onClick={()=>setConfirmDiscard(false)}>继续保留</NqButton><NqButton variant="quiet" onClick={()=>{onDiscard();setConfirmDiscard(false);}}>确认放弃</NqButton></div>:<NqButton variant="quiet" onClick={()=>setConfirmDiscard(true)}>放弃保留的输入</NqButton>)}</div>;
}
