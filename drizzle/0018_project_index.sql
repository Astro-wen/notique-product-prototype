ALTER TABLE projects ADD COLUMN folder_name TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN last_opened_at TEXT;
--> statement-breakpoint
ALTER TABLE projects ADD COLUMN name_source TEXT NOT NULL DEFAULT 'manual';
