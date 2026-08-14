-- AIOps approval gate (enterprise line, docs/aiops-closed-loop.md).
-- Journal-only migration, deliberately WITHOUT a drizzle-kit snapshot:
-- approval_requests is not part of the drizzle schema (the sessions schema
-- is shared CF/Node; adding this table there would make the next generated
-- migration try to re-create/drop it). Precedent: 0003 feishu publication,
-- 0005 session memory freeze. Renumbered-safe: appended at the sqlite
-- chain's next free slot after 0005_session_memory_freeze.
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"alert_id" text,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" integer,
	"expires_at" integer NOT NULL,
	"reason" text,
	"created_at" integer NOT NULL,
	CONSTRAINT "ck_approval_requests_status" CHECK ("status" IN ('pending','approved','rejected','expired'))
);
--> statement-breakpoint
CREATE INDEX "idx_approval_requests_tenant_status" ON "approval_requests" ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_session" ON "approval_requests" ("session_id");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_expiry" ON "approval_requests" ("status","expires_at");
