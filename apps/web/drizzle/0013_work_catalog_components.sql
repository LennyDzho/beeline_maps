CREATE TABLE IF NOT EXISTS `category_work_types` (
	`category_id` text NOT NULL,
	`work_type_id` text NOT NULL,
	PRIMARY KEY(`category_id`, `work_type_id`),
	FOREIGN KEY (`category_id`) REFERENCES `work_categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_type_id`) REFERENCES `work_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `equipment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`usage` text DEFAULT 'unspecified' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "equipment_usage_check" CHECK("equipment_items"."usage" in ('unspecified', 'consumable', 'reusable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `equipment_items_name_unique` ON `equipment_items` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `work_categories_name_unique` ON `work_categories` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_order_equipment` (
	`work_order_id` text NOT NULL,
	`equipment_id` text NOT NULL,
	`quantity` real,
	`name_snapshot` text NOT NULL,
	`unit_snapshot` text NOT NULL,
	`usage_snapshot` text NOT NULL,
	PRIMARY KEY(`work_order_id`, `equipment_id`),
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`equipment_id`) REFERENCES `equipment_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_equipment_quantity_check" CHECK("work_order_equipment"."quantity" is null or "work_order_equipment"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_order_work_types` (
	`work_order_id` text NOT NULL,
	`work_type_version_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`name_snapshot` text NOT NULL,
	PRIMARY KEY(`work_order_id`, `work_type_version_id`),
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_type_version_id`) REFERENCES `work_type_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `work_order_component_sequence_unique` ON `work_order_work_types` (`work_order_id`,`sequence`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_type_aliases` (
	`organization_id` text NOT NULL,
	`alias` text NOT NULL,
	`work_type_id` text NOT NULL,
	PRIMARY KEY(`organization_id`, `alias`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_type_id`) REFERENCES `work_types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_type_version_equipment` (
	`work_type_version_id` text NOT NULL,
	`equipment_id` text NOT NULL,
	`quantity` real,
	`name_snapshot` text NOT NULL,
	`unit_snapshot` text NOT NULL,
	`usage_snapshot` text NOT NULL,
	PRIMARY KEY(`work_type_version_id`, `equipment_id`),
	FOREIGN KEY (`work_type_version_id`) REFERENCES `work_type_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`equipment_id`) REFERENCES `equipment_items`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "version_equipment_quantity_check" CHECK("work_type_version_equipment"."quantity" is null or "work_type_version_equipment"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `worker_work_competencies` (
	`worker_id` text NOT NULL,
	`category_id` text NOT NULL,
	`work_type_id` text NOT NULL,
	PRIMARY KEY(`worker_id`, `category_id`, `work_type_id`),
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `work_categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`work_type_id`) REFERENCES `work_types`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE `work_orders` ADD `category_id` text REFERENCES work_categories(id);--> statement-breakpoint
ALTER TABLE `work_orders` ADD `service_duration_minutes` integer;--> statement-breakpoint
ALTER TABLE `work_orders` ADD `duration_source` text DEFAULT 'version' NOT NULL;