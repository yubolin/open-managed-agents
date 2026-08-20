ALTER TABLE "workspace_backups" ADD COLUMN IF NOT EXISTS "environment_id" text;--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD COLUMN IF NOT EXISTS "backup_handle" text;--> statement-breakpoint
ALTER TABLE "workspace_backups" ADD COLUMN IF NOT EXISTS "source_session_id" text;--> statement-breakpoint
ALTER TABLE "workspace_backups" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_backups" ALTER COLUMN "blob_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_backups" ALTER COLUMN "size_bytes" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_backups_source_session" ON "workspace_backups" ("source_session_id", "created_at");
