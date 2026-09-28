ALTER TABLE `system_settings` ADD `calculation_timeout_seconds` integer NOT NULL DEFAULT 180 CHECK (`calculation_timeout_seconds` BETWEEN 30 AND 1800);
