import type { ConflictChoice, ContentOrigin, SourceHighlightRequest, VersionRef, WorkspaceSnapshot } from '../../../../lib/shared/workflow-v2.ts';

export type DraftOwner = Pick<WorkspaceSnapshot['access'],'workspaceId'|'actorId'> & {eventId:string};
type DraftOrigin=Extract<ContentOrigin,'source_statement'|'user_input'>;
type FactChoices=Record<string,{claimVersionId:string;mode:'keep'|'reopen'}>;
const copyFactChoices=(choices:FactChoices)=>Object.fromEntries(Object.entries(choices).map(([id,c])=>[id,{claimVersionId:c.claimVersionId,mode:c.mode}]));
export type InlineDraft={kind:'inline';targetId:string;mode:'edit'|'answer';claimId:string;value?:string;origin:DraftOrigin;questionChoices?:FactChoices};
export type OutcomeDraft={kind:'outcome';targetId:string;targetKind:'action'|'question';correctionId?:string;answers:Record<string,string>;note?:string;choices:Record<string,{mode:''|'replace'|'coexist';applicability:string;priorAnswerRefs?:VersionRef[]}>;complete:boolean};
export type MemberDraft={kind:'members';targetId:string;editClaimId?:string;choices:Record<string,{operation:'keep'|'confirm'|'edit'|'reject'|'accept_action';claimVersionId:string;origin:DraftOrigin;text?:string;questionChoices?:FactChoices}>};
export type ConflictDraft={kind:'conflict';targetId:string;existingRef:VersionRef;candidateRef:VersionRef;mode:ConflictChoice['mode'];applicability:string};
export type HighlightDraft={kind:'highlight';targetId:string;assetVersionId:string;ranges:SourceHighlightRequest['ranges']};
export type QuestionDraft={kind:'question';targetId:string;text?:string;origin:DraftOrigin;choices:Record<string,{claimVersionId:string;mode:'keep'|'reopen'}>};
export type MemoryDraft=QuestionDraft|InlineDraft|OutcomeDraft|MemberDraft|ConflictDraft|HighlightDraft;
export type RetainedDraft=MemoryDraft & {needsReview:boolean};
const sameOwner=(a:DraftOwner|null,b:DraftOwner)=>a?.workspaceId===b.workspaceId && a.actorId===b.actorId && a.eventId===b.eventId;

// An explicit allowlist keeps snapshots, original statements, quotes, previous
// answers and server errors outside the own-input recovery state.
function copyDraft(d:MemoryDraft):MemoryDraft {
  switch(d.kind) {
    case 'question':return {kind:d.kind,targetId:d.targetId,...(d.text===undefined?{}:{text:d.text}),origin:d.origin,choices:Object.fromEntries(Object.entries(d.choices).map(([id,c])=>[id,{claimVersionId:c.claimVersionId,mode:c.mode}]))};
    case 'inline':return {kind:d.kind,targetId:d.targetId,mode:d.mode,claimId:d.claimId,...(d.value===undefined?{}:{value:d.value}),origin:d.origin,...(d.questionChoices?{questionChoices:copyFactChoices(d.questionChoices)}:{})};
    case 'outcome':return {kind:d.kind,targetId:d.targetId,targetKind:d.targetKind,...(d.correctionId?{correctionId:d.correctionId}:{}),answers:Object.fromEntries(Object.entries(d.answers).map(([id,text])=>[id,text])),...(d.note===undefined?{}:{note:d.note}),choices:Object.fromEntries(Object.entries(d.choices).map(([id,c])=>[id,{mode:c.mode,applicability:c.applicability,...(c.priorAnswerRefs?{priorAnswerRefs:c.priorAnswerRefs.map(r=>({claimId:r.claimId,claimVersionId:r.claimVersionId}))}:{})}])),complete:d.complete};
    case 'members':return {kind:d.kind,targetId:d.targetId,...(d.editClaimId?{editClaimId:d.editClaimId}:{}),choices:Object.fromEntries(Object.entries(d.choices).map(([id,c])=>[id,{operation:c.operation,claimVersionId:c.claimVersionId,origin:c.origin,...(c.text===undefined?{}:{text:c.text}),...(c.questionChoices?{questionChoices:copyFactChoices(c.questionChoices)}:{})}]))};
    case 'conflict':return {kind:d.kind,targetId:d.targetId,existingRef:{claimId:d.existingRef.claimId,claimVersionId:d.existingRef.claimVersionId},candidateRef:{claimId:d.candidateRef.claimId,claimVersionId:d.candidateRef.claimVersionId},mode:d.mode,applicability:d.applicability};
    case 'highlight':return {kind:d.kind,targetId:d.targetId,assetVersionId:d.assetVersionId,ranges:d.ranges.map(r=>({segmentId:r.segmentId,startOffset:r.startOffset,endOffset:r.endOffset}))};
  }
}
export function ownDraftText(d:MemoryDraft):Array<{label:string;text:string}> {
  switch(d.kind) {
    case 'question':return d.text===undefined?[]:[{label:'修改问题',text:d.text}];
    case 'inline':return d.value===undefined?[]:[{label:d.mode==='edit'?'修改重点':'补充答案',text:d.value}];
    case 'outcome':return [...Object.values(d.answers).map(text=>({label:'问题答案',text})),...(d.note===undefined?[]:[{label:'补充说明',text:d.note}]),...Object.values(d.choices).filter(c=>c.applicability).map(c=>({label:'适用情况',text:c.applicability}))];
    case 'members':return Object.values(d.choices).filter(c=>c.text!==undefined).map(c=>({label:'修改重点',text:c.text!}));
    case 'conflict':return d.applicability?[{label:'适用情况',text:d.applicability}]:[];
    case 'highlight':return [];
  }
}

/** One mounted record owns volatile input. Changing actor, workspace or record
 * destroys it. Suspension fences late requests and freezes own-input recovery. */
export class MemoryDraftSession {
  private owner:DraftOwner|null=null;
  private suspended=false;
  private entries:RetainedDraft[]=[];
  private listeners=new Set<()=>void>();
  epoch=0;
  readonly subscribe=(fn:()=>void)=>{this.listeners.add(fn);return ()=>this.listeners.delete(fn);};
  readonly getSnapshot=()=>this.entries;
  private changed(){for(const fn of this.listeners)fn();}
  bind(owner:DraftOwner) {
    if(!sameOwner(this.owner,owner)) {this.owner={...owner};this.entries=[];this.epoch++;this.suspended=false;this.changed();}
    else if(this.suspended) {this.suspended=false;this.epoch++;this.changed();}
  }
  hasOwner(){return this.owner!==null;}
  matches(owner:DraftOwner){return sameOwner(this.owner,owner);}
  suspend() {
    if(this.suspended)return;
    this.suspended=true;this.epoch++;
    this.entries=this.entries.map(d=>({...d,needsReview:true}));this.changed();
  }
  isCurrent(epoch:number){return !this.suspended && this.epoch===epoch;}
  bindEditor(owner:DraftOwner){return new BoundDraftSession(this,{...owner},this.epoch);}
  discard(){if(!this.entries.length)return;this.entries=[];this.changed();}
  put(draft:MemoryDraft) {
    if(!this.owner || this.suspended)return;
    const clean=copyDraft(draft),next={...clean,needsReview:this.entries.find(d=>d.kind===draft.kind)?.needsReview ?? false};
    const previous=this.entries.find(d=>d.kind===draft.kind);
    if(JSON.stringify(previous)===JSON.stringify(next))return;
    this.entries=[...this.entries.filter(d=>d.kind!==draft.kind),next];this.changed();
  }
  read<K extends MemoryDraft['kind']>(kind:K):Extract<RetainedDraft,{kind:K}>|undefined {return this.entries.find(d=>d.kind===kind) as Extract<RetainedDraft,{kind:K}>|undefined;}
  restored<K extends MemoryDraft['kind']>(kind:K){const d=this.read(kind);return d?.needsReview?d:undefined;}
  clear(kind?:MemoryDraft['kind']) {
    if(this.suspended)return;
    const next=kind?this.entries.filter(d=>d.kind!==kind):[];
    if(next.length===this.entries.length)return;
    this.entries=next;this.changed();
  }
}

const emptyDrafts:RetainedDraft[]=[];
export class BoundDraftSession {
  private session:MemoryDraftSession;private owner:DraftOwner;private epoch:number;
  constructor(session:MemoryDraftSession,owner:DraftOwner,epoch:number){this.session=session;this.owner=owner;this.epoch=epoch;}
  readonly subscribe=(fn:()=>void)=>this.session.subscribe(fn);
  readonly getSnapshot=()=>this.active()?this.session.getSnapshot():emptyDrafts;
  private active(){return this.session.matches(this.owner) && this.session.isCurrent(this.epoch);}
  put(draft:MemoryDraft){if(this.active())this.session.put(draft);}
  restored<K extends MemoryDraft['kind']>(kind:K){return this.active()?this.session.restored(kind):undefined;}
  clear(kind?:MemoryDraft['kind']){if(this.active())this.session.clear(kind);}
}
