CREATE TABLE "aiops_alert_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"alert_id" text NOT NULL,
	"event_type" text NOT NULL,
	"actor" text NOT NULL,
	"payload_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "ck_aev_type" CHECK ("event_type" IN ('ingested','severity_escalated','resolved','suppressed','unsuppressed','expired','run_triggered','run_completed'))
);
--> statement-breakpoint
CREATE TABLE "aiops_alert_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"webhook_token_hash" text NOT NULL,
	"severity_mapping_json" text DEFAULT '{}' NOT NULL,
	"stale_after_seconds" bigint DEFAULT 86400 NOT NULL,
	"enabled" bigint DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "uq_asrc_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ck_asrc_type" CHECK ("type" IN ('alertmanager','generic'))
);
--> statement-breakpoint
CREATE TABLE "aiops_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'firing' NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"labels_json" text NOT NULL,
	"annotations_json" text DEFAULT '{}' NOT NULL,
	"starts_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"occurrence_count" bigint DEFAULT 1 NOT NULL,
	"resolved_at" bigint,
	"correlated_run_id" text,
	"correlation_id" text,
	"suppress_note" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "uq_alerts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ck_alerts_status" CHECK ("status" IN ('firing','resolved','suppressed','expired')),
	CONSTRAINT "ck_alerts_severity" CHECK ("severity" IN ('critical','high','medium','low','info'))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "source_alert_id" text;--> statement-breakpoint
ALTER TABLE "aiops_alert_events" ADD CONSTRAINT "aiops_alert_events_tenant_id_alert_id_aiops_alerts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","alert_id") REFERENCES "public"."aiops_alerts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aiops_alerts" ADD CONSTRAINT "aiops_alerts_tenant_id_source_id_aiops_alert_sources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."aiops_alert_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_aev_alert" ON "aiops_alert_events" USING btree ("tenant_id","alert_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_aev_type" ON "aiops_alert_events" USING btree ("tenant_id","event_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_asrc_token" ON "aiops_alert_sources" USING btree ("webhook_token_hash");--> statement-breakpoint
CREATE INDEX "idx_asrc_tenant" ON "aiops_alert_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_alerts_active_fingerprint" ON "aiops_alerts" USING btree ("tenant_id","fingerprint") WHERE "status" IN ('firing','suppressed');--> statement-breakpoint
CREATE INDEX "idx_alerts_tenant_status" ON "aiops_alerts" USING btree ("tenant_id","status","severity","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_alerts_source" ON "aiops_alerts" USING btree ("tenant_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_runs_tenant_source_alert" ON "runs" USING btree ("tenant_id","source_alert_id");
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- aiops_alert_events append-only guards (p1-aiops-alerts-spec §11 I10).
--
-- PG enforces the FKs natively (no trigger mirror needed), but immutability
-- needs a database-level guard: UPDATE and DELETE abort unconditionally —
-- a step beyond run_events, whose append-only is a service-layer discipline.
-- Mirrors trg_aev_no_update / trg_aev_no_delete in the SQLite/D1 migrations.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION aiops_alert_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: aiops_alert_events is append-only';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_aev_no_update
BEFORE UPDATE ON aiops_alert_events
FOR EACH ROW EXECUTE FUNCTION aiops_alert_events_append_only();--> statement-breakpoint
CREATE TRIGGER trg_aev_no_delete
BEFORE DELETE ON aiops_alert_events
FOR EACH ROW EXECUTE FUNCTION aiops_alert_events_append_only();
