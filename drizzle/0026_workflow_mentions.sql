-- Freeze optional occurrence choices for atomic reversal without changing the old claim.
CREATE TABLE workflow_mention_decisions (
  decision_id text PRIMARY KEY NOT NULL REFERENCES workflow_decisions(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES claim_occurrence_candidates(id) ON DELETE CASCADE,
  candidate_fingerprint text NOT NULL,
  after_status text NOT NULL CHECK(after_status IN ('confirmed','rejected','converted')),
  converted_claim_id text REFERENCES claims(id) ON DELETE SET NULL,
  converted_version_id text REFERENCES claim_versions(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX idx_workflow_mention_decisions_candidate ON workflow_mention_decisions(workspace_id,candidate_id);
