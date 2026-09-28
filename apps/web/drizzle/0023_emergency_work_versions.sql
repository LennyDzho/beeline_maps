ALTER TABLE `work_type_versions` ADD `is_emergency` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE work_type_versions SET is_emergency=1 WHERE work_type_id IN
  (SELECT id FROM work_types WHERE TRIM(name) IN ('Авария','авария','АВАРИЯ'));
