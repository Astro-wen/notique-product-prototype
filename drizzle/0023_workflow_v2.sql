-- Workflow V2 extends the existing ledger. Existing decisions and versions remain intact.
ALTER TABLE events ADD COLUMN source_revision integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE claims ADD COLUMN workflow_revision integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE claim_versions ADD COLUMN workflow_origin text;
--> statement-breakpoint
ALTER TABLE verdicts ADD COLUMN workflow_decision_id text;
--> statement-breakpoint
ALTER TABLE verdicts ADD COLUMN workflow_member_id text;
--> statement-breakpoint
DROP INDEX uq_verdicts_claim_base_action;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_verdicts_workflow_member ON verdicts(workflow_decision_id, workflow_member_id);
--> statement-breakpoint
CREATE TABLE workflow_cards (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  group_key text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  kind text NOT NULL CHECK(kind IN ('record','question','action','conflict')),
  title text NOT NULL,
  needs_decision integer NOT NULL DEFAULT 0 CHECK(needs_decision IN (0,1)),
  reason_code text CHECK(reason_code IN ('accepted_change','blocking_question','action_choice')),
  reason text NOT NULL DEFAULT '',
  disposition text NOT NULL DEFAULT 'active' CHECK(disposition IN ('active','processed')),
  latest_decision_id text,
  decision_revision integer,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_workflow_cards_group ON workflow_cards(workspace_id,event_id,group_key);
--> statement-breakpoint
CREATE INDEX idx_workflow_cards_project ON workflow_cards(workspace_id,project_id,event_id);
--> statement-breakpoint
CREATE TABLE card_members (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  card_id text NOT NULL REFERENCES workflow_cards(id) ON DELETE CASCADE,
  claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  claim_version_id text NOT NULL REFERENCES claim_versions(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'primary' CHECK(role IN ('primary','context')),
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_card_members_version ON card_members(card_id,claim_version_id);
--> statement-breakpoint
CREATE INDEX idx_card_members_claim ON card_members(workspace_id,claim_id);
--> statement-breakpoint
CREATE TABLE workflow_decisions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  card_id text REFERENCES workflow_cards(id) ON DELETE SET NULL,
  actor_id text NOT NULL,
  operation text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  idempotency_key text NOT NULL,
  context_version integer NOT NULL,
  reversal_of text REFERENCES workflow_decisions(id) ON DELETE SET NULL,
  reverted_by text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_workflow_decisions_key ON workflow_decisions(workspace_id,actor_id,card_id,idempotency_key);
--> statement-breakpoint
CREATE INDEX idx_workflow_decisions_event ON workflow_decisions(workspace_id,project_id,event_id,created_at);
--> statement-breakpoint
CREATE TABLE decision_members (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id text NOT NULL REFERENCES workflow_decisions(id) ON DELETE CASCADE,
  claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  verdict_id text REFERENCES verdicts(id) ON DELETE SET NULL,
  before_version_id text NOT NULL REFERENCES claim_versions(id) ON DELETE CASCADE,
  after_version_id text NOT NULL REFERENCES claim_versions(id) ON DELETE CASCADE,
  before_state_json text NOT NULL,
  after_state_json text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_decision_members_claim ON decision_members(decision_id,claim_id);
--> statement-breakpoint
CREATE TABLE review_deferrals (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  card_id text NOT NULL REFERENCES workflow_cards(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  until_at text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_review_deferrals_actor ON review_deferrals(card_id,actor_id);
--> statement-breakpoint
CREATE TABLE review_progress (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  last_card_id text REFERENCES workflow_cards(id) ON DELETE SET NULL,
  snapshot_id text NOT NULL,
  finished_at text,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_review_progress_actor ON review_progress(event_id,actor_id);
--> statement-breakpoint
CREATE TABLE workflow_narratives (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  scope_kind text NOT NULL CHECK(scope_kind IN ('accepted','draft','mixed')),
  based_on_context_version integer NOT NULL,
  text text NOT NULL DEFAULT '',
  sentence_refs_json text NOT NULL DEFAULT '[]',
  freshness text NOT NULL CHECK(freshness IN ('current','stale','updating','failed')),
  input_hash text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_workflow_narratives_version ON workflow_narratives(workspace_id,scope_key,scope_kind,based_on_context_version);
--> statement-breakpoint
CREATE INDEX idx_workflow_narratives_project ON workflow_narratives(workspace_id,project_id,event_id);
--> statement-breakpoint
CREATE TABLE derived_dependencies (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id) ON DELETE CASCADE,
  derived_type text NOT NULL,
  derived_id text NOT NULL,
  claim_version_id text REFERENCES claim_versions(id) ON DELETE CASCADE,
  asset_version_id text REFERENCES asset_versions(id) ON DELETE CASCADE,
  scope text NOT NULL,
  CHECK(claim_version_id IS NOT NULL OR asset_version_id IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX idx_derived_dependencies_claim ON derived_dependencies(workspace_id,claim_version_id);
--> statement-breakpoint
CREATE INDEX idx_derived_dependencies_asset ON derived_dependencies(workspace_id,asset_version_id);
--> statement-breakpoint
CREATE INDEX idx_derived_dependencies_output ON derived_dependencies(workspace_id,derived_type,derived_id);
--> statement-breakpoint
CREATE TABLE workflow_snapshots (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  context_version integer NOT NULL,
  source_revision integer NOT NULL,
  payload_json text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_workflow_snapshots_scope ON workflow_snapshots(workspace_id,project_id,event_id,actor_id,context_version);
--> statement-breakpoint
CREATE INDEX idx_workflow_snapshots_expiry ON workflow_snapshots(expires_at);
--> statement-breakpoint
CREATE TABLE action_metadata (
  claim_id text PRIMARY KEY NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  basis_version_refs_json text NOT NULL DEFAULT '[]',
  basis_state text NOT NULL DEFAULT 'current' CHECK(basis_state IN ('current','needs_review')),
  cancelled_at text,
  owner_hint text,
  due_at text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_action_metadata_project ON action_metadata(workspace_id,project_id,event_id);
--> statement-breakpoint
CREATE TABLE workflow_outcomes (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK(subject_type IN ('action','question')),
  subject_claim_id text NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  current_version_id text,
  author_id text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_workflow_outcomes_subject ON workflow_outcomes(workspace_id,subject_claim_id,created_at);
--> statement-breakpoint
CREATE TABLE outcome_versions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  outcome_id text NOT NULL REFERENCES workflow_outcomes(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision > 0),
  text text NOT NULL,
  evidence_refs_json text NOT NULL DEFAULT '[]',
  answer_claim_version_ids_json text NOT NULL DEFAULT '[]',
  relation_ids_json text NOT NULL DEFAULT '[]',
  supersedes_version_id text REFERENCES outcome_versions(id) ON DELETE SET NULL,
  withdrawn_at text,
  author_id text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_outcome_versions_revision ON outcome_versions(outcome_id,revision);
--> statement-breakpoint
CREATE TABLE workflow_changes (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id) ON DELETE CASCADE,
  mutation_id text NOT NULL,
  context_version integer NOT NULL,
  actor_id text NOT NULL,
  kind text NOT NULL,
  changed_refs_json text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_workflow_changes_project ON workflow_changes(workspace_id,project_id,context_version);
--> statement-breakpoint
CREATE TABLE workflow_reports (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  event_ids_json text NOT NULL,
  context_version integer NOT NULL,
  scope text NOT NULL CHECK(scope IN ('accepted','mixed')),
  format text NOT NULL CHECK(format IN ('markdown','plain_text')),
  content text NOT NULL,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX idx_workflow_reports_project ON workflow_reports(workspace_id,project_id,context_version);
--> statement-breakpoint
CREATE TABLE workflow_outbox (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text REFERENCES events(id) ON DELETE CASCADE,
  kind text NOT NULL,
  task_key text NOT NULL,
  input_revision integer NOT NULL,
  payload_json text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
  available_at text NOT NULL,
  lease_owner text,
  lease_expires_at text,
  fencing_token integer NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  error_code text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_workflow_outbox_task ON workflow_outbox(workspace_id,task_key);
--> statement-breakpoint
CREATE INDEX idx_workflow_outbox_dispatch ON workflow_outbox(state,available_at,lease_expires_at);
--> statement-breakpoint
CREATE TABLE workspace_members (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('viewer','editor','owner')),
  revoked_at text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_workspace_members_actor ON workspace_members(workspace_id,actor_id);
--> statement-breakpoint
CREATE TABLE access_grants (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  token_hash text NOT NULL,
  scope text NOT NULL CHECK(scope = 'mcp:read'),
  expires_at text NOT NULL,
  revoked_at text,
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_access_grants_hash ON access_grants(token_hash);
--> statement-breakpoint
CREATE INDEX idx_access_grants_actor ON access_grants(workspace_id,actor_id);
