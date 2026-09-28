CREATE TABLE IF NOT EXISTS `application_dataset` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`version`) REFERENCES `dataset_imports`(`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "application_dataset_singleton" CHECK("application_dataset"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dataset_imports` (
	`version` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`manifest_json` text NOT NULL,
	`imported_by_user_id` text NOT NULL,
	`imported_at` text NOT NULL,
	`empty_target_guard` integer NOT NULL,
	FOREIGN KEY (`imported_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dataset_import_empty_target" CHECK("dataset_imports"."empty_target_guard" = 1)
);
--> statement-breakpoint
ALTER TABLE `work_categories` ADD `service_duration_minutes` integer;--> statement-breakpoint
ALTER TABLE `work_categories` ADD `duration_source` text DEFAULT '' NOT NULL;
