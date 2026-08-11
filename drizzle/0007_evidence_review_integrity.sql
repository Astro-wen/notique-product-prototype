CREATE TABLE `claim_evidence_review_attestations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`claim_id` text NOT NULL,
	`claim_version_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`claim_version_id`) REFERENCES `claim_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_claim_evidence_review_actor_version` ON `claim_evidence_review_attestations` (`workspace_id`,`actor_id`,`claim_id`,`claim_version_id`);
--> statement-breakpoint
CREATE INDEX `idx_claim_evidence_review_version` ON `claim_evidence_review_attestations` (`claim_version_id`,`actor_id`);
