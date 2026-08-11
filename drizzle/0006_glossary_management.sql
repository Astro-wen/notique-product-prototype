ALTER TABLE `glossary_entries` ADD `category` text DEFAULT 'general' NOT NULL;
--> statement-breakpoint
ALTER TABLE `glossary_entries` ADD `source_type` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `glossary_entries` ADD `source_label` text;
--> statement-breakpoint
ALTER TABLE `glossary_entries` ADD `is_active` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `glossary_entries` ADD `version` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `glossary_entries` ADD `updated_at` text;
--> statement-breakpoint
ALTER TABLE `glossary_entries` ADD `deleted_at` text;
--> statement-breakpoint
UPDATE `glossary_entries`
SET `source_type` = 'verified_claim'
WHERE `source_claim_version_id` <> 'manual';
--> statement-breakpoint
UPDATE `glossary_entries` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_glossary_entries_project_active` ON `glossary_entries` (`project_id`,`is_active`,`deleted_at`);
--> statement-breakpoint
CREATE TABLE `glossary_entry_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`action` text NOT NULL,
	`base_version` integer,
	`result_version` integer NOT NULL,
	`actor_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_glossary_entry_audits_entry` ON `glossary_entry_audits` (`entry_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_glossary_entry_audits_project` ON `glossary_entry_audits` (`project_id`,`created_at`);
