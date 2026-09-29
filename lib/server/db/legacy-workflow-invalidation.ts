import type { RequestScope } from '../http/context.ts';

/** Append to the existing V1 business batch, after its project context update.
 * No separate write may publish a changed ledger with a current V2 summary. */
export function legacyWorkflowInvalidationStatements(
  db: D1Database,
  scope: RequestScope,
  projectId: string,
  timestamp: string,
  changedClaimIds: string[] = [],
  options: { advanceContext?: boolean; eventId?: string } = {},
): D1PreparedStatement[] {
  const bind = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const claimIds = JSON.stringify([...new Set(changedClaimIds)]);
  const statements: D1PreparedStatement[] = [];
  if (options.advanceContext) statements.push(bind(
    'UPDATE projects SET context_version=context_version+1,ledger_version=ledger_version+1,updated_at=? WHERE id=? AND workspace_id=?',
    timestamp,projectId,scope.workspaceId,
  ));
  if (changedClaimIds.length) {
    statements.push(bind(`UPDATE claims SET workflow_revision=workflow_revision+1
      WHERE workspace_id=? AND project_id=? AND id IN (SELECT value FROM json_each(?))`,scope.workspaceId,projectId,claimIds));
    // An accepted action reached through V1 needs the same frozen basis as an
    // action accepted through V2. Later edits do not silently rewrite it.
    statements.push(bind(`INSERT INTO action_metadata
      (claim_id,workspace_id,project_id,event_id,basis_version_refs_json,basis_state,created_at,updated_at)
      SELECT c.id,c.workspace_id,c.project_id,c.event_id,
        COALESCE((SELECT json_group_array(json_object('claimId',v.claim_id,'claimVersionId',v.id))
          FROM claim_relations r JOIN claim_versions v ON v.id=r.target_claim_version_id
          WHERE r.source_claim_version_id=c.current_version_id AND r.type='informed_by' AND r.status='active'),'[]'),
        'current',?,? FROM claims c
      WHERE c.workspace_id=? AND c.project_id=? AND c.id IN (SELECT value FROM json_each(?))
        AND c.type='next_action' AND c.review_status='verified' AND c.lifecycle_status='active'
        AND json_extract((SELECT normalized_value_json FROM claim_versions
          WHERE id=c.current_version_id),'$.completed_action_claim_id') IS NULL
        AND NOT EXISTS (SELECT 1 FROM action_metadata a WHERE a.claim_id=c.id)`,
      timestamp,timestamp,scope.workspaceId,projectId,claimIds));
    statements.push(bind(`UPDATE workflow_cards SET revision=revision+1,updated_at=?,
      disposition=CASE WHEN NOT EXISTS (
        SELECT 1 FROM card_members pending JOIN claims c ON c.id=pending.claim_id
        WHERE pending.card_id=workflow_cards.id AND c.review_status='pending' AND c.lifecycle_status='active'
      ) THEN 'processed' ELSE disposition END,
      needs_decision=CASE WHEN NOT EXISTS (
        SELECT 1 FROM card_members pending JOIN claims c ON c.id=pending.claim_id
        WHERE pending.card_id=workflow_cards.id AND c.review_status='pending' AND c.lifecycle_status='active'
      ) THEN 0 ELSE needs_decision END
      WHERE workspace_id=? AND project_id=? AND id IN
        (SELECT card_id FROM card_members WHERE claim_id IN (SELECT value FROM json_each(?)))`,
      timestamp,scope.workspaceId,projectId,claimIds));
  }
  // A native edit may change a relation, answer, action state, glossary, or
  // source without replacing a claim version. The context is shared, so every
  // old narrative for this project becomes stale in the same transaction.
  statements.push(bind(`UPDATE workflow_narratives SET freshness='stale',updated_at=?
    WHERE workspace_id=? AND project_id=? AND freshness<>'stale'`,timestamp,scope.workspaceId,projectId));
  statements.push(bind(`UPDATE action_metadata AS a SET basis_state='needs_review',updated_at=?
    WHERE a.workspace_id=? AND a.project_id=? AND a.basis_state='current'
      AND EXISTS (SELECT 1 FROM json_each(a.basis_version_refs_json) frozen
        LEFT JOIN claims c ON c.id=json_extract(frozen.value,'$.claimId')
          AND c.workspace_id=a.workspace_id AND c.project_id=a.project_id
        WHERE c.id IS NULL OR c.current_version_id<>json_extract(frozen.value,'$.claimVersionId')
          OR c.review_status='rejected' OR c.lifecycle_status IN ('withdrawn','superseded'))
      OR a.workspace_id=? AND a.project_id=? AND a.basis_state='current'
      AND EXISTS (SELECT 1 FROM claims action_claim JOIN claim_relations r
        ON r.source_claim_version_id=action_claim.current_version_id
        WHERE action_claim.id=a.claim_id AND r.type='informed_by' AND r.status='active'
          AND NOT EXISTS (SELECT 1 FROM json_each(a.basis_version_refs_json) frozen
            WHERE json_extract(frozen.value,'$.claimVersionId')=r.target_claim_version_id))`,
    timestamp,scope.workspaceId,projectId,scope.workspaceId,projectId));
  statements.push(bind('DELETE FROM workflow_snapshots WHERE workspace_id=? AND project_id=?',scope.workspaceId,projectId));
  statements.push(bind(`INSERT INTO workflow_outbox
    (id,workspace_id,project_id,event_id,kind,task_key,input_revision,payload_json,available_at,created_at,updated_at)
    SELECT 'wjob_'||lower(hex(randomblob(16))),e.workspace_id,e.project_id,e.id,'narrative',
      'narrative:'||e.project_id||':'||e.id||':'||p.context_version,p.context_version,
      json_object('eventId',e.id,'contextVersion',p.context_version),?,?,?
    FROM events e JOIN projects p ON p.id=e.project_id AND p.workspace_id=e.workspace_id
    WHERE e.workspace_id=? AND e.project_id=? AND e.material_status<>'archived'
      AND (e.id=? OR EXISTS (SELECT 1 FROM workflow_narratives n WHERE n.workspace_id=e.workspace_id
        AND n.project_id=e.project_id AND (n.event_id=e.id OR n.event_id IS NULL))
        OR EXISTS (SELECT 1 FROM claims c WHERE c.event_id=e.id AND c.workspace_id=e.workspace_id
          AND c.project_id=e.project_id AND c.id IN (SELECT value FROM json_each(?))))
    ON CONFLICT(workspace_id,task_key) DO NOTHING`,
    new Date(Date.parse(timestamp)+2000).toISOString(),timestamp,timestamp,scope.workspaceId,projectId,options.eventId ?? '',claimIds));
  return statements;
}
