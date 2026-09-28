CREATE TABLE `organization_planning_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`optimization_engine` text DEFAULT 'local_greedy' NOT NULL,
	`travel_matrix_provider` text DEFAULT 'two_gis' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "planner_engine_check" CHECK("organization_planning_settings"."optimization_engine" in ('local_greedy', 'two_gis_tsp')),
	CONSTRAINT "planner_matrix_check" CHECK("organization_planning_settings"."travel_matrix_provider" in ('two_gis', 'osrm')),
	CONSTRAINT "planner_combination_check" CHECK("organization_planning_settings"."optimization_engine" != 'two_gis_tsp' or "organization_planning_settings"."travel_matrix_provider" = 'two_gis')
);
