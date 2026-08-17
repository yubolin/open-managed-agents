-- Phase 1: nullable columns first. Application backfill classifies legacy
-- rows before the target environment enables final write constraints.
ALTER TABLE "sessions" ADD COLUMN "snapshot_state" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "snapshot_finalized_at" bigint;--> statement-breakpoint
ALTER TABLE "session_threads" ADD COLUMN "agent_version" bigint;--> statement-breakpoint
ALTER TABLE "session_threads" ADD COLUMN "agent_snapshot" text;--> statement-breakpoint
ALTER TABLE "session_threads" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "session_threads" ADD COLUMN "hash_algorithm" text;
