ALTER TABLE `organizations` ADD `office_address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `office_latitude` real;--> statement-breakpoint
ALTER TABLE `organizations` ADD `office_longitude` real;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `building_address` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `apartment` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `entrance` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `intercom` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `scheduling_timezone` text;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `client_window_start` text;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `client_window_end` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `timezone` text;