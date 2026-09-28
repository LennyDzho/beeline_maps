CREATE TABLE `ai_verification_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result` text,
	`request_hash` text NOT NULL,
	`external_request_id` text,
	`error_code` text,
	`error_message` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `work_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `ai_verifier_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ai_verification_runs_attempt_check" CHECK("ai_verification_runs"."attempt" > 0),
	CONSTRAINT "ai_verification_runs_status_check" CHECK("ai_verification_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "ai_verification_runs_result_check" CHECK("ai_verification_runs"."result" is null or "ai_verification_runs"."result" in ('accepted', 'not_accepted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_verification_runs_report_attempt_unique` ON `ai_verification_runs` (`report_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `ai_verification_runs_status_idx` ON `ai_verification_runs` (`status`);--> statement-breakpoint
CREATE TABLE `ai_verifier_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model_name` text NOT NULL,
	`endpoint_url` text NOT NULL,
	`secret_reference` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`timeout_seconds` integer DEFAULT 30 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ai_verifier_connections_status_check" CHECK("ai_verifier_connections"."status" in ('active', 'disabled')),
	CONSTRAINT "ai_verifier_connections_timeout_check" CHECK("ai_verifier_connections"."timeout_seconds" between 1 and 300),
	CONSTRAINT "ai_verifier_connections_attempts_check" CHECK("ai_verifier_connections"."max_attempts" between 1 and 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_verifier_connections_organization_name_unique` ON `ai_verifier_connections` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`actor_user_id` text,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_events_organization_created_idx` ON `audit_events` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "memberships_status_check" CHECK("memberships"."status" in ('invited', 'active', 'blocked', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_organization_user_unique` ON `memberships` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `memberships_role_id_idx` ON `memberships` (`role_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Europe/Moscow' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK("organizations"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `qualifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`validity_required` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `qualifications_organization_code_unique` ON `qualifications` (`organization_id`,`code`);--> statement-breakpoint
CREATE TABLE `report_media` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`kind` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`storage_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum` text NOT NULL,
	`upload_status` text DEFAULT 'uploaded' NOT NULL,
	`captured_at` text,
	`latitude` real,
	`longitude` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `work_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "report_media_kind_check" CHECK("report_media"."kind" in ('photo', 'video')),
	CONSTRAINT "report_media_size_check" CHECK("report_media"."size_bytes" >= 0),
	CONSTRAINT "report_media_upload_status_check" CHECK("report_media"."upload_status" in ('pending', 'uploaded', 'failed', 'deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_media_storage_key_unique` ON `report_media` (`storage_key`);--> statement-breakpoint
CREATE INDEX `report_media_report_id_idx` ON `report_media` (`report_id`);--> statement-breakpoint
CREATE TABLE `report_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`reviewer_type` text NOT NULL,
	`reviewer_user_id` text,
	`ai_verification_run_id` text,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `work_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ai_verification_run_id`) REFERENCES `ai_verification_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "report_reviews_reviewer_type_check" CHECK("report_reviews"."reviewer_type" in ('dispatcher', 'ai_model')),
	CONSTRAINT "report_reviews_decision_check" CHECK("report_reviews"."decision" in ('accepted', 'changes_requested', 'rejected', 'not_accepted', 'error_fallback'))
);
--> statement-breakpoint
CREATE INDEX `report_reviews_report_created_idx` ON `report_reviews` (`report_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_area_id` text,
	`assigned_worker_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`plate` text,
	`region` text,
	`vin` text,
	`status` text DEFAULT 'available' NOT NULL,
	`condition` text DEFAULT 'serviceable' NOT NULL,
	`next_service_at` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_area_id`) REFERENCES `service_areas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assigned_worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "resources_status_check" CHECK("resources"."status" in ('working', 'repair', 'available', 'inactive')),
	CONSTRAINT "resources_condition_check" CHECK("resources"."condition" in ('serviceable', 'service_required', 'unserviceable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resources_organization_vin_unique` ON `resources` (`organization_id`,`vin`);--> statement-breakpoint
CREATE INDEX `resources_organization_status_idx` ON `resources` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `resources_assigned_worker_id_idx` ON `resources` (`assigned_worker_id`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission_code` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission_code`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_code`) REFERENCES `permissions`(`code`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_organization_code_unique` ON `roles` (`organization_id`,`code`);--> statement-breakpoint
CREATE INDEX `roles_organization_id_idx` ON `roles` (`organization_id`);--> statement-breakpoint
CREATE TABLE `route_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`service_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`optimizer_version` text,
	`created_by_user_id` text NOT NULL,
	`published_by_user_id` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "route_plans_status_check" CHECK("route_plans"."status" in ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE INDEX `route_plans_organization_date_idx` ON `route_plans` (`organization_id`,`service_date`);--> statement-breakpoint
CREATE TABLE `route_stops` (
	`id` text PRIMARY KEY NOT NULL,
	`route_plan_id` text NOT NULL,
	`work_order_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`planned_start` text NOT NULL,
	`planned_end` text,
	`travel_minutes` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`route_plan_id`) REFERENCES `route_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "route_stops_sequence_check" CHECK("route_stops"."sequence" > 0),
	CONSTRAINT "route_stops_travel_minutes_check" CHECK("route_stops"."travel_minutes" is null or "route_stops"."travel_minutes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `route_stops_plan_order_unique` ON `route_stops` (`route_plan_id`,`work_order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `route_stops_plan_worker_sequence_unique` ON `route_stops` (`route_plan_id`,`worker_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `route_stops_worker_start_idx` ON `route_stops` (`worker_id`,`planned_start`);--> statement-breakpoint
CREATE TABLE `service_areas` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_areas_organization_code_unique` ON `service_areas` (`organization_id`,`code`);--> statement-breakpoint
CREATE TABLE `service_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`external_reference` text,
	`name` text NOT NULL,
	`address` text NOT NULL,
	`latitude` real,
	`longitude` real,
	`notes` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "service_objects_latitude_check" CHECK("service_objects"."latitude" is null or "service_objects"."latitude" between -90 and 90),
	CONSTRAINT "service_objects_longitude_check" CHECK("service_objects"."longitude" is null or "service_objects"."longitude" between -180 and 180)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_objects_organization_external_unique` ON `service_objects` (`organization_id`,`external_reference`);--> statement-breakpoint
CREATE INDEX `service_objects_organization_id_idx` ON `service_objects` (`organization_id`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_organization_name_unique` ON `skills` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `work_order_status_history` (
	`id` text PRIMARY KEY NOT NULL,
	`work_order_id` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_by_user_id` text,
	`reason` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `work_order_status_history_order_created_idx` ON `work_order_status_history` (`work_order_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `work_orders` (
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
	CONSTRAINT "work_orders_priority_check" CHECK("work_orders"."priority" in ('high', 'medium', 'low')),
	CONSTRAINT "work_orders_status_check" CHECK("work_orders"."status" in ('new', 'assigned', 'en_route', 'in_progress', 'completed', 'confirmed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_orders_organization_number_unique` ON `work_orders` (`organization_id`,`number`);--> statement-breakpoint
CREATE INDEX `work_orders_organization_status_idx` ON `work_orders` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `work_orders_assignee_schedule_idx` ON `work_orders` (`assignee_worker_id`,`scheduled_start`);--> statement-breakpoint
CREATE INDEX `work_orders_work_type_version_idx` ON `work_orders` (`work_type_version_id`);--> statement-breakpoint
CREATE TABLE `work_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`work_order_id` text NOT NULL,
	`performer_worker_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`field_values_json` text DEFAULT '{}' NOT NULL,
	`submitted_at` text,
	`accepted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`work_order_id`) REFERENCES `work_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`performer_worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "work_reports_revision_check" CHECK("work_reports"."revision" > 0),
	CONSTRAINT "work_reports_status_check" CHECK("work_reports"."status" in ('draft', 'submitted', 'manual_review', 'ai_queued', 'ai_review', 'accepted', 'changes_requested', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_reports_order_revision_unique` ON `work_reports` (`work_order_id`,`revision`);--> statement-breakpoint
CREATE INDEX `work_reports_status_submitted_idx` ON `work_reports` (`status`,`submitted_at`);--> statement-breakpoint
CREATE TABLE `work_type_version_qualifications` (
	`work_type_version_id` text NOT NULL,
	`qualification_id` text NOT NULL,
	PRIMARY KEY(`work_type_version_id`, `qualification_id`),
	FOREIGN KEY (`work_type_version_id`) REFERENCES `work_type_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`qualification_id`) REFERENCES `qualifications`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `work_type_version_skills` (
	`work_type_version_id` text NOT NULL,
	`skill_id` text NOT NULL,
	PRIMARY KEY(`work_type_version_id`, `skill_id`),
	FOREIGN KEY (`work_type_version_id`) REFERENCES `work_type_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `work_type_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`work_type_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`verification_mode` text DEFAULT 'dispatcher' NOT NULL,
	`ai_verifier_connection_id` text,
	`report_template_json` text DEFAULT '{}' NOT NULL,
	`evidence_policy_json` text DEFAULT '{}' NOT NULL,
	`published_by_user_id` text,
	`published_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_type_id`) REFERENCES `work_types`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ai_verifier_connection_id`) REFERENCES `ai_verifier_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "work_type_versions_version_check" CHECK("work_type_versions"."version" > 0),
	CONSTRAINT "work_type_versions_status_check" CHECK("work_type_versions"."status" in ('draft', 'published', 'archived')),
	CONSTRAINT "work_type_versions_verification_mode_check" CHECK("work_type_versions"."verification_mode" in ('dispatcher', 'ai_model')),
	CONSTRAINT "work_type_versions_verifier_check" CHECK(("work_type_versions"."verification_mode" = 'dispatcher' and "work_type_versions"."ai_verifier_connection_id" is null) or ("work_type_versions"."verification_mode" = 'ai_model' and "work_type_versions"."ai_verifier_connection_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_type_versions_work_type_version_unique` ON `work_type_versions` (`work_type_id`,`version`);--> statement-breakpoint
CREATE INDEX `work_type_versions_status_idx` ON `work_type_versions` (`status`);--> statement-breakpoint
CREATE TABLE `work_types` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_types_organization_code_unique` ON `work_types` (`organization_id`,`code`);--> statement-breakpoint
CREATE TABLE `worker_qualifications` (
	`worker_id` text NOT NULL,
	`qualification_id` text NOT NULL,
	`document_number` text,
	`issued_at` text,
	`expires_at` text,
	`status` text DEFAULT 'valid' NOT NULL,
	PRIMARY KEY(`worker_id`, `qualification_id`),
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`qualification_id`) REFERENCES `qualifications`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "worker_qualifications_status_check" CHECK("worker_qualifications"."status" in ('valid', 'expiring', 'expired', 'suspended'))
);
--> statement-breakpoint
CREATE INDEX `worker_qualifications_expires_at_idx` ON `worker_qualifications` (`expires_at`);--> statement-breakpoint
CREATE TABLE `worker_skills` (
	`worker_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`level` text DEFAULT 'qualified' NOT NULL,
	`confirmed_at` text,
	PRIMARY KEY(`worker_id`, `skill_id`),
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`service_area_id` text,
	`employee_number` text NOT NULL,
	`full_name` text NOT NULL,
	`phone` text NOT NULL,
	`shift_status` text DEFAULT 'off_shift' NOT NULL,
	`load_percent` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_area_id`) REFERENCES `service_areas`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "workers_shift_status_check" CHECK("workers"."shift_status" in ('on_shift', 'break', 'off_shift')),
	CONSTRAINT "workers_load_percent_check" CHECK("workers"."load_percent" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workers_organization_employee_unique` ON `workers` (`organization_id`,`employee_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `workers_user_id_unique` ON `workers` (`user_id`);--> statement-breakpoint
CREATE INDEX `workers_service_area_id_idx` ON `workers` (`service_area_id`);--> statement-breakpoint
PRAGMA optimize;
