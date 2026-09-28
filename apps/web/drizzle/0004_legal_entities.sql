INSERT OR IGNORE INTO `organizations`
  (`id`, `name`, `timezone`, `application_name`, `email_alerts`, `weekly_digest`, `status`, `created_at`, `updated_at`)
VALUES
  ('ORG-001', 'ООО "ТехноСервис"', 'Europe/Moscow', 'Маршрут FSM', 1, 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);--> statement-breakpoint
UPDATE `roles` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `memberships` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `service_areas` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `work_schedules` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `workers` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `skills` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `qualifications` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `resources` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `ai_verifier_connections` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `work_types` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `service_objects` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `work_orders` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `route_plans` SET `organization_id` = 'ORG-001';--> statement-breakpoint
UPDATE `audit_events` SET `organization_id` = 'ORG-001';--> statement-breakpoint
INSERT OR IGNORE INTO `organizations`
  (`id`, `name`, `timezone`, `application_name`, `email_alerts`, `weekly_digest`, `status`, `created_at`, `updated_at`)
VALUES
  ('ORG-002', 'ИП Иванов', 'Europe/Moscow', 'Маршрут FSM', 1, 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);--> statement-breakpoint
INSERT OR IGNORE INTO `organizations`
  (`id`, `name`, `timezone`, `application_name`, `email_alerts`, `weekly_digest`, `status`, `created_at`, `updated_at`)
VALUES
  ('ORG-003', 'АО "Городские Сети"', 'Europe/Moscow', 'Маршрут FSM', 1, 0, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
