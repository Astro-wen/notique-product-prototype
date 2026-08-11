CREATE TABLE `review_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`duration_ms` integer,
	`initial_pending_claim_count` integer NOT NULL,
	`initial_pending_occurrence_count` integer NOT NULL,
	`remaining_pending_claim_count` integer NOT NULL,
	`remaining_pending_occurrence_count` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `ck_review_sessions_status` CHECK (`status` IN ('active', 'completed', 'abandoned')),
	CONSTRAINT `ck_review_sessions_initial_work` CHECK (`initial_pending_claim_count` + `initial_pending_occurrence_count` > 0),
	CONSTRAINT `ck_review_sessions_nonnegative_counts` CHECK (`initial_pending_claim_count` >= 0 AND `initial_pending_occurrence_count` >= 0 AND `remaining_pending_claim_count` >= 0 AND `remaining_pending_occurrence_count` >= 0),
	CONSTRAINT `ck_review_sessions_duration` CHECK (`duration_ms` IS NULL OR `duration_ms` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_sessions_active_actor_project` ON `review_sessions` (`workspace_id`,`project_id`,`actor_id`) WHERE `status` = 'active';--> statement-breakpoint
CREATE INDEX `idx_review_sessions_project_started` ON `review_sessions` (`workspace_id`,`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_review_sessions_actor_status` ON `review_sessions` (`workspace_id`,`actor_id`,`status`);
