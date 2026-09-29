import type { LedgerClaim, LedgerRelation } from '../../domain/workflow-projection.ts';
import type { ReviewCard } from '../../shared/workflow-v2.ts';

export type DecisionState = {
  type?:string;
  versionId:string;reviewStatus:string;lifecycleStatus:string;workflowRevision:number;
  confidence?:number|null;needsAdditionalEvidence?:number;resolvedAt?:string|null;
  cardState?:ReviewCard;
  relationStates?:Array<LedgerRelation|null>;
  preExistingRelations?:LedgerRelation[];
  actionMetadata?:unknown;
};
export function decisionState(c:LedgerClaim):DecisionState {
  return {type:c.type,versionId:c.current_version_id,reviewStatus:c.review_status,lifecycleStatus:c.lifecycle_status,workflowRevision:c.workflow_revision,
    confidence:c.confidence ?? null,needsAdditionalEvidence:c.needs_additional_evidence ?? 0,resolvedAt:c.resolved_at ?? null};
}
