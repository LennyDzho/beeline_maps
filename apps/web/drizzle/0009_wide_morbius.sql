CREATE TABLE `mobile_commands` (
	`user_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`accepted` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `operation_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mobile_command_precondition" CHECK("mobile_commands"."accepted" = 1)
);
--> statement-breakpoint
CREATE TABLE `mobile_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`work_order_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `mobile_issues_order_created_idx` ON `mobile_issues` (`work_order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mobile_notice_reads` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mobile_session_bindings` (
	`session_id` text PRIMARY KEY NOT NULL,
	`worker_id` text NOT NULL,
	`organization_id` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `work_orders` ADD `revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER work_orders_increment_revision AFTER UPDATE ON work_orders
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE work_orders SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
