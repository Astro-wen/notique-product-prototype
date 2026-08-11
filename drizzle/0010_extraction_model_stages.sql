CREATE TABLE `extraction_model_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_effort` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`input_hash` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cached_tokens` integer,
	`estimated_cost_usd` real,
	`provider_request_id` text,
	`validated_output_json` text,
	`error_code` text,
	`error_details_json` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`duration_ms` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `ck_extraction_model_stages_stage` CHECK (`stage` IN ('inventory', 'verify', 'verify_escalated')),
	CONSTRAINT `ck_extraction_model_stages_status` CHECK (`status` IN ('processing', 'succeeded', 'failed')),
	CONSTRAINT `ck_extraction_model_stages_attempt` CHECK (`attempt` >= 1),
	CONSTRAINT `ck_extraction_model_stages_tokens` CHECK ((`input_tokens` IS NULL OR `input_tokens` >= 0) AND (`output_tokens` IS NULL OR `output_tokens` >= 0) AND (`cached_tokens` IS NULL OR `cached_tokens` >= 0)),
	CONSTRAINT `ck_extraction_model_stages_duration` CHECK (`duration_ms` IS NULL OR `duration_ms` >= 0),
	CONSTRAINT `ck_extraction_model_stages_success_output` CHECK (`status` <> 'succeeded' OR `validated_output_json` IS NOT NULL),
	CONSTRAINT `ck_extraction_model_stages_failed_output` CHECK (`status` <> 'failed' OR `validated_output_json` IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_extraction_model_stages_run_stage_attempt` ON `extraction_model_stages` (`run_id`,`stage`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_extraction_model_stages_run_stage` ON `extraction_model_stages` (`run_id`,`stage`);--> statement-breakpoint
CREATE INDEX `idx_extraction_model_stages_status` ON `extraction_model_stages` (`status`,`updated_at`);
