CREATE TABLE `worker_day_equipment` (
	`worker_id` text NOT NULL,
	`service_date` text NOT NULL,
	`departed_at` text NOT NULL,
	`equipment_json` text,
	`source` text NOT NULL,
	`recorded_by_user_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`worker_id`, `service_date`),
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recorded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Freeze the whole day's kit at the first actual departure/start. A later
-- assignment or recalculation must never add its equipment to this snapshot.
CREATE TRIGGER worker_equipment_on_departure AFTER UPDATE OF status ON work_orders
WHEN OLD.status IN ('new','assigned') AND NEW.status IN ('en_route','in_progress','paused','completed') AND NEW.assignee_worker_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO worker_day_equipment (worker_id,service_date,departed_at,equipment_json,source,updated_at)
  SELECT NEW.assignee_worker_id,SUBSTR(NEW.scheduled_start,1,10),NEW.updated_at,
    CASE WHEN EXISTS(SELECT 1 FROM work_orders o WHERE o.assignee_worker_id=NEW.assignee_worker_id
      AND SUBSTR(o.scheduled_start,1,10)=SUBSTR(NEW.scheduled_start,1,10) AND o.id<>NEW.id
      AND o.status IN ('en_route','in_progress','paused','completed','confirmed')) THEN NULL
    ELSE (SELECT json_group_array(json_object('equipmentId',equipment_id,'name',name,'unit',unit,'usage',usage,'quantity',quantity)) FROM (
      SELECT e.equipment_id,MIN(e.name_snapshot) AS name,MIN(e.unit_snapshot) AS unit,MIN(e.usage_snapshot) AS usage,
        CASE WHEN COUNT(e.quantity)<>COUNT(*) THEN NULL WHEN MIN(e.usage_snapshot)='consumable' THEN SUM(e.quantity)
          WHEN MIN(e.usage_snapshot)='reusable' THEN MAX(e.quantity) ELSE NULL END AS quantity
      FROM work_order_equipment e JOIN work_orders o ON o.id=e.work_order_id
      WHERE o.assignee_worker_id=NEW.assignee_worker_id AND SUBSTR(o.scheduled_start,1,10)=SUBSTR(NEW.scheduled_start,1,10)
        AND o.status<>'cancelled' GROUP BY e.equipment_id ORDER BY e.equipment_id)) END,
    'plan_at_departure',NEW.updated_at;
END;
