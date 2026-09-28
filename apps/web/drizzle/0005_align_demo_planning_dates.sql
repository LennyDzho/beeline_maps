UPDATE `work_orders`
SET `scheduled_start` = '2026-08-23' || SUBSTR(`scheduled_start`, 11),
    `completed_at` = CASE
      WHEN `completed_at` IS NOT NULL AND SUBSTR(`completed_at`, 1, 10) = '2026-10-23'
        THEN '2026-08-23' || SUBSTR(`completed_at`, 11)
      ELSE `completed_at`
    END,
    `updated_at` = CURRENT_TIMESTAMP
WHERE `organization_id` = 'ORG-001'
  AND `id` IN ('ORD-9018', 'ORD-9019')
  AND SUBSTR(`scheduled_start`, 1, 10) = '2026-10-23';--> statement-breakpoint
UPDATE `work_orders`
SET `scheduled_start` = '2026-08-24' || SUBSTR(`scheduled_start`, 11),
    `updated_at` = CURRENT_TIMESTAMP
WHERE `organization_id` = 'ORG-001'
  AND `id` IN ('ORD-9020', 'ORD-9021')
  AND SUBSTR(`scheduled_start`, 1, 10) = '2026-10-24';--> statement-breakpoint
UPDATE `work_reports`
SET `submitted_at` = '2026-08-23' || SUBSTR(`submitted_at`, 11),
    `updated_at` = CURRENT_TIMESTAMP
WHERE `id` = 'REPORT-ORD-9018'
  AND `submitted_at` IS NOT NULL
  AND SUBSTR(`submitted_at`, 1, 10) = '2026-10-23';--> statement-breakpoint
UPDATE `route_plans`
SET `service_date` = '2026-08-23',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `service_date` = '2026-10-23'
  AND EXISTS (
    SELECT 1 FROM `route_stops`
    WHERE `route_stops`.`route_plan_id` = `route_plans`.`id`
      AND `route_stops`.`work_order_id` IN ('ORD-9018', 'ORD-9019')
  );--> statement-breakpoint
UPDATE `route_plans`
SET `service_date` = '2026-08-24',
    `updated_at` = CURRENT_TIMESTAMP
WHERE `service_date` = '2026-10-24'
  AND EXISTS (
    SELECT 1 FROM `route_stops`
    WHERE `route_stops`.`route_plan_id` = `route_plans`.`id`
      AND `route_stops`.`work_order_id` IN ('ORD-9020', 'ORD-9021')
  );--> statement-breakpoint
UPDATE `route_stops`
SET `planned_start` = CASE
      WHEN SUBSTR(`planned_start`, 1, 10) = '2026-10-23' THEN '2026-08-23' || SUBSTR(`planned_start`, 11)
      WHEN SUBSTR(`planned_start`, 1, 10) = '2026-10-24' THEN '2026-08-24' || SUBSTR(`planned_start`, 11)
      ELSE `planned_start`
    END,
    `planned_end` = CASE
      WHEN SUBSTR(`planned_end`, 1, 10) = '2026-10-23' THEN '2026-08-23' || SUBSTR(`planned_end`, 11)
      WHEN SUBSTR(`planned_end`, 1, 10) = '2026-10-24' THEN '2026-08-24' || SUBSTR(`planned_end`, 11)
      ELSE `planned_end`
    END
WHERE `work_order_id` IN ('ORD-9018', 'ORD-9019', 'ORD-9020', 'ORD-9021');
