CREATE TABLE `draft_link_candidates` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `project_id` text NOT NULL,
  `extraction_run_id` text NOT NULL,
  `source_claim_id` text NOT NULL,
  `source_claim_version_id` text NOT NULL,
  `target_draft_claim_id` text NOT NULL,
  `target_draft_claim_version_id` text NOT NULL,
  `type` text NOT NULL,
  `reason` text NOT NULL,
  `confidence` real NOT NULL,
  `status` text DEFAULT 'proposed' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`extraction_run_id`) REFERENCES `extraction_runs`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`source_claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`target_draft_claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_draft_link_candidate_pair` ON `draft_link_candidates` (`extraction_run_id`,`source_claim_version_id`,`target_draft_claim_version_id`,`type`);
--> statement-breakpoint
CREATE INDEX `idx_draft_link_candidates_project_status` ON `draft_link_candidates` (`project_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_draft_link_candidates_target` ON `draft_link_candidates` (`target_draft_claim_id`,`status`);
