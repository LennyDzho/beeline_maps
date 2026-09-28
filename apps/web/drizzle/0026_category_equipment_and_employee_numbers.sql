ALTER TABLE `work_categories` ADD `equipment_configured` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `category_equipment` (
  `category_id` text NOT NULL REFERENCES `work_categories`(`id`) ON DELETE CASCADE,
  `equipment_id` text NOT NULL REFERENCES `equipment_items`(`id`) ON DELETE RESTRICT,
  `quantity` real,
  PRIMARY KEY (`category_id`, `equipment_id`),
  CHECK (`quantity` IS NULL OR (`quantity` > 0 AND `quantity` <= 1000000))
);
--> statement-breakpoint
INSERT INTO category_equipment(category_id,equipment_id,quantity)
SELECT c.category_id,e.equipment_id,CASE WHEN COUNT(e.quantity)=COUNT(*) THEN MAX(e.quantity) ELSE NULL END
FROM category_work_types c
JOIN work_type_versions v ON v.work_type_id=c.work_type_id
  AND v.version=(SELECT MAX(v2.version) FROM work_type_versions v2 WHERE v2.work_type_id=v.work_type_id)
JOIN work_type_version_equipment e ON e.work_type_version_id=v.id
GROUP BY c.category_id,e.equipment_id;
--> statement-breakpoint
UPDATE work_categories SET equipment_configured=1;
--> statement-breakpoint
WITH numbered AS (
 SELECT id, ROW_NUMBER() OVER (ORDER BY organization_id,full_name,id) +
 (SELECT COALESCE(MAX(CAST(employee_number AS INTEGER)),0) FROM workers WHERE employee_number<>'' AND employee_number NOT GLOB '*[^0-9]*') AS number
 FROM workers WHERE employee_number='' OR employee_number GLOB '*[^0-9]*'
)
UPDATE workers SET employee_number=CAST((SELECT number FROM numbered WHERE numbered.id=workers.id) AS TEXT)
WHERE id IN (SELECT id FROM numbered);
--> statement-breakpoint
CREATE TABLE `resource_assignment_guards` (
 `id` text PRIMARY KEY NOT NULL,
 `available` integer NOT NULL CONSTRAINT `resource_must_be_available` CHECK (`available`=1)
);
