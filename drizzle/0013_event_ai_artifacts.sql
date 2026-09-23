CREATE TABLE `event_ai_artifact_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`extraction_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`input_manifest_json` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_effort` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`provider_request_id` text,
	`validated_output_json` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`attempt_no` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`error_code` text,
	`error_details_json` text,
	`queued_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_event_ai_artifact_runs_idempotency` ON `event_ai_artifact_runs` (`event_id`,`kind`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_event_ai_artifact_runs_dispatch` ON `event_ai_artifact_runs` (`status`,`next_attempt_at`,`lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_event_ai_artifact_runs_extraction` ON `event_ai_artifact_runs` (`extraction_run_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `event_ai_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`artifact_version` integer NOT NULL,
	`input_hash` text NOT NULL,
	`content_json` text NOT NULL,
	`derived_asset_id` text,
	`derived_asset_version_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `event_ai_artifact_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_event_ai_artifacts_input` ON `event_ai_artifacts` (`event_id`,`kind`,`input_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_event_ai_artifacts_run` ON `event_ai_artifacts` (`run_id`);
--> statement-breakpoint
CREATE INDEX `idx_event_ai_artifacts_event_kind` ON `event_ai_artifacts` (`event_id`,`kind`,`created_at`);
--> statement-breakpoint
CREATE TABLE `readable_segment_sources` (
	`artifact_id` text NOT NULL,
	`readable_segment_id` text NOT NULL,
	`source_segment_id` text NOT NULL,
	`source_order` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `event_ai_artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`readable_segment_id`) REFERENCES `text_segments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_segment_id`) REFERENCES `text_segments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_readable_segment_sources_mapping` ON `readable_segment_sources` (`artifact_id`,`readable_segment_id`,`source_segment_id`);
--> statement-breakpoint
CREATE INDEX `idx_readable_segment_sources_source` ON `readable_segment_sources` (`source_segment_id`);
