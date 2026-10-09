CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`root` text NOT NULL,
	`terminal` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`created` integer NOT NULL,
	`revoked` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`owner` text NOT NULL,
	`operation` text NOT NULL,
	`args` text NOT NULL,
	`state` text NOT NULL,
	`result` text,
	`created` integer NOT NULL,
	`completed` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_device_state` ON `jobs` (`device_id`,`state`);--> statement-breakpoint
CREATE TABLE `once` (
	`name` text PRIMARY KEY NOT NULL,
	`used` integer NOT NULL
);
