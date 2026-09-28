ALTER TABLE `organizations` ADD `optimization_engine` text DEFAULT 'local_greedy' NOT NULL CHECK (`optimization_engine` IN ('local_greedy'));--> statement-breakpoint
ALTER TABLE `organizations` ADD `travel_matrix_provider` text DEFAULT 'two_gis' NOT NULL CHECK (`travel_matrix_provider` IN ('two_gis', 'local_estimated'));
