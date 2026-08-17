-- Phase 1: nullable columns first. Application backfill classifies legacy
-- rows before the target environment enables final write constraints.
ALTER TABLE `sessions` ADD `snapshot_state` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `snapshot_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `snapshot_finalized_at` integer;
