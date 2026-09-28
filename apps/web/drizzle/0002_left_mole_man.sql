ALTER TABLE `organizations` ADD `application_name` text DEFAULT 'Маршрут FSM' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `email_alerts` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `weekly_digest` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`service_area_id` text,
	`employee_number` text NOT NULL,
	`full_name` text NOT NULL,
	`phone` text NOT NULL,
	`shift_status` text DEFAULT 'off_shift' NOT NULL,
	`load_percent` integer DEFAULT 0 NOT NULL,
	`transport_mode` text DEFAULT 'none' NOT NULL,
	`transport_details` text DEFAULT '' NOT NULL,
	`qualification_warning` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_area_id`) REFERENCES `service_areas`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workers_shift_status_check" CHECK("__new_workers"."shift_status" in ('on_shift', 'break', 'off_shift')),
	CONSTRAINT "workers_load_percent_check" CHECK("__new_workers"."load_percent" between 0 and 100),
	CONSTRAINT "workers_transport_mode_check" CHECK("__new_workers"."transport_mode" in ('car', 'transit', 'none'))
);
--> statement-breakpoint
INSERT INTO `__new_workers`("id", "organization_id", "user_id", "service_area_id", "employee_number", "full_name", "phone", "shift_status", "load_percent", "transport_mode", "transport_details", "qualification_warning", "active", "created_at", "updated_at") SELECT "id", "organization_id", "user_id", "service_area_id", "employee_number", "full_name", "phone", "shift_status", "load_percent", 'none', '', false, "active", "created_at", "updated_at" FROM `workers`;--> statement-breakpoint
DROP TABLE `workers`;--> statement-breakpoint
ALTER TABLE `__new_workers` RENAME TO `workers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `workers_organization_employee_unique` ON `workers` (`organization_id`,`employee_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `workers_user_id_unique` ON `workers` (`user_id`);--> statement-breakpoint
CREATE INDEX `workers_service_area_id_idx` ON `workers` (`service_area_id`);
