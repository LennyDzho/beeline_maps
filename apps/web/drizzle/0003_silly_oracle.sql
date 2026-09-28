DROP TABLE IF EXISTS `__new_workers`;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `work_schedules_organization_name_unique` ON `work_schedules` (`organization_id`,`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `work_schedules_organization_active_idx` ON `work_schedules` (`organization_id`,`active`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_schedule_days` (
	`schedule_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`start_time` text,
	`end_time` text,
	`break_start` text,
	`break_end` text,
	PRIMARY KEY(`schedule_id`, `weekday`),
	FOREIGN KEY (`schedule_id`) REFERENCES `work_schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "work_schedule_days_weekday_check" CHECK("weekday" between 1 and 7),
	CONSTRAINT "work_schedule_days_work_time_check" CHECK(("enabled" = 0) or ("start_time" is not null and "end_time" is not null and "start_time" < "end_time")),
	CONSTRAINT "work_schedule_days_break_check" CHECK(("break_start" is null and "break_end" is null) or ("break_start" is not null and "break_end" is not null and "break_start" < "break_end"))
);--> statement-breakpoint
ALTER TABLE `workers` ADD `work_schedule_id` text REFERENCES `work_schedules`(`id`) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `workers` ADD `start_address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `start_latitude` real;--> statement-breakpoint
ALTER TABLE `workers` ADD `start_longitude` real;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workers_work_schedule_id_idx` ON `workers` (`work_schedule_id`);
