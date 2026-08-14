-- AIOps approval gate (enterprise line, docs/aiops-closed-loop.md).
-- Journal-only migration, deliberately WITHOUT a drizzle-kit snapshot —
-- see the sqlite 0006 counterpart for the rationale. Appended at the pg
-- chain's next free slot after 0006_session_memory_freeze.
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"alert_id" text,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" bigint,
	"expires_at" bigint NOT NULL,
	"reason" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ck_approval_requests_status" CHECK ("status" IN ('pending','approved','rejected','expired'))
);
--> statement-breakpoint
CREATE INDEX "idx_approval_requests_tenant_status" ON "approval_requests" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_session" ON "approval_requests" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_approval_requests_expiry" ON "approval_requests" USING btree ("status","expires_at");
