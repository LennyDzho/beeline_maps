CREATE TABLE `system_settings` (
 `id` integer PRIMARY KEY NOT NULL CHECK (`id`=1),
 `application_name` text NOT NULL DEFAULT 'Марш!',
 `email_alerts` integer NOT NULL DEFAULT 1,
 `weekly_digest` integer NOT NULL DEFAULT 0,
 `optimization_engine` text NOT NULL DEFAULT 'local_greedy' CHECK (`optimization_engine` IN ('local_greedy','ortools','two_gis_tsp')),
 `travel_matrix_provider` text NOT NULL DEFAULT 'osrm' CHECK (`travel_matrix_provider` IN ('osrm','two_gis')),
 `solver_policy` text NOT NULL DEFAULT 'emergency_fast/v1' CHECK (`solver_policy` IN ('emergency_fast/v1','emergency_staff/v1')),
 `updated_at` text NOT NULL,
 CHECK (`optimization_engine`<>'two_gis_tsp' OR `travel_matrix_provider`='two_gis')
);
--> statement-breakpoint
INSERT INTO system_settings(id,application_name,email_alerts,weekly_digest,optimization_engine,travel_matrix_provider,solver_policy,updated_at)
SELECT 1,
 COALESCE((SELECT application_name FROM organizations ORDER BY id LIMIT 1),'Марш!'),
 COALESCE((SELECT email_alerts FROM organizations ORDER BY id LIMIT 1),1),
 COALESCE((SELECT weekly_digest FROM organizations ORDER BY id LIMIT 1),0),
 COALESCE((SELECT COALESCE(solver_engine,optimization_engine) FROM organization_planning_settings ORDER BY updated_at DESC,organization_id LIMIT 1),'local_greedy'),
 COALESCE((SELECT travel_matrix_provider FROM organization_planning_settings ORDER BY updated_at DESC,organization_id LIMIT 1),'osrm'),
 COALESCE((SELECT solver_policy FROM organization_planning_settings ORDER BY updated_at DESC,organization_id LIMIT 1),'emergency_fast/v1'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now');
