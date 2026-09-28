CREATE TABLE IF NOT EXISTS `dispatcher_notification_cursors` (
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`delivered_sequence` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `organization_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dispatcher_notification_reads` (
	`user_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `sequence`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sequence`) REFERENCES `dispatcher_notifications`(`sequence`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `dispatcher_notifications` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`organization_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dispatcher_notification_kind" CHECK("dispatcher_notifications"."kind" in ('status', 'problem'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `dispatcher_notifications_scope_sequence_idx` ON `dispatcher_notifications` (`organization_id`,`sequence`);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS dispatcher_status_event AFTER UPDATE OF status ON work_orders
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO dispatcher_notifications (organization_id, work_order_id, kind, detail, created_at)
  VALUES (NEW.organization_id, NEW.id, 'status', NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS dispatcher_problem_event AFTER INSERT ON mobile_issues
BEGIN
  INSERT INTO dispatcher_notifications (organization_id, work_order_id, kind, detail, created_at)
  SELECT organization_id, NEW.work_order_id, 'problem', NEW.reason || ': ' || NEW.detail, NEW.created_at
  FROM work_orders WHERE id=NEW.work_order_id;
END;
