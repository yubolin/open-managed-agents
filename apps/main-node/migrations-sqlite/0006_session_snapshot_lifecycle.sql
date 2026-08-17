-- Phase 1 of the snapshot migration: add nullable lifecycle/evidence columns.
-- Application-layer JCS backfill and write constraints are separate phases.
ALTER TABLE `sessions` ADD `snapshot_state` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `snapshot_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `snapshot_finalized_at` integer;--> statement-breakpoint
ALTER TABLE `session_threads` ADD `agent_version` integer;--> statement-breakpoint
ALTER TABLE `session_threads` ADD `agent_snapshot` text;--> statement-breakpoint
ALTER TABLE `session_threads` ADD `config_hash` text;--> statement-breakpoint
ALTER TABLE `session_threads` ADD `hash_algorithm` text;
