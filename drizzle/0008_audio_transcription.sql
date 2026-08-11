CREATE TABLE `transcription_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`audio_asset_id` text NOT NULL,
	`audio_asset_version_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_hash` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`response_format` text DEFAULT 'diarized_json' NOT NULL,
	`request_timeout_ms` integer NOT NULL,
	`staged_result_r2_key` text,
	`staged_result_sha256` text,
	`derived_transcript_asset_id` text,
	`derived_transcript_asset_version_id` text,
	`segment_count` integer,
	`duration_ms` integer,
	`provider_request_id` text,
	`attempt_no` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`error_code` text,
	`error_details_json` text,
	`queued_at` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audio_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audio_asset_version_id`) REFERENCES `asset_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transcription_runs_audio_idempotency` ON `transcription_runs` (`audio_asset_version_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_transcription_runs_workspace_status` ON `transcription_runs` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_transcription_runs_event_created` ON `transcription_runs` (`event_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_transcription_runs_lease` ON `transcription_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `transcription_queue_outbox` (
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
	FOREIGN KEY (`run_id`) REFERENCES `transcription_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transcription_queue_outbox_run` ON `transcription_queue_outbox` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_transcription_queue_outbox_dispatch` ON `transcription_queue_outbox` (`status`,`next_attempt_at`,`lease_expires_at`);
