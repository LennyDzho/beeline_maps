CREATE TABLE `route_plan_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`service_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`organization_ids_json` text NOT NULL,
	`member_plans_json` text NOT NULL,
	`input_revision_json` text NOT NULL,
	`published_revision_json` text,
	`result_json` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`published_by_user_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_at` text,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "route_plan_groups_status_check" CHECK("route_plan_groups"."status" in ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `route_plan_groups_date_idx` ON `route_plan_groups` (`service_date`);