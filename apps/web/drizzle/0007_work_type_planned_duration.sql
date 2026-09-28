ALTER TABLE `work_type_versions` ADD `planned_duration_minutes` integer DEFAULT 60 NOT NULL CHECK (`planned_duration_minutes` BETWEEN 15 AND 480);--> statement-breakpoint
UPDATE `work_orders`
SET `scheduled_end` = (
  SELECT strftime('%Y-%m-%dT%H:%M', `work_orders`.`scheduled_start`, '+' || `work_type_versions`.`planned_duration_minutes` || ' minutes')
  FROM `work_type_versions`
  WHERE `work_type_versions`.`id` = `work_orders`.`work_type_version_id`
)
WHERE `scheduled_end` IS NULL;
