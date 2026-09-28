CREATE TABLE `worker_planning_availability` (
	`worker_id` text PRIMARY KEY NOT NULL,
	`available_at` text NOT NULL,
	`address` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`activity_revision` text NOT NULL,
	`updated_by_user_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "worker_availability_latitude_check" CHECK("worker_planning_availability"."latitude" between -90 and 90),
	CONSTRAINT "worker_availability_longitude_check" CHECK("worker_planning_availability"."longitude" between -180 and 180)
);
