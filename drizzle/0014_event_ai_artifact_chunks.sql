CREATE TABLE `event_ai_artifact_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_run_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`input_hash` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_request_id` text,
	`validated_output_json` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`attempt_no` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`artifact_run_id`) REFERENCES `event_ai_artifact_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_event_ai_artifact_chunks_order` ON `event_ai_artifact_chunks` (`artifact_run_id`,`chunk_index`);
--> statement-breakpoint
CREATE INDEX `idx_event_ai_artifact_chunks_status` ON `event_ai_artifact_chunks` (`artifact_run_id`,`status`);
