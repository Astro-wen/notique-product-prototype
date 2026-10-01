import type {ProjectOverview} from '../shared/workflow-v2';

/** The overview must discover background completion even when the task was
 * started in another tab and the shell still holds an older terminal Run. */
export function projectOverviewPollInterval(snapshot:ProjectOverview|undefined, processing:boolean, accessDenied:boolean):number|false {
  if(accessDenied)return false;
  if(processing || snapshot?.recordSummaries.some(r=>!r.coverage.complete || r.narrative?.freshness==='updating'))return 3000;
  return 30_000;
}
