ALTER TABLE `transcription_runs` ADD `orchestration_mode` text DEFAULT 'single' NOT NULL;
--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `parent_run_id` text;
--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `chunk_index` integer;
--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `chunk_start_ms` integer;
--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `chunk_end_ms` integer;
--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `chunk_count` integer;
--> statement-breakpoint
ALTER TABLE `transcription_runs` ADD `completed_chunk_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_transcription_runs_parent_chunk`
  ON `transcription_runs` (`parent_run_id`,`chunk_index`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transcription_runs_parent_chunk`
  ON `transcription_runs` (`parent_run_id`,`chunk_index`)
  WHERE `parent_run_id` IS NOT NULL;
