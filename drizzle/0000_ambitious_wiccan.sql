CREATE TABLE `asset_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`content_sha256` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`parser_version` text,
	`r2_original_key` text NOT NULL,
	`r2_model_key` text,
	`model_derivative_sha256` text,
	`derived_from_asset_version_id` text,
	`transform_json` text,
	`finalized_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asset_versions_asset_version` ON `asset_versions` (`asset_id`,`version_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asset_versions_r2_key` ON `asset_versions` (`r2_original_key`);--> statement-breakpoint
CREATE INDEX `idx_asset_versions_asset_hash` ON `asset_versions` (`asset_id`,`content_sha256`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`current_version_id` text,
	`captured_at` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`processing_status` text DEFAULT 'uploading' NOT NULL,
	`staged_r2_key` text,
	`staged_sha256` text,
	`staged_mime_type` text,
	`staged_size_bytes` integer,
	`failure_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_assets_event_status` ON `assets` (`event_id`,`processing_status`);--> statement-breakpoint
CREATE INDEX `idx_assets_workspace_project` ON `assets` (`workspace_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `claim_occurrence_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`target_claim_id` text NOT NULL,
	`target_claim_version_id` text NOT NULL,
	`event_id` text NOT NULL,
	`extraction_run_id` text NOT NULL,
	`evidence_ref_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`base_version_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_occurrence_candidates_run_status` ON `claim_occurrence_candidates` (`extraction_run_id`,`status`);--> statement-breakpoint
CREATE TABLE `claim_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`claim_version_id` text NOT NULL,
	`event_id` text NOT NULL,
	`evidence_ref_id` text NOT NULL,
	`occurrence_verdict_id` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claim_occurrences_verdict` ON `claim_occurrences` (`occurrence_verdict_id`);--> statement-breakpoint
CREATE INDEX `idx_claim_occurrences_claim_event` ON `claim_occurrences` (`claim_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `claim_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`type` text NOT NULL,
	`source_claim_version_id` text NOT NULL,
	`target_claim_version_id` text NOT NULL,
	`context_version` integer NOT NULL,
	`replaces_relation_id` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`contradiction_status` text,
	`resolved_at` text,
	`resolved_by_verdict_id` text,
	`resolved_by_relation_id` text,
	`reason` text,
	`confidence` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_claim_relations_project_status` ON `claim_relations` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_claim_relations_source_status` ON `claim_relations` (`source_claim_version_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_claim_relations_target_status` ON `claim_relations` (`target_claim_version_id`,`status`);--> statement-breakpoint
CREATE TABLE `claim_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`statement` text NOT NULL,
	`normalized_value_json` text,
	`uncertainty_json` text,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claim_versions_claim_version` ON `claim_versions` (`claim_id`,`version_no`);--> statement-breakpoint
CREATE INDEX `idx_claim_versions_claim_created` ON `claim_versions` (`claim_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`extraction_run_id` text NOT NULL,
	`client_claim_key` text NOT NULL,
	`type` text NOT NULL,
	`materiality` text NOT NULL,
	`confidence` real,
	`needs_additional_evidence` integer DEFAULT false NOT NULL,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`lifecycle_status` text DEFAULT 'active' NOT NULL,
	`current_version_id` text,
	`first_event_id` text NOT NULL,
	`source` text DEFAULT 'ai' NOT NULL,
	`opened_at` text,
	`last_repeated_at` text,
	`repeat_count` integer DEFAULT 0 NOT NULL,
	`resolved_at` text,
	`withdraw_reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claims_run_client_key` ON `claims` (`extraction_run_id`,`client_claim_key`);--> statement-breakpoint
CREATE INDEX `idx_claims_project_review_lifecycle` ON `claims` (`project_id`,`review_status`,`lifecycle_status`);--> statement-breakpoint
CREATE INDEX `idx_claims_run_review` ON `claims` (`extraction_run_id`,`review_status`);--> statement-breakpoint
CREATE INDEX `idx_claims_project_type` ON `claims` (`project_id`,`type`);--> statement-breakpoint
CREATE TABLE `context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`extraction_run_id` text NOT NULL,
	`context_version` integer NOT NULL,
	`snapshot_hash` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_context_snapshots_run` ON `context_snapshots` (`extraction_run_id`);--> statement-breakpoint
CREATE INDEX `idx_context_snapshots_project_version` ON `context_snapshots` (`project_id`,`context_version`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_type` text NOT NULL,
	`title` text NOT NULL,
	`occurred_at` text NOT NULL,
	`sequence_no` integer NOT NULL,
	`material_status` text DEFAULT 'draft' NOT NULL,
	`active_run_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_project_sequence` ON `events` (`project_id`,`sequence_no`);--> statement-breakpoint
CREATE INDEX `idx_events_workspace_project` ON `events` (`workspace_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `idx_events_project_occurred` ON `events` (`project_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `evidence_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`claim_version_id` text NOT NULL,
	`kind` text NOT NULL,
	`asset_version_id` text,
	`user_note_id` text,
	`segment_ids_json` text,
	`quote_raw` text,
	`start_ms` integer,
	`end_ms` integer,
	`page_number` integer,
	`bbox_json` text,
	`observation` text,
	`evidence_role` text NOT NULL,
	`provenance_grade` text NOT NULL,
	`structural_validation_status` text NOT NULL,
	`semantic_support_verdict` text DEFAULT 'unreviewed' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`claim_version_id`) REFERENCES `claim_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_refs_claim_version` ON `evidence_refs` (`claim_version_id`);--> statement-breakpoint
CREATE INDEX `idx_evidence_refs_asset_version` ON `evidence_refs` (`asset_version_id`);--> statement-breakpoint
CREATE INDEX `idx_evidence_refs_project_event` ON `evidence_refs` (`project_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `extraction_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_snapshot_hash` text NOT NULL,
	`input_manifest_json` text NOT NULL,
	`context_version` integer NOT NULL,
	`context_snapshot_hash` text NOT NULL,
	`provider` text,
	`model` text,
	`model_params_json` text DEFAULT '{}' NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`parser_version` text NOT NULL,
	`attempt_no` integer DEFAULT 1 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`queued_at` text,
	`started_at` text,
	`finished_at` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`image_units` integer,
	`estimated_cost_usd` real,
	`provider_request_id` text,
	`error_code` text,
	`error_details_json` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_extraction_runs_event_idempotency` ON `extraction_runs` (`event_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_extraction_runs_project_status` ON `extraction_runs` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_extraction_runs_event_created` ON `extraction_runs` (`event_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_extraction_runs_lease` ON `extraction_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `gap_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ledger_version` integer NOT NULL,
	`scenario_version` integer NOT NULL,
	`overlay_version` text NOT NULL,
	`missing_slots_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_gap_checks_cache_key` ON `gap_checks` (`project_id`,`ledger_version`,`scenario_version`,`overlay_version`);--> statement-breakpoint
CREATE TABLE `glossary_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`canonical_value` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`source_claim_id` text NOT NULL,
	`source_claim_version_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_glossary_entries_project` ON `glossary_entries` (`project_id`);--> statement-breakpoint
CREATE TABLE `occurrence_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`action` text NOT NULL,
	`target_base_version_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`candidate_id`) REFERENCES `claim_occurrence_candidates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_occurrence_verdicts_candidate` ON `occurrence_verdicts` (`candidate_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`scenario` text,
	`scenario_status` text DEFAULT 'unassessed' NOT NULL,
	`scenario_candidates_json` text DEFAULT '[]' NOT NULL,
	`scenario_assessment_run_id` text,
	`scenario_version` integer DEFAULT 0 NOT NULL,
	`scenario_lease_expires_at` text,
	`scenario_assessment_attempt` integer DEFAULT 0 NOT NULL,
	`scenario_confirmed_by` text,
	`scenario_confirmed_at` text,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`ledger_version` integer DEFAULT 0 NOT NULL,
	`context_version` integer DEFAULT 0 NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_projects_workspace_updated` ON `projects` (`workspace_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_projects_workspace_active` ON `projects` (`workspace_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `queue_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`last_error_code` text,
	`sent_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_queue_outbox_run` ON `queue_outbox` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_queue_outbox_dispatch` ON `queue_outbox` (`status`,`next_attempt_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `relation_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`relation_id` text NOT NULL,
	`action` text NOT NULL,
	`base_relation_status` text NOT NULL,
	`winning_claim_version_id` text,
	`evidence_selection_json` text,
	`secondary_evidence_note` text,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`relation_id`) REFERENCES `claim_relations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_relation_verdicts_relation` ON `relation_verdicts` (`relation_id`);--> statement-breakpoint
CREATE TABLE `scenario_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scenario_version` integer NOT NULL,
	`scenario` text NOT NULL,
	`source` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scenario_verdicts_project_version` ON `scenario_verdicts` (`project_id`,`scenario_version`);--> statement-breakpoint
CREATE TABLE `text_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`asset_version_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`speaker` text,
	`start_ms` integer,
	`end_ms` integer,
	`parser_version` text NOT NULL,
	`text_raw` text NOT NULL,
	`text_normalized` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`asset_version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_text_segments_asset_version_ordinal` ON `text_segments` (`asset_version_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_text_segments_event_ordinal` ON `text_segments` (`event_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `idx_text_segments_project_event` ON `text_segments` (`project_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `transcript_import_items` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`upload_status` text DEFAULT 'pending' NOT NULL,
	`r2_key` text,
	`content_sha256` text,
	`uploaded_size_bytes` integer,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `transcript_imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_transcript_import_items_import` ON `transcript_import_items` (`import_id`);--> statement-breakpoint
CREATE TABLE `transcript_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`item_count` integer NOT NULL,
	`expires_at` text NOT NULL,
	`finalized_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_transcript_imports_project_status` ON `transcript_imports` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `user_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`verdict_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_user_notes_claim` ON `user_notes` (`claim_id`);--> statement-breakpoint
CREATE TABLE `verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`action` text NOT NULL,
	`base_version_id` text NOT NULL,
	`new_version_id` text,
	`user_id` text NOT NULL,
	`explanation` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_verdicts_claim_created` ON `verdicts` (`claim_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `view_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ledger_version` integer NOT NULL,
	`scenario_version` integer NOT NULL,
	`view_type` text NOT NULL,
	`builder_version` text NOT NULL,
	`locale` text NOT NULL,
	`model` text,
	`prompt_version` text,
	`schema_version` text,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_view_snapshots_cache_key` ON `view_snapshots` (`project_id`,`ledger_version`,`scenario_version`,`view_type`,`builder_version`,`locale`);--> statement-breakpoint
CREATE INDEX `idx_view_snapshots_project_type` ON `view_snapshots` (`project_id`,`view_type`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
