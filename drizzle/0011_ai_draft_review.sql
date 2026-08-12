CREATE TABLE `ai_draft_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event_id` text NOT NULL,
	`extraction_run_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`assessment` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_ai_draft_assessment_actor_run` ON `ai_draft_assessments` (`workspace_id`,`actor_id`,`extraction_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_ai_draft_assessments_project_created` ON `ai_draft_assessments` (`project_id`,`created_at`);
