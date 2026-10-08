import type { HighlightSource } from '../components/source-highlight-editor';
import { api, request } from '@/app/api-client';
import type { ApiSuccess } from '@/lib/shared/api-types';
import type { MentionDecisionRequest, AnalysisRun, StartAnalysisRequest, RetryAnalysisRequest, ProjectOverview, ReviewProgress, ReviewProgressRequest, SourceHighlightRequest, ActionTransitionRequest, DecisionRequest, MutationReceipt, RevertDecisionRequest, OutcomeCorrectionRequest, OutcomeRequest, QuestionAnswerRequest, ReportRequest, ReportSnapshot, WorkspaceQuery, WorkspaceSnapshot } from '@/lib/shared/workflow-v2';
import type { RecordSource } from '../components/record-workspace';

const id = encodeURIComponent;
async function post<T>(path: string, body: unknown, key: string, signal?:AbortSignal): Promise<T> {
  return (await request<ApiSuccess<T>>(`/api/v2/${path}`, {method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body),signal})).data;
}
export const workflowService = {
  startAnalysis:(eventId:string,body:StartAnalysisRequest,key:string)=>post<AnalysisRun>(`events/${id(eventId)}/analysis`,body,key),
  retryAnalysis:(runId:string,body:RetryAnalysisRequest,key:string)=>post<AnalysisRun>(`analysis-runs/${id(runId)}/retry`,body,key),
  async getAnalysisRun(runId:string,signal?:AbortSignal):Promise<AnalysisRun> {
    return (await request<ApiSuccess<AnalysisRun>>(`/api/v2/analysis-runs/${id(runId)}`,{cache:'no-store',signal})).data;
  },
  async getOverview(projectId:string,query:WorkspaceQuery={},signal?:AbortSignal):Promise<ProjectOverview> {
    const params=new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
    return (await request<ApiSuccess<ProjectOverview>>(`/api/v2/projects/${id(projectId)}/overview?${params}`,{cache:'no-store',signal})).data;
  },
  async getWorkspace(eventId:string, query:WorkspaceQuery = {}, signal?:AbortSignal):Promise<WorkspaceSnapshot> {
    const params = new URLSearchParams(Object.entries(query).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
    return (await request<ApiSuccess<WorkspaceSnapshot>>(`/api/v2/events/${id(eventId)}/workspace?${params}`,{cache:'no-store',signal})).data;
  },
  async getFullWorkspace(eventId:string, minContextVersion?:number, signal?:AbortSignal):Promise<WorkspaceSnapshot> {
    const first = await this.getWorkspace(eventId,{limit:50,...(minContextVersion===undefined?{}:{minContextVersion})},signal);
    const cards = [...first.reviewCards];
    let cursor = first.nextCursor;
    while(cursor) {
      const page = await this.getWorkspace(eventId,{limit:50,snapshotId:first.snapshotId,cursor},signal);
      cards.push(...page.reviewCards);cursor=page.nextCursor;
    }
    return {...first,reviewCards:cards,nextCursor:null};
  },
  progress: (eventId:string,body:ReviewProgressRequest,key:string)=>post<ReviewProgress>(`events/${id(eventId)}/review-progress`,body,key),
  highlight: (eventId:string,body:SourceHighlightRequest,key:string)=>post<MutationReceipt>(`events/${id(eventId)}/highlights`,body,key),
  async highlightSources(eventId:string):Promise<HighlightSource[]> {
    const [segments,event]=await Promise.all([api.listEventTranscriptSegments(eventId),api.getEvent(eventId)]);
    const assets=event.assets.filter(a=>a.status==='ready' && a.metadata.analysis_source!==false && a.metadata.analysis_source!==0 && a.metadata.artifact_kind!=='readable_transcript' && a.metadata.transcription_chunk!==true && a.metadata.transcription_chunk!==1
      && (!a.metadata.source_audio_asset_version_id || event.assets.some(audio=>audio.kind==='audio' && audio.versionId===a.metadata.source_audio_asset_version_id)));
    return segments.flatMap(s=>{const asset=assets.find(a=>a.versionId===s.asset_version_id);return asset?[{id:s.id,assetVersionId:s.asset_version_id,ordinal:s.ordinal,textRaw:s.text,filename:asset.filename,speaker:s.speaker,startMs:s.start_ms}]:[];});
  },
  mention: (mentionId:string,body:MentionDecisionRequest,key:string)=>post<MutationReceipt>(`reaffirmed-mentions/${id(mentionId)}/decisions`,body,key),
  decide: (cardId:string, body:DecisionRequest, key:string)=>post<MutationReceipt>(`review-cards/${id(cardId)}/decisions`,body,key),
  revert: (decisionId:string,body:RevertDecisionRequest,key:string)=>post<MutationReceipt>(`decisions/${id(decisionId)}/revert`,body,key),
  transition: (actionId:string, body:ActionTransitionRequest, key:string)=>post<MutationReceipt>(`actions/${id(actionId)}/transitions`,body,key),
  answer: (questionId:string, body:QuestionAnswerRequest, key:string)=>post<MutationReceipt>(`questions/${id(questionId)}/answers`,body,key),
  outcome: (actionId:string, body:OutcomeRequest, key:string)=>post<MutationReceipt>(`actions/${id(actionId)}/outcomes`,body,key),
  correction: (outcomeId:string, body:OutcomeCorrectionRequest, key:string)=>post<MutationReceipt>(`outcomes/${id(outcomeId)}/corrections`,body,key),
  report: (projectId:string, body:ReportRequest, key:string, signal?:AbortSignal)=>post<ReportSnapshot>(`projects/${id(projectId)}/reports`,body,key,signal),
  async sources(ids:string[]):Promise<RecordSource[]> {
    return Promise.all(ids.map(async evidenceRefId=>{
      const ref = await api.getEvidence(evidenceRefId);
      if (ref.kind === 'user_note') return { evidenceRefId, kind: ref.kind, quote: ref.quote ?? '', speaker: '用户补充', timestamp: '' };
      // Derived transcripts resolve to their original recording through the
      // evidence context, rather than borrowing any audio in the record.
      const context = await api.getEvidenceContext(evidenceRefId);
      const quote = context.target.quote_raw ?? ref.quote ?? ref.caption ?? '';
      const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
      const quoted = quote.trim() ? context.context.target.filter(s => s.text && normalize(s.text).includes(normalize(quote))) : [];
      const speakers = [...new Set((quoted.length ? quoted : context.context.target).map(s => s.speaker).filter(Boolean))];
      const start = context.audio?.start_ms != null ? Math.max(0,context.audio.start_ms/1000) : typeof ref.timestampStart==='number' ? Math.max(0,ref.timestampStart) : null;
      const matchedStart = quoted[0]?.start_ms ?? context.target.start_ms;
      const quoteStart=matchedStart != null ? Math.max(0,matchedStart/1000) : typeof ref.timestampStart==='number' ? Math.max(0,ref.timestampStart) : start;
      const seconds = quoteStart===null ? null : Math.floor(quoteStart);
      const audioUrl=context.audio?.view_url || ref.audioUrl;
      const viewUrl=context.asset_view_url || ref.viewUrl;
      const speaker=speakers.join('、') || ref.speaker || ref.filename || '原始材料';
      return {evidenceRefId,kind:ref.kind,quote,speaker,timestamp:seconds===null?'':`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`,
        ...(audioUrl?{audioUrl,audioStartSeconds:start ?? 0}:{}),...(viewUrl?{viewUrl}:{})};
    }));
  },
};
