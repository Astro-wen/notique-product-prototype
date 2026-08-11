CREATE TABLE `mutation_replays` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`endpoint_scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_mutation_replays_scope_key` ON `mutation_replays` (`workspace_id`,`actor_id`,`endpoint_scope`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_mutation_replays_created` ON `mutation_replays` (`created_at`);