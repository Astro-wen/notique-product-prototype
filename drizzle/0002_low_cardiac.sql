CREATE TABLE `mutation_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`guard_value` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ck_mutation_guards_true" CHECK("mutation_guards"."guard_value" = 1)
);
