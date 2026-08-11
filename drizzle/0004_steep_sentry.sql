ALTER TABLE `transcript_import_items` ADD `event_id` text;--> statement-breakpoint
ALTER TABLE `transcript_import_items` ADD `asset_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transcript_import_items_event` ON `transcript_import_items` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transcript_import_items_asset` ON `transcript_import_items` (`asset_id`);