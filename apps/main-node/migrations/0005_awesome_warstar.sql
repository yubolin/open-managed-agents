CREATE TABLE "aiops_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"name" text NOT NULL,
	"labels" text DEFAULT '{}' NOT NULL,
	"annotations" text DEFAULT '{}' NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint,
	"dedup_count" integer DEFAULT 1 NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"session_id" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ck_aiops_alerts_status" CHECK ("status" IN ('new','dispatching','dispatched','error','deduped','resolved')),
	CONSTRAINT "ck_aiops_alerts_severity" CHECK ("severity" IN ('critical','warning','info'))
);
--> statement-breakpoint
CREATE INDEX "idx_aiops_alerts_fingerprint" ON "aiops_alerts" USING btree ("tenant_id","fingerprint","status");--> statement-breakpoint
CREATE INDEX "idx_aiops_alerts_status_created" ON "aiops_alerts" USING btree ("status","created_at");