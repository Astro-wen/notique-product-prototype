ALTER TABLE `extraction_runs` ADD `first_queued_at` text;--> statement-breakpoint
ALTER TABLE `extraction_runs` ADD `current_queued_at` text;--> statement-breakpoint
ALTER TABLE `extraction_runs` ADD `first_started_at` text;--> statement-breakpoint
ALTER TABLE `extraction_runs` ADD `current_started_at` text;--> statement-breakpoint
UPDATE `extraction_runs`
   SET `first_queued_at` = COALESCE(`queued_at`, `created_at`),
       `current_queued_at` = COALESCE(`queued_at`, `created_at`),
       `first_started_at` = `started_at`,
       `current_started_at` = `started_at`;--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `first_queued_at` text;--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `current_queued_at` text;--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `first_started_at` text;--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `current_started_at` text;--> statement-breakpoint
UPDATE `transcription_runs`
   SET `first_queued_at` = COALESCE(`queued_at`, `created_at`),
       `current_queued_at` = COALESCE(`queued_at`, `created_at`),
       `first_started_at` = `started_at`,
       `current_started_at` = `started_at`;
