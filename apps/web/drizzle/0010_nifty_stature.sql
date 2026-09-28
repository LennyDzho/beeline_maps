PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_work_orders` (
	`revision` integer DEFAULT 0 NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`number` text NOT NULL,
	`work_type_version_id` text NOT NULL,
	`service_object_id` text,
	`assignee_worker_id` text,
	`resource_id` text,
	`created_by_user_id` text NOT NULL,
	`confirmed_by_user_id` text,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`scheduled_start` text NOT NULL,
	`scheduled_end` text,
	`address_snapshot` text NOT NULL,
	`latitude_snapshot` real,
	`longitude_snapshot` real,
	`completed_at` text,
	`confirmed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_type_version_id`) REFERENCES `work_type_versions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`service_object_id`) REFERENCES `service_objects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "work_orders_priority_check" CHECK("__new_work_orders"."priority" in ('high', 'medium', 'low')),
	CONSTRAINT "work_orders_status_check" CHECK("__new_work_orders"."status" in ('new', 'assigned', 'en_route', 'in_progress', 'paused', 'completed', 'confirmed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_work_orders`("revision", "id", "organization_id", "number", "work_type_version_id", "service_object_id", "assignee_worker_id", "resource_id", "created_by_user_id", "confirmed_by_user_id", "description", "priority", "status", "scheduled_start", "scheduled_end", "address_snapshot", "latitude_snapshot", "longitude_snapshot", "completed_at", "confirmed_at", "created_at", "updated_at") SELECT "revision", "id", "organization_id", "number", "work_type_version_id", "service_object_id", "assignee_worker_id", "resource_id", "created_by_user_id", "confirmed_by_user_id", "description", "priority", "status", "scheduled_start", "scheduled_end", "address_snapshot", "latitude_snapshot", "longitude_snapshot", "completed_at", "confirmed_at", "created_at", "updated_at" FROM `work_orders`;--> statement-breakpoint
DROP TABLE `work_orders`;--> statement-breakpoint
ALTER TABLE `__new_work_orders` RENAME TO `work_orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `work_orders_organization_number_unique` ON `work_orders` (`organization_id`,`number`);--> statement-breakpoint
CREATE INDEX `work_orders_organization_status_idx` ON `work_orders` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `work_orders_assignee_schedule_idx` ON `work_orders` (`assignee_worker_id`,`scheduled_start`);--> statement-breakpoint
CREATE INDEX `work_orders_work_type_version_idx` ON `work_orders` (`work_type_version_id`);
--> statement-breakpoint
CREATE TRIGGER work_orders_increment_revision AFTER UPDATE ON work_orders
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE work_orders SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
