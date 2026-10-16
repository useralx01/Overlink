CREATE TABLE IF NOT EXISTS `mesh_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`from_device` text NOT NULL,
	`target_device` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`filename` text DEFAULT '' NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`delivered` integer,
	CONSTRAINT "mesh_kind" CHECK("mesh_transfers"."kind" IN ('text','handoff','file')),
	CONSTRAINT "mesh_state" CHECK("mesh_transfers"."state" IN ('queued','delivered'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mesh_transfers_inbox` ON `mesh_transfers` (`owner`,`target_device`,`state`,`created`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mesh_transfers_expiry` ON `mesh_transfers` (`expires`);