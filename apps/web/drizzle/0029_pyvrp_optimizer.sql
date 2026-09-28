CREATE TABLE `system_settings_next` (
 `id` integer PRIMARY KEY NOT NULL CHECK (`id`=1),
 `application_name` text NOT NULL DEFAULT 'Марш!',
 `email_alerts` integer NOT NULL DEFAULT 1,
 `weekly_digest` integer NOT NULL DEFAULT 0,
 `optimization_engine` text NOT NULL DEFAULT 'local_greedy' CHECK (`optimization_engine` IN ('local_greedy','ortools','pyvrp','two_gis_tsp')),
 `travel_matrix_provider` text NOT NULL DEFAULT 'osrm' CHECK (`travel_matrix_provider` IN ('osrm','two_gis')),
 `solver_policy` text NOT NULL DEFAULT 'emergency_fast/v1' CHECK (`solver_policy` IN ('emergency_fast/v1','emergency_staff/v1')),
 `updated_at` text NOT NULL,
 `calculation_timeout_seconds` integer NOT NULL DEFAULT 180 CHECK (`calculation_timeout_seconds` BETWEEN 30 AND 1800),
 CHECK (`optimization_engine`<>'two_gis_tsp' OR `travel_matrix_provider`='two_gis')
);
--> statement-breakpoint
INSERT INTO system_settings_next SELECT id,application_name,email_alerts,weekly_digest,optimization_engine,travel_matrix_provider,solver_policy,updated_at,calculation_timeout_seconds FROM system_settings;
--> statement-breakpoint
DROP TABLE system_settings;
--> statement-breakpoint
ALTER TABLE system_settings_next RENAME TO system_settings;
